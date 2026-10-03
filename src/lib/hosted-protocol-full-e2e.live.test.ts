import { generateSecretKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { describe, expect, it } from "vitest";

import type { NostrPublicKey } from "../domain/nostr";
import { WebSocketNostrRelayAdapter } from "./nostr-relay";

const RELAY_URL = process.env.PACTAGENT_HOSTED_PROTOCOL_URL ?? "wss://localhost:8443";
const RUNTIME_API_BASE = process.env.PACTAGENT_RUNTIME_API_BASE ?? "http://localhost:3000";
const UI_ORIGIN = process.env.PACTAGENT_REQUESTER_UI_ORIGIN ?? "http://localhost:3000";

function isRelayAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(RELAY_URL);
    const timer = setTimeout(() => { socket.close(); resolve(false); }, 5_000);
    socket.addEventListener("open", () => { clearTimeout(timer); socket.close(); resolve(true); });
    socket.addEventListener("error", () => { clearTimeout(timer); resolve(false); });
  });
}

function isRuntimeAvailable(): Promise<boolean> {
  return fetch(`${RUNTIME_API_BASE}/api/status`)
    .then((r) => r.ok)
    .catch(() => false);
}

const relayAvailable = await isRelayAvailable();
const runtimeAvailable = await isRuntimeAvailable();
const configuredProvider = Boolean(process.env.PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY);
const liveIt = relayAvailable && runtimeAvailable && configuredProvider ? it : it.skip;

/*
 * F38-02B: Complete hosted-protocol E2E through REAL HTTP BFF/runtime API.
 *
 * This test does NOT:
 * - instantiate PactAgentProviderService in-process
 * - directly call EconomicEnvironment.startDemoWallet()
 * - directly call bindDemoTransactionFunding()
 * - directly call finalizeDemoTransaction()
 * - construct PactAgentWorkflow as the orchestration boundary
 * - use direct ws:// Strfry (uses Caddy WSS endpoint)
 *
 * The test exercises the production path:
 * REAL HTTP REQUESTER BOUNDARY
 * → requester BFF/session
 * → authenticated server/runtime transport
 * → production PactAgentRuntime
 * → externalProvider=true
 * → Caddy WSS
 * → Strfry
 * → standalone provider PROCESS
 * → P002 discovery
 * → agreement
 * → real #37 Demo Cashu funding
 * → NIP-59 private task
 * → provider decrypt/execution
 * → NIP-59 private result
 * → requester retrieval/verification
 * → coordinator settlement
 * → runtime-owned terminal persistence
 * → runtime-owned output collection
 * → authoritative Demo wallet balance.
 */

/*
 * F38-02D: Privacy sentinels.
 * Both TASK_SENTINEL and RESULT_SENTINEL are unique per test run.
 * The task sentinel is embedded in the private document/prompt.
 * The result sentinel is expected in the provider's result summary.
 * After terminal settlement, relay-visible events are scanned for leaks.
 */
const TASK_SENTINEL = `PACTAGENT_PRIVATE_TASK_SENTINEL_${bytesToHex(generateSecretKey()).slice(0, 8)}`;
const RESULT_SENTINEL = `PACTAGENT_RESULT_SENTINEL_${bytesToHex(generateSecretKey()).slice(0, 8)}`;

