import { describe, expect, it } from "vitest";

import { sats } from "../domain/money";
import type { SignedNostrEvent } from "../domain/nostr";
import {
  DOCUMENT_SUMMARY_EXECUTION_GRACE_SECONDS,
  DOCUMENT_SUMMARY_PROFILE_ID,
  PACT_EXECUTION_DEADLINE_REASON_CODE,
  PactPrivateCommitmentSalt,
  createPactResultReference,
  type PactAgreementState,
} from "../domain/pact-service-agreement";
import {
  CashuPrivateBackendError,
  CashuTestMintError,
  createCashuTestMintAdapterWithBackend,
  type CashuMutationResult,
  type CashuPrivateStore,
  type SpendLockedValueInput,
} from "./cashu-test-mint";
import { FakeCashuBackend, fakeFunding } from "./cashu-test-fixture";
import type { PactCashuEscrowSettlementStore } from "./cashu-escrow-settlement";
import { createPactAgentRuntime, type PactAgentRuntimeConfig } from "./pactagent-runtime";
import {
  createPactAgentWorkflow,
  type DeterministicPactAgentClock,
  type PactAgentWorkflowResumeState,
} from "./pactagent-workflow";
import type { ApprovedRequesterDecision } from "./requester-decision";
import {
  FakeCashuPort,
  MINT_URL,
  MemoryRelay,
  ROOT_TIME,
  buildFixture,
  buildRuntimeConfig,
  privateFunding,
  sharedStores,
  startInput,
  transactionId,
  type SharedStores,
} from "./pactagent-runtime-test-fixture";

/*
 * Issue #58: document-summary@1 rule revision 1.1 execution-deadline refund
 * through the workflow and the long-lived runtime. The runtime fixture
 * accepts at ROOT_TIME with maximum_execution_seconds 120 and a 900 s escrow
 * timeout, so the deadline is ROOT_TIME + 120 + grace and the locktime is
 * ROOT_TIME + 900.
 */
const DEADLINE = ROOT_TIME + 120 + DOCUMENT_SUMMARY_EXECUTION_GRACE_SECONDS;
const LOCKTIME = ROOT_TIME + 900;
const NIP59_GIFT_WRAP_KIND = 1059;

const fixture = buildFixture();

/**
 * Delivers the requester's private task, then loses the provider: "reject"
 * fails the provider's result gift wrap (abandoned at task_delivered); "drop"
 * silently loses it, so result_submitted is published but completion cannot
 * proceed (abandoned at result_submitted).
 */
class LostProviderResultRelay extends MemoryRelay {
  #giftWraps = 0;

  constructor(private readonly mode: "reject" | "drop") {
    super();
    this.events.push(...fixture.referenceEvents);
  }

  async publish(event: SignedNostrEvent): Promise<void> {
    if (event.kind === NIP59_GIFT_WRAP_KIND && ++this.#giftWraps > 1) {
      if (this.mode === "reject") throw new Error("Simulated provider outage");
      return;
    }
    await super.publish(event);
  }
}

class FlakySpendCashuPort extends FakeCashuPort {
  failNextSpend = false;

  async spendLockedValue(input: SpendLockedValueInput): Promise<CashuMutationResult> {
    if (this.failNextSpend) {
      this.failNextSpend = false;
      throw new CashuTestMintError("mint_unavailable", "Simulated mint outage", "not_submitted");
    }
    return super.spendLockedValue(input);
  }
}

function crashAfterSettlementState(
  store: PactCashuEscrowSettlementStore,
  targetState: string,
): PactCashuEscrowSettlementStore {
  let armed = true;
  return {
    read: (key) => store.read(key),
    insert: (key, value) => store.insert(key, value),
    async compareAndSet(key, expectedRevision, value) {
      const saved = await store.compareAndSet(key, expectedRevision, value);
      if (saved && armed && (value as { state?: unknown }).state === targetState) {
        armed = false;
        throw new Error(`simulated crash after ${targetState}`);
      }
      return saved;
    },
    withExclusiveLock: (key, operation) => store.withExclusiveLock(key, operation),
  };
}

