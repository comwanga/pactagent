import { createHash } from "node:crypto";
import { deserializeProofs } from "@cashu/cashu-ts";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

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
import type { PactAgreementReferences } from "../domain/pact-service-agreement";
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
import type { PactAgentRuntimeConfig } from "./pactagent-runtime";
import {
  DeterministicPactAgentClock,
  type PactAgentParticipantIdentities,
  type PactAgentWorkflowDependencies,
} from "./pactagent-workflow";
import type { RequesterDecisionModel } from "./requester-decision";
import type { SelectedProviderReferences } from "./provider-discovery";

export const ROOT_TIME = 1_900_000_000;
export const MINT_URL = "https://testmint.example/cashu";
export const CURVE_POINT = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

export function key(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

export function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ident(secret: Uint8Array): NostrIdentity {
  return { publicKey: nostrPublicKey(getPublicKey(secret)), relays: ["wss://relay.example"] };
}

export function signEvent(event: UnsignedNostrEvent, secret: Uint8Array): SignedNostrEvent {
  return finalizeEvent({ ...event, tags: event.tags.map((t) => [...t]) }, secret) as unknown as SignedNostrEvent;
}

export function privateFunding() {
  return createPrivateCashuFunding({
    mintUrl: MINT_URL,
    unit: "sat",
    proofs: deserializeProofs([{ id: "00aabb", amount: "400", secret: "PRIVATE-PROOF", C: CURVE_POINT, witness: "PRIVATE-WITNESS" }]),
  });
}

export function transactionId(idempotencyKey: string): string {
  return `txn_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

export function filterMatches(event: SignedNostrEvent, filter: NostrFilter): boolean {
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

export class MemoryRelay implements NostrRelayAdapter {
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

export class FailingTransitionRelay extends MemoryRelay {
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

export class FakeCashuPort implements CashuTestMintPort {
  private readonly outcomes = new Map<string, CashuMutationResult>();
  prepareCalls = 0;
  spendCalls = 0;
  readonly spendOperationIds: string[] = [];
  reconciliationSpend = false;

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
    this.spendOperationIds.push(input.operationId);
    const prior = this.outcomes.get(input.operationId);
    if (prior?.status === "succeeded") return prior;
    if (this.reconciliationSpend && !this.outcomes.has(input.operationId)) {
      return { status: "submitted_unknown", outcome: "reconciliation_required", operationId: input.operationId };
    }
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

export class FakePrivateDelivery implements CashuPrivateValueDeliveryPort {
  async deliver(input: Parameters<CashuPrivateValueDeliveryPort["deliver"]>[0]): Promise<CashuPrivateDeliveryResult> {
    return { status: "delivered", deliveryId: input.deliveryId, beneficiary: input.expectedBeneficiary };
  }
}

export class ApprovingDecisionModel implements RequesterDecisionModel {
  constructor(private readonly recommendation: unknown) {}
  async recommend(): Promise<unknown> {
    return this.recommendation;
  }
}

export interface RuntimeFixture {
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

export function buildFixture(): RuntimeFixture {
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

export interface SharedStores {
  privateStore: CashuPrivateStore;
  settlementStore: PactCashuEscrowSettlementStore;
}

export function sharedStores(): SharedStores {
  return {
    privateStore: createInMemoryCashuPrivateStore(),
    settlementStore: createInMemoryPactCashuEscrowSettlementStore(),
  };
}

export interface BuiltRuntime {
  config: PactAgentRuntimeConfig;
  relay: MemoryRelay;
  cashu: FakeCashuPort;
}

export function buildRuntimeConfig(
  fixture: RuntimeFixture,
  shared: SharedStores,
  options: { relay?: MemoryRelay; cashu?: FakeCashuPort } = {},
): BuiltRuntime {
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
  const config: PactAgentRuntimeConfig = {
    identities: fixture.identities,
    dependencies,
    privateStore: shared.privateStore,
    references: fixture.references,
    selectedReferences: fixture.selectedReferences,
    resolveFunding: async (reference) => {
      if (reference !== "funding-reference-0001") throw new Error("Unknown funding reference");
      return privateFunding();
    },
  };
  return { config, relay, cashu };
}

export function startInput(idempotencyKey = "idempotent-key-0001") {
  return {
    idempotencyKey,
    fundingReference: "funding-reference-0001",
    privateDocument: "PRIVATE-DOCUMENT Runtime transaction document about Bitcoin.",
    mediaType: "text/plain" as const,
    privatePrompt: "PRIVATE-PROMPT Summarize.",
    maximumBudgetSats: sats(500n),
  };
}
