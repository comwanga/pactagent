import { createHash } from "node:crypto";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { deserializeProofs } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";

import { sats } from "../domain/money";
import {
  nostrPublicKey,
  type NostrIdentity,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "../domain/nostr";
import { createPontmoreAgentDefinition } from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  createPactServiceOffer,
  PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
} from "../domain/pact-service-offer";
import {
  createPactEscrowAuthoritySource,
  PACT_SERVICE_AGREEMENT_ROOT_TYPE,
  validatePactServiceAgreementRoot,
  type PactAgreementReferences,
} from "../domain/pact-service-agreement";
import type { RequesterPolicy } from "../domain/pact-agents";
import {
  createInMemoryPactCashuEscrowSettlementStore,
  type PactCashuEscrowSettlementStore,
} from "./cashu-escrow-settlement";
import {
  createInMemoryCashuPrivateStore,
  createPrivateCashuFunding,
  createPrivateCashuSpendingKey,
  type CashuMutationResult,
  type CashuPrivateDeliveryResult,
  type CashuPrivateHandle,
  type CashuPrivateValueDeliveryPort,
  type CashuPrivateStore,
  type CashuTestMintPort,
  type PrepareLockedValueInput,
  type ProofStateSummary,
  type SpendLockedValueInput,
  type ValidatedMintCapabilities,
} from "./cashu-test-mint";
import { createLocalNostrSigner } from "./nostr-signer";
import { createLocalNostrEncrypter } from "./private-task-transport";
import type { NostrFilter, NostrRelayAdapter } from "./nostr-relay";
import {
  createPactAgentRuntime,
  PactAgentRuntimeError,
  type PactAgentRuntime,
} from "./pactagent-runtime";
import {
  DeterministicPactAgentClock,
  type PactAgentParticipantIdentities,
  type PactAgentWorkflowDependencies,
} from "./pactagent-workflow";
import type { RequesterDecisionModel } from "./requester-decision";
import type { SelectedProviderReferences } from "./provider-discovery";
import {
  createPactAgentRuntimeFromEnv,
  publishRuntimeBootstrapArtifacts,
} from "./pactagent-runtime.live";
import { toApiError } from "./pactagent-runtime-singleton";
import type { PactAgentLiveDemoConfig } from "./pactagent-workflow.live";

const ROOT_TIME = 1_900_000_000;
const MINT_URL = "https://testmint.example/cashu";
const CURVE_POINT = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