function lifecycle(relay: MemoryRelay): PactAgreementState[] {
  return relay.events
    .filter((event) => event.tags.some((tag) => tag[0] === "t" && tag[1] === "pactagent/service-agreement-transition@1"))
    .sort((left, right) => left.created_at - right.created_at)
    .map((event) => (JSON.parse(event.content) as { state: PactAgreementState }).state);
}

function countState(relay: MemoryRelay, state: PactAgreementState): number {
  return lifecycle(relay).filter((candidate) => candidate === state).length;
}

function clockOf(config: PactAgentRuntimeConfig): DeterministicPactAgentClock {
  return config.dependencies.clock as DeterministicPactAgentClock;
}

async function activeExposure(store: CashuPrivateStore): Promise<bigint> {
  const ledger = (await store.read(MINT_URL, "exposure-ledger")) as {
    reservations?: Record<string, { amountSats: string; status: string }>;
  } | undefined;
  return Object.values(ledger?.reservations ?? {})
    .filter((reservation) => reservation.status !== "released")
    .reduce((total, reservation) => total + BigInt(reservation.amountSats), 0n);
}

describe("workflow execution-deadline refund recovery", () => {
  const SALT = new Uint8Array(32).fill(7);

  async function abandonedWorkflow(
    mode: "reject" | "drop",
    options: { cashu?: FakeCashuPort; settlementStore?: PactCashuEscrowSettlementStore } = {},
  ) {
    const shared = sharedStores();
    const relay = new LostProviderResultRelay(mode);
    const built = buildRuntimeConfig(fixture, shared, { relay, cashu: options.cashu });
    const dependencies = {
      ...built.config.dependencies,
      ...(options.settlementStore === undefined ? {} : { settlementStore: options.settlementStore }),
    };
    const workflow = createPactAgentWorkflow({ identities: fixture.identities, dependencies });
    const input = startInput("workflow-deadline-0001");
    await expect(
      workflow.runSuccessfulTransaction({
        requesterDefinition: fixture.references.requesterDefinition,
        privateDocument: input.privateDocument,
        mediaType: input.mediaType,
        privatePrompt: input.privatePrompt,
        maximumBudgetSats: sats(500n),
        funding: privateFunding(),
        privateSalt: new PactPrivateCommitmentSalt(SALT),
      }),
    ).rejects.toMatchObject({ code: "private_transport_failed" });
    const checkpoint = workflow.escrowCheckpoint;
    const resumeState = (
      phase: PactAgentWorkflowResumeState["phase"],
      refundReference?: string,
    ): PactAgentWorkflowResumeState => ({
      kind: "refund",
      phase,
      privateTerms: {
        source_document: input.privateDocument,
        input_media_type: input.mediaType,
        private_prompt: input.privatePrompt,
      },
      privateSalt: new PactPrivateCommitmentSalt(SALT),
      context: workflow.currentContext!,
      decision: {
        status: "approved",
        reason: "approved",
        capabilityProfile: DOCUMENT_SUMMARY_PROFILE_ID,
        selection: fixture.selectedReferences,
        amountSats: "350",
      } satisfies ApprovedRequesterDecision,
      escrowReference: checkpoint.escrowReference,
      escrowVersion: checkpoint.escrowVersion,
      refundReference,
    });
    const resume = (
      phase: PactAgentWorkflowResumeState["phase"],
      reconcileOnly = false,
      refundReference?: string,
    ) =>
      createPactAgentWorkflow({ identities: fixture.identities, dependencies })
        .resumeRefundTransaction(resumeState(phase, refundReference), { reconcileOnly });
    return { relay, cashu: built.cashu, clock: clockOf(built.config), resume, shared };
  }

  it("refunds an agreement abandoned after task_delivered once the deadline passes", async () => {
    const { relay, cashu, clock, resume } = await abandonedWorkflow("reject");
    expect(lifecycle(relay)).toEqual(["accepted", "escrow_funded", "task_delivered"]);

    clock.advanceTo(DEADLINE - 1);
    await expect(resume("task_delivered")).rejects.toMatchObject({ code: "unexpected_state" });
    expect(countState(relay, "refund_authorized")).toBe(0);
    expect(cashu.spendCalls).toBe(0);

    clock.advanceTo(DEADLINE);
    const report = await resume("task_delivered");
    expect(report).toMatchObject({ finalOutcome: "refunded", refundReference: expect.stringMatching(/^pactrefund_/) });
    expect(report.lifecycle.map((entry) => entry.state)).toEqual([
      "accepted",
      "escrow_funded",
      "task_delivered",
      "refund_authorized",
      "refunded",
    ]);
    const authorization = relay.events.find((event) => event.tags.some((tag) => tag[1] === "refund_authorized"))!;
    expect(JSON.parse(authorization.content)).toMatchObject({
      prev_state: "task_delivered",
      actor_role: "requester",
      reason_code: PACT_EXECUTION_DEADLINE_REASON_CODE,
    });
    expect(authorization.pubkey).toBe(fixture.identities.requesterSigner.publicKey);
    expect(authorization.created_at).toBe(DEADLINE);
    expect(new Set(cashu.spendOperationIds).size).toBe(1);
  });

  it("refunds a submitted result whose completion is blocked once the deadline passes", async () => {
    const { relay, cashu, clock, resume } = await abandonedWorkflow("drop");
    expect(lifecycle(relay)).toEqual(["accepted", "escrow_funded", "task_delivered", "result_submitted"]);

    clock.advanceTo(DEADLINE - 1);
    await expect(resume("result_submitted")).rejects.toMatchObject({ code: "unexpected_state" });
    expect(countState(relay, "refund_authorized")).toBe(0);

    clock.advanceTo(DEADLINE + 30);
    const report = await resume("result_submitted");
    expect(report.finalOutcome).toBe("refunded");
    expect(report.lifecycle.map((entry) => entry.state)).toEqual([
      "accepted",
      "escrow_funded",
      "task_delivered",
      "result_submitted",
      "refund_authorized",
      "refunded",
    ]);
    expect(cashu.spendCalls).toBe(1);
  });

  it("recovers a published authorization after a failed refund without publishing another", async () => {
    const cashu = new FlakySpendCashuPort();
    const { relay, clock, resume } = await abandonedWorkflow("reject", { cashu });
    clock.advanceTo(DEADLINE);
    cashu.failNextSpend = true;
    await expect(resume("task_delivered")).rejects.toMatchObject({ code: "settlement_failed" });
    expect(lifecycle(relay)).toEqual(["accepted", "escrow_funded", "task_delivered", "refund_authorized"]);

    clock.advanceTo(DEADLINE + 600);
    const report = await resume("refund_authorized");
    expect(report.finalOutcome).toBe("refunded");
    expect(countState(relay, "refund_authorized")).toBe(1);
    expect(countState(relay, "refunded")).toBe(1);
    await expect(resume("refunded", false, report.refundReference)).resolves.toMatchObject({
      finalOutcome: "refunded",
      refundReference: report.refundReference,
    });
    expect(countState(relay, "refund_authorized")).toBe(1);
    expect(new Set(cashu.spendOperationIds).size).toBe(1);
  });

  it("resumes an interrupted refund from durable state without a second Cashu operation", async () => {
    const base = sharedStores().settlementStore;
    const settlementStore = crashAfterSettlementState(base, "refund_confirmed");
    const { relay, cashu, clock, resume } = await abandonedWorkflow("reject", { settlementStore });
    clock.advanceTo(DEADLINE);
    await expect(resume("task_delivered")).rejects.toMatchObject({ code: "settlement_failed" });
    expect(countState(relay, "refunded")).toBe(0);

    const report = await resume("refund_authorized");
    expect(report.finalOutcome).toBe("refunded");
    expect(countState(relay, "refund_authorized")).toBe(1);
    expect(countState(relay, "refunded")).toBe(1);
    expect(new Set(cashu.spendOperationIds).size).toBe(1);
  });

  it("never authorizes a new refund during reconcile-only recovery", async () => {
    const { relay, clock, resume } = await abandonedWorkflow("reject");
    clock.advanceTo(DEADLINE);
    await expect(resume("task_delivered", true)).rejects.toMatchObject({ code: "unexpected_state" });
    expect(countState(relay, "refund_authorized")).toBe(0);
  });
});

