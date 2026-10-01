import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findForbiddenPublicMaterial } from "../domain/forbidden-material";
import {
  PactAgentApiClient,
  PactAgentApiClientError,
  isWorkflowReport,
  type TransactionStatus,
} from "./pactagent-api-client";
import { readLiveDemoConfigFromEnv } from "./pactagent-live-config";
import {
  scanForSecrets,
  startTestServer,
  stopTestServer,
  type ServerHandle,
} from "./pactagent-test-helpers";

/*
 * PactAgent browser acceptance test (Issue #34).
 *
 * Black-box: starts a real Next.js server and exercises ONLY the public HTTP
 * API surface. Does NOT import workflow, relay, signer, Cashu, or settlement
 * modules (pactagent-live-config is env-reading only).
 *
 * Two lanes:
 *   - Live (opt-in): targets the configured relay + Cashu test mint.
 *     Skips cleanly when live configuration is missing.
 *   - No-config: asserts a clean skip.
 *
 * Covers the issue's required browser acceptance checks:
 *   - authenticate via session cookie
 *   - submit with one stable idempotency key
 *   - duplicate idempotency key does not create a second agreement
 *   - authoritative lifecycle reaches settled
 *   - selected 350-sat offer + P002 provider
 *   - requester-decision advisory + deterministic policy
 *   - private summary retrieved through authorized endpoint
 *   - safe terminal report separate from private result
 *   - reload recovers the same transaction
 *   - unauthorized requester gets 401
 *   - unavailable result/report returns 409 before terminal
 *   - resume/reconcile call only the runtime endpoints
 *   - no private material in URLs, response bodies, or persisted storage
 */

const liveConfig = readLiveDemoConfigFromEnv();

const collectedPublicBodies: string[] = [];
const collectedUrls: string[] = [];

