import { deserializeProofs } from "@cashu/cashu-ts";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import { sats } from "../domain/money";
import { nostrPublicKey, type NostrIdentity, type SignedNostrEvent, type UnsignedNostrEvent } from "../domain/nostr";
import { createPontmoreAgentDefinition } from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  DOCUMENT_SUMMARY_PROFILE_ID,
  PactPrivateCommitmentSalt,
  createPactAgreementTransition,
  createPactCompletionDecision,
  createPactEscrowAuthorityBinding,
  createPactEscrowAuthoritySource,
  createPactResultReference,
  createPactServiceAgreementRoot,
  createPactTermsCommitment,
  reconstructPactAgreementHistory,
  validatePactServiceAgreementRoot,
  type PactAgreementContext,
  type PactAgreementReferences,
  type PactAgreementState,
} from "../domain/pact-service-agreement";
import {
  CashuTestMintError,
  PrivateCashuSpendingKey,
  createPrivateCashuFunding,
  createPrivateCashuBeneficiaryDestination,
  createPrivateCashuSpendingKey,
  type CashuPrivateDeliveryResult,
  type CashuMutationResult,
  type CashuPrivateHandle,
  type CashuPrivateValueDeliveryPort,
  type CashuTestMintPort,
  type PrepareLockedValueInput,
  type ProofStateSummary,
  type SpendLockedValueInput,
  type ValidatedMintCapabilities,
} from "./cashu-test-mint";
import {
  PactCashuSettlementError,
  createInMemoryPactCashuEscrowSettlementStore,
  createPactCashuEscrowSettlementCoordinator,
  createSqlitePactCashuEscrowSettlementStore,
  type PactCashuClock,
  type PactCashuEscrowSettlementStore,
} from "./cashu-escrow-settlement";
import type { NostrRelayAdapter } from "./nostr-relay";
import { createLocalNostrSigner } from "./nostr-signer";

const ROOT_TIME = 1_900_000_000;
const MINT_URL = "https://testmint.example/cashu";
const CURVE_POINT =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PRIVATE_FAILURE =
  "cashuA_PRIVATE_TOKEN PRIVATE-PROOF PRIVATE-WITNESS PRIVATE-PREIMAGE PRIVATE-MINT-CREDENTIAL PRIVATE-PAYOUT";

function key(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function identity(secret: Uint8Array): NostrIdentity {
  return { publicKey: nostrPublicKey(getPublicKey(secret)), relays: ["wss://relay.example"] };
}

function sign(event: UnsignedNostrEvent, secret: Uint8Array): SignedNostrEvent {
  return finalizeEvent(
    { ...event, tags: event.tags.map((tag) => [...tag]) },
    secret,
  ) as unknown as SignedNostrEvent;
}

class TestClock implements PactCashuClock {
  constructor(public value: number) {}
  now(): number {
    return this.value;
  }
}

class TestRelay implements NostrRelayAdapter {
  readonly url = "wss://relay.example";
  readonly events: SignedNostrEvent[] = [];
  failures = 0;
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async publish(event: SignedNostrEvent): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("PRIVATE-RELAY-FAILURE");
    }
    if (!this.events.some((candidate) => candidate.id === event.id)) this.events.push(event);
  }
  async queryEvents(): Promise<SignedNostrEvent[]> {
    return [...this.events];
  }
}

class FakeCashuPort implements CashuTestMintPort {
  mintUrl = MINT_URL;
  unit: "sat" | "usd" = "sat";
  capabilityCalls = 0;
  prepareCalls = 0;
  spendCalls = 0;
  spendSubmissions = 0;
  readonly spendPublicKeys: string[] = [];
  prepareModes: Array<"success" | "unknown" | "timeout" | "under" | "over" | "fee_mismatch"> = [];
  spendModes: Array<"success" | "unknown" | "timeout" | "definitive"> = [];
  private readonly outcomes = new Map<string, CashuMutationResult>();
  private readonly ambiguous = new Set<string>();

  async inspectCapabilities(): Promise<ValidatedMintCapabilities> {
    this.capabilityCalls += 1;
    return {
      mintUrl: this.mintUrl,
      unit: this.unit as "sat",
      nuts: {
        nut07ProofState: true,
        nut09Restore: true,
        nut10SpendingConditions: true,
        nut11P2pk: true,
      },
      activeKeyset: { id: "00aabb", inputFeePpk: 1 },
      acceptedKeysetIds: ["00aabb"],
    };
  }

  async prepareLockedValue(input: PrepareLockedValueInput): Promise<CashuMutationResult> {
    this.prepareCalls += 1;
    const prior = this.outcomes.get(input.operationId);
    if (prior?.status === "succeeded") return prior;
    const mode = this.prepareModes.shift() ?? "success";
    if (mode === "timeout") {
      throw new CashuTestMintError("mint_timeout", PRIVATE_FAILURE, "not_submitted");
    }
    if (mode === "unknown") {
      return { status: "submitted_unknown", outcome: "reconciliation_required", operationId: input.operationId };
    }
    const boundAmount = mode === "under" ? 349n : mode === "over" ? 351n : 350n;
    const output = boundAmount + 1n;
    const fee = mode === "fee_mismatch" ? 2n : 1n;
    const change = mode === "fee_mismatch" ? 48n : 400n - output - fee;
    const successful: CashuMutationResult = {
      status: "succeeded",
      operationId: input.operationId,
      handle: { reference: "cashu_private_11111111-1111-4111-8111-111111111111" },
      changeHandle: { reference: "cashu_private_33333333-3333-4333-8333-333333333333" },
      facts: {
        mintUrl: this.mintUrl,
        unit: "sat",
        amountSats: sats(boundAmount),
        inputAmountSats: sats(400n),
        outputAmountSats: sats(output),
        changeAmountSats: sats(change),
        mintFeeSats: sats(fee),
        reservedSpendFeeSats: sats(1n),
      },
    };
    this.outcomes.set(input.operationId, successful);
    return successful;
  }

  async inspectProofState(handle: CashuPrivateHandle): Promise<ProofStateSummary> {
    return {
      handle,
      state: "unspent",
      proofCount: 1,
      unspentCount: 1,
      pendingCount: 0,
      spentCount: 0,
    };
  }

  async spendLockedValue(input: SpendLockedValueInput): Promise<CashuMutationResult> {
    this.spendCalls += 1;
    this.spendPublicKeys.push(input.spendingKey.publicKey);
    const prior = this.outcomes.get(input.operationId);
    if (prior?.status === "succeeded") return prior;
    const reconciling = this.ambiguous.delete(input.operationId);
    const mode = reconciling ? "success" : (this.spendModes.shift() ?? "success");
    if (mode === "timeout") {
      throw new CashuTestMintError("mint_timeout", PRIVATE_FAILURE, "not_submitted");
    }
    if (mode === "definitive") {
      throw new CashuTestMintError("operation_rejected", PRIVATE_FAILURE, "failed_definitively");
    }
    if (mode === "unknown") {
      this.spendSubmissions += 1;
      this.ambiguous.add(input.operationId);
      return { status: "submitted_unknown", outcome: "reconciliation_required", operationId: input.operationId };
    }
    if (!reconciling) this.spendSubmissions += 1;
    const successful: CashuMutationResult = {
      status: "succeeded",
      operationId: input.operationId,
      handle: { reference: "cashu_private_22222222-2222-4222-8222-222222222222" },
      changeHandle: { reference: "cashu_private_44444444-4444-4444-8444-444444444444" },
      facts: {
        mintUrl: this.mintUrl,
        unit: "sat",
        amountSats: sats(350n),
        inputAmountSats: sats(351n),
        outputAmountSats: sats(350n),
        changeAmountSats: sats(1n),
        mintFeeSats: sats(0n),
        reservedSpendFeeSats: sats(0n),
      },
    };
    this.outcomes.set(input.operationId, successful);
    return successful;
  }
}

