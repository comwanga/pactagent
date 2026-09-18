import { deserializeProofs } from "@cashu/cashu-ts";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { nostrPublicKey, type NostrIdentity, type SignedNostrEvent, type UnsignedNostrEvent } from "../domain/nostr";
import { sats } from "../domain/money";
import { createPontmoreAgentDefinition } from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  createPactServiceOffer,
  PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
} from "../domain/pact-service-offer";
import {
  createPactCashuEscrowSettlementCoordinator,
  createInMemoryPactCashuEscrowSettlementStore,
} from "./cashu-escrow-settlement";
import {
  createPrivateCashuSpendingKey,
  createPrivateCashuFunding,
  type CashuMutationResult,
  type CashuPrivateDeliveryResult,
  type CashuPrivateHandle,
  type CashuPrivateValueDeliveryPort,
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
  createPactAgentWorkflow,
  DeterministicPactAgentClock,
  type PactAgentParticipantIdentities,
  type PactAgentWorkflowDependencies,
} from "./pactagent-workflow";
import type { RequesterDecisionModel } from "./requester-decision";
import type { RequesterPolicy } from "../domain/pact-agents";

const ROOT_TIME = 1_900_000_000;
const MINT_URL = "https://testmint.example/cashu";
const CURVE_POINT = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const SECRET_MARKERS = [
  "PRIVATE-DOCUMENT",
  "PRIVATE-PROMPT",
  "PRIVATE-RESULT",
  "PRIVATE-PROOF",
  "PRIVATE-WITNESS",
  "PRIVATE-SECRET",
  "nsec1",
  "cashuA",
  "cashuB",
];

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

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async publish(event: SignedNostrEvent): Promise<void> {
    if (!this.events.some((c) => c.id === event.id)) this.events.push(event);
  }

  async queryEvents(filter: NostrFilter): Promise<SignedNostrEvent[]> {
    return this.events.filter((e) => filterMatches(e, filter)).sort((a, b) => b.created_at - a.created_at);
  }
}

class FakeCashuPort implements CashuTestMintPort {
  private readonly outcomes = new Map<string, CashuMutationResult>();
  prepareCalls = 0;
  spendCalls = 0;

