import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RUNTIME_API_BASE = process.env.PACTAGENT_RUNTIME_API_BASE ?? "http://localhost:3000";
const UI_ORIGIN = process.env.PACTAGENT_REQUESTER_UI_ORIGIN ?? "http://localhost:3000";
const STATE_DIRECTORY = process.env.PACTAGENT_DEMO_STATE_DIRECTORY;
const RESTART_PHASE = process.env.PACTAGENT_REPEATABILITY_RESTART_PHASE === "true";

interface ApiBody extends Record<string, unknown> {
  readonly accountingPending: boolean;
  readonly balance: { readonly availableSats: number };
  readonly generation: number;
  readonly lifecycle: ReadonlyArray<{ readonly state: string }>;
  readonly operationalState: string;
  readonly phase: string;
  readonly selectedOffer: { readonly amountSats: string };
  readonly transactionId: string;
}

function requestHeaders(cookie?: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    origin: UI_ORIGIN,
    "sec-fetch-site": "same-origin",
    host: new URL(UI_ORIGIN).host,
    ...(cookie ? { cookie } : {}),
    ...extra,
  };
}

async function api(path: string, cookie?: string, init: RequestInit = {}): Promise<{
  readonly response: Response;
  readonly body: ApiBody;
}> {
  const response = await fetch(`${RUNTIME_API_BASE}${path}`, {
    ...init,
    headers: requestHeaders(cookie, init.headers as Record<string, string> | undefined),
    cache: "no-store",
  });
  const body = await response.json() as ApiBody;
  return { response, body };
}

async function waitForSettlement(transactionId: string, cookie: string): Promise<ApiBody> {
  const deadline = Date.now() + 180_000;
  let last: ApiBody | undefined;
  while (Date.now() < deadline) {
    const current = await api(`/api/requester/transactions/${transactionId}`, cookie);
    expect(current.response.status).toBe(200);
    last = current.body;
    if (["settled", "refunded", "resolved_not_funded", "failed", "reconciliation_required"]
      .includes(String(last.operationalState))) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Demo transaction timed out: ${JSON.stringify(last ?? {})}`);
}

function exposureSnapshot(): { activeSats: bigint; uncertainOperations: number; reservations: number } {
  if (!STATE_DIRECTORY) throw new Error("PACTAGENT_DEMO_STATE_DIRECTORY is required");
  const database = new DatabaseSync(join(STATE_DIRECTORY, "cashu-private.sqlite"), { readOnly: true });
  try {
    const ledgerRow = database.prepare(`
      SELECT value_json FROM pact_cashu_private_values WHERE store_key = 'exposure-ledger'
    `).get() as { value_json?: unknown } | undefined;
    const ledger = ledgerRow && typeof ledgerRow.value_json === "string"
      ? JSON.parse(ledgerRow.value_json) as { reservations?: Record<string, { amountSats?: string; status?: string }> }
      : {};
    const reservations = Object.values(ledger.reservations ?? {});
    const activeSats = reservations.reduce(
      (sum, reservation) => reservation.status === "released" || !/^\d+$/u.test(reservation.amountSats ?? "")
        ? sum
        : sum + BigInt(reservation.amountSats!),
      0n,
    );
    const operations = database.prepare(`
      SELECT value_json FROM pact_cashu_private_values WHERE store_key LIKE 'operation:%'
    `).all() as Array<{ value_json?: unknown }>;
    const uncertainOperations = operations.filter(({ value_json }) => {
      if (typeof value_json !== "string") return false;
      const operation = JSON.parse(value_json) as { status?: string };
      return operation.status === "submitted_unknown" || operation.status === "reconciliation_required";
    }).length;
    return { activeSats, uncertainOperations, reservations: reservations.length };
  } finally {
    database.close();
  }
}

const runtimeAvailable = await fetch(`${RUNTIME_API_BASE}/api/status`).then((response) => response.ok).catch(() => false);
const liveIt = runtimeAvailable && STATE_DIRECTORY ? it : it.skip;

describe("persisted Demo transaction repeatability", () => {
  liveIt(RESTART_PHASE
    ? "settles after a normal runtime restart using the same persisted state"
    : "settles three consecutive requester transactions without deleting persisted state", async () => {
    const initial = await api("/api/requester/demo");
    expect(initial.response.status).toBe(200);
    const setCookie = initial.response.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const cookie = setCookie!.split(";")[0];

    const started = await api("/api/requester/demo/start", cookie, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `repeatability-start-${RESTART_PHASE ? "restart" : "initial"}` },
      body: "{}",
    });
    expect(started.response.ok).toBe(true);

    const runCount = RESTART_PHASE ? 1 : 3;
    for (let index = 0; index < runCount; index += 1) {
      if (index > 0) {
        const reset = await api("/api/requester/demo/reset", cookie, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": `repeatability-reset-${index + 1}` },
          body: "{}",
        });
        expect(reset.response.ok).toBe(true);
      }

      const walletBefore = await api("/api/requester/demo", cookie);
      expect(walletBefore.response.status).toBe(200);
      expect(walletBefore.body.balance.availableSats).toBe(1000);
      expect(walletBefore.body.accountingPending).toBe(false);

      const label = RESTART_PHASE ? "restart-1" : `initial-${index + 1}`;
      const submitted = await api("/api/requester/transactions", cookie, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `repeatability-transaction-${label}` },
        body: JSON.stringify({
          privateDocument: `Persisted Demo repeatability acceptance ${label}.`,
          privatePrompt: "Summarize the document.",
          mediaType: "text/plain",
          maximumBudgetSats: 500,
        }),
      });
      expect(submitted.response.status).toBe(202);
      const transactionId = String(submitted.body.transactionId);
      const status = await waitForSettlement(transactionId, cookie);
      expect(status.phase).toBe("settled");
      expect(status.operationalState).toBe("settled");
      expect(status.selectedOffer.amountSats).toBe("350");

      const report = await api(`/api/requester/transactions/${transactionId}/report`, cookie);
      expect(report.response.status).toBe(200);
      expect(report.body.lifecycle.map(({ state }) => state)).toEqual([
        "accepted",
        "escrow_funded",
        "task_delivered",
        "result_submitted",
        "result_verified",
        "release_authorized",
        "settled",
      ]);

      const walletAfter = await api("/api/requester/demo", cookie);
      expect(walletAfter.response.status).toBe(200);
      expect(walletAfter.body.balance.availableSats).toBeLessThan(650);
      expect(walletAfter.body.balance.availableSats).toBeGreaterThan(0);
      expect(walletAfter.body.accountingPending).toBe(false);
      const exposure = exposureSnapshot();
      expect(exposure.activeSats).toBe(0n);
      expect(exposure.uncertainOperations).toBe(0);

      console.info(JSON.stringify({
        acceptance: "demo_repeatability",
        run: label,
        transactionId,
        generation: walletBefore.body.generation,
        startingBalanceSats: walletBefore.body.balance.availableSats,
        offerAmountSats: 350,
        lockAmountSats: 351,
        lifecycle: report.body.lifecycle.map(({ state }) => state),
        finalState: status.operationalState,
        finalBalanceSats: walletAfter.body.balance.availableSats,
        exposureLedger: {
          activeSats: exposure.activeSats.toString(),
          uncertainOperations: exposure.uncertainOperations,
          reservationRecords: exposure.reservations,
        },
      }));
    }
  }, 600_000);
});