function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    "origin": UI_ORIGIN,
    "sec-fetch-site": "same-origin",
    "host": new URL(UI_ORIGIN).host,
    ...extra,
  };
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 120_000,
  intervalMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T;
  while (Date.now() < deadline) {
    lastValue = await fn();
    if (predicate(lastValue)) return lastValue;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

liveIt(
  "complete hosted-protocol E2E through real HTTP BFF/runtime API with Demo Cashu settlement",
  async () => {
    // --- Read provider public key from environment ---
    const providerPublicKey = process.env.PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY as NostrPublicKey;
    if (!providerPublicKey) throw new Error("PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY is required for hosted E2E");

    // --- 1. Establish requester session through the same status request the UI makes. ---
    // Start is intentionally unavailable until the BFF has issued an opaque,
    // HttpOnly requester session.
    let sessionCookie: string | undefined = undefined;
    const initialDemoResponse = await fetch(`${RUNTIME_API_BASE}/api/requester/demo`, {
      method: "GET",
      headers: apiHeaders(),
    });
    expect(initialDemoResponse.ok).toBe(true);
    const initialDemoBody = await initialDemoResponse.json();
    expect(initialDemoBody).toEqual({ economicMode: "demo", started: false });
    const initialSetCookie = initialDemoResponse.headers.get("set-cookie");
    sessionCookie = initialSetCookie ? initialSetCookie.split(";")[0] : undefined;
    expect(sessionCookie).toBeDefined();

    // --- 2. POST Start Demo through requester API ---
    const startDemoResponse = await fetch(`${RUNTIME_API_BASE}/api/requester/demo/start`, {
      method: "POST",
      headers: apiHeaders({
        "idempotency-key": "start-demo-acceptance-001",
        cookie: sessionCookie!,
      }),
      body: JSON.stringify({}),
    });
    if (!startDemoResponse.ok) {
      const errorBody = await startDemoResponse.json().catch(() => ({}));
      throw new Error(`Start Demo failed: ${startDemoResponse.status} ${JSON.stringify(errorBody)}`);
    }
    const startDemoBody = await startDemoResponse.json();
    expect(startDemoBody.generation).toBe(1);
    // Capture session cookie
    const setCookie = startDemoResponse.headers.get("set-cookie");
    if (setCookie) sessionCookie = setCookie.split(";")[0];

    // --- 3. Poll requester Demo status until started ---
    const demoStatusResponse = await fetch(`${RUNTIME_API_BASE}/api/requester/demo`, {
      method: "GET",
      headers: apiHeaders({ cookie: sessionCookie ?? "" }),
    });
    expect(demoStatusResponse.ok).toBe(true);
    const demoStatus = await demoStatusResponse.json();

    // --- 4. Assert authoritative initial balance = expected allocation ---
    expect(demoStatus.balance.availableSats).toBe(1000);
    expect(demoStatus.generation).toBe(1);

    // --- 5. Submit a real requester transaction through requester API ---
    // F38-02D: Task sentinel embedded in the private document.
    const submitResponse = await fetch(`${RUNTIME_API_BASE}/api/requester/transactions`, {
      method: "POST",
      headers: apiHeaders({
        "idempotency-key": `e2e-txn-${bytesToHex(generateSecretKey()).slice(0, 16)}`,
        cookie: sessionCookie!,
      }),
      body: JSON.stringify({
        privateDocument: `${TASK_SENTINEL} ${RESULT_SENTINEL} This is a test document about Bitcoin and Lightning Network protocols for the PactAgent hosted E2E test.`,
        privatePrompt: "Summarize the document.",
        mediaType: "text/plain",
        maximumBudgetSats: 500,
      }),
    });

    // The BFF may return 202 (accepted) or 200
    if (!submitResponse.ok && submitResponse.status !== 202) {
      const errorBody = await submitResponse.json().catch(() => ({}));
      throw new Error(`Transaction submission failed: ${submitResponse.status} ${JSON.stringify(errorBody)}`);
    }
    const accepted = await submitResponse.json();
    expect(accepted.transactionId).toBeDefined();
    const transactionId = accepted.transactionId;

    // --- 6-14. Runtime discovers provider, funds escrow, NIP-59 task, provider executes, result, settlement ---
    // All of this happens internally through the production PactAgentRuntime.

    // --- 15. Poll requester transaction status until terminal ---
    const finalStatus = await pollUntil(
      async () => {
        const resp = await fetch(`${RUNTIME_API_BASE}/api/requester/transactions/${transactionId}`, {
          method: "GET",
          headers: apiHeaders({ cookie: sessionCookie! }),
        });
        if (!resp.ok) throw new Error(`status failed: ${resp.status}`);
        return resp.json();
      },
      (status) => status.operationalState === "settled" || status.operationalState === "refunded" || status.phase === "settled" || status.phase === "refunded",
      180_000,
      3_000,
    );

    // --- 16. Assert terminal outcome = settled ---
    expect(finalStatus.phase === "settled" || finalStatus.operationalState === "settled").toBe(true);
    expect(finalStatus.selectedOffer.providerPublicKey).toBe(providerPublicKey);
    expect(finalStatus.selectedOffer.amountSats).toBe("350");

    // --- 17. Retrieve result through requester API ---
    const resultResponse = await fetch(`${RUNTIME_API_BASE}/api/requester/transactions/${transactionId}/result`, {
      method: "GET",
      headers: apiHeaders({ cookie: sessionCookie! }),
    });
    expect(resultResponse.ok).toBe(true);
    const resultBody = await resultResponse.json();
    expect(resultBody.summary).toBeDefined();
    expect(resultBody.summary).toContain(RESULT_SENTINEL);

    // --- 18. Query Demo wallet through requester API ---
    const finalWalletResponse = await fetch(`${RUNTIME_API_BASE}/api/requester/demo`, {
      method: "GET",
      headers: apiHeaders({ cookie: sessionCookie! }),
    });
    expect(finalWalletResponse.ok).toBe(true);
    const finalWallet = await finalWalletResponse.json();

    // --- 19. Assert accountingPending=false ---
    expect(finalWallet.accountingPending).toBe(false);

    // --- 20. Assert authoritative final balance reflects real settlement ---
    // The wallet started with 1000 sats. After settlement: balance < 1000 and > 0.
    expect(finalWallet.balance.availableSats).toBeLessThan(1000);
    expect(finalWallet.balance.availableSats).toBeGreaterThan(0);
    // The settled offer is 350 sats; Cashu protocol fees may account for a
    // small additional deduction, but the wallet must lose at least the
    // authoritative offer amount.
    expect(1000 - finalWallet.balance.availableSats)
      .toBeGreaterThanOrEqual(Number(finalStatus.selectedOffer.amountSats));

    // Safe, secret-free evidence emitted for the canonical acceptance report.
    console.info(JSON.stringify({
      acceptance: "hosted_protocol_full_e2e",
      transactionId,
      providerPublicKeyPrefix: providerPublicKey.slice(0, 12),
      phase: finalStatus.phase,
      operationalState: finalStatus.operationalState,
      offerAmountSats: finalStatus.selectedOffer.amountSats,
      initialBalanceSats: 1000,
      finalBalanceSats: finalWallet.balance.availableSats,
      accountingPending: finalWallet.accountingPending,
    }));

    // --- F38-02D: Privacy sentinel scan ---
    // After terminal settlement, inspect relay-visible events.
    // Scan event content AND tags for both sentinels.
    const relay = new WebSocketNostrRelayAdapter(RELAY_URL, {
      connectTimeoutMs: 10_000,
      defaultTimeoutMs: 30_000,
    });
    await relay.connect();
    try {
      const allEvents = await relay.queryEvents({ limit: 500 });
      const allContent = allEvents.map((e) => e.content).join("\n");
      const allTags = allEvents.map((e) => e.tags.map((t) => t.join(",")).join("\n")).join("\n");
      const allMetadata = allContent + "\n" + allTags;

      // Neither plaintext sentinel should be publicly observable.
      expect(allMetadata).not.toContain(TASK_SENTINEL);
      expect(allMetadata).not.toContain(RESULT_SENTINEL);
    } finally {
      await relay.disconnect().catch(() => undefined);
    }
  },
  300_000,
);

/*
 * Network critical-path negative checks.
 */
describe("hosted-protocol network critical-path negatives", () => {
  it("fails when Strfry is unavailable (relay URL points to nothing)", async () => {
    const relay = new WebSocketNostrRelayAdapter("ws://127.0.0.1:9999", {
      connectTimeoutMs: 3_000,
      defaultTimeoutMs: 5_000,
    });
    await expect(relay.connect()).rejects.toBeDefined();
    await relay.disconnect().catch(() => undefined);
  });

  it("fails when runtime API is unavailable", async () => {
    const resp = await fetch("http://localhost:9999/api/status").catch(() => null);
    expect(resp).toBeNull();
  });
});