function key(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ident(secret: Uint8Array): NostrIdentity {
  return { publicKey: nostrPublicKey(getPublicKey(secret)), relays: ["wss://relay.example"] };
}

function signEvent(event: UnsignedNostrEvent, secret: Uint8Array): SignedNostrEvent {
  return finalizeEvent({ ...event, tags: event.tags.map((t) => [...t]) }, secret) as unknown as SignedNostrEvent;
}

function privateFunding() {
  return createPrivateCashuFunding({
    mintUrl: MINT_URL,
    unit: "sat",
    proofs: deserializeProofs([{ id: "00aabb", amount: "400", secret: "PRIVATE-PROOF", C: CURVE_POINT, witness: "PRIVATE-WITNESS" }]),
  });
}

function transactionId(idempotencyKey: string): string {
  return `txn_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

function filterMatches(event: SignedNostrEvent, filter: NostrFilter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  if (filter.tags) {
    for (const [name, values] of Object.entries(filter.tags)) {
      if (!event.tags.some((tag) => tag[0] === name && values.includes(tag[1]))) return false;
    }
  }
  return true;
}

class MemoryRelay implements NostrRelayAdapter {
  readonly url = "wss://relay.example";
  readonly events: SignedNostrEvent[] = [];
  connectCalls = 0;
  disconnectCalls = 0;

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }
  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }
  async publish(event: SignedNostrEvent): Promise<void> {
    if (!this.events.some((c) => c.id === event.id)) this.events.push(event);
  }
  async queryEvents(filter: NostrFilter): Promise<SignedNostrEvent[]> {
    return this.events.filter((e) => filterMatches(e, filter)).sort((a, b) => b.created_at - a.created_at);
  }
}

class FailingTransitionRelay extends MemoryRelay {
  private failedOnce = false;

  constructor(private readonly stateTag: string) {
    super();
  }

  async publish(event: SignedNostrEvent): Promise<void> {
    if (!this.failedOnce && event.tags.some((t) => t[0] === "t" && t[1] === this.stateTag)) {
      this.failedOnce = true;
      throw new Error(`Simulated ${this.stateTag} publication failure`);
    }
    await super.publish(event);
  }
}

class InspectingRootRelay extends MemoryRelay {
  constructor(private readonly inspect: (event: SignedNostrEvent) => Promise<void>) {
    super();
  }

  async publish(event: SignedNostrEvent): Promise<void> {
    await super.publish(event);
    if (event.tags.some((tag) => tag[0] === "t" && tag[1] === PACT_SERVICE_AGREEMENT_ROOT_TYPE)) {
      await this.inspect(event);
    }
  }
}

class FakeCashuPort implements CashuTestMintPort {
  private readonly outcomes = new Map<string, CashuMutationResult>();
  private readonly ambiguousSpendOperations = new Set<string>();
  prepareCalls = 0;
  prepareSubmissions = 0;
  spendCalls = 0;
  spendSubmissions = 0;
  readonly spendOperationIds: string[] = [];
  reconciliationSpend = false;
  recoverAmbiguousSpend = false;
  capabilitiesFail = false;

  async inspectCapabilities(): Promise<ValidatedMintCapabilities> {
    if (this.capabilitiesFail) throw new Error("simulated capability failure");
    return {
      mintUrl: MINT_URL,
      unit: "sat",
      nuts: { nut07ProofState: true, nut09Restore: true, nut10SpendingConditions: true, nut11P2pk: true },
      activeKeyset: { id: "00aabb", inputFeePpk: 1 },
      acceptedKeysetIds: ["00aabb"],
    };
  }

  async prepareLockedValue(input: PrepareLockedValueInput): Promise<CashuMutationResult> {
    this.prepareCalls += 1;
    const prior = this.outcomes.get(input.operationId);
    if (prior?.status === "succeeded") return prior;
    this.prepareSubmissions += 1;
    const result: CashuMutationResult = {
      status: "succeeded",
      operationId: input.operationId,
      handle: { reference: "cashu_private_11111111-1111-4111-8111-111111111111" },
      changeHandle: { reference: "cashu_private_33333333-3333-4333-8333-333333333333" },
      facts: { mintUrl: MINT_URL, unit: "sat", amountSats: sats(350n), inputAmountSats: sats(400n), outputAmountSats: sats(351n), changeAmountSats: sats(48n), mintFeeSats: sats(1n), reservedSpendFeeSats: sats(1n) },
    };
    this.outcomes.set(input.operationId, result);
    return result;
  }

  async inspectProofState(handle: CashuPrivateHandle): Promise<ProofStateSummary> {
    return { handle, state: "unspent", proofCount: 1, unspentCount: 1, pendingCount: 0, spentCount: 0 };
  }

  async spendLockedValue(input: SpendLockedValueInput): Promise<CashuMutationResult> {
    this.spendCalls += 1;
    this.spendOperationIds.push(input.operationId);
    const prior = this.outcomes.get(input.operationId);
    if (prior?.status === "succeeded") return prior;
    if (this.reconciliationSpend && !this.outcomes.has(input.operationId)) {
      if (!this.ambiguousSpendOperations.has(input.operationId)) {
        this.ambiguousSpendOperations.add(input.operationId);
        this.spendSubmissions += 1;
      }
      return { status: "submitted_unknown", outcome: "reconciliation_required", operationId: input.operationId };
    }
    const result: CashuMutationResult = {
      status: "succeeded",
      operationId: input.operationId,
      handle: { reference: "cashu_private_22222222-2222-4222-8222-222222222222" },
      changeHandle: { reference: "cashu_private_44444444-4444-4444-8444-444444444444" },
      facts: { mintUrl: MINT_URL, unit: "sat", amountSats: sats(350n), inputAmountSats: sats(351n), outputAmountSats: sats(350n), changeAmountSats: sats(1n), mintFeeSats: sats(0n), reservedSpendFeeSats: sats(0n) },
    };
    if (!(this.recoverAmbiguousSpend && this.ambiguousSpendOperations.has(input.operationId))) {
      this.spendSubmissions += 1;
    }
    this.outcomes.set(input.operationId, result);
    return result;
  }
}

class FakePrivateDelivery implements CashuPrivateValueDeliveryPort {
  async deliver(input: Parameters<CashuPrivateValueDeliveryPort["deliver"]>[0]): Promise<CashuPrivateDeliveryResult> {
    return { status: "delivered", deliveryId: input.deliveryId, beneficiary: input.expectedBeneficiary };
  }
}

class ApprovingDecisionModel implements RequesterDecisionModel {
  constructor(private readonly recommendation: unknown) {}
  async recommend(): Promise<unknown> {
    return this.recommendation;
  }
}

interface RuntimeFixture {
  identities: PactAgentParticipantIdentities;
  references: PactAgreementReferences;
  selectedReferences: SelectedProviderReferences;
  requesterPolicy: RequesterPolicy;
  decisionBounds: { maximumInstructionCharacters: number; maximumRationaleCharacters: number; modelTimeoutMilliseconds: number };
  decisionModel: RequesterDecisionModel;
  normalSpendKey: ReturnType<typeof createPrivateCashuSpendingKey>;
  refundSpendKey: ReturnType<typeof createPrivateCashuSpendingKey>;
  mintUrl: string;
  referenceEvents: SignedNostrEvent[];
}

function buildFixture(): RuntimeFixture {
  const requesterKey = key(31);
  const providerKey = key(32);
  const authorityKey = key(33);
  const requester = ident(requesterKey);
  const provider = ident(providerKey);

  const descriptor = createCashuEscrowDescriptor({
    identity: provider, identifier: "rt-cashu-summary", updatedAt: ROOT_TIME - 10,
    referenceFormat: "opaque_service_reference", timeoutSeconds: 900,
  });
  const offer = createPactServiceOffer({
    identity: provider, identifier: "rt-document-summary-offer",
    capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
    amountSats: sats(350n), settlementNetwork: "cashu",
    escrowDescriptorReference: descriptor.address, maximumExecutionSeconds: 120,
    validFrom: ROOT_TIME - 10, expiresAt: ROOT_TIME + 3600, updatedAt: ROOT_TIME - 10,
  });
  const requesterDefinition = createPontmoreAgentDefinition({
    identity: requester, identifier: "rt-requester", name: "RT Requester", about: "Requests summaries.",
    capabilities: { names: ["service-discovery"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/rt-requester@1",
    escrowDescriptorReference: descriptor.address, updatedAt: ROOT_TIME - 9,
  });
  const providerDefinition = createPontmoreAgentDefinition({
    identity: provider, identifier: "rt-provider", name: "RT Provider", about: "Provides summaries.",
    capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
    pricingPolicyReference: offer.address, escrowDescriptorReference: descriptor.address, updatedAt: ROOT_TIME - 9,
  });

  const descriptorEvent = signEvent(descriptor.event, providerKey);
  const offerEvent = signEvent(offer.event, providerKey);
  const providerDefinitionEvent = signEvent(providerDefinition.event, providerKey);
  const requesterDefinitionEvent = signEvent(requesterDefinition.event, requesterKey);

  const providerPubkey = provider.publicKey;
  const selectedReferences: SelectedProviderReferences = {
    providerPublicKey: providerPubkey,
    providerDefinitionReference: `30360:${providerPubkey}:rt-provider`,
    offerReference: `30400:${providerPubkey}:rt-document-summary-offer`,
    escrowDescriptorReference: `30361:${providerPubkey}:rt-cashu-summary`,
  };

  const recommendation = {
    action: "recommend",
    providerPublicKey: providerPubkey,
    providerDefinitionReference: selectedReferences.providerDefinitionReference,
    offerReference: selectedReferences.offerReference,
    escrowDescriptorReference: selectedReferences.escrowDescriptorReference,
    proposedAmountSats: "350",
  };

  return {
    identities: {
      requesterSigner: createLocalNostrSigner(hex(requesterKey)),
      providerSigner: createLocalNostrSigner(hex(providerKey)),
      escrowAuthoritySigner: createLocalNostrSigner(hex(authorityKey)),
      requesterEncrypter: createLocalNostrEncrypter(hex(requesterKey)),
      providerEncrypter: createLocalNostrEncrypter(hex(providerKey)),
    },
    references: {
      requesterDefinition: requesterDefinitionEvent,
      providerDefinition: providerDefinitionEvent,
      escrowDescriptor: descriptorEvent,
    },
    selectedReferences,
    requesterPolicy: {
      maxBudgetSats: sats(500n), allowedCapabilities: ["document-summary"],
      maximumEscrowDurationSeconds: 15 * 60, maximumProviderPriceSats: sats(450n),
      allowedSettlementNetworks: ["cashu"], autoRelease: "deterministic_checks_only",
    },
    decisionBounds: { maximumInstructionCharacters: 1000, maximumRationaleCharacters: 500, modelTimeoutMilliseconds: 5000 },
    decisionModel: new ApprovingDecisionModel(recommendation),
    normalSpendKey: createPrivateCashuSpendingKey({ purpose: "cashu-nut11", secretKeyHex: hex(key(21)) }),
    refundSpendKey: createPrivateCashuSpendingKey({ purpose: "cashu-nut11", secretKeyHex: hex(key(22)) }),
    mintUrl: MINT_URL,
    referenceEvents: [descriptorEvent, offerEvent, providerDefinitionEvent, requesterDefinitionEvent],
  };
}

interface SharedStores {
  privateStore: CashuPrivateStore;
  settlementStore: PactCashuEscrowSettlementStore;
}

interface RuntimeParts {
  runtime: PactAgentRuntime;
  relay: MemoryRelay;
  cashu: FakeCashuPort;
  clock: DeterministicPactAgentClock;
}

function buildRuntime(
  fixture: RuntimeFixture,
  shared: SharedStores,
  options: {
    relay?: MemoryRelay;
    cashu?: FakeCashuPort;
    requesterDecisionSource?: "deterministic" | "model";
  } = {},
): RuntimeParts {
  const relay = options.relay ?? new MemoryRelay();
  if (options.relay === undefined) {
    relay.events.push(...fixture.referenceEvents);
  }
  const cashu = options.cashu ?? new FakeCashuPort();
  const clock = new DeterministicPactAgentClock(ROOT_TIME);
  const dependencies: PactAgentWorkflowDependencies = {
    relay,
    clock,
    requesterPolicy: fixture.requesterPolicy,
    decisionModel: fixture.decisionModel,
    decisionBounds: fixture.decisionBounds,
    cashu,
    privateDelivery: new FakePrivateDelivery(),
    settlementStore: shared.settlementStore,
    mintUrl: fixture.mintUrl,
    normalSpendKey: fixture.normalSpendKey,
    refundSpendKey: fixture.refundSpendKey,
  };
  const runtime = createPactAgentRuntime({
    identities: fixture.identities,
    dependencies,
    privateStore: shared.privateStore,
    references: fixture.references,
    selectedReferences: fixture.selectedReferences,
    requesterDecisionSource: options.requesterDecisionSource ?? "deterministic",
    resolveFunding: async (reference) => {
      if (reference !== "funding-reference-0001") throw new Error("Unknown funding reference");
      return privateFunding();
    },
  });
  return { runtime, relay, cashu, clock };
}

function startInput(idempotencyKey = "idempotent-key-0001") {
  return {
    idempotencyKey,
    fundingReference: "funding-reference-0001",
    privateDocument: "PRIVATE-DOCUMENT Runtime transaction document about Bitcoin.",
    mediaType: "text/plain" as const,
    privatePrompt: "PRIVATE-PROMPT Summarize.",
    maximumBudgetSats: sats(500n),
  };
}

function sharedStores(): SharedStores {
  return {
    privateStore: createInMemoryCashuPrivateStore(),
    settlementStore: createInMemoryPactCashuEscrowSettlementStore(),
  };
}

function ambiguousFundingCashu(): FakeCashuPort {
  const cashu = new FakeCashuPort();
  cashu.prepareLockedValue = async (input) => {
    cashu.prepareCalls += 1;
    return {
      status: "submitted_unknown",
      outcome: "reconciliation_required",
      operationId: input.operationId,
    };
  };
  return cashu;
}

async function replaceEscrowAuthoritySource(
  store: PactCashuEscrowSettlementStore,
  agreementRootEventId: string,
  authoritySourceReference: string,
): Promise<void> {
  const binding = (await store.read(`agreement-escrow:${agreementRootEventId}`)) as {
    escrowReference: string;
  };
  const key = `escrow:${binding.escrowReference}`;
  const record = (await store.read(key)) as { revision: number };
  await expect(store.compareAndSet(key, record.revision, {
    ...record,
    revision: record.revision + 1,
    escrowAuthoritySource: authoritySourceReference,
  })).resolves.toBe(true);
}

describe("PactAgent runtime", () => {
  it("publishes requester, provider, offer, and escrow bootstrap artifacts to an empty relay", async () => {
    const relay = new MemoryRelay();
    const config: PactAgentLiveDemoConfig = {
      relayUrl: relay.url,
      testMintUrl: MINT_URL,
      requesterPrivateKeyHex: hex(key(31)),
      providerPrivateKeyHex: hex(key(32)),
      escrowAuthorityPrivateKeyHex: hex(key(33)),
      normalSpendKeyHex: hex(key(21)),
      refundSpendKeyHex: hex(key(22)),
      fundingToken: "cashuA_not-used-by-bootstrap-artifact-test",
      fundingReference: "funding-reference-bootstrap-test",
      stateDirectory: ".not-used",
    };
    const published = await publishRuntimeBootstrapArtifacts(config, relay, ROOT_TIME);
    expect(relay.events).toHaveLength(4);
    const identifiers = relay.events
      .flatMap((event) => event.tags)
      .filter((tag) => tag[0] === "d")
      .map((tag) => tag[1]);
    expect(identifiers).toEqual(expect.arrayContaining([
      "live-requester",
      "live-provider",
      "live-document-summary-offer",
      "live-cashu-escrow",
    ]));
    expect(published.references.requesterDefinition.id).toBeDefined();
  });

  it("disconnects the relay and closes stores once when live initialization fails", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const relay = new MemoryRelay();
    const cashu = new FakeCashuPort();
    const privateMarker = "PRIVATE-MINT-INITIALIZATION-CAUSE";
    cashu.inspectCapabilities = async () => {
      throw new Error(privateMarker);
    };
    const dependencies: PactAgentWorkflowDependencies = {
      relay,
      clock: new DeterministicPactAgentClock(ROOT_TIME),
      requesterPolicy: fixture.requesterPolicy,
      decisionModel: fixture.decisionModel,
      decisionBounds: fixture.decisionBounds,
      cashu,
      privateDelivery: new FakePrivateDelivery(),
      settlementStore: shared.settlementStore,
      mintUrl: fixture.mintUrl,
      normalSpendKey: fixture.normalSpendKey,
      refundSpendKey: fixture.refundSpendKey,
    };
    const environment = {
      PACTAGENT_LIVE_RELAY_URL: relay.url,
      PACTAGENT_CASHU_TEST_MINT_URL: MINT_URL,
      PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY: hex(key(31)),
      PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: hex(key(32)),
      PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY: hex(key(33)),
      PACTAGENT_LIVE_NORMAL_SPEND_KEY: hex(key(21)),
      PACTAGENT_LIVE_REFUND_SPEND_KEY: hex(key(22)),
      PACTAGENT_LIVE_FUNDING_TOKEN: "PRIVATE-LIVE-FUNDING-TOKEN",
      PACTAGENT_LIVE_FUNDING_REFERENCE: "funding-reference-live-failure",
      PACTAGENT_LIVE_STATE_DIRECTORY: ".unused-live-failure-state",
    } as const;
    const previous = Object.fromEntries(
      Object.keys(environment).map((name) => [name, process.env[name]]),
    );
    for (const [name, value] of Object.entries(environment)) process.env[name] = value;
    let closeCalls = 0;
    let caught: unknown;
    try {
      await createPactAgentRuntimeFromEnv(() => ({
        relay,
        cashu,
        privateStore: shared.privateStore,
        identities: fixture.identities,
        dependencies,
        close: () => {
          closeCalls += 1;
        },
      }));
    } catch (error) {
      caught = error;
    } finally {
      for (const name of Object.keys(environment)) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(caught).toBeInstanceOf(Error);
    expect(relay.connectCalls).toBe(1);
    expect(relay.disconnectCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(toApiError(caught)).toEqual({ error: "Internal error", code: "internal_error" });
    expect(JSON.stringify(toApiError(caught))).not.toContain(privateMarker);
  });

  it("persists the transaction identity before publishing the agreement root", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const expectedTransactionId = transactionId("identity-boundary-0001");
    const relay = new InspectingRootRelay(async (event) => {
      const stored = await shared.privateStore.read("transaction", expectedTransactionId) as {
        phase?: string;
        agreementId?: string;
      } | undefined;
      expect(stored).toMatchObject({ phase: "initialized" });
      expect(event.content).toContain(stored!.agreementId!);
    });
    relay.events.push(...fixture.referenceEvents);
    const { runtime } = buildRuntime(fixture, shared, { relay });
    await runtime.start();
    await runtime.startTransaction(startInput("identity-boundary-0001"));
    await runtime.shutdown();
  }, 30_000);

  it("resumes the original agreement when only the pre-effect identity survived", async () => {
    const fixture = buildFixture();
    const base = createInMemoryCashuPrivateStore();
    let transactionWrites = 0;
    let blockCheckpoints = true;
    const privateStore: CashuPrivateStore = {
      read: (scope, key) => base.read(scope, key),
      async write(scope, key, value) {
        if (scope === "transaction") {
          transactionWrites += 1;
          if (blockCheckpoints && transactionWrites > 1) {
            throw new Error("simulated hard-stop checkpoint loss");
          }
        }
        await base.write(scope, key, value);
      },
      withExclusiveLock: (scope, key, operation) => base.withExclusiveLock(scope, key, operation),
    };
    const shared = {
      privateStore,
      settlementStore: createInMemoryPactCashuEscrowSettlementStore(),
    };
    const first = buildRuntime(fixture, shared);
    await first.runtime.start();
    await expect(
      first.runtime.startTransaction(startInput("hard-stop-identity")),
    ).rejects.toThrow("simulated hard-stop checkpoint loss");
    const durable = await base.read("transaction", transactionId("hard-stop-identity")) as {
      phase?: string;
      agreementId?: string;
    };
    expect(durable.phase).toBe("initialized");
    await first.runtime.shutdown();

    blockCheckpoints = false;
    const relay = new MemoryRelay();
    relay.events.push(...first.relay.events);
    const restartedCashu = new FakeCashuPort();
    const restarted = buildRuntime(fixture, shared, { relay, cashu: restartedCashu }).runtime;
    await restarted.start();
    const report = await restarted.resume(transactionId("hard-stop-identity"));
    expect(report.agreementId).toBe(durable.agreementId);
    expect(report.finalOutcome).toBe("settled");
    expect(restartedCashu.prepareCalls).toBe(1);
    expect(restartedCashu.spendCalls).toBe(1);
    await restarted.shutdown();
  }, 30_000);

  it("isolates two different transactions", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const { runtime } = buildRuntime(fixture, shared);
    await runtime.start();
    const a = await runtime.startTransaction(startInput("idempotent-key-000a"));
    const b = await runtime.startTransaction(startInput("idempotent-key-000b"));
    expect(a.transactionId).not.toBe(b.transactionId);
    expect(a.report.agreementRootEventId).not.toBe(b.report.agreementRootEventId);
    await runtime.shutdown();
  }, 30_000);

  it("serializes concurrent start and idempotent identity into one transaction", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const { runtime, cashu } = buildRuntime(fixture, shared);
    await runtime.start();
    const input = startInput();
    const [a, b] = await Promise.all([
      runtime.startTransaction(input),
      runtime.startTransaction(input),
    ]);
    expect(a.transactionId).toBe(b.transactionId);
    expect(a.report.agreementRootEventId).toBe(b.report.agreementRootEventId);
    expect(cashu.prepareCalls).toBe(1);
    expect(cashu.spendCalls).toBe(1);
    await runtime.shutdown();
  }, 30_000);

  it("restart after funding reconstructs the same agreement without funding again", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();

    const relayA = new FailingTransitionRelay("task_delivered");
    relayA.events.push(...fixture.referenceEvents);
    const cashuA = new FakeCashuPort();
    const first = buildRuntime(fixture, shared, { relay: relayA, cashu: cashuA });
    const runtimeA = first.runtime;
    await runtimeA.start();
    await expect(runtimeA.startTransaction(startInput())).rejects.toThrow("Task delivered transition failed");
    expect(cashuA.prepareCalls).toBe(1);
    expect(cashuA.spendCalls).toBe(0);
    await runtimeA.shutdown();

    const relayB = new MemoryRelay();
    relayB.events.push(...relayA.events);
    const cashuB = new FakeCashuPort();
    const runtimeB = buildRuntime(fixture, shared, { relay: relayB, cashu: cashuB }).runtime;
    await runtimeB.start();
    const report = await runtimeB.resume(transactionId("idempotent-key-0001"));
    expect(report.finalOutcome).toBe("settled");
    expect(cashuB.prepareCalls).toBe(0);
    expect(cashuB.spendCalls).toBe(1);
    await expect(runtimeB.status(transactionId("idempotent-key-0001"))).resolves.toMatchObject({
      phase: "settled",
      finalOutcome: "settled",
    });
    await expect(runtimeB.report(transactionId("idempotent-key-0001"))).resolves.toMatchObject({
      finalOutcome: "settled",
    });
    await runtimeB.shutdown();

    const relayC = new MemoryRelay();
    relayC.events.push(...relayB.events);
    const cashuC = new FakeCashuPort();
    const runtimeC = buildRuntime(fixture, shared, { relay: relayC, cashu: cashuC }).runtime;
    await runtimeC.start();
    await expect(runtimeC.resume(transactionId("idempotent-key-0001"))).resolves.toMatchObject({
      finalOutcome: "settled",
    });
    expect(cashuC.prepareCalls).toBe(0);
    expect(cashuC.spendCalls).toBe(0);
    await runtimeC.shutdown();
  }, 30_000);

  it("reconcile rejects an accepted transaction with no existing escrow or Cashu attempt", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const relayA = new MemoryRelay();
    relayA.events.push(...fixture.referenceEvents);
    const failingCashu = new FakeCashuPort();
    failingCashu.capabilitiesFail = true;
    const runtimeA = buildRuntime(fixture, shared, { relay: relayA, cashu: failingCashu }).runtime;
    await runtimeA.start();
    await expect(runtimeA.startTransaction(startInput("reconcile-no-economic"))).rejects.toThrow();
    expect(failingCashu.prepareCalls).toBe(0);
    await runtimeA.shutdown();

    const relayB = new MemoryRelay();
    relayB.events.push(...relayA.events);
    const cashuB = new FakeCashuPort();
    const runtimeB = buildRuntime(fixture, shared, { relay: relayB, cashu: cashuB }).runtime;
    await runtimeB.start();
    await expect(runtimeB.reconcile(transactionId("reconcile-no-economic"))).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(cashuB.prepareCalls).toBe(0);
    expect(cashuB.spendCalls).toBe(0);
    await runtimeB.shutdown();
  }, 30_000);

  it("restart after successful release does not spend twice", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const { runtime, relay, cashu } = buildRuntime(fixture, shared);
    await runtime.start();
    const started = await runtime.startTransaction(startInput());
    expect(started.report.finalOutcome).toBe("settled");
    expect(cashu.spendCalls).toBe(1);
    await runtime.shutdown();

    const relayB = new MemoryRelay();
    relayB.events.push(...relay.events);
    const cashuB = new FakeCashuPort();
    const runtimeB = buildRuntime(fixture, shared, { relay: relayB, cashu: cashuB }).runtime;
    await runtimeB.start();
    const report = await runtimeB.resume(started.transactionId);
    expect(report.finalOutcome).toBe("settled");
    expect(cashuB.spendCalls).toBe(0);
    await runtimeB.shutdown();
  }, 30_000);

  it("persists a restart-stable requester decision projection and supports a future model source", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const first = buildRuntime(fixture, shared, { requesterDecisionSource: "deterministic" });
    await first.runtime.start();
    const started = await first.runtime.startTransaction(startInput("decision-projection-restart"));
    const before = await first.runtime.status(started.transactionId);
    expect(before.requesterDecision).toMatchObject({
      source: "deterministic",
      recommendation: {
        action: "recommend",
        providerPublicKey: fixture.selectedReferences.providerPublicKey,
        offerReference: fixture.selectedReferences.offerReference,
        amountSats: "350",
      },
      policy: {
        selectedProviderMatchesDiscovery: true,
        stableReferencesMatch: true,
        withinRequesterBudget: true,
        cashuCompatible: true,
        priceAllowed: true,
        executionDurationAllowed: true,
      },
      authorized: true,
    });
    await first.runtime.shutdown();

    const relay = new MemoryRelay();
    relay.events.push(...first.relay.events);
    const restarted = buildRuntime(fixture, shared, {
      relay,
      requesterDecisionSource: "model",
    }).runtime;
    await restarted.start();
    const after = await restarted.status(started.transactionId);
    expect(after.requesterDecision).toEqual(before.requesterDecision);
    await restarted.shutdown();

    const modelShared = sharedStores();
    const modelRuntime = buildRuntime(fixture, modelShared, {
      requesterDecisionSource: "model",
    }).runtime;
    await modelRuntime.start();
    const modelTransaction = await modelRuntime.startTransaction(startInput("decision-projection-model"));
    expect((await modelRuntime.status(modelTransaction.transactionId)).requesterDecision?.source).toBe("model");
    await modelRuntime.shutdown();
  }, 60_000);

  it("uses the canonical root timestamp for a stable authority source across restart", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const { runtime, relay } = buildRuntime(fixture, shared);
    await runtime.start();
    const started = await runtime.startTransaction(startInput("canonical-authority-source"));
    await runtime.shutdown();

    const rootEvent = relay.events.find((event) => event.id === started.report.agreementRootEventId)!;
    const root = validatePactServiceAgreementRoot(rootEvent, fixture.references);
    const canonicalSource = createPactEscrowAuthoritySource({
      root,
      references: fixture.references,
      authority: fixture.identities.escrowAuthoritySigner.publicKey,
      createdAt: root.event.created_at + 1,
    });
    const signedCanonicalSource = await fixture.identities.providerSigner.sign(canonicalSource.event);
    const binding = (await shared.settlementStore.read(
      `agreement-escrow:${root.event.id}`,
    )) as { escrowReference: string };
    const beforeRestart = (await shared.settlementStore.read(
      `escrow:${binding.escrowReference}`,
    )) as { escrowAuthoritySource: string };
    expect(canonicalSource.event.created_at).toBe(root.event.created_at + 1);
    expect(beforeRestart.escrowAuthoritySource).toBe(signedCanonicalSource.id);

    const relayAfterRestart = new MemoryRelay();
    relayAfterRestart.events.push(...relay.events);
    const restarted = buildRuntime(fixture, shared, { relay: relayAfterRestart }).runtime;
    await restarted.start();
    await expect(restarted.resume(started.transactionId)).resolves.toMatchObject({
      finalOutcome: "settled",
    });
    const afterRestart = (await shared.settlementStore.read(
      `escrow:${binding.escrowReference}`,
    )) as { escrowAuthoritySource: string };
    expect(afterRestart.escrowAuthoritySource).toBe(signedCanonicalSource.id);
    await restarted.shutdown();
  }, 30_000);

  it("reconstructs an exact valid legacy authority source before funding reconciliation", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const relay = new MemoryRelay();
    relay.events.push(...fixture.referenceEvents);
    const firstCashu = ambiguousFundingCashu();
    const first = buildRuntime(fixture, shared, { relay, cashu: firstCashu }).runtime;
    await first.start();
    const transaction = transactionId("legacy-authority-source");
    await expect(first.startTransaction(startInput("legacy-authority-source"))).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    await first.shutdown();

    const rootEvent = relay.events.find((event) =>
      event.tags.some((tag) => tag[0] === "t" && tag[1] === PACT_SERVICE_AGREEMENT_ROOT_TYPE),
    )!;
    const root = validatePactServiceAgreementRoot(rootEvent, fixture.references);
    const legacySource = createPactEscrowAuthoritySource({
      root,
      references: fixture.references,
      authority: fixture.identities.escrowAuthoritySigner.publicKey,
      createdAt: root.event.created_at + 4,
    });
    const signedLegacySource = await fixture.identities.providerSigner.sign(legacySource.event);
    await replaceEscrowAuthoritySource(shared.settlementStore, root.event.id, signedLegacySource.id);

    const relayAfterRestart = new MemoryRelay();
    relayAfterRestart.events.push(...relay.events);
    const recoveryCashu = ambiguousFundingCashu();
    const restarted = buildRuntime(fixture, shared, {
      relay: relayAfterRestart,
      cashu: recoveryCashu,
    }).runtime;
    await restarted.start();
    await expect(restarted.reconcile(transaction)).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    expect(recoveryCashu.prepareCalls).toBe(1);
    await restarted.shutdown();
  }, 30_000);

  it("rejects a persisted authority source bound to a different authority", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const relay = new MemoryRelay();
    relay.events.push(...fixture.referenceEvents);
    const first = buildRuntime(fixture, shared, {
      relay,
      cashu: ambiguousFundingCashu(),
    }).runtime;
    await first.start();
    const transaction = transactionId("mismatched-authority-source");
    await expect(first.startTransaction(startInput("mismatched-authority-source"))).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    await first.shutdown();

    const rootEvent = relay.events.find((event) =>
      event.tags.some((tag) => tag[0] === "t" && tag[1] === PACT_SERVICE_AGREEMENT_ROOT_TYPE),
    )!;
    const root = validatePactServiceAgreementRoot(rootEvent, fixture.references);
    const mismatchedSource = createPactEscrowAuthoritySource({
      root,
      references: fixture.references,
      authority: nostrPublicKey(getPublicKey(key(44))),
      createdAt: root.event.created_at + 4,
    });
    const signedMismatch = await fixture.identities.providerSigner.sign(mismatchedSource.event);
    await replaceEscrowAuthoritySource(shared.settlementStore, root.event.id, signedMismatch.id);

    const relayAfterRestart = new MemoryRelay();
    relayAfterRestart.events.push(...relay.events);
    const recoveryCashu = ambiguousFundingCashu();
    const restarted = buildRuntime(fixture, shared, {
      relay: relayAfterRestart,
      cashu: recoveryCashu,
    }).runtime;
    await restarted.start();
    await expect(restarted.reconcile(transaction)).rejects.toMatchObject({
      code: "corrupt_record",
    });
    expect(recoveryCashu.prepareCalls).toBe(0);
    await restarted.shutdown();
  }, 30_000);

  it("ambiguous release reconciles the exact original operation without a second spend", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();

    const relayA = new MemoryRelay();
    relayA.events.push(...fixture.referenceEvents);
    const cashuA = new FakeCashuPort();
    cashuA.reconciliationSpend = true;
    const first = buildRuntime(fixture, shared, { relay: relayA, cashu: cashuA });
    const runtimeA = first.runtime;
    await runtimeA.start();
    await expect(runtimeA.startTransaction(startInput())).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    const original = cashuA.spendOperationIds;
    expect(original).toHaveLength(1);
    first.clock.advanceTo(ROOT_TIME + 1_000);
    expect(await runtimeA.status(transactionId("idempotent-key-0001"))).toMatchObject({
      operationalState: "reconciliation_required",
      availableActions: { resume: false, reconcile: true },
    });
    await runtimeA.shutdown();

    const relayB = new MemoryRelay();
    relayB.events.push(...relayA.events);
    const cashuB = new FakeCashuPort();
    cashuB.reconciliationSpend = true;
    const runtimeB = buildRuntime(fixture, shared, { relay: relayB, cashu: cashuB }).runtime;
    await runtimeB.start();
    await expect(runtimeB.resume(transactionId("idempotent-key-0001"))).rejects.toMatchObject({
      code: "reconciliation_required",
    });

    // The resume must reconcile the exact original economic operation — same
    // operation id, submitted exactly once total, never a second distinct spend.
    expect(cashuB.spendOperationIds).toEqual(original);
    expect(new Set([...cashuA.spendOperationIds, ...cashuB.spendOperationIds]).size).toBe(1);

    const status = await runtimeB.status(transactionId("idempotent-key-0001"));
    expect(status.finalOutcome).toBeUndefined();
    expect(status.phase).not.toBe("settled");
    await runtimeB.shutdown();
  }, 30_000);

  it("serializes concurrent resume and reconcile for one interrupted economic operation", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const relay = new MemoryRelay();
    relay.events.push(...fixture.referenceEvents);
    const cashu = new FakeCashuPort();
    cashu.reconciliationSpend = true;
    const runtime = buildRuntime(fixture, shared, { relay, cashu }).runtime;
    await runtime.start();
    await expect(runtime.startTransaction(startInput("concurrent-recovery-0001")))
      .rejects.toMatchObject({ code: "reconciliation_required" });
    expect(cashu.prepareSubmissions).toBe(1);
    expect(cashu.spendSubmissions).toBe(1);

    cashu.reconciliationSpend = false;
    cashu.recoverAmbiguousSpend = true;
    const transaction = transactionId("concurrent-recovery-0001");
    const [resumed, reconciled] = await Promise.all([
      runtime.resume(transaction),
      runtime.reconcile(transaction),
    ]);

    expect(resumed.finalOutcome).toBe("settled");
    expect(reconciled.finalOutcome).toBe("settled");
    expect(reconciled.agreementRootEventId).toBe(resumed.agreementRootEventId);
    if (!("lifecycle" in reconciled)) throw new Error("expected terminal reconciliation report");
    expect(reconciled.lifecycle).toEqual(resumed.lifecycle);
    expect(cashu.prepareSubmissions).toBe(1);
    expect(cashu.spendSubmissions).toBe(1);
    expect(cashu.spendCalls).toBe(2);
    expect(
      relay.events.filter((event) =>
        event.tags.some(
          (tag) => tag[0] === "t" && tag[1] === PACT_SERVICE_AGREEMENT_ROOT_TYPE,
        ),
      ),
    ).toHaveLength(1);
    for (const transition of resumed.lifecycle) {
      expect(relay.events.filter((event) => event.id === transition.eventId)).toHaveLength(1);
    }
    await runtime.shutdown();
  }, 30_000);

  it("fails closed on a corrupted persisted record", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const { runtime } = buildRuntime(fixture, shared);
    await runtime.start();
    await shared.privateStore.write("transaction", "txn_bad", { version: 1, phase: "not-a-phase" });
    await expect(runtime.resume("txn_bad")).rejects.toBeInstanceOf(PactAgentRuntimeError);
    await runtime.shutdown();
  }, 30_000);

  it("terminal transaction returns the existing outcome idempotently", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const { runtime, cashu } = buildRuntime(fixture, shared);
    await runtime.start();
    const started = await runtime.startTransaction(startInput());
    const resumed = await runtime.resume(started.transactionId);
    expect(resumed.finalOutcome).toBe("settled");
    expect(resumed.agreementRootEventId).toBe(started.report.agreementRootEventId);
    expect(cashu.spendCalls).toBe(1);
    await runtime.shutdown();
  }, 30_000);

  it("exposes no recovery actions for a refunded terminal transaction", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const { runtime } = buildRuntime(fixture, shared);
    await runtime.start();
    const started = await runtime.startTransaction(startInput("refunded-action-projection"));
    const raw = await shared.privateStore.read("transaction", started.transactionId) as Record<string, unknown>;
    const refunded: Record<string, unknown> = {
      ...raw,
      kind: "refund",
      phase: "refunded",
      refundReference: "refund-safe-reference",
    };
    delete refunded.settlementReference;
    delete refunded.resultReference;
    await shared.privateStore.write("transaction", started.transactionId, refunded);
    expect(await runtime.status(started.transactionId)).toMatchObject({
      operationalState: "refunded",
      finalOutcome: "refunded",
      availableActions: { resume: false, reconcile: false },
      resultAvailable: false,
      reportAvailable: true,
    });
    await runtime.shutdown();
  }, 30_000);

  it("startup and shutdown connect and disconnect the relay exactly once", async () => {
    const fixture = buildFixture();
    const shared = sharedStores();
    const relay = new MemoryRelay();
    relay.events.push(...fixture.referenceEvents);
    const { runtime } = buildRuntime(fixture, shared, { relay });
    await runtime.start();
    expect(relay.connectCalls).toBe(1);
    await runtime.shutdown();
    expect(relay.disconnectCalls).toBe(1);
    await expect(runtime.startTransaction(startInput())).rejects.toMatchObject({ code: "not_running" });
  }, 30_000);
});
