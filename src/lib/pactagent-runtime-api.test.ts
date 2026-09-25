import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES,
  PACT_SERVICE_AGREEMENT_ROOT_TYPE,
} from "@/domain/pact-service-agreement";
import { PRIVATE_TASK_MAX_PROMPT_BYTES } from "@/domain/private-task-transport";

import { GET as getStatus } from "@/app/api/transactions/[id]/route";
import { POST as postReconcile } from "@/app/api/transactions/[id]/reconcile/route";
import { GET as getReport } from "@/app/api/transactions/[id]/report/route";
import { GET as getResult } from "@/app/api/transactions/[id]/result/route";
import { POST as postResume } from "@/app/api/transactions/[id]/resume/route";
import { POST as postTransaction } from "@/app/api/transactions/route";
import {
  configurePactAgentRuntime,
  getPactAgentRuntime,
  handleRuntimeTermination,
  resetPactAgentRuntime,
  runBoundedRuntimeShutdown,
} from "@/lib/pactagent-runtime-singleton";
import {
  buildFixture,
  buildRuntimeConfig,
  sharedStores,
  transactionId,
} from "@/lib/pactagent-runtime-test-fixture";

const TOKEN = "test-runtime-token";
let observed: ReturnType<typeof buildRuntimeConfig>;
let observedStores: ReturnType<typeof sharedStores>;

function authed(url: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  return new Request(url, { ...init, headers });
}

function startBody() {
  return {
    fundingReference: "funding-reference-0001",
    privateDocument: "PRIVATE-DOCUMENT HTTP transaction document about Bitcoin.",
    mediaType: "text/plain",
    privatePrompt: "PRIVATE-PROMPT Summarize this document.",
    maximumBudgetSats: 500,
  };
}

