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
  DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES,
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
  type PactAgentRuntime,
} from "./pactagent-runtime";
import {
  DeterministicPactAgentClock,
  type PactAgentParticipantIdentities,
  type PactAgentWorkflowDependencies,
} from "./pactagent-workflow";
import type { RequesterDecisionModel } from "./requester-decision";
import type { SelectedProviderReferences } from "./provider-discovery";

const ROOT_TIME = 1_900_000_000;
const MINT_URL = "https://testmint.example/cashu";
const CURVE_POINT = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const NIP59_GIFT_WRAP_KIND = 1059;

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
  reconnectCalls = 0;

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }
  async reconnect(): Promise<void> {
    this.reconnectCalls += 1;
  }
  async disconnect(): Promise<void> {}
  async publish(event: SignedNostrEvent): Promise<void> {
    if (!this.events.some((c) => c.id === event.id)) this.events.push(event);
  }
  async queryEvents(filter: NostrFilter): Promise<SignedNostrEvent[]> {
    return this.events.filter((e) => filterMatches(e, filter)).sort((a, b) => b.created_at - a.created_at);
  }
}

class GiftWrapFailingRelay extends MemoryRelay {
  private failedOnce = false;

  async publish(event: SignedNostrEvent): Promise<void> {
    if (!this.failedOnce && event.kind === NIP59_GIFT_WRAP_KIND) {
      this.failedOnce = true;
      throw new Error("Simulated oversized frame rejection");
    }
    await super.publish(event);
  }
}

class AlwaysGiftWrapFailingRelay extends MemoryRelay {
  async publish(event: SignedNostrEvent): Promise<void> {
    if (event.kind === NIP59_GIFT_WRAP_KIND) {
      throw new Error("Simulated oversized frame rejection");
    }
    await super.publish(event);
  }
}

class FakeCashuPort implements CashuTestMintPort {
  private readonly outcomes = new Map<string, CashuMutationResult>();
  prepareCalls = 0;
  spendCalls = 0;
  spendSubmissions = 0;