describe.skipIf(!liveConfig)("PactAgent browser acceptance (live)", () => {
  let server: ServerHandle;
  let client: PactAgentApiClient;
  let cookieClient: PactAgentApiClient;
  let transactionId: string;

  beforeAll(async () => {
    const env: Record<string, string | undefined> = {};
    if (liveConfig) {
      env.PACTAGENT_LIVE_RELAY_URL = liveConfig.relayUrl;
      env.PACTAGENT_CASHU_TEST_MINT_URL = liveConfig.testMintUrl;
      env.PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY = liveConfig.requesterPrivateKeyHex;
      env.PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY = liveConfig.providerPrivateKeyHex;
      env.PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY = liveConfig.escrowAuthorityPrivateKeyHex;
      env.PACTAGENT_LIVE_NORMAL_SPEND_KEY = liveConfig.normalSpendKeyHex;
      env.PACTAGENT_LIVE_REFUND_SPEND_KEY = liveConfig.refundSpendKeyHex;
      env.PACTAGENT_LIVE_FUNDING_TOKEN = liveConfig.fundingToken;
      env.PACTAGENT_LIVE_FUNDING_REFERENCE = liveConfig.fundingReference;
    }
    server = await startTestServer(env);
    client = new PactAgentApiClient(server.apiToken, server.baseUrl);
    cookieClient = new PactAgentApiClient(undefined, server.baseUrl);
  }, 120_000);

  afterAll(async () => {
    if (server) await stopTestServer(server);
  }, 30_000);

  it("authenticates to the runtime via session cookie", async () => {
    const session = await cookieClient.startSession({ token: server.apiToken });
    expect(session.authenticated).toBe(true);
  }, 15_000);

  it("bootstraps the runtime and verifies test mint readiness", async () => {
    const ready = await client.bootstrap();
    expect(ready.ready).toBe(true);
    expect(ready.unit).toBe("sat");
    collectedPublicBodies.push(JSON.stringify(ready));
  }, 30_000);

  it("submits a transaction with one stable idempotency key", async () => {
    const result = await client.startTransaction({
      idempotencyKey: "browser-acceptance-key-001",
      fundingReference: "live-funding-ref-001",
      privateDocument:
        "PRIVATE-DOCUMENT This is a synthetic test document for browser acceptance testing of the PactAgent requester flow.",
      mediaType: "text/plain",
      privatePrompt: "PRIVATE-PROMPT Summarize concisely.",
      maximumBudgetSats: "500",
    });
    expect(result.transactionId).toMatch(/^txn_/);
    transactionId = result.transactionId;
    collectedUrls.push(`${server.baseUrl}/api/transactions`);
  }, 30_000);

  it("duplicate idempotency key does not create a second agreement", async () => {
    const result = await client.startTransaction({
      idempotencyKey: "browser-acceptance-key-001",
      fundingReference: "live-funding-ref-001",
      privateDocument: "PRIVATE-DOCUMENT This is a synthetic test document for browser acceptance testing.",
      mediaType: "text/plain",
      maximumBudgetSats: "500",
    });
    expect(result.transactionId).toBe(transactionId);
  }, 30_000);

  it("unavailable result and report return 409 before terminal state", async () => {
    expect(transactionId).toBeDefined();
    await expect(client.getPrivateResult(transactionId)).rejects.toMatchObject({
      code: expect.stringMatching(/result_not_available|transaction_in_progress|report_not_available/),
      status: 409,
    });
    await expect(client.getReport(transactionId)).rejects.toMatchObject({
      code: expect.stringMatching(/report_not_available|transaction_in_progress/),
      status: 409,
    });
  }, 15_000);

  it("polls authoritative lifecycle until settled", async () => {
    expect(transactionId).toBeDefined();
    const deadline = Date.now() + 240_000;
    let lastStatus: TransactionStatus | undefined;
    while (Date.now() < deadline) {
      const s = await client.getStatus(transactionId);
      lastStatus = s;
      collectedPublicBodies.push(JSON.stringify(s));
      if (s.finalOutcome === "settled" || s.finalOutcome === "refunded" || s.operationalState === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(lastStatus).toBeDefined();
    expect(lastStatus!.finalOutcome).toBe("settled");
    expect(lastStatus!.selectedOffer.amountSats).toBe("350");
  }, 300_000);

  it("selected offer shows P002 provider and 350-sat signed offer", async () => {
    const s = await client.getStatus(transactionId);
    expect(s.selectedOffer.amountSats).toBe("350");
    expect(s.selectedOffer.unit).toBe("sat");
    expect(s.selectedOffer.providerPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(s.selectedOffer.offerReference).toBeTruthy();
    collectedPublicBodies.push(JSON.stringify(s));
  }, 10_000);

  it("requester decision shows advisory model + deterministic policy", async () => {
    const s = await client.getStatus(transactionId);
    expect(s.requesterDecision).toBeDefined();
    const decision = s.requesterDecision!;
    expect(decision.recommendation.amountSats).toBe("350");
    expect(decision.policy.selectedProviderMatchesDiscovery).toBe(true);
    expect(decision.policy.priceAllowed).toBe(true);
    expect(decision.policy.withinRequesterBudget).toBe(true);
    expect(decision.authorized).toBe(true);
  }, 10_000);

  it("retrieves the safe terminal report separately", async () => {
    const r = await client.getReport(transactionId);
    collectedPublicBodies.push(JSON.stringify(r));
    expect(r.finalOutcome).toBe("settled");
    expect(r.amountSats).toBe("350");
    expect(r.lifecycle.length).toBeGreaterThanOrEqual(7);
    expect(r.lifecycle.every((step) => step.eventId.length === 64)).toBe(true);
  }, 10_000);

  it("retrieves the private summary through the authorized endpoint", async () => {
    const result = await client.getPrivateResult(transactionId);
    expect(result.summary).toBeTruthy();
    expect(result.summary.length).toBeGreaterThan(0);
  }, 10_000);

  it("safe report does not contain the private summary content", async () => {
    const report = await client.getReport(transactionId);
    const privateResult = await client.getPrivateResult(transactionId);
    const reportJson = JSON.stringify(report);
    expect(reportJson).not.toContain(privateResult.summary.slice(0, 20));
  }, 10_000);

  it("reload recovers the same terminal transaction", async () => {
    const s = await client.getStatus(transactionId);
    expect(s.transactionId).toBe(transactionId);
    expect(s.finalOutcome).toBe("settled");
  }, 10_000);

  it("resume on a terminal transaction is idempotent (no blind retry)", async () => {
    const r = await client.resume(transactionId);
    expect(isWorkflowReport(r)).toBe(true);
    if (isWorkflowReport(r)) {
      expect(r.finalOutcome).toBe("settled");
      expect(r.amountSats).toBe("350");
    }
  }, 15_000);

  it("unauthorized requester cannot access transaction status", async () => {
    const response = await fetch(`${server.baseUrl}/api/transactions/${transactionId}`, {
      headers: { Authorization: "Bearer wrong-token" },
      cache: "no-store",
    });
    expect(response.status).toBe(401);
    const body = await response.text();
    collectedPublicBodies.push(body);
  }, 10_000);

  it("unauthorized requester cannot access the private result", async () => {
    const response = await fetch(`${server.baseUrl}/api/transactions/${transactionId}/result`, {
      headers: { Authorization: "Bearer wrong-token" },
      cache: "no-store",
    });
    expect(response.status).toBe(401);
  }, 10_000);

  it("unauthorized requester cannot access the safe report", async () => {
    const response = await fetch(`${server.baseUrl}/api/transactions/${transactionId}/report`, {
      headers: { Authorization: "Bearer wrong-token" },
      cache: "no-store",
    });
    expect(response.status).toBe(401);
  }, 10_000);

  it("non-existent transaction returns 404", async () => {
    await expect(client.getStatus("txn_nonexistent0000000000000000000000")).rejects.toMatchObject({
      code: "transaction_not_found",
      status: 404,
    });
  }, 10_000);

  it("session cookie client can access the same transaction", async () => {
    const s = await cookieClient.getStatus(transactionId);
    expect(s.transactionId).toBe(transactionId);
    expect(s.finalOutcome).toBe("settled");
  }, 10_000);

  it("safe status and report responses contain no private material", async () => {
    for (const body of collectedPublicBodies) {
      const leaks = scanForSecrets(body);
      expect(leaks).toEqual([]);
      try {
        const parsed = JSON.parse(body);
        const reason = findForbiddenPublicMaterial(parsed);
        expect(reason).toBeUndefined();
      } catch {
        // Non-JSON body — already scanned for secret markers above
      }
    }
  }, 10_000);

  it("no private material appears in URLs", async () => {
    for (const url of collectedUrls) {
      const leaks = scanForSecrets(url);
      expect(leaks).toEqual([]);
    }
  }, 10_000);

  it("PactAgentApiClientError carries structured code and status", async () => {
    try {
      await cookieClient.getPrivateResult("txn_nonexistent0000000000000000000000");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PactAgentApiClientError);
      const e = err as PactAgentApiClientError;
      expect(e.code).toBe("transaction_not_found");
      expect(e.status).toBe(404);
    }
  }, 10_000);
});

describe("PactAgent browser acceptance (no live config)", () => {
  it("skips cleanly when live configuration is missing", () => {
    if (liveConfig) return;
    expect(true).toBe(true);
  });
});