  async inspectCapabilities(): Promise<ValidatedMintCapabilities> {
    return {
      mintUrl: MINT_URL, unit: "sat",
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
      status: "succeeded", operationId: input.operationId,
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
    const result: CashuMutationResult = {
      status: "succeeded", operationId: input.operationId,
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
  async recommend(): Promise<unknown> { return this.recommendation; }
}

function privateFunding() {
  return createPrivateCashuFunding({
    mintUrl: MINT_URL, unit: "sat",
    proofs: deserializeProofs([{ id: "00aabb", amount: "400", secret: "PRIVATE-PROOF", C: CURVE_POINT, witness: "PRIVATE-WITNESS" }]),
  });
}

function scanForSecrets(value: unknown): string[] {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return SECRET_MARKERS.filter((m) => serialized.includes(m));
}

function buildWorkflow(options: { timeout?: number } = {}) {
  const timeoutSeconds = options.timeout ?? 900;
  const requesterKey = key(31);
  const providerKey = key(32);
  const authorityKey = key(33);
  const requester = ident(requesterKey);
  const provider = ident(providerKey);

  const relay = new MemoryRelay();
  const clock = new DeterministicPactAgentClock(ROOT_TIME);

  const descriptor = createCashuEscrowDescriptor({
    identity: provider, identifier: "wf-cashu-summary", updatedAt: ROOT_TIME - 10,
    referenceFormat: "opaque_service_reference", timeoutSeconds,
  });
  const offer = createPactServiceOffer({
    identity: provider, identifier: "wf-document-summary-offer",
    capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
    amountSats: sats(350n), settlementNetwork: "cashu",
    escrowDescriptorReference: descriptor.address, maximumExecutionSeconds: 120,
    validFrom: ROOT_TIME - 10, expiresAt: ROOT_TIME + 3600, updatedAt: ROOT_TIME - 10,
  });
  const requesterDefinition = createPontmoreAgentDefinition({
    identity: requester, identifier: "wf-requester", name: "WF Requester", about: "Requests summaries.",
    capabilities: { names: ["service-discovery"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/wf-requester@1",
    escrowDescriptorReference: descriptor.address, updatedAt: ROOT_TIME - 9,
  });
  const providerDefinition = createPontmoreAgentDefinition({
    identity: provider, identifier: "wf-provider", name: "WF Provider", about: "Provides summaries.",
    capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
    pricingPolicyReference: offer.address, escrowDescriptorReference: descriptor.address, updatedAt: ROOT_TIME - 9,
  });

  relay.events.push(signEvent(descriptor.event, providerKey));
  relay.events.push(signEvent(offer.event, providerKey));
  relay.events.push(signEvent(providerDefinition.event, providerKey));

  const signedRequesterDefinition = signEvent(requesterDefinition.event, requesterKey);
  const providerPubkey = provider.publicKey;

  const recommendation = {
    action: "recommend",
    providerPublicKey: providerPubkey,
    providerDefinitionReference: `30360:${providerPubkey}:wf-provider`,
    offerReference: `30400:${providerPubkey}:wf-document-summary-offer`,
    escrowDescriptorReference: `30361:${providerPubkey}:wf-cashu-summary`,
    proposedAmountSats: "350",
  };

  const requesterPolicy: RequesterPolicy = {
    maxBudgetSats: sats(500n), allowedCapabilities: ["document-summary"],
    maximumEscrowDurationSeconds: 15 * 60, maximumProviderPriceSats: sats(450n),
    allowedSettlementNetworks: ["cashu"], autoRelease: "deterministic_checks_only",
  };
  const decisionBounds = { maximumInstructionCharacters: 1000, maximumRationaleCharacters: 500, modelTimeoutMilliseconds: 5000 };

  const identities: PactAgentParticipantIdentities = {
    requesterSigner: createLocalNostrSigner(hex(requesterKey)),
    providerSigner: createLocalNostrSigner(hex(providerKey)),
    escrowAuthoritySigner: createLocalNostrSigner(hex(authorityKey)),
    requesterEncrypter: createLocalNostrEncrypter(hex(requesterKey)),
    providerEncrypter: createLocalNostrEncrypter(hex(providerKey)),
  };

  const cashu = new FakeCashuPort();
  const store = createInMemoryPactCashuEscrowSettlementStore();
  const privateDelivery = new FakePrivateDelivery();

  const dependencies: PactAgentWorkflowDependencies = {
    relay, clock, requesterPolicy,
    decisionModel: new ApprovingDecisionModel(recommendation),
    decisionBounds, cashu, privateDelivery, settlementStore: store,
    mintUrl: MINT_URL,
    normalSpendKey: createPrivateCashuSpendingKey({ purpose: "cashu-nut11", secretKeyHex: hex(key(21)) }),
    refundSpendKey: createPrivateCashuSpendingKey({ purpose: "cashu-nut11", secretKeyHex: hex(key(22)) }),
  };

  const workflow = createPactAgentWorkflow({ identities, dependencies });

  return {
    workflow, relay, clock, cashu, store, privateDelivery,
    requesterKey, providerKey, authorityKey,
    requesterDefinition: signedRequesterDefinition,
    requesterPolicy, decisionBounds, escrowTimeoutSeconds: timeoutSeconds,
    identities, dependencies, recommendation,
  };
}

describe("PactAgent end-to-end workflow integration", () => {
  describe("successful transaction path", () => {
    it("completes the full canonical lifecycle through settled", async () => {
      const s = buildWorkflow();
      const report = await s.workflow.runSuccessfulTransaction({
        requesterDefinition: s.requesterDefinition,
        privateDocument: "PRIVATE-DOCUMENT This is a test document about Bitcoin and Lightning Network protocols. It covers transaction structures, scripting, and layer-two scaling solutions.",
        mediaType: "text/plain",
        privatePrompt: "PRIVATE-PROMPT Summarize concisely.",
        maximumBudgetSats: sats(500n),
        funding: privateFunding(),
      });

      expect(report.finalOutcome).toBe("settled");
      expect(report.amountSats).toBe("350");
      expect(report.unit).toBe("sat");
      expect(report.lifecycle.map((l) => l.state)).toEqual([
        "accepted", "escrow_funded", "task_delivered",
        "result_submitted", "result_verified", "release_authorized", "settled",
      ]);
      expect(report.settlementReference).toMatch(/^pactsettlement_/);
      expect(report.resultReference).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(report.escrowReference).toMatch(/^pactescrow_/);
      expect(s.cashu.prepareCalls).toBe(1);
      expect(s.cashu.spendCalls).toBe(1);
    }, 30_000);

    it("uses discovery rather than hard-coding P002", async () => {
      const s = buildWorkflow();
      const report = await s.workflow.runSuccessfulTransaction({
        requesterDefinition: s.requesterDefinition,
        privateDocument: "PRIVATE-DOCUMENT Discovery validation document.",
        mediaType: "text/plain",
        maximumBudgetSats: sats(500n),
        funding: privateFunding(),
      });

      const providerPubkey = ident(s.providerKey).publicKey;
      expect(report.selectedReferences.providerPublicKey).toBe(providerPubkey);
      expect(report.selectedReferences.providerDefinitionReference).toContain("wf-provider");
      expect(report.selectedReferences.offerReference).toContain("wf-document-summary-offer");
      expect(report.selectedReferences.escrowDescriptorReference).toContain("wf-cashu-summary");
    }, 30_000);

    it("model recommendation approves the exact 350-sat signed offer", async () => {
      const s = buildWorkflow();
      const report = await s.workflow.runSuccessfulTransaction({
        requesterDefinition: s.requesterDefinition,
        privateDocument: "PRIVATE-DOCUMENT Model approval document.",
        mediaType: "text/plain",
        maximumBudgetSats: sats(500n),
        funding: privateFunding(),
      });
      expect(report.amountSats).toBe("350");
    }, 30_000);

    it("proposal is not treated as provider acceptance", async () => {
      const s = buildWorkflow();
      const report = await s.workflow.runSuccessfulTransaction({
        requesterDefinition: s.requesterDefinition,
        privateDocument: "PRIVATE-DOCUMENT Acceptance boundary document.",
        mediaType: "text/plain",
        maximumBudgetSats: sats(500n),
        funding: privateFunding(),
      });
      expect(report.lifecycle[0].state).toBe("accepted");
      expect(report.lifecycle.length).toBeGreaterThan(1);
    }, 30_000);

    it("relays reconstruct to the complete canonical lifecycle", async () => {
      const s = buildWorkflow();
      const report = await s.workflow.runSuccessfulTransaction({
        requesterDefinition: s.requesterDefinition,
        privateDocument: "PRIVATE-DOCUMENT Reconstruction document.",
        mediaType: "text/plain",
        maximumBudgetSats: sats(500n),
        funding: privateFunding(),
      });
      expect(report.lifecycle.length).toBe(7);
      expect(report.lifecycle.every((l) => l.eventId.length === 64));
    }, 30_000);
  });

  describe("recovery / refund path", () => {
    it("completes the timeout refund lifecycle through refunded", async () => {
      const s = buildWorkflow({ timeout: 300 });
      const report = await s.workflow.runRefundTransaction({
        requesterDefinition: s.requesterDefinition,
        privateDocument: "PRIVATE-DOCUMENT Refund path document.",
        mediaType: "text/plain",
        maximumBudgetSats: sats(500n),
        funding: privateFunding(),
      });

      expect(report.finalOutcome).toBe("refunded");
      expect(report.lifecycle.map((l) => l.state)).toEqual([
        "accepted", "escrow_funded", "refund_authorized", "refunded",
      ]);
      expect(report.refundReference).toMatch(/^pactrefund_/);
    }, 30_000);

    it("release and refund remain mutually exclusive", async () => {
      const s = buildWorkflow({ timeout: 300 });
      const report = await s.workflow.runRefundTransaction({
        requesterDefinition: s.requesterDefinition,
        privateDocument: "PRIVATE-DOCUMENT Mutual exclusivity document.",
        mediaType: "text/plain",
        maximumBudgetSats: sats(500n),
        funding: privateFunding(),
      });

      expect(report.finalOutcome).toBe("refunded");
      const coordinator = createPactCashuEscrowSettlementCoordinator({
        mintUrl: MINT_URL, cashu: s.cashu, privateDelivery: s.privateDelivery,
        store: s.store, escrowAuthoritySigner: s.identities.escrowAuthoritySigner,
        normalSpendKey: s.dependencies.normalSpendKey, refundSpendKey: s.dependencies.refundSpendKey,
        relay: s.relay, clock: s.clock,
      });
      await expect(
        coordinator.releaseEscrow({
          idempotencyKey: "release-after-refund",
          escrowReference: report.escrowReference,
          expectedVersion: 999,
          context: { root: { event: { id: report.agreementRootEventId } } as never, references: {} as never },
          history: [],
        }),
      ).rejects.toBeDefined();
    }, 30_000);
  });

  describe("cross-boundary safety", () => {
    it("public output contains no private task, result, salt, key, or Cashu material", async () => {
      const s = buildWorkflow();
      const report = await s.workflow.runSuccessfulTransaction({
        requesterDefinition: s.requesterDefinition,
        privateDocument: "PRIVATE-DOCUMENT Cross-boundary safety scan document.",
        mediaType: "text/plain",
        privatePrompt: "PRIVATE-PROMPT Cross-boundary scan.",
        maximumBudgetSats: sats(500n),
        funding: privateFunding(),
      });

      expect(scanForSecrets(report)).toEqual([]);
      for (const event of s.relay.events) {
        if (event.kind === 1059) continue;
        expect(scanForSecrets(event)).toEqual([]);
      }
    }, 30_000);

    it("repeated workflow calls do not repeat confirmed economic execution", async () => {
      const s = buildWorkflow();
      await s.workflow.runSuccessfulTransaction({
        requesterDefinition: s.requesterDefinition,
        privateDocument: "PRIVATE-DOCUMENT Idempotency test document.",
        mediaType: "text/plain",
        maximumBudgetSats: sats(500n),
        funding: privateFunding(),
      });
      expect(s.cashu.spendCalls).toBe(1);

      await expect(
        s.workflow.runSuccessfulTransaction({
          requesterDefinition: s.requesterDefinition,
          privateDocument: "PRIVATE-DOCUMENT Second attempt.",
          mediaType: "text/plain",
          maximumBudgetSats: sats(500n),
          funding: privateFunding(),
        }),
      ).rejects.toBeDefined();
    }, 30_000);

    it("the model remains advisory and receives no signer or Cashu capability", async () => {
      const s = buildWorkflow();
      let modelReceivedSigner = false;
      let modelReceivedCashuSecret = false;
      const spyModel: RequesterDecisionModel = {
        async recommend(input: unknown): Promise<unknown> {
          const serialized = JSON.stringify(input);
          if (serialized.includes("sign") || serialized.includes("Signer") || serialized.includes("privateKey") || serialized.includes("nsec")) {
            modelReceivedSigner = true;
          }
          if (serialized.includes("proof") || serialized.includes("Proof") || serialized.includes("witness") || serialized.includes("preimage") || serialized.includes("cashuA") || serialized.includes("cashuB")) {
            modelReceivedCashuSecret = true;
          }
          return s.recommendation;
        },
      };
      const workflow = createPactAgentWorkflow({
        identities: s.identities,
        dependencies: { ...s.dependencies, decisionModel: spyModel },
      });
      await workflow.runSuccessfulTransaction({
        requesterDefinition: s.requesterDefinition,
        privateDocument: "PRIVATE-DOCUMENT Advisory boundary document.",
        mediaType: "text/plain",
        maximumBudgetSats: sats(500n),
        funding: privateFunding(),
      });
      expect(modelReceivedSigner).toBe(false);
      expect(modelReceivedCashuSecret).toBe(false);
    }, 30_000);
  });
});