class FakePrivateDelivery implements CashuPrivateValueDeliveryPort {
  readonly calls: Array<{
    deliveryId: string;
    handle: CashuPrivateHandle;
    expectedBeneficiary: string;
  }> = [];

  async deliver(input: Parameters<CashuPrivateValueDeliveryPort["deliver"]>[0]): Promise<CashuPrivateDeliveryResult> {
    if (input.destination.beneficiary !== input.expectedBeneficiary) {
      throw new CashuTestMintError(
        "operation_rejected",
        "Private Cashu beneficiary is not authorized for this delivery",
      );
    }
    if (!this.calls.some((call) => call.deliveryId === input.deliveryId)) {
      this.calls.push({
        deliveryId: input.deliveryId,
        handle: input.handle,
        expectedBeneficiary: input.expectedBeneficiary,
      });
    }
    return {
      status: "delivered",
      deliveryId: input.deliveryId,
      beneficiary: input.expectedBeneficiary,
    };
  }
}

function fixture(
  options: { amount?: string; timeout?: number; agreementId?: string; identityOffset?: number } = {},
) {
  const offset = options.identityOffset ?? 0;
  const requesterKey = key(11 + offset);
  const providerKey = key(12 + offset);
  const authorityKey = key(13 + offset);
  const requester = identity(requesterKey);
  const provider = identity(providerKey);
  const authority = identity(authorityKey);
  const descriptor = createCashuEscrowDescriptor({
    identity: provider,
    identifier: "cashu-summary",
    updatedAt: ROOT_TIME - 3,
    referenceFormat: "opaque_service_reference",
    timeoutSeconds: options.timeout ?? 900,
  });
  const requesterDefinition = createPontmoreAgentDefinition({
    identity: requester,
    identifier: "requester",
    name: "Requester",
    about: "Requests summaries.",
    capabilities: { names: ["service-discovery"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/requester@1",
    escrowDescriptorReference: descriptor.address,
    updatedAt: ROOT_TIME - 2,
  });
  const providerDefinition = createPontmoreAgentDefinition({
    identity: provider,
    identifier: "provider",
    name: "Provider",
    about: "Provides summaries.",
    capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/provider@1",
    escrowDescriptorReference: descriptor.address,
    updatedAt: ROOT_TIME - 1,
  });
  const references: PactAgreementReferences = {
    requesterDefinition: sign(requesterDefinition.event, requesterKey),
    providerDefinition: sign(providerDefinition.event, providerKey),
    escrowDescriptor: sign(descriptor.event, providerKey),
  };
  const privateTerms = {
    source_document: "PRIVATE-DOCUMENT",
    input_media_type: "text/plain" as const,
    private_prompt: "PRIVATE-PROMPT",
  };
  const privateResult = { summary: "PRIVATE-RESULT" };
  const privateSalt = new PactPrivateCommitmentSalt(new Uint8Array(32).fill(9));
  const commitment = createPactTermsCommitment(DOCUMENT_SUMMARY_PROFILE_ID, privateTerms, privateSalt);
  const draft = createPactServiceAgreementRoot({
    agreementId: options.agreementId ?? "12345678-1234-4234-9234-123456789abc",
    references,
    amountSats: options.amount ?? "350",
    maximumExecutionSeconds: 300,
    expiresAt: ROOT_TIME + 600,
    termsCommitment: commitment,
    createdAt: ROOT_TIME,
  });
  const root = validatePactServiceAgreementRoot(sign(draft.event, requesterKey), references);
  const sourceDraft = createPactEscrowAuthoritySource({
    root,
    references,
    authority: authority.publicKey,
    createdAt: ROOT_TIME + 1,
  });
  const source = sign(sourceDraft.event, providerKey);
  const escrowAuthority = createPactEscrowAuthorityBinding({
    root,
    references,
    authority: authority.publicKey,
    source,
  });
  const context: PactAgreementContext = { root, references, escrowAuthority };
  const history: SignedNostrEvent[] = [];
  append(context, history, "accepted", "provider", providerKey, ROOT_TIME + 2);
  return {
    requesterKey,
    providerKey,
    authorityKey,
    requester,
    provider,
    authority,
    references,
    privateTerms,
    privateResult,
    privateSalt,
    context,
    history,
    locktime: ROOT_TIME + 2 + (options.timeout ?? 900),
  };
}

function append(
  context: PactAgreementContext,
  history: SignedNostrEvent[],
  state: PactAgreementState,
  role: "requester" | "provider" | "escrow",
  secret: Uint8Array,
  createdAt: number,
  options: { reasonCode?: string; resultReference?: string } = {},
): SignedNostrEvent {
  const draft = createPactAgreementTransition({
    context,
    history,
    predecessorEventId: history.at(-1)?.id ?? null,
    nextState: state,
    actor: identity(secret).publicKey,
    actorRole: role,
    reasonCode: options.reasonCode,
    resultReference: options.resultReference,
    createdAt,
  });
  const event = sign(draft.event, secret);
  history.push(event);
  return event;
}

function privateFunding(mintUrl = MINT_URL) {
  return createPrivateCashuFunding({
    mintUrl,
    unit: "sat",
    proofs: deserializeProofs([
      { id: "00aabb", amount: "400", secret: "PRIVATE-PROOF", C: CURVE_POINT, witness: "PRIVATE-WITNESS" },
    ]),
  });
}

function setup(options: { fixture?: ReturnType<typeof fixture>; cashu?: FakeCashuPort; store?: PactCashuEscrowSettlementStore; privateDelivery?: FakePrivateDelivery } = {}) {
  const data = options.fixture ?? fixture();
  const cashu = options.cashu ?? new FakeCashuPort();
  const store = options.store ?? createInMemoryPactCashuEscrowSettlementStore();
  const relay = new TestRelay();
  const clock = new TestClock(ROOT_TIME + 30);
  const normalSpendKey = createPrivateCashuSpendingKey({ purpose: "cashu-nut11", secretKeyHex: hex(key(21)) });
  const refundSpendKey = createPrivateCashuSpendingKey({ purpose: "cashu-nut11", secretKeyHex: hex(key(22)) });
  const privateDelivery = options.privateDelivery ?? new FakePrivateDelivery();
  const escrowAuthoritySigner = createLocalNostrSigner(hex(data.authorityKey));
  const coordinator = createPactCashuEscrowSettlementCoordinator({
    mintUrl: MINT_URL,
    cashu,
    privateDelivery,
    store,
    escrowAuthoritySigner,
    normalSpendKey,
    refundSpendKey,
    relay,
    clock,
  });
  return {
    ...data,
    cashu,
    privateDelivery,
    store,
    relay,
    clock,
    coordinator,
    escrowAuthoritySigner,
    normalSpendKey,
    refundSpendKey,
  };
}

async function prepareAndFund(data: ReturnType<typeof setup>) {
  const prepared = await data.coordinator.prepareEscrow({
    idempotencyKey: "prepare-escrow-1",
    context: data.context,
    history: data.history,
  });
  const funded = await data.coordinator.fundEscrow({
    idempotencyKey: "fund-escrow-001",
    escrowReference: prepared.escrow.escrowReference,
    expectedVersion: prepared.escrow.version,
    context: data.context,
    history: data.history,
    funding: privateFunding(),
  });
  if (funded.outcome === "confirmed") data.history.push(data.relay.events.at(-1)!);
  return { prepared, funded };
}

function advanceReleaseHistory(
  data: ReturnType<typeof setup>,
  releaseAuthorizationCreatedAt?: number,
): {
  context: PactAgreementContext;
  resultReference: string;
} {
  const firstTime = data.history.at(-1)!.created_at + 1;
  append(data.context, data.history, "task_delivered", "provider", data.providerKey, firstTime);
  const resultReference = createPactResultReference(
    DOCUMENT_SUMMARY_PROFILE_ID,
    data.context.root.event.id,
    data.privateResult,
  );
  append(data.context, data.history, "result_submitted", "provider", data.providerKey, firstTime + 1, {
    resultReference,
  });
  const decision = createPactCompletionDecision({
    context: data.context,
    history: data.history,
    privateTerms: data.privateTerms,
    privateSalt: data.privateSalt,
    privateResult: data.privateResult,
  });
  const context = { ...data.context, completionDecisions: [decision] };
  append(context, data.history, "result_verified", "requester", data.requesterKey, firstTime + 2, {
    resultReference,
  });
  append(
    context,
    data.history,
    "release_authorized",
    "requester",
    data.requesterKey,
    releaseAuthorizationCreatedAt ?? firstTime + 3,
  );
  data.clock.value = firstTime + 4;
  return { context, resultReference };
}

describe("PactAgent Cashu escrow settlement coordinator", () => {
  it("completes prepare -> fund -> authorize -> release -> settled", async () => {
    const data = setup();
    const { funded } = await prepareAndFund(data);
    expect(funded.outcome).toBe("confirmed");
    expect(funded.escrow.state).toBe("funded");
    expect(reconstructPactAgreementHistory(data.context, data.history)).toMatchObject({ currentState: "escrow_funded" });

    const release = advanceReleaseHistory(data);
    const authorized = await data.coordinator.submitReleaseAuthorization({
      idempotencyKey: "authorize-release-1",
      escrowReference: funded.escrow.escrowReference,
      expectedVersion: funded.escrow.version,
      context: release.context,
      history: data.history,
      resultReference: release.resultReference,
    });
    const settled = await data.coordinator.releaseEscrow({
      idempotencyKey: "release-escrow-1",
      escrowReference: funded.escrow.escrowReference,
      expectedVersion: authorized.escrow.version,
      context: release.context,
      history: data.history,
    });
    data.history.push(data.relay.events.at(-1)!);

    expect(settled).toMatchObject({ outcome: "confirmed", escrow: { state: "settled", amountSats: "350", unit: "sat" } });
    expect(settled.escrow.settlementReference).toMatch(/^pactsettlement_/);
    expect(data.cashu.prepareCalls).toBe(1);
    expect(data.cashu.spendSubmissions).toBe(1);
    expect(reconstructPactAgreementHistory(release.context, data.history)).toMatchObject({ currentState: "settled" });
    await expect(data.store.read(`escrow:${settled.escrow.escrowReference}`)).resolves.toMatchObject({
      fundingChangeHandle: {
        reference: "cashu_private_33333333-3333-4333-8333-333333333333",
      },
      settlementHandle: {
        reference: "cashu_private_22222222-2222-4222-8222-222222222222",
      },
    });
    expect(JSON.stringify(settled)).not.toContain("cashu_private_");
    await expect(
      data.coordinator.refundEscrow({
        idempotencyKey: "refund-after-release",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: settled.escrow.version,
        context: release.context,
        history: data.history,
      }),
    ).rejects.toMatchObject({ code: "already_released" });
  }, 10_000);

  it("completes prepare -> fund -> timeout authorization -> refund -> refunded", async () => {
    const data = setup();
    const { funded } = await prepareAndFund(data);
    data.clock.value = data.locktime;
    append(data.context, data.history, "refund_authorized", "requester", data.requesterKey, data.locktime, {
      reasonCode: "timeout",
    });
    const authorized = await data.coordinator.submitRefundAuthorization({
      idempotencyKey: "authorize-refund-1",
      escrowReference: funded.escrow.escrowReference,
      expectedVersion: funded.escrow.version,
      context: data.context,
      history: data.history,
      basis: "timeout",
    });
    const refunded = await data.coordinator.refundEscrow({
      idempotencyKey: "refund-escrow-1",
      escrowReference: funded.escrow.escrowReference,
      expectedVersion: authorized.escrow.version,
      context: data.context,
      history: data.history,
    });
    data.history.push(data.relay.events.at(-1)!);
    expect(refunded).toMatchObject({ outcome: "confirmed", escrow: { state: "refunded" } });
    expect(refunded.escrow.refundReference).toMatch(/^pactrefund_/);
    expect(reconstructPactAgreementHistory(data.context, data.history)).toMatchObject({ currentState: "refunded" });
    expect(data.cashu.spendPublicKeys.at(-1)).toBe(data.refundSpendKey.publicKey);
    await expect(data.store.read(`escrow:${refunded.escrow.escrowReference}`)).resolves.toMatchObject({
      refundHandle: {
        reference: "cashu_private_22222222-2222-4222-8222-222222222222",
      },
    });
    expect(JSON.stringify(refunded)).not.toContain("cashu_private_");
  });

  it("recovers and idempotently delivers provider payout plus requester change after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-provider-delivery-"));
    const databasePath = join(directory, "settlement.sqlite");
    let store = createSqlitePactCashuEscrowSettlementStore(databasePath);
    try {
      const data = setup({ store });
      const { funded } = await prepareAndFund(data);
      const release = advanceReleaseHistory(data);
      const authorized = await data.coordinator.submitReleaseAuthorization({
        idempotencyKey: "delivery-release-auth",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: funded.escrow.version,
        context: release.context,
        history: data.history,
        resultReference: release.resultReference,
      });
      const settled = await data.coordinator.releaseEscrow({
        idempotencyKey: "delivery-release-run",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: authorized.escrow.version,
        context: release.context,
        history: data.history,
      });
      store.close();

      store = createSqlitePactCashuEscrowSettlementStore(databasePath);
      const privateDelivery = new FakePrivateDelivery();
      const restarted = createPactCashuEscrowSettlementCoordinator({
        mintUrl: MINT_URL,
        cashu: data.cashu,
        privateDelivery,
        store,
        escrowAuthoritySigner: data.escrowAuthoritySigner,
        normalSpendKey: data.normalSpendKey,
        refundSpendKey: data.refundSpendKey,
        relay: data.relay,
        clock: data.clock,
      });
      const providerDestination = createPrivateCashuBeneficiaryDestination({
        beneficiary: data.provider.publicKey,
        async deliver() {},
      });
      const requesterDestination = createPrivateCashuBeneficiaryDestination({
        beneficiary: data.requester.publicKey,
        async deliver() {},
      });
      const request = {
        idempotencyKey: "deliver-provider-01",
        escrowReference: settled.escrow.escrowReference,
        expectedVersion: settled.escrow.version,
        providerDestination,
        requesterChangeDestination: requesterDestination,
      };
      const delivered = await restarted.deliverProviderPayout(request);
      await expect(restarted.deliverProviderPayout(request)).resolves.toEqual(delivered);
      expect(privateDelivery.calls).toHaveLength(3);
      expect(privateDelivery.calls.map((call) => call.expectedBeneficiary)).toEqual([
        data.provider.publicKey,
        data.requester.publicKey,
        data.requester.publicKey,
      ]);
      expect(privateDelivery.calls[0].handle.reference).not.toBe(
        privateDelivery.calls[1].handle.reference,
      );
      expect(new Set(privateDelivery.calls.map((call) => call.handle.reference)).size).toBe(3);
      expect(JSON.stringify(delivered)).not.toContain("cashu_private_");
      expect(JSON.stringify(delivered)).not.toContain("PRIVATE-");
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("recovers and idempotently delivers requester refund plus change after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-refund-delivery-"));
    const databasePath = join(directory, "settlement.sqlite");
    let store = createSqlitePactCashuEscrowSettlementStore(databasePath);
    try {
      const data = setup({ store });
      const { funded } = await prepareAndFund(data);
      data.clock.value = data.locktime;
      append(data.context, data.history, "refund_authorized", "requester", data.requesterKey, data.locktime, {
        reasonCode: "timeout",
      });
      const authorized = await data.coordinator.submitRefundAuthorization({
        idempotencyKey: "delivery-refund-auth",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: funded.escrow.version,
        context: data.context,
        history: data.history,
        basis: "timeout",
      });
      const refunded = await data.coordinator.refundEscrow({
        idempotencyKey: "delivery-refund-run",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: authorized.escrow.version,
        context: data.context,
        history: data.history,
      });
      store.close();

      store = createSqlitePactCashuEscrowSettlementStore(databasePath);
      const privateDelivery = new FakePrivateDelivery();
      const restarted = createPactCashuEscrowSettlementCoordinator({
        mintUrl: MINT_URL,
        cashu: data.cashu,
        privateDelivery,
        store,
        escrowAuthoritySigner: data.escrowAuthoritySigner,
        normalSpendKey: data.normalSpendKey,
        refundSpendKey: data.refundSpendKey,
        relay: data.relay,
        clock: data.clock,
      });
      const requesterDestination = createPrivateCashuBeneficiaryDestination({
        beneficiary: data.requester.publicKey,
        async deliver() {},
      });
      const request = {
        idempotencyKey: "deliver-refund-001",
        escrowReference: refunded.escrow.escrowReference,
        expectedVersion: refunded.escrow.version,
        requesterDestination,
      };
      const delivered = await restarted.deliverRequesterRefund(request);
      await expect(restarted.deliverRequesterRefund(request)).resolves.toEqual(delivered);
      expect(privateDelivery.calls).toHaveLength(3);
      expect(privateDelivery.calls.every((call) => call.expectedBeneficiary === data.requester.publicKey)).toBe(true);
      expect(privateDelivery.calls[0].handle.reference).not.toBe(
        privateDelivery.calls[1].handle.reference,
      );
      expect(new Set(privateDelivery.calls.map((call) => call.handle.reference)).size).toBe(3);
      expect(JSON.stringify(delivered)).not.toContain("cashu_private_");
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("uses the normal path for a requester-authorized rejected-result refund", async () => {
    const data = setup();
    const { funded } = await prepareAndFund(data);
    const createdAt = data.history.at(-1)!.created_at + 1;
    append(data.context, data.history, "task_delivered", "provider", data.providerKey, createdAt);
    const resultReference = createPactResultReference(
      DOCUMENT_SUMMARY_PROFILE_ID,
      data.context.root.event.id,
      data.privateResult,
    );
    append(data.context, data.history, "result_submitted", "provider", data.providerKey, createdAt + 1, {
      resultReference,
    });
    append(data.context, data.history, "rejected", "requester", data.requesterKey, createdAt + 2, {
      reasonCode: "result_rejected",
    });
    append(data.context, data.history, "refund_authorized", "requester", data.requesterKey, createdAt + 3, {
      reasonCode: "result_rejected",
    });
    data.clock.value = createdAt + 4;
    const authorized = await data.coordinator.submitRefundAuthorization({
      idempotencyKey: "reject-refund-auth",
      escrowReference: funded.escrow.escrowReference,
      expectedVersion: funded.escrow.version,
      context: data.context,
      history: data.history,
      basis: "rejected",
    });
    await expect(
      data.coordinator.refundEscrow({
        idempotencyKey: "reject-refund-run1",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: authorized.escrow.version,
        context: data.context,
        history: data.history,
      }),
    ).resolves.toMatchObject({ outcome: "confirmed", escrow: { state: "refunded" } });
    expect(data.cashu.spendPublicKeys.at(-1)).toBe(data.normalSpendKey.publicKey);
  });

  it("rejects wrong mint, unit, amount, agreement participants, and escrow reference", async () => {
    const wrongMint = new FakeCashuPort();
    wrongMint.mintUrl = "https://other.example";
    await expect(setup({ cashu: wrongMint }).coordinator.prepareEscrow({
      idempotencyKey: "wrong-mint-001",
      context: setup().context,
      history: setup().history,
    })).rejects.toMatchObject({ code: "unsupported_mint_or_unit" });

    const wrongUnit = new FakeCashuPort();
    wrongUnit.unit = "usd";
    const unitData = setup({ cashu: wrongUnit });
    await expect(unitData.coordinator.prepareEscrow({ idempotencyKey: "wrong-unit-001", context: unitData.context, history: unitData.history })).rejects.toMatchObject({ code: "unsupported_mint_or_unit" });

    const amountData = setup({ fixture: fixture({ amount: "349" }) });
    await expect(amountData.coordinator.prepareEscrow({ idempotencyKey: "wrong-amount-01", context: amountData.context, history: amountData.history })).rejects.toMatchObject({ code: "agreement_mismatch" });

    const data = setup();
    const prepared = await data.coordinator.prepareEscrow({ idempotencyKey: "binding-prepare", context: data.context, history: data.history });
    const other = fixture({
      agreementId: "22345678-1234-4234-9234-123456789abc",
      identityOffset: 20,
    });
    await expect(data.coordinator.fundEscrow({ idempotencyKey: "wrong-agreement", escrowReference: prepared.escrow.escrowReference, expectedVersion: prepared.escrow.version, context: other.context, history: other.history, funding: privateFunding() })).rejects.toMatchObject({ code: "agreement_mismatch" });
    const participantMismatch = {
      ...data.context,
      root: {
        ...data.context.root,
        content: { ...data.context.root.content, requester: other.requester.publicKey },
      },
    } as PactAgreementContext;
    await expect(data.coordinator.fundEscrow({ idempotencyKey: "wrong-participant", escrowReference: prepared.escrow.escrowReference, expectedVersion: prepared.escrow.version, context: participantMismatch, history: data.history, funding: privateFunding() })).rejects.toMatchObject({ code: "participant_mismatch" });
    const authorityMismatch = {
      ...data.context,
      escrowAuthority: other.context.escrowAuthority,
    } as PactAgreementContext;
    await expect(data.coordinator.fundEscrow({ idempotencyKey: "wrong-authority1", escrowReference: prepared.escrow.escrowReference, expectedVersion: prepared.escrow.version, context: authorityMismatch, history: data.history, funding: privateFunding() })).rejects.toMatchObject({ code: "unauthorized_operation" });
    await expect(data.coordinator.inspectEscrowStatus("pactescrow_00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("binds one durable opaque escrow instance to each agreement root", async () => {
    const data = setup();
    const first = await data.coordinator.prepareEscrow({
      idempotencyKey: "prepare-binding1",
      context: data.context,
      history: data.history,
    });
    const second = await data.coordinator.prepareEscrow({
      idempotencyKey: "prepare-binding2",
      context: data.context,
      history: data.history,
    });
    expect(second.escrow.escrowReference).toBe(first.escrow.escrowReference);
    expect(second.escrow.agreementRoot).toBe(data.context.root.event.id);
  });

  it.each(["under", "over", "fee_mismatch"] as const)("rejects %s funding accounting", async (mode) => {
    const cashu = new FakeCashuPort();
    cashu.prepareModes.push(mode);
    const data = setup({ cashu });
    const prepared = await data.coordinator.prepareEscrow({ idempotencyKey: `prepare-${mode}`, context: data.context, history: data.history });
    await expect(data.coordinator.fundEscrow({ idempotencyKey: `fund-${mode}-001`, escrowReference: prepared.escrow.escrowReference, expectedVersion: prepared.escrow.version, context: data.context, history: data.history, funding: privateFunding() })).rejects.toMatchObject({ code: "funding_not_confirmed" });
    expect(data.relay.events).toHaveLength(0);
  });

  it("rejects release before funding and wrong, missing, expired, stale, or replayed authorization", async () => {
    const data = setup();
    const prepared = await data.coordinator.prepareEscrow({ idempotencyKey: "prepare-auth-01", context: data.context, history: data.history });
    await expect(data.coordinator.releaseEscrow({ idempotencyKey: "release-early-1", escrowReference: prepared.escrow.escrowReference, expectedVersion: prepared.escrow.version, context: data.context, history: data.history })).rejects.toMatchObject({ code: "completion_not_authorized" });

    const funded = await data.coordinator.fundEscrow({ idempotencyKey: "fund-auth-0001", escrowReference: prepared.escrow.escrowReference, expectedVersion: prepared.escrow.version, context: data.context, history: data.history, funding: privateFunding() });
    data.history.push(data.relay.events.at(-1)!);
    const release = advanceReleaseHistory(data);
    await expect(data.coordinator.submitReleaseAuthorization({ idempotencyKey: "auth-wrong-result", escrowReference: prepared.escrow.escrowReference, expectedVersion: funded.escrow.version, context: release.context, history: data.history, resultReference: `sha256:${"ab".repeat(32)}` })).rejects.toMatchObject({ code: "completion_not_authorized" });

    data.clock.value = data.locktime;
    await expect(data.coordinator.submitReleaseAuthorization({ idempotencyKey: "auth-expired-001", escrowReference: prepared.escrow.escrowReference, expectedVersion: funded.escrow.version, context: release.context, history: data.history, resultReference: release.resultReference })).rejects.toMatchObject({ code: "completion_not_authorized" });
    data.clock.value = data.history.at(-1)!.created_at + 1;
    const authorized = await data.coordinator.submitReleaseAuthorization({ idempotencyKey: "auth-valid-0001", escrowReference: prepared.escrow.escrowReference, expectedVersion: funded.escrow.version, context: release.context, history: data.history, resultReference: release.resultReference });
    await expect(data.coordinator.submitReleaseAuthorization({ idempotencyKey: "auth-replay-0001", escrowReference: prepared.escrow.escrowReference, expectedVersion: authorized.escrow.version, context: release.context, history: data.history, resultReference: release.resultReference })).rejects.toMatchObject({ code: "completion_not_authorized" });
    await expect(data.coordinator.releaseEscrow({ idempotencyKey: "release-stale-01", escrowReference: prepared.escrow.escrowReference, expectedVersion: authorized.escrow.version, context: release.context, history: data.history.slice(0, -1) })).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("rejects wrong signers, forged actor roles, forks, stale predecessors, and terminal histories before Cashu", async () => {
    const data = setup();
    const { funded } = await prepareAndFund(data);
    const release = advanceReleaseHistory(data);
    const unauthorizedDraft = createPactAgreementTransition({
      context: release.context,
      history: data.history.slice(0, -1),
      predecessorEventId: data.history.at(-2)!.id,
      nextState: "release_authorized",
      actor: data.requester.publicKey,
      actorRole: "requester",
      createdAt: data.history.at(-2)!.created_at + 1,
    });
    const wrongIdentity = identity(key(44));
    const wrongContent = {
      ...JSON.parse(unauthorizedDraft.event.content),
      actor: wrongIdentity.publicKey,
      actor_role: "requester",
    };
    const wrongSigned = sign(
      {
        ...unauthorizedDraft.event,
        pubkey: wrongIdentity.publicKey,
        tags: unauthorizedDraft.event.tags.map((tag) =>
          tag[0] === "p" ? ["p", wrongIdentity.publicKey] : tag,
        ),
        content: JSON.stringify(wrongContent),
      },
      key(44),
    );
    await expect(data.coordinator.submitReleaseAuthorization({ idempotencyKey: "wrong-signer-01", escrowReference: funded.escrow.escrowReference, expectedVersion: funded.escrow.version, context: release.context, history: [...data.history.slice(0, -1), wrongSigned], resultReference: release.resultReference })).rejects.toMatchObject({ code: "unauthorized_operation" });

    const validAuthorization = data.history.at(-1)!;
    const forgedRole = sign(
      {
        ...validAuthorization,
        content: JSON.stringify({
          ...JSON.parse(validAuthorization.content),
          actor_role: "escrow",
        }),
      },
      data.requesterKey,
    );
    await expect(
      data.coordinator.submitReleaseAuthorization({
        idempotencyKey: "forged-role-001",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: funded.escrow.version,
        context: release.context,
        history: [...data.history.slice(0, -1), forgedRole],
        resultReference: release.resultReference,
      }),
    ).rejects.toMatchObject({ code: "unauthorized_operation" });

    const stalePredecessor = data.history.at(-3)!;
    let eventReferenceIndex = 0;
    const staleAuthorization = sign(
      {
        ...validAuthorization,
        tags: validAuthorization.tags.map((tag) => {
          if (tag[0] !== "e") return [...tag];
          eventReferenceIndex += 1;
          return eventReferenceIndex === 2 ? ["e", stalePredecessor.id] : [...tag];
        }),
        content: JSON.stringify({
          ...JSON.parse(validAuthorization.content),
          predecessor: stalePredecessor.id,
        }),
      },
      data.requesterKey,
    );
    await expect(
      data.coordinator.submitReleaseAuthorization({
        idempotencyKey: "stale-predecessor",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: funded.escrow.version,
        context: release.context,
        history: [...data.history.slice(0, -1), staleAuthorization],
        resultReference: release.resultReference,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    const forkDraft = createPactAgreementTransition({
      context: release.context,
      history: data.history.slice(0, -1),
      predecessorEventId: data.history.at(-2)!.id,
      nextState: "release_authorized",
      actor: data.requester.publicKey,
      actorRole: "requester",
      createdAt: data.history.at(-2)!.created_at + 2,
    });
    const fork = sign(forkDraft.event, data.requesterKey);
    await expect(data.coordinator.submitReleaseAuthorization({ idempotencyKey: "forked-history-1", escrowReference: funded.escrow.escrowReference, expectedVersion: funded.escrow.version, context: release.context, history: [...data.history, fork], resultReference: release.resultReference })).rejects.toMatchObject({ code: "invalid_state" });
    expect(data.cashu.spendCalls).toBe(0);
  });

  it("handles duplicate funding and idempotency conflicts without a second Cashu call", async () => {
    const data = setup();
    const { prepared, funded } = await prepareAndFund(data);
    const duplicate = await data.coordinator.fundEscrow({ idempotencyKey: "fund-escrow-001", escrowReference: prepared.escrow.escrowReference, expectedVersion: prepared.escrow.version, context: data.context, history: data.history, funding: privateFunding() });
    expect(duplicate.outcome).toBe("confirmed");
    expect(data.cashu.prepareCalls).toBe(1);
    await expect(data.coordinator.fundEscrow({ idempotencyKey: "fund-escrow-001", escrowReference: prepared.escrow.escrowReference, expectedVersion: prepared.escrow.version + 1, context: data.context, history: data.history, funding: privateFunding() })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(funded.escrow.state).toBe("funded");
  });

  it("coalesces concurrent duplicate release calls into one economic outcome", async () => {
    const data = setup();
    const { funded } = await prepareAndFund(data);
    const release = advanceReleaseHistory(data);
    const authorized = await data.coordinator.submitReleaseAuthorization({ idempotencyKey: "auth-concurrent", escrowReference: funded.escrow.escrowReference, expectedVersion: funded.escrow.version, context: release.context, history: data.history, resultReference: release.resultReference });
    const request = { idempotencyKey: "release-concurrent", escrowReference: funded.escrow.escrowReference, expectedVersion: authorized.escrow.version, context: release.context, history: data.history };
    const [first, second] = await Promise.all([data.coordinator.releaseEscrow(request), data.coordinator.releaseEscrow(request)]);
    expect(first.escrow.state).toBe("settled");
    expect(second.escrow.state).toBe("settled");
    expect(data.cashu.spendSubmissions).toBe(1);
  });

  it("allows only one economic submission during a concurrent release/refund attempt", async () => {
    const data = setup();
    const { funded } = await prepareAndFund(data);
    const release = advanceReleaseHistory(data);
    const authorized = await data.coordinator.submitReleaseAuthorization({
      idempotencyKey: "auth-race-release",
      escrowReference: funded.escrow.escrowReference,
      expectedVersion: funded.escrow.version,
      context: release.context,
      history: data.history,
      resultReference: release.resultReference,
    });
    const [releaseAttempt, refundAttempt] = await Promise.allSettled([
      data.coordinator.releaseEscrow({
        idempotencyKey: "race-release-001",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: authorized.escrow.version,
        context: release.context,
        history: data.history,
      }),
      data.coordinator.refundEscrow({
        idempotencyKey: "race-refund-0001",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: authorized.escrow.version,
        context: release.context,
        history: data.history,
      }),
    ]);
    expect([releaseAttempt.status, refundAttempt.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(data.cashu.spendSubmissions).toBe(1);
  });

  it("persists ambiguous operations and reconciles without blind duplicate submission", async () => {
    const cashu = new FakeCashuPort();
    cashu.spendModes.push("unknown", "success");
    const data = setup({ cashu });
    const { funded } = await prepareAndFund(data);
    const release = advanceReleaseHistory(data);
    const authorized = await data.coordinator.submitReleaseAuthorization({ idempotencyKey: "auth-reconcile1", escrowReference: funded.escrow.escrowReference, expectedVersion: funded.escrow.version, context: release.context, history: data.history, resultReference: release.resultReference });
    const request = { idempotencyKey: "release-reconcile", escrowReference: funded.escrow.escrowReference, expectedVersion: authorized.escrow.version, context: release.context, history: data.history };
    await expect(data.coordinator.releaseEscrow(request)).resolves.toMatchObject({ outcome: "reconciliation_required" });
    await expect(data.coordinator.releaseEscrow(request)).resolves.toMatchObject({ outcome: "confirmed", escrow: { state: "settled" } });
    expect(cashu.spendCalls).toBe(2);
    expect(cashu.spendSubmissions).toBe(1);
  });

  it.each([
    ["timeout", "mint_unavailable"],
    ["definitive", "settlement_conflict"],
  ] as const)("persists and safely retries a %s release failure", async (mode, errorCode) => {
    const cashu = new FakeCashuPort();
    cashu.spendModes.push(mode, "success");
    const data = setup({ cashu });
    const { funded } = await prepareAndFund(data);
    const release = advanceReleaseHistory(data);
    const authorized = await data.coordinator.submitReleaseAuthorization({
      idempotencyKey: `auth-${mode}-failure`,
      escrowReference: funded.escrow.escrowReference,
      expectedVersion: funded.escrow.version,
      context: release.context,
      history: data.history,
      resultReference: release.resultReference,
    });
    const request = {
      idempotencyKey: `release-${mode}-failure`,
      escrowReference: funded.escrow.escrowReference,
      expectedVersion: authorized.escrow.version,
      context: release.context,
      history: data.history,
    };
    await expect(data.coordinator.releaseEscrow(request)).rejects.toMatchObject({ code: errorCode });
    await expect(data.coordinator.inspectEscrowStatus(funded.escrow.escrowReference)).resolves.toMatchObject({
      state: "release_authorized",
    });
    await expect(data.coordinator.releaseEscrow(request)).resolves.toMatchObject({
      outcome: "confirmed",
      escrow: { state: "settled" },
    });
    expect(cashu.spendSubmissions).toBe(1);
  });

  it("recovers confirmed release publication from a fresh durable store instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-settlement-"));
    const databasePath = join(directory, "settlement.sqlite");
    let store = createSqlitePactCashuEscrowSettlementStore(databasePath);
    try {
      const data = setup({ store });
      const { funded } = await prepareAndFund(data);
      const release = advanceReleaseHistory(data);
      const authorized = await data.coordinator.submitReleaseAuthorization({ idempotencyKey: "auth-crash-0001", escrowReference: funded.escrow.escrowReference, expectedVersion: funded.escrow.version, context: release.context, history: data.history, resultReference: release.resultReference });
      data.relay.failures = 1;
      const request = { idempotencyKey: "release-crash-01", escrowReference: funded.escrow.escrowReference, expectedVersion: authorized.escrow.version, context: release.context, history: data.history };
      await expect(data.coordinator.releaseEscrow(request)).resolves.toMatchObject({ outcome: "publication_pending", escrow: { state: "release_confirmed" } });
      expect(data.cashu.spendSubmissions).toBe(1);

      store.close();
      store = createSqlitePactCashuEscrowSettlementStore(databasePath);
      await expect(store.read(`escrow:${funded.escrow.escrowReference}`)).resolves.toMatchObject({
        settlementHandle: {
          reference: "cashu_private_22222222-2222-4222-8222-222222222222",
        },
      });
      const restarted = createPactCashuEscrowSettlementCoordinator({
        mintUrl: MINT_URL,
        cashu: data.cashu,
        privateDelivery: data.privateDelivery,
        store,
        escrowAuthoritySigner: data.escrowAuthoritySigner,
        normalSpendKey: data.normalSpendKey,
        refundSpendKey: data.refundSpendKey,
        relay: data.relay,
        clock: data.clock,
      });
      await expect(restarted.releaseEscrow(request)).resolves.toMatchObject({ outcome: "confirmed", escrow: { state: "settled" } });
      expect(data.cashu.spendSubmissions).toBe(1);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("recovers confirmed funding publication from a fresh durable store instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-funding-"));
    const databasePath = join(directory, "settlement.sqlite");
    let store = createSqlitePactCashuEscrowSettlementStore(databasePath);
    try {
      const data = setup({ store });
      const prepared = await data.coordinator.prepareEscrow({
        idempotencyKey: "prepare-fund-crash",
        context: data.context,
        history: data.history,
      });
      const request = {
        idempotencyKey: "fund-crash-0001",
        escrowReference: prepared.escrow.escrowReference,
        expectedVersion: prepared.escrow.version,
        context: data.context,
        history: data.history,
        funding: privateFunding(),
      };
      data.relay.failures = 1;
      await expect(data.coordinator.fundEscrow(request)).resolves.toMatchObject({
        outcome: "publication_pending",
        escrow: { state: "funding_confirmed" },
      });
      expect(data.cashu.prepareCalls).toBe(1);

      store.close();
      store = createSqlitePactCashuEscrowSettlementStore(databasePath);
      await expect(store.read(`escrow:${prepared.escrow.escrowReference}`)).resolves.toMatchObject({
        fundingChangeHandle: {
          reference: "cashu_private_33333333-3333-4333-8333-333333333333",
        },
      });
      const restarted = createPactCashuEscrowSettlementCoordinator({
        mintUrl: MINT_URL,
        cashu: data.cashu,
        privateDelivery: data.privateDelivery,
        store,
        escrowAuthoritySigner: data.escrowAuthoritySigner,
        normalSpendKey: data.normalSpendKey,
        refundSpendKey: data.refundSpendKey,
        relay: data.relay,
        clock: data.clock,
      });
      await expect(restarted.fundEscrow(request)).resolves.toMatchObject({
        outcome: "confirmed",
        escrow: { state: "funded" },
      });
      expect(data.cashu.prepareCalls).toBe(1);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers confirmed refund publication from a fresh durable store instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-refund-"));
    const databasePath = join(directory, "settlement.sqlite");
    let store = createSqlitePactCashuEscrowSettlementStore(databasePath);
    try {
      const data = setup({ store });
      const { funded } = await prepareAndFund(data);
      data.clock.value = data.locktime;
      append(data.context, data.history, "refund_authorized", "requester", data.requesterKey, data.locktime, {
        reasonCode: "timeout",
      });
      const authorized = await data.coordinator.submitRefundAuthorization({
        idempotencyKey: "auth-refund-crash",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: funded.escrow.version,
        context: data.context,
        history: data.history,
        basis: "timeout",
      });
      const request = {
        idempotencyKey: "refund-crash-001",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: authorized.escrow.version,
        context: data.context,
        history: data.history,
      };
      data.relay.failures = 1;
      await expect(data.coordinator.refundEscrow(request)).resolves.toMatchObject({
        outcome: "publication_pending",
        escrow: { state: "refund_confirmed" },
      });
      expect(data.cashu.spendSubmissions).toBe(1);

      store.close();
      store = createSqlitePactCashuEscrowSettlementStore(databasePath);
      await expect(store.read(`escrow:${funded.escrow.escrowReference}`)).resolves.toMatchObject({
        refundHandle: {
          reference: "cashu_private_22222222-2222-4222-8222-222222222222",
        },
      });
      const restarted = createPactCashuEscrowSettlementCoordinator({
        mintUrl: MINT_URL,
        cashu: data.cashu,
        privateDelivery: data.privateDelivery,
        store,
        escrowAuthoritySigner: data.escrowAuthoritySigner,
        normalSpendKey: data.normalSpendKey,
        refundSpendKey: data.refundSpendKey,
        relay: data.relay,
        clock: data.clock,
      });
      await expect(restarted.refundEscrow(request)).resolves.toMatchObject({
        outcome: "confirmed",
        escrow: { state: "refunded" },
      });
      expect(data.cashu.spendSubmissions).toBe(1);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("distinguishes funding timeout before submission from ambiguous reconciliation", async () => {
    const timeoutCashu = new FakeCashuPort();
    timeoutCashu.prepareModes.push("timeout", "success");
    const timeoutData = setup({ cashu: timeoutCashu });
    const prepared = await timeoutData.coordinator.prepareEscrow({
      idempotencyKey: "prepare-timeout1",
      context: timeoutData.context,
      history: timeoutData.history,
    });
    const request = {
      idempotencyKey: "fund-timeout-001",
      escrowReference: prepared.escrow.escrowReference,
      expectedVersion: prepared.escrow.version,
      context: timeoutData.context,
      history: timeoutData.history,
      funding: privateFunding(),
    };
    await expect(timeoutData.coordinator.fundEscrow(request)).rejects.toMatchObject({
      code: "mint_unavailable",
    });
    await expect(timeoutData.coordinator.fundEscrow(request)).resolves.toMatchObject({
      outcome: "confirmed",
      escrow: { state: "funded" },
    });

    const ambiguousCashu = new FakeCashuPort();
    ambiguousCashu.prepareModes.push("unknown", "success");
    const ambiguousData = setup({ cashu: ambiguousCashu });
    const ambiguousPrepared = await ambiguousData.coordinator.prepareEscrow({
      idempotencyKey: "prepare-unknown1",
      context: ambiguousData.context,
      history: ambiguousData.history,
    });
    const ambiguousRequest = {
      idempotencyKey: "fund-unknown-001",
      escrowReference: ambiguousPrepared.escrow.escrowReference,
      expectedVersion: ambiguousPrepared.escrow.version,
      context: ambiguousData.context,
      history: ambiguousData.history,
      funding: privateFunding(),
    };
    await expect(ambiguousData.coordinator.fundEscrow(ambiguousRequest)).resolves.toMatchObject({
      outcome: "reconciliation_required",
      escrow: { state: "funding_reconciliation_required" },
    });
    await expect(ambiguousData.coordinator.fundEscrow(ambiguousRequest)).resolves.toMatchObject({
      outcome: "confirmed",
      escrow: { state: "funded" },
    });
  });

  it("rejects malformed or aliased NUT-11 coordinator keys before mint access", () => {
    const data = setup();
    expect(() =>
      createPactCashuEscrowSettlementCoordinator({
        mintUrl: MINT_URL,
        cashu: data.cashu,
        privateDelivery: data.privateDelivery,
        store: data.store,
        escrowAuthoritySigner: createLocalNostrSigner(hex(data.authorityKey)),
        normalSpendKey: data.normalSpendKey,
        refundSpendKey: data.normalSpendKey,
        relay: data.relay,
        clock: data.clock,
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_spending_condition" }));
    expect(() =>
      createPactCashuEscrowSettlementCoordinator({
        mintUrl: MINT_URL,
        cashu: data.cashu,
        privateDelivery: data.privateDelivery,
        store: data.store,
        escrowAuthoritySigner: data.escrowAuthoritySigner,
        normalSpendKey: new PrivateCashuSpendingKey(CURVE_POINT),
        refundSpendKey: data.refundSpendKey,
        relay: data.relay,
        clock: data.clock,
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_spending_condition" }));
    expect(data.cashu.prepareCalls).toBe(0);
    expect(data.cashu.spendCalls).toBe(0);
  });

  it("rejects a malformed signed timeout/refund configuration before mint access", async () => {
    const data = setup();
    const descriptor = data.references.escrowDescriptor;
    const content = JSON.parse(descriptor.content) as {
      dispute_rules: {
        timeout: { duration_seconds: number; fallback_resolution: string };
      };
    };
    content.dispute_rules.timeout.duration_seconds = 0;
    content.dispute_rules.timeout.fallback_resolution = "unsafe_private_resolution";
    const malformedDescriptor = sign(
      { ...descriptor, content: JSON.stringify(content) },
      data.providerKey,
    );
    const context = {
      ...data.context,
      references: { ...data.references, escrowDescriptor: malformedDescriptor },
    } as PactAgreementContext;
    await expect(
      data.coordinator.prepareEscrow({
        idempotencyKey: "malformed-timeout",
        context,
        history: data.history,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(data.cashu.capabilityCalls).toBe(0);
  });

  it("handles duplicate refunds idempotently and rejects both economic directions after a winner", async () => {
    const data = setup();
    const { funded } = await prepareAndFund(data);
    data.clock.value = data.locktime;
    append(data.context, data.history, "refund_authorized", "requester", data.requesterKey, data.locktime, {
      reasonCode: "timeout",
    });
    const authorized = await data.coordinator.submitRefundAuthorization({
      idempotencyKey: "auth-refund-dupe",
      escrowReference: funded.escrow.escrowReference,
      expectedVersion: funded.escrow.version,
      context: data.context,
      history: data.history,
      basis: "timeout",
    });
    const request = {
      idempotencyKey: "refund-dupe-001",
      escrowReference: funded.escrow.escrowReference,
      expectedVersion: authorized.escrow.version,
      context: data.context,
      history: data.history,
    };
    const first = await data.coordinator.refundEscrow(request);
    const duplicate = await data.coordinator.refundEscrow(request);
    expect(duplicate).toEqual(first);
    expect(data.cashu.spendSubmissions).toBe(1);
    await expect(
      data.coordinator.releaseEscrow({ ...request, idempotencyKey: "release-after-refund" }),
    ).rejects.toMatchObject({ code: "already_refunded" });
  });

  it("allows release and rejects timeout refund immediately before locktime", async () => {
    const before = setup();
    const beforeFund = await prepareAndFund(before);
    const release = advanceReleaseHistory(before);
    before.clock.value = before.locktime - 1;
    await expect(before.coordinator.submitReleaseAuthorization({ idempotencyKey: "before-locktime", escrowReference: beforeFund.funded.escrow.escrowReference, expectedVersion: beforeFund.funded.escrow.version, context: release.context, history: before.history, resultReference: release.resultReference })).resolves.toMatchObject({ outcome: "confirmed" });

    const earlyRefund = setup();
    await prepareAndFund(earlyRefund);
    earlyRefund.clock.value = earlyRefund.locktime - 1;
    expect(() =>
      append(
        earlyRefund.context,
        earlyRefund.history,
        "refund_authorized",
        "requester",
        earlyRefund.requesterKey,
        earlyRefund.locktime - 1,
        { reasonCode: "timeout" },
      ),
    ).toThrowError(expect.objectContaining({ code: "timeout_not_reached" }));
    expect(earlyRefund.cashu.spendSubmissions).toBe(0);
  });

  it("does not let clock skew extend release authorization to locktime", async () => {
    const data = setup();
    const { funded } = await prepareAndFund(data);
    const release = advanceReleaseHistory(data, data.locktime);
    data.clock.value = data.locktime - 1;
    await expect(
      data.coordinator.submitReleaseAuthorization({
        idempotencyKey: "release-at-locktime",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: funded.escrow.version,
        context: release.context,
        history: data.history,
        resultReference: release.resultReference,
      }),
    ).rejects.toMatchObject({ code: "completion_not_authorized" });
  });

  it("allows timeout refund exactly at and immediately after locktime", async () => {
    for (const offset of [0, 1]) {
      const data = setup();
      const { funded } = await prepareAndFund(data);
      data.clock.value = data.locktime + offset;
      append(data.context, data.history, "refund_authorized", "requester", data.requesterKey, data.locktime + offset, { reasonCode: "timeout" });
      await expect(data.coordinator.submitRefundAuthorization({ idempotencyKey: `refund-boundary-${offset}`, escrowReference: funded.escrow.escrowReference, expectedVersion: funded.escrow.version, context: data.context, history: data.history, basis: "timeout" })).resolves.toMatchObject({ outcome: "confirmed" });
    }
  });

  it("keeps private Cashu, task, result, key, and failure material out of results and errors", async () => {
    const data = setup();
    const { funded } = await prepareAndFund(data);
    const serialized = JSON.stringify(funded);
    for (const marker of [
      ...PRIVATE_FAILURE.split(" "),
      "PRIVATE-DOCUMENT",
      "PRIVATE-PROMPT",
      "PRIVATE-RESULT",
      hex(key(21)),
      hex(key(22)),
    ]) {
      expect(serialized).not.toContain(marker);
      expect(JSON.stringify(data.relay.events)).not.toContain(marker);
    }
    const cashu = new FakeCashuPort();
    cashu.prepareModes.push("timeout");
    const failing = setup({ cashu });
    const prepared = await failing.coordinator.prepareEscrow({ idempotencyKey: "privacy-prepare", context: failing.context, history: failing.history });
    const logSpies = (["debug", "error", "info", "log", "warn"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    let caught: unknown;
    try {
      await failing.coordinator.fundEscrow({ idempotencyKey: "privacy-funding", escrowReference: prepared.escrow.escrowReference, expectedVersion: prepared.escrow.version, context: failing.context, history: failing.history, funding: privateFunding() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PactCashuSettlementError);
    for (const marker of PRIVATE_FAILURE.split(" ")) {
      expect(JSON.stringify(caught)).not.toContain(marker);
      expect(JSON.stringify(failing.relay.events)).not.toContain(marker);
    }
    expect("cause" in (caught as object)).toBe(false);
    for (const spy of logSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    await expect(
      failing.coordinator.prepareEscrow({
        idempotencyKey: "cashuA_PRIVATE_TOKEN",
        context: failing.context,
        history: failing.history,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("publishes a versioned seven-operation schema with safe examples and the full error contract", () => {
    const source = readFileSync(
      new URL("../../docs/pactagent-cashu-escrow-service-v1.openapi.json", import.meta.url),
      "utf8",
    );
    const schema = JSON.parse(source) as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string }>>;
      components: { schemas: { Error: { properties: { code: { enum: string[] } } } } };
    };
    const operationIds = Object.values(schema.paths).flatMap((path) =>
      Object.values(path).map((operation) => operation.operationId),
    );
    expect(schema.openapi).toBe("3.1.0");
    expect(operationIds).toEqual([
      "prepareEscrow",
      "fundEscrow",
      "inspectEscrowStatus",
      "submitReleaseAuthorization",
      "releaseEscrow",
      "submitRefundAuthorization",
      "refundEscrow",
    ]);
    expect(schema.components.schemas.Error.properties.code.enum).toEqual(
      expect.arrayContaining([
        "invalid_request",
        "unsupported_mint_or_unit",
        "unsupported_spending_condition",
        "agreement_mismatch",
        "participant_mismatch",
        "unauthorized_operation",
        "invalid_state",
        "stale_state",
        "idempotency_conflict",
        "funding_not_confirmed",
        "completion_not_authorized",
        "timeout_not_reached",
        "already_released",
        "already_refunded",
        "settlement_conflict",
        "mint_unavailable",
        "reconciliation_required",
      ]),
    );
    for (const marker of [
      "cashuA_PRIVATE_TOKEN",
      "PRIVATE-PROOF",
      "PRIVATE-WITNESS",
      "PRIVATE-PREIMAGE",
      hex(key(21)),
    ]) {
      expect(source).not.toContain(marker);
    }
  });
});