describe("runtime execution-deadline refund recovery", () => {
  function runtimeWith(
    shared: SharedStores,
    relay: MemoryRelay,
    options: { cashu?: FakeCashuPort; realAdapter?: FakeCashuBackend } = {},
  ) {
    const built = buildRuntimeConfig(fixture, shared, { relay, cashu: options.cashu });
    const config: PactAgentRuntimeConfig = options.realAdapter
      ? {
          ...built.config,
          dependencies: {
            ...built.config.dependencies,
            cashu: createCashuTestMintAdapterWithBackend({
              configuration: { testMintUrl: MINT_URL, unit: "sat", maximumExposureSats: sats(1_000n) },
              backend: options.realAdapter,
              privateStore: shared.privateStore,
            }),
          },
          resolveFunding: async () => fakeFunding(),
        }
      : built.config;
    return { runtime: createPactAgentRuntime(config), cashu: built.cashu, clock: clockOf(config) };
  }

  async function abandon(
    key: string,
    mode: "reject" | "drop" = "reject",
    options: { cashu?: FakeCashuPort; realAdapter?: FakeCashuBackend } = {},
  ) {
    const shared = sharedStores();
    const relay = new LostProviderResultRelay(mode);
    const parts = runtimeWith(shared, relay, options);
    await parts.runtime.start();
    await expect(parts.runtime.startTransaction(startInput(key))).rejects.toMatchObject({
      code: "private_transport_failed",
    });
    return { ...parts, relay, shared, id: transactionId(key) };
  }

  it("advertises and authorizes refund at the execution deadline, not before", async () => {
    const { runtime, clock, relay, id, cashu } = await abandon("runtime-deadline-0001");
    await expect(runtime.status(id)).resolves.toMatchObject({
      phase: "task_delivered",
      availableActions: { resume: true, reconcile: false, refund: false },
    });
    clock.advanceTo(DEADLINE - 1);
    expect((await runtime.status(id)).availableActions.refund).toBe(false);
    await expect(runtime.refund(id)).rejects.toMatchObject({ code: "invalid_request" });
    expect(countState(relay, "refund_authorized")).toBe(0);

    clock.advanceTo(DEADLINE);
    await expect(runtime.status(id)).resolves.toMatchObject({
      availableActions: { resume: true, reconcile: false, refund: true },
    });
    await expect(runtime.refund(id)).resolves.toMatchObject({ finalOutcome: "refunded" });
    await expect(runtime.status(id)).resolves.toMatchObject({
      operationalState: "refunded",
      finalOutcome: "refunded",
      availableActions: { resume: false, reconcile: false, refund: false },
    });
    await expect(runtime.refund(id)).resolves.toMatchObject({ finalOutcome: "refunded" });
    expect(cashu.spendCalls).toBe(1);
    await runtime.shutdown();
  });

  it("refunds from the relay phase when the persisted phase is stale", async () => {
    const { runtime, clock, id, shared, cashu } = await abandon("runtime-deadline-stale");
    // A process killed between task_delivered and the progress checkpoint
    // leaves the durable record at escrow_funded.
    const record = (await shared.privateStore.read("transaction", id)) as Record<string, unknown>;
    await shared.privateStore.write("transaction", id, { ...record, phase: "escrow_funded" });
    clock.advanceTo(DEADLINE);
    expect((await runtime.status(id)).availableActions.refund).toBe(false);
    await expect(runtime.refund(id)).resolves.toMatchObject({ finalOutcome: "refunded" });
    expect(cashu.spendCalls).toBe(1);
    await runtime.shutdown();
  });

  it("reclaims an abandoned task_delivered escrow, releases its exposure, and stays idempotent", async () => {
    const backend = new FakeCashuBackend();
    const { runtime, clock, relay, id, shared } = await abandon("runtime-deadline-reclaim", "reject", {
      realAdapter: backend,
    });
    const locked = await activeExposure(shared.privateStore);
    expect(locked).toBeGreaterThan(0n);

    clock.advanceTo(DEADLINE - 1);
    await expect(runtime.reclaimExpiredFundedEscrows()).resolves.toMatchObject({ reclaimed: 0, failed: 0 });
    expect(await activeExposure(shared.privateStore)).toBe(locked);

    clock.advanceTo(DEADLINE);
    await expect(runtime.reclaimExpiredFundedEscrows()).resolves.toMatchObject({ reclaimed: 1, failed: 0 });
    await expect(runtime.status(id)).resolves.toMatchObject({ operationalState: "refunded" });
    expect(await activeExposure(shared.privateStore)).toBe(0n);
    const submitted = backend.submitCalls;
    expect(submitted).toBe(2);

    await expect(runtime.reclaimExpiredFundedEscrows()).resolves.toMatchObject({ reclaimed: 0, failed: 0 });
    await runtime.bootstrap();
    expect(backend.submitCalls).toBe(submitted);
    expect(countState(relay, "refund_authorized")).toBe(1);
    expect(countState(relay, "refunded")).toBe(1);
    await runtime.shutdown();
  });

  it("keeps ambiguous refund exposure reserved until reconciliation proves the spend", async () => {
    const backend = new FakeCashuBackend();
    const { runtime, clock, id, shared } = await abandon("runtime-deadline-ambiguous", "reject", {
      realAdapter: backend,
    });
    clock.advanceTo(DEADLINE);
    backend.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    await expect(runtime.reclaimExpiredFundedEscrows()).resolves.toMatchObject({ reclaimed: 0, failed: 1 });
    await expect(runtime.status(id)).resolves.toMatchObject({
      operationalState: "reconciliation_required",
      reconciliationState: "refund_reconciliation_required",
      availableActions: { resume: false, reconcile: true, refund: false },
    });
    const reserved = await activeExposure(shared.privateStore);
    expect(reserved).toBeGreaterThan(0n);

    // Reclaim never replays an ambiguous refund.
    await expect(runtime.reclaimExpiredFundedEscrows()).resolves.toMatchObject({ reclaimed: 0, failed: 0 });
    expect(backend.submitCalls).toBe(2);
    expect(await activeExposure(shared.privateStore)).toBe(reserved);

    // NUT-07 reports the inputs spent and NUT-09 restores the original outputs.
    backend.states = [{ state: "spent" }];
    backend.restoreSucceeds = true;
    await expect(runtime.reconcile(id)).resolves.toMatchObject({ finalOutcome: "refunded" });
    expect(backend.submitCalls).toBe(2);
    expect(backend.restoreCalls).toBe(1);
    expect(await activeExposure(shared.privateStore)).toBe(0n);
    await runtime.shutdown();
  });

  it("leaves a submitted result to the success path until locktime and refunds it after", async () => {
    const { runtime, clock, relay, id, cashu } = await abandon("runtime-deadline-submitted", "drop");
    clock.advanceTo(DEADLINE + 10);
    await expect(runtime.status(id)).resolves.toMatchObject({
      phase: "result_submitted",
      availableActions: { refund: true },
    });
    await expect(runtime.reclaimExpiredFundedEscrows()).resolves.toMatchObject({ reclaimed: 0, failed: 0 });
    expect(countState(relay, "refund_authorized")).toBe(0);
    expect(cashu.spendCalls).toBe(0);

    clock.advanceTo(LOCKTIME);
    await expect(runtime.reclaimExpiredFundedEscrows()).resolves.toMatchObject({ reclaimed: 1 });
    const authorization = relay.events.find((event) => event.tags.some((tag) => tag[1] === "refund_authorized"))!;
    expect(JSON.parse(authorization.content)).toMatchObject({
      prev_state: "result_submitted",
      reason_code: PACT_EXECUTION_DEADLINE_REASON_CODE,
    });
    await runtime.shutdown();
  });

  it("refunds a manually chosen submitted result after the deadline", async () => {
    const { runtime, clock, id } = await abandon("runtime-deadline-manual", "drop");
    clock.advanceTo(DEADLINE);
    await expect(runtime.refund(id)).resolves.toMatchObject({ finalOutcome: "refunded" });
    await runtime.shutdown();
  });

  it("waits for locktime on an escrow prepared before rule revision 1.1", async () => {
    const { runtime, clock, id, shared, cashu } = await abandon("runtime-deadline-legacy");
    const status = await runtime.status(id);
    const key = `escrow:${status.escrowReference}`;
    // Byte-for-byte a pre-1.1 record: same revision, no stored deadline.
    const { executionDeadline: removed, ...legacy } = (await shared.settlementStore.read(key)) as {
      revision: number;
      executionDeadline?: number;
    };
    expect(removed).toBe(DEADLINE);
    await expect(shared.settlementStore.compareAndSet(key, legacy.revision, legacy)).resolves.toBe(true);

    clock.advanceTo(DEADLINE + 60);
    expect((await runtime.status(id)).availableActions.refund).toBe(false);
    await expect(runtime.reclaimExpiredFundedEscrows()).resolves.toMatchObject({ reclaimed: 0 });
    expect(cashu.spendCalls).toBe(0);

    clock.advanceTo(LOCKTIME);
    expect((await runtime.status(id)).availableActions.refund).toBe(true);
    await expect(runtime.reclaimExpiredFundedEscrows()).resolves.toMatchObject({ reclaimed: 1 });
    await runtime.shutdown();
  });

  it("freezes refunds when a late provider result forks the abandoned agreement", async () => {
    const { runtime, clock, relay, id, cashu } = await abandon("runtime-deadline-fork");
    const status = await runtime.status(id);
    clock.advanceTo(DEADLINE);
    await expect(runtime.refund(id)).resolves.toMatchObject({ finalOutcome: "refunded" });
    const spends = cashu.spendCalls;

    // The provider returns after the irreversible refund and publishes a
    // competing result off task_delivered. The completed refund stands; no
    // further economic action is possible and the fork is reported.
    const delivered = relay.events
      .filter((event) => event.tags.some((tag) => tag[1] === "pactagent/service-agreement-transition@1"))
      .find((event) => (JSON.parse(event.content) as { state: string }).state === "task_delivered")!;
    const provider = fixture.identities.providerSigner.publicKey;
    const rootId = status.agreementRootEventId!;
    relay.events.push(await fixture.identities.providerSigner.sign({
      pubkey: provider,
      created_at: DEADLINE + 5,
      kind: delivered.kind,
      tags: [
        ["d", status.agreementId],
        ["t", "pactagent/service-agreement-transition@1"],
        ["t", "result_submitted"],
        ["e", rootId],
        ["e", delivered.id],
        ["p", provider],
      ],
      content: JSON.stringify({
        version: 1,
        agreement_id: status.agreementId,
        agreement_root: rootId,
        predecessor: delivered.id,
        state: "result_submitted",
        prev_state: "task_delivered",
        actor: provider,
        actor_role: "provider",
        result_reference: createPactResultReference(DOCUMENT_SUMMARY_PROFILE_ID, rootId, { summary: "late" }),
      }),
    }));

    await expect(runtime.report(id)).rejects.toMatchObject({ code: "reconstruction_failed" });
    await expect(runtime.refund(id)).rejects.toMatchObject({ code: "reconstruction_failed" });
    await expect(runtime.reclaimExpiredFundedEscrows()).resolves.toMatchObject({ reclaimed: 0 });
    expect(cashu.spendCalls).toBe(spends);
    await expect(runtime.status(id)).resolves.toMatchObject({ operationalState: "refunded" });
    await runtime.shutdown();
  });
});