async function waitForStatus(
  id: string,
  predicate: (status: Record<string, unknown>) => boolean,
  timeoutMilliseconds = 30_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const response = await getStatus(
      authed(`http://localhost/api/transactions/${id}`),
      { params: Promise.resolve({ id }) },
    );
    const status = await response.json() as Record<string, unknown>;
    if (response.status === 200 && predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for transaction ${id}`);
}

describe("PactAgent HTTP transaction API", () => {
  beforeEach(() => {
    process.env.PACTAGENT_RUNTIME_API_TOKEN = TOKEN;
    resetPactAgentRuntime();
    const fixture = buildFixture();
    const shared = sharedStores();
    observedStores = shared;
    observed = buildRuntimeConfig(fixture, shared);
    configurePactAgentRuntime(observed.config);
  });

  afterEach(async () => {
    await runBoundedRuntimeShutdown(60_000);
    resetPactAgentRuntime();
  });

  it("rejects requests without a valid bearer token", async () => {
    const res = await postTransaction(
      new Request("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "k" },
        body: JSON.stringify(startBody()),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
  });

  it("sets no-store on unauthorized responses from every transaction endpoint", async () => {
    const context = { params: Promise.resolve({ id: "txn_unauthorized" }) };
    const responses = [
      await postTransaction(new Request("http://localhost/api/transactions", { method: "POST" })),
      await getStatus(new Request("http://localhost/api/transactions/txn_unauthorized"), context),
      await getReport(new Request("http://localhost/api/transactions/txn_unauthorized/report"), context),
      await getResult(new Request("http://localhost/api/transactions/txn_unauthorized/result"), context),
      await postResume(new Request("http://localhost/api/transactions/txn_unauthorized/resume", { method: "POST" }), context),
      await postReconcile(new Request("http://localhost/api/transactions/txn_unauthorized/reconcile", { method: "POST" }), context),
    ];
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("runs bounded runtime shutdown exactly once for concurrent lifecycle signals", async () => {
    await getPactAgentRuntime();
    const exits: number[] = [];
    await Promise.all([
      handleRuntimeTermination((code) => exits.push(code), 1_000),
      runBoundedRuntimeShutdown(1_000),
    ]);
    expect(observed.relay.disconnectCalls).toBe(1);
    expect(exits).toEqual([0]);
  });

  it.each([
    ["document", { ...startBody(), privateDocument: "x".repeat(DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES + 1) }],
    ["encoded PDF", { ...startBody(), mediaType: "application/pdf", privateDocument: "A".repeat(DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES + 1) }],
    ["prompt", { ...startBody(), privatePrompt: "p".repeat(PRIVATE_TASK_MAX_PROMPT_BYTES + 1) }],
  ])("rejects an oversized %s before runtime effects", async (_label, body) => {
    const idempotencyKey = `oversized-${_label.replaceAll(" ", "-")}`;
    const initialRelayEvents = observed.relay.events.length;
    const response = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(observed.relay.events).toHaveLength(initialRelayEvents);
    expect(observed.cashu.prepareCalls).toBe(0);
    expect(observed.cashu.spendCalls).toBe(0);
    expect(await observedStores.privateStore.read("transaction", transactionId(idempotencyKey)))
      .toBeUndefined();
  });

  it("rejects a raw body above the endpoint limit before runtime effects", async () => {
    const initialRelayEvents = observed.relay.events.length;
    const response = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "raw-body-limit" },
        body: JSON.stringify({ ...startBody(), padding: "z".repeat(1_200_000) }),
      }),
    );
    expect(response.status).toBe(413);
    expect(observed.relay.events).toHaveLength(initialRelayEvents);
    expect(observed.cashu.prepareCalls).toBe(0);
  });

  it("requires an opaque funding reference and never accepts a raw token field", async () => {
    const missing = { ...startBody() } as Record<string, unknown>;
    delete missing.fundingReference;
    const missingResponse = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "missing-funding-ref" },
        body: JSON.stringify(missing),
      }),
    );
    expect(missingResponse.status).toBe(400);

    const rawTokenResponse = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "raw-token-rejected" },
        body: JSON.stringify({ ...startBody(), rawCashuToken: "cashuA_PRIVATE" }),
      }),
    );
    expect(rawTokenResponse.status).toBe(400);
    expect(observed.cashu.prepareCalls).toBe(0);
  });

  it("returns 202 with a stable transaction id and Location", async () => {
    const res = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-0001" },
        body: JSON.stringify(startBody()),
      }),
    );
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { transactionId: string };
    expect(body.transactionId).toBe(transactionId("key-0001"));
    expect(res.headers.get("location")).toBe(`/api/transactions/${body.transactionId}`);

    const immediate = await getStatus(
      authed(`http://localhost/api/transactions/${body.transactionId}`),
      { params: Promise.resolve({ id: body.transactionId }) },
    );
    expect(immediate.status).toBe(200);
  }, 60_000);

  it("returns a durable pollable id before delayed execution and runs one logical agreement", async () => {
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    const publish = observed.relay.publish.bind(observed.relay);
    observed.relay.publish = async (event) => {
      if (event.tags.some((tag) => tag[0] === "t" && tag[1] === PACT_SERVICE_AGREEMENT_ROOT_TYPE)) {
        await rootGate;
      }
      await publish(event);
    };

    const request = () => postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "early-acceptance-0001" },
        body: JSON.stringify(startBody()),
      }),
    );
    const first = await request();
    expect(first.status).toBe(202);
    const accepted = await first.json() as { transactionId: string };
    const active = await waitForStatus(
      accepted.transactionId,
      (status) => status.operationalState === "active" && status.requesterDecision !== undefined,
    );
    expect(active).toMatchObject({
      transactionId: accepted.transactionId,
      operationalState: "active",
      selectedOffer: {
        providerPublicKey: observed.config.selectedReferences.providerPublicKey,
        offerReference: observed.config.selectedReferences.offerReference,
        escrowDescriptorReference: observed.config.selectedReferences.escrowDescriptorReference,
        amountSats: "350",
        unit: "sat",
      },
      availableActions: { resume: false, reconcile: false },
      resultAvailable: false,
      reportAvailable: false,
      requesterDecision: {
        source: "deterministic",
        recommendation: { action: "recommend", amountSats: "350" },
        authorized: true,
      },
    });

    const repeated = await request();
    expect((await repeated.json() as { transactionId: string }).transactionId).toBe(accepted.transactionId);
    releaseRoot();
    const settled = await waitForStatus(accepted.transactionId, (status) => status.phase === "settled");
    expect(settled.requesterDecision).toMatchObject({
      source: "deterministic",
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
    expect(settled.selectedOffer).toEqual(active.selectedOffer);
    expect(settled.requesterDecision).toEqual(active.requesterDecision);
    expect(observed.relay.events.filter((event) =>
      event.tags.some((tag) => tag[0] === "t" && tag[1] === PACT_SERVICE_AGREEMENT_ROOT_TYPE)
    )).toHaveLength(1);
    expect(observed.cashu.prepareCalls).toBe(1);
  }, 60_000);

  it("returns typed unavailable result and report responses", async () => {
    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const underlying = observed.config.dependencies.decisionModel;
    resetPactAgentRuntime();
    configurePactAgentRuntime({
      ...observed.config,
      dependencies: {
        ...observed.config.dependencies,
        decisionModel: {
          async recommend(input, context) {
            await decisionGate;
            return underlying.recommend(input, context);
          },
        },
      },
    });
    const started = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "unavailable-resources-0001" },
        body: JSON.stringify(startBody()),
      }),
    );
    const { transactionId: id } = await started.json() as { transactionId: string };
    const context = { params: Promise.resolve({ id }) };
    const [result, report] = await Promise.all([
      getResult(authed(`http://localhost/api/transactions/${id}/result`), context),
      getReport(authed(`http://localhost/api/transactions/${id}/report`), context),
    ]);
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: "Private result is not available", code: "result_not_available" });
    expect(report.status).toBe(409);
    expect(await report.json()).toEqual({ error: "Report is not available", code: "report_not_available" });
    releaseDecision();
  }, 60_000);

  it("persists a redacted failure as an authoritative resumable status", async () => {
    resetPactAgentRuntime();
    configurePactAgentRuntime({
      ...observed.config,
      dependencies: {
        ...observed.config.dependencies,
        decisionModel: { async recommend() { return { action: "decline" }; } },
      },
    });
    const started = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "redacted-failure-0001" },
        body: JSON.stringify(startBody()),
      }),
    );
    expect(started.status).toBe(202);
    const { transactionId: id } = await started.json() as { transactionId: string };
    const failed = await waitForStatus(id, (status) => status.operationalState === "failed");
    expect(failed).toMatchObject({
      phase: "initialized",
      operationalState: "failed",
      failureCode: "transaction_failed",
      availableActions: { resume: true, reconcile: false },
      resultAvailable: false,
      reportAvailable: false,
    });
    expect(JSON.stringify(failed)).not.toContain("decline");
  }, 60_000);

  it("returns the same transaction for a repeated idempotency key", async () => {
    const first = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-0002" },
        body: JSON.stringify(startBody()),
      }),
    );
    const second = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-0002" },
        body: JSON.stringify(startBody()),
      }),
    );
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((await first.json()).transactionId).toBe((await second.json()).transactionId);
    await waitForStatus(transactionId("key-0002"), (status) => status.phase === "settled");
    expect(observed.cashu.prepareCalls).toBe(1);
  }, 60_000);

  it("rejects a missing idempotency key with 400", async () => {
    const res = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(startBody()),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request" });
  });

  it("serves a safe status DTO with no private material", async () => {
    const started = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-0003" },
        body: JSON.stringify(startBody()),
      }),
    );
    const { transactionId } = (await started.json()) as { transactionId: string };
    const status = await waitForStatus(transactionId, (candidate) => candidate.phase === "settled");
    expect(status.finalOutcome).toBe("settled");
    expect(status).toMatchObject({
      operationalState: "settled",
      selectedOffer: {
        amountSats: "350",
        unit: "sat",
      },
      requesterDecision: {
        source: "deterministic",
        recommendation: { action: "recommend", amountSats: "350" },
        authorized: true,
      },
      availableActions: { resume: false, reconcile: false },
      resultAvailable: true,
      reportAvailable: true,
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("PRIVATE-DOCUMENT");
    expect(serialized).not.toContain("PRIVATE-PROMPT");
    const allowedKeys = new Set([
      "transactionId",
      "kind",
      "phase",
      "operationalState",
      "agreementId",
      "selectedOffer",
      "requesterDecision",
      "availableActions",
      "resultAvailable",
      "reportAvailable",
      "failureCode",
      "agreementRootEventId",
      "finalOutcome",
      "resultReference",
      "escrowReference",
      "settlementReference",
      "refundReference",
      "reconciliationRequired",
      "reconciliationState",
    ]);
    for (const key of Object.keys(status)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  }, 60_000);

  it("serves a safe terminal report DTO", async () => {
    const started = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-0004" },
        body: JSON.stringify(startBody()),
      }),
    );
    const { transactionId } = (await started.json()) as { transactionId: string };
    await waitForStatus(transactionId, (status) => status.reportAvailable === true);

    const res = await getReport(
      authed(`http://localhost/api/transactions/${transactionId}/report`),
      { params: Promise.resolve({ id: transactionId }) },
    );
    expect(res.status).toBe(200);
    const report = (await res.json()) as { finalOutcome: string };
    expect(report.finalOutcome).toBe("settled");
    expect(JSON.stringify(report)).not.toContain("PRIVATE-DOCUMENT");
  }, 60_000);

  it("returns the private summary only to the authorized requester", async () => {
    const started = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-0005" },
        body: JSON.stringify(startBody()),
      }),
    );
    const { transactionId } = (await started.json()) as { transactionId: string };
    await waitForStatus(transactionId, (status) => status.resultAvailable === true);

    const res = await getResult(
      authed(`http://localhost/api/transactions/${transactionId}/result`),
      { params: Promise.resolve({ id: transactionId }) },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as { summary: string };
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  }, 60_000);

  it("redacts errors and never leaks internals", async () => {
    const res = await getStatus(
      authed("http://localhost/api/transactions/txn_missing"),
      { params: Promise.resolve({ id: "txn_missing" }) },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("transaction_not_found");
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it("resume and reconcile return the terminal outcome idempotently", async () => {
    const started = await postTransaction(
      authed("http://localhost/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-0006" },
        body: JSON.stringify(startBody()),
      }),
    );
    const { transactionId } = (await started.json()) as { transactionId: string };
    await waitForStatus(transactionId, (status) => status.phase === "settled");

    const resumed = await postResume(
      authed(`http://localhost/api/transactions/${transactionId}/resume`, { method: "POST" }),
      { params: Promise.resolve({ id: transactionId }) },
    );
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { finalOutcome: string }).finalOutcome).toBe("settled");

    const reconciled = await postReconcile(
      authed(`http://localhost/api/transactions/${transactionId}/reconcile`, { method: "POST" }),
      { params: Promise.resolve({ id: transactionId }) },
    );
    expect(reconciled.status).toBe(200);
    expect(((await reconciled.json()) as { finalOutcome: string }).finalOutcome).toBe("settled");
  }, 60_000);
});