  async inspectCapabilities(): Promise<ValidatedMintCapabilities> {
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
    const prior = this.outcomes.get(input.operationId);
    if (prior?.status === "succeeded") return prior;
    this.spendSubmissions += 1;
    const result: CashuMutationResult = {
      status: "succeeded",
      operationId: input.operationId,
      handle: { reference: "cashu_private_22222222-2222-4222-8222-222222222222" },
      changeHandle: { reference: "cashu_private_44444444-4444-4444-8444-444444444444" },
      facts: { mintUrl: MINT_URL, unit: "sat", amountSats: sats(350n), inputAmountSats: sats(351n), outputAmountSats: sats(350n), changeAmountSats: sats(1n), mintFeeSats: sats(0n), reservedSpendFeeSats: sats(0n) },
    };
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

function crashAfterSettlementState(
  store: PactCashuEscrowSettlementStore,
  targetState: "refund_authorized" | "refund_pending" | "refund_confirmed",
): PactCashuEscrowSettlementStore {
  let armed = true;
  return {
    read: (key) => store.read(key),
    insert: (key, value) => store.insert(key, value),
    async compareAndSet(key, expectedRevision, value) {
      const saved = await store.compareAndSet(key, expectedRevision, value);
      if (
        saved &&
        armed &&
        typeof value === "object" &&
        value !== null &&
        "state" in value &&
        value.state === targetState
      ) {
        armed = false;
        throw new Error(`simulated_process_crash_after_${targetState}`);
      }
      return saved;
    },
    withExclusiveLock: (key, operation) => store.withExclusiveLock(key, operation),
  };
}

function crashBeforeTerminalTransactionWrite(store: CashuPrivateStore): CashuPrivateStore {
  let armed = true;
  return {
    read: (scope, key) => store.read(scope, key),
    async write(scope, key, value) {
      if (
        armed &&
        typeof value === "object" &&
        value !== null &&
        "phase" in value &&
        value.phase === "refunded"
      ) {
        armed = false;
        throw new Error("simulated_process_crash_before_terminal_transaction_write");
      }
      await store.write(scope, key, value);
    },
    withExclusiveLock: (scope, key, operation) => store.withExclusiveLock(scope, key, operation),
  };
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
    clock?: DeterministicPactAgentClock;
  } = {},
): RuntimeParts {
  const relay = options.relay ?? new MemoryRelay();
  if (options.relay === undefined) {
    relay.events.push(...fixture.referenceEvents);
  }
  const cashu = options.cashu ?? new FakeCashuPort();
  const clock = options.clock ?? new DeterministicPactAgentClock(ROOT_TIME);
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
    requesterDecisionSource: "deterministic",
    economicMode: "demo",
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

const fixture = buildFixture();

describe("Pre-#37 recovery remediation", () => {
  it("oversized private task fails at the profile boundary BEFORE escrow funding", async () => {
    const shared = sharedStores();
    const { runtime, cashu, relay } = buildRuntime(fixture, shared);

    await runtime.start();
    const largeDoc = "A".repeat(DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES + 1);
    await expect(
      runtime.startTransaction({
        ...startInput("oversized-task-key-001"),
        privateDocument: largeDoc,
      }),
    ).rejects.toMatchObject({ code: "privacy_boundary_violation" });

    expect(cashu.prepareCalls).toBe(0);
    expect(cashu.spendCalls).toBe(0);
    const id = `txn_${createHash("sha256").update("oversized-task-key-001").digest("hex").slice(0, 32)}`;
    const status = await runtime.status(id);
    expect(status.phase).toBe("initialized");
    expect(status.agreementRootEventId).toBeUndefined();
    expect(relay.events.filter((event) => event.kind === NIP59_GIFT_WRAP_KIND)).toHaveLength(0);
    expect(relay.events.some((event) => event.content.includes('"state":"task_delivered"'))).toBe(false);
    await runtime.shutdown();
  });

  it("valid-size task proceeds through preflight to escrow funding", async () => {
    const shared = sharedStores();
    const { runtime, cashu } = buildRuntime(fixture, shared);

    await runtime.start();
    const result = await runtime.startTransaction(startInput("valid-size-task-001"));
    const status = await runtime.status(result.transactionId);
    expect(status.phase).toBe("settled");
    expect(cashu.prepareCalls).toBeGreaterThan(0);
    runtime.shutdown();
  });

  it("funded publication failure leaves transaction failed with resume available before locktime", async () => {
    const shared = sharedStores();
    const relay = new GiftWrapFailingRelay();
    relay.events.push(...fixture.referenceEvents);
    const { runtime } = buildRuntime(fixture, shared, { relay });

    await runtime.start();
    await expect(
      runtime.startTransaction(startInput("pub-fail-task-001")),
    ).rejects.toMatchObject({ code: "private_transport_failed" });

    const id = `txn_${createHash("sha256").update("pub-fail-task-001").digest("hex").slice(0, 32)}`;
    const status = await runtime.status(id);
    expect(status.operationalState).toBe("failed");
    expect(status.availableActions.resume).toBe(true);
    expect(status.availableActions.refund).toBe(false);
    runtime.shutdown();
  });

  it("expired funded escrow does NOT advertise resume and DOES advertise refund", async () => {
    const shared = sharedStores();
    const relay = new GiftWrapFailingRelay();
    relay.events.push(...fixture.referenceEvents);
    const { runtime, clock } = buildRuntime(fixture, shared, { relay });

    await runtime.start();
    await expect(
      runtime.startTransaction(startInput("expired-fund-task-001")),
    ).rejects.toMatchObject({ code: "private_transport_failed" });

    const id = `txn_${createHash("sha256").update("expired-fund-task-001").digest("hex").slice(0, 32)}`;
    clock.advanceTo(ROOT_TIME + 1000);

    const status = await runtime.status(id);
    expect(status.availableActions.resume).toBe(false);
    expect(status.availableActions.refund).toBe(true);
    runtime.shutdown();
  });

  it("timeout refund completes and reaches refunded terminal state", async () => {
    const shared = sharedStores();
    const relay = new GiftWrapFailingRelay();
    relay.events.push(...fixture.referenceEvents);
    const { runtime, clock } = buildRuntime(fixture, shared, { relay });

    await runtime.start();
    await expect(
      runtime.startTransaction(startInput("refund-task-001")),
    ).rejects.toMatchObject({ code: "private_transport_failed" });

    const id = `txn_${createHash("sha256").update("refund-task-001").digest("hex").slice(0, 32)}`;
    clock.advanceTo(ROOT_TIME + 1000);

    const beforeStatus = await runtime.status(id);
    expect(beforeStatus.availableActions.refund).toBe(true);

    const report = await runtime.refund(id);
    expect(report.finalOutcome).toBe("refunded");

    const afterStatus = await runtime.status(id);
    expect(afterStatus.operationalState).toBe("refunded");
    expect(afterStatus.availableActions.resume).toBe(false);
    expect(afterStatus.availableActions.refund).toBe(false);
    expect(afterStatus.reportAvailable).toBe(true);
    runtime.shutdown();
  });

  it("refund is idempotent: second refund returns the same terminal result without re-spending", async () => {
    const shared = sharedStores();
    const relay = new GiftWrapFailingRelay();
    relay.events.push(...fixture.referenceEvents);
    const { runtime, clock, cashu } = buildRuntime(fixture, shared, { relay });

    await runtime.start();
    await expect(
      runtime.startTransaction(startInput("idempotent-refund-001")),
    ).rejects.toMatchObject({ code: "private_transport_failed" });

    const id = `txn_${createHash("sha256").update("idempotent-refund-001").digest("hex").slice(0, 32)}`;
    clock.advanceTo(ROOT_TIME + 1000);

    await runtime.refund(id);
    const spendAfterFirst = cashu.spendCalls;

    const report2 = await runtime.refund(id);
    expect(report2.finalOutcome).toBe("refunded");
    expect(cashu.spendCalls).toBe(spendAfterFirst);

    runtime.shutdown();
  });

  it.each([
    ["refund_authorized", 0],
    ["refund_pending", 0],
    ["refund_confirmed", 1],
  ] as const)(
    "recovers after restart from durable %s without a duplicate economic refund",
    async (crashState, submissionsBeforeRestart) => {
      const privateStore = createInMemoryCashuPrivateStore();
      const durableSettlementStore = createInMemoryPactCashuEscrowSettlementStore();
      const relay = new GiftWrapFailingRelay();
      relay.events.push(...fixture.referenceEvents);
      const cashu = new FakeCashuPort();
      const clock = new DeterministicPactAgentClock(ROOT_TIME);
      const idempotencyKey = `crash-${crashState}-001`;
      const id = `txn_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;

      const first = buildRuntime(
        fixture,
        {
          privateStore,
          settlementStore: crashAfterSettlementState(durableSettlementStore, crashState),
        },
        { relay, cashu, clock },
      );
      await first.runtime.start();
      await expect(first.runtime.startTransaction(startInput(idempotencyKey))).rejects.toMatchObject({
        code: "private_transport_failed",
      });
      clock.advanceTo(ROOT_TIME + 1000);
      await expect(first.runtime.refund(id)).rejects.toMatchObject({ code: "settlement_failed" });
      expect(cashu.spendSubmissions).toBe(submissionsBeforeRestart);

      const interrupted = await first.runtime.status(id);
      expect(interrupted.availableActions).toEqual({ resume: false, reconcile: false, refund: true });
      await first.runtime.shutdown();

      const restarted = buildRuntime(
        fixture,
        { privateStore, settlementStore: durableSettlementStore },
        { relay, cashu, clock },
      );
      await restarted.runtime.start();
      expect((await restarted.runtime.status(id)).availableActions).toEqual({
        resume: false,
        reconcile: false,
        refund: true,
      });
      const report = await restarted.runtime.refund(id);
      expect(report.finalOutcome).toBe("refunded");
      expect(cashu.spendSubmissions).toBe(1);
      expect((await restarted.runtime.status(id)).availableActions).toEqual({
        resume: false,
        reconcile: false,
        refund: false,
      });
      await restarted.runtime.shutdown();
    },
  );

  it("terminalizes after restart when the economic refund completed before the transaction record update", async () => {
    const durablePrivateStore = createInMemoryCashuPrivateStore();
    const settlementStore = createInMemoryPactCashuEscrowSettlementStore();
    const relay = new GiftWrapFailingRelay();
    relay.events.push(...fixture.referenceEvents);
    const cashu = new FakeCashuPort();
    const clock = new DeterministicPactAgentClock(ROOT_TIME);
    const idempotencyKey = "crash-before-refund-terminal-write-001";
    const id = `txn_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;

    const first = buildRuntime(
      fixture,
      {
        privateStore: crashBeforeTerminalTransactionWrite(durablePrivateStore),
        settlementStore,
      },
      { relay, cashu, clock },
    );
    await first.runtime.start();
    await expect(first.runtime.startTransaction(startInput(idempotencyKey))).rejects.toMatchObject({
      code: "private_transport_failed",
    });
    clock.advanceTo(ROOT_TIME + 1000);
    await expect(first.runtime.refund(id)).rejects.toThrow(
      "simulated_process_crash_before_terminal_transaction_write",
    );
    expect(cashu.spendSubmissions).toBe(1);
    expect((await first.runtime.status(id)).availableActions).toEqual({
      resume: false,
      reconcile: false,
      refund: true,
    });
    await first.runtime.shutdown();

    const restarted = buildRuntime(
      fixture,
      { privateStore: durablePrivateStore, settlementStore },
      { relay, cashu, clock },
    );
    await restarted.runtime.start();
    const report = await restarted.runtime.refund(id);
    expect(report.finalOutcome).toBe("refunded");
    expect(cashu.spendSubmissions).toBe(1);
    expect((await restarted.runtime.status(id)).operationalState).toBe("refunded");
    await restarted.runtime.shutdown();
  });

  it("serializes concurrent refunds for one transaction into one economic outcome", async () => {
    const shared = sharedStores();
    const relay = new GiftWrapFailingRelay();
    relay.events.push(...fixture.referenceEvents);
    const { runtime, clock, cashu } = buildRuntime(fixture, shared, { relay });
    const idempotencyKey = "concurrent-refund-one-001";
    const id = `txn_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;

    await runtime.start();
    await expect(runtime.startTransaction(startInput(idempotencyKey))).rejects.toMatchObject({
      code: "private_transport_failed",
    });
    clock.advanceTo(ROOT_TIME + 1000);
    const outcomes = await Promise.all([runtime.refund(id), runtime.refund(id)]);
    expect(outcomes.map((outcome) => outcome.finalOutcome)).toEqual(["refunded", "refunded"]);
    expect(cashu.spendSubmissions).toBe(1);
    await runtime.shutdown();
  });

  it("scopes literal refund idempotency labels independently across transactions", async () => {
    const shared = sharedStores();
    const relay = new AlwaysGiftWrapFailingRelay();
    relay.events.push(...fixture.referenceEvents);
    const { runtime, clock, cashu } = buildRuntime(fixture, shared, { relay });
    const keys = ["independent-refund-a-001", "independent-refund-b-001"] as const;
    const ids = keys.map(
      (idempotencyKey) => `txn_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`,
    );

    await runtime.start();
    for (const idempotencyKey of keys) {
      await expect(runtime.startTransaction(startInput(idempotencyKey))).rejects.toMatchObject({
        code: "private_transport_failed",
      });
    }
    clock.advanceTo(ROOT_TIME + 1000);
    const reports = await Promise.all(ids.map((id) => runtime.refund(id)));
    expect(reports.map((report) => report.finalOutcome)).toEqual(["refunded", "refunded"]);
    expect(cashu.spendSubmissions).toBe(2);
    await runtime.shutdown();
  });

  it("resume is rejected after refund reaches terminal state", async () => {
    const shared = sharedStores();
    const relay = new GiftWrapFailingRelay();
    relay.events.push(...fixture.referenceEvents);
    const { runtime, clock } = buildRuntime(fixture, shared, { relay });

    await runtime.start();
    await expect(
      runtime.startTransaction(startInput("resume-after-refund-001")),
    ).rejects.toMatchObject({ code: "private_transport_failed" });

    const id = `txn_${createHash("sha256").update("resume-after-refund-001").digest("hex").slice(0, 32)}`;
    clock.advanceTo(ROOT_TIME + 1000);

    await runtime.refund(id);

    const resumeReport = await runtime.resume(id);
    expect(resumeReport.finalOutcome).toBe("refunded");
    runtime.shutdown();
  });

  it("refund before locktime is rejected with invalid_request", async () => {
    const shared = sharedStores();
    const relay = new GiftWrapFailingRelay();
    relay.events.push(...fixture.referenceEvents);
    const { runtime } = buildRuntime(fixture, shared, { relay });

    await runtime.start();
    await expect(
      runtime.startTransaction(startInput("early-refund-001")),
    ).rejects.toMatchObject({ code: "private_transport_failed" });

    const id = `txn_${createHash("sha256").update("early-refund-001").digest("hex").slice(0, 32)}`;
    await expect(runtime.refund(id)).rejects.toMatchObject({ code: "invalid_request" });
    runtime.shutdown();
  });

  it("relay reconnect is called during recovery operations", async () => {
    const shared = sharedStores();
    const relay = new GiftWrapFailingRelay();
    relay.events.push(...fixture.referenceEvents);
    const { runtime, clock } = buildRuntime(fixture, shared, { relay });

    await runtime.start();
    await expect(
      runtime.startTransaction(startInput("reconnect-test-001")),
    ).rejects.toMatchObject({ code: "private_transport_failed" });

    const id = `txn_${createHash("sha256").update("reconnect-test-001").digest("hex").slice(0, 32)}`;
    clock.advanceTo(ROOT_TIME + 1000);

    const reconnectCallsBefore = relay.reconnectCalls;
    await runtime.status(id);
    expect(relay.reconnectCalls).toBe(reconnectCallsBefore);

    await runtime.refund(id);
    expect(relay.reconnectCalls).toBeGreaterThan(reconnectCallsBefore);

    runtime.shutdown();
  });

  it("projects the complete authoritative recovery action matrix", async () => {
    const shared = sharedStores();
    const relay = new AlwaysGiftWrapFailingRelay();
    relay.events.push(...fixture.referenceEvents);
    const { runtime, clock } = buildRuntime(fixture, shared, { relay });
    const fundedKey = "action-matrix-funded-001";
    const fundedId = `txn_${createHash("sha256").update(fundedKey).digest("hex").slice(0, 32)}`;

    await runtime.start();
    await expect(runtime.startTransaction(startInput(fundedKey))).rejects.toMatchObject({
      code: "private_transport_failed",
    });
    const fundedStatus = await runtime.status(fundedId);
    const rootId = fundedStatus.agreementRootEventId!;
    const binding = (await shared.settlementStore.read(`agreement-escrow:${rootId}`)) as {
      escrowReference: string;
    };
    const escrowKey = `escrow:${binding.escrowReference}`;
    const originalTransaction = (await shared.privateStore.read("transaction", fundedId)) as Record<string, unknown>;

    const setEscrowState = async (
      state: string,
      operationOverrides: Record<string, unknown> = {},
    ) => {
      const current = (await shared.settlementStore.read(escrowKey)) as {
        revision: number;
        operations: Record<string, unknown>;
        [key: string]: unknown;
      };
      expect(
        await shared.settlementStore.compareAndSet(escrowKey, current.revision, {
          ...current,
          revision: current.revision + 1,
          state,
          operations: { ...current.operations, ...operationOverrides },
        }),
      ).toBe(true);
    };
    const setTransactionPhase = async (phase: string) => {
      const current = (await shared.privateStore.read("transaction", fundedId)) as Record<string, unknown>;
      await shared.privateStore.write("transaction", fundedId, { ...current, phase });
    };
    const expectActions = async (resume: boolean, reconcile: boolean, refund: boolean) => {
      expect((await runtime.status(fundedId)).availableActions).toEqual({ resume, reconcile, refund });
    };

    await setEscrowState("prepared");
    await expectActions(true, false, false);
    await setEscrowState("funded");
    await expectActions(true, false, false);
    await setEscrowState("release_authorized");
    await expectActions(true, false, false);
    await setEscrowState("release_pending");
    await expectActions(true, false, false);
    await setEscrowState("release_confirmed");
    await expectActions(true, false, false);

    clock.advanceTo(ROOT_TIME + 900);
    await setEscrowState("funded");
    await expectActions(false, false, true);
    await setEscrowState("release_authorized");
    await expectActions(false, false, true);

    clock.advanceTo(ROOT_TIME + 901);
    await setEscrowState("funded");
    await expectActions(false, false, true);
    await setEscrowState("release_authorized");
    await expectActions(false, false, true);
    await setEscrowState("release_pending");
    await expectActions(true, false, false);
    await setEscrowState("release_confirmed");
    await expectActions(true, false, false);
    await setEscrowState("refund_authorized");
    await expectActions(false, false, true);
    await setEscrowState("refund_pending");
    await expectActions(false, false, true);
    await setEscrowState("refund_confirmed");
    await expectActions(false, false, true);
    await setEscrowState("refund_reconciliation_required");
    await expectActions(false, true, false);

    await setTransactionPhase("settled");
    await expectActions(false, false, false);
    await setTransactionPhase("refunded");
    await expectActions(false, false, false);

    await shared.privateStore.write("transaction", fundedId, {
      ...originalTransaction,
      phase: "accepted",
    });
    await setEscrowState("prepared", {
      "wf-fund-escrow-001": { type: "fund", fingerprint: "test", status: "failed" },
    });
    await expectActions(false, false, false);

    const noEscrowKey = "action-matrix-no-escrow-001";
    const noEscrowId = `txn_${createHash("sha256").update(noEscrowKey).digest("hex").slice(0, 32)}`;
    await expect(
      runtime.startTransaction({
        ...startInput(noEscrowKey),
        privateDocument: "A".repeat(DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES + 1),
      }),
    ).rejects.toMatchObject({ code: "privacy_boundary_violation" });
    expect((await runtime.status(noEscrowId)).availableActions).toEqual({
      resume: true,
      reconcile: false,
      refund: false,
    });
    clock.advanceTo(ROOT_TIME + 4000);
    expect((await runtime.status(noEscrowId)).availableActions).toEqual({
      resume: false,
      reconcile: false,
      refund: false,
    });
    await runtime.shutdown();
  });
});
