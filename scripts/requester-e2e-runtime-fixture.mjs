import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PACTAGENT_E2E_RUNTIME_PORT ?? "3411");
const TOKEN = process.env.PACTAGENT_RUNTIME_API_TOKEN ?? "e2e-runtime-token";
const transactions = new Map();
const idempotency = new Map();
const demoWallets = new Map();
const demoResetIdempotency = new Map();
const counts = {
  create: 0,
  status: 0,
  result: 0,
  report: 0,
  resume: 0,
  reconcile: 0,
  demoStart: 0,
  demoStatus: 0,
  demoReset: 0,
};
let sequence = 0;

const providerPublicKey = "22".repeat(32);

function json(response, status, body) {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "content-length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function selectedOffer() {
  return {
    providerPublicKey,
    providerDefinitionReference: "31990:provider:p002-e2e",
    offerReference: "offer-e2e-signed-reference",
    escrowDescriptorReference: "32121:provider:pip01-e2e",
    amountSats: "350",
    unit: "sat",
  };
}

function decision() {
  return {
    source: "model",
    recommendation: {
      action: "recommend",
      providerPublicKey,
      offerReference: "offer-e2e-signed-reference",
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
  };
}

function baseStatus(transaction) {
  return {
    transactionId: transaction.id,
    kind: "successful",
    phase: "accepted",
    operationalState: "active",
    agreementId: `agreement-${transaction.id}`,
    selectedOffer: selectedOffer(),
    requesterDecision: decision(),
    availableActions: { resume: false, reconcile: false, refund: false },
    resultAvailable: false,
    reportAvailable: false,
    agreementRootEventId: `root-${transaction.id}`,
  };
}

function settledStatus(transaction, availability = {}) {
  return {
    ...baseStatus(transaction),
    phase: "settled",
    operationalState: "settled",
    resultAvailable: availability.result ?? true,
    reportAvailable: availability.report ?? true,
    finalOutcome: "settled",
    resultReference: `result-${transaction.id}`,
    escrowReference: `escrow-${transaction.id}`,
    settlementReference: `settlement-${transaction.id}`,
  };
}

function status(transaction) {
  transaction.statusReads += 1;
  if (transaction.scenario === "reconciliation" && !transaction.reconciled) {
    return {
      ...baseStatus(transaction),
      phase: "release_authorized",
      operationalState: "reconciliation_required",
      resultAvailable: true,
      availableActions: { resume: false, reconcile: true, refund: false },
      reconciliationRequired: true,
      reconciliationState: "release_reconciliation_required",
      resultReference: `result-${transaction.id}`,
      escrowReference: `escrow-${transaction.id}`,
    };
  }
  if (transaction.scenario === "resume" && !transaction.resumed) {
    return {
      ...baseStatus(transaction),
      operationalState: "failed",
      availableActions: { resume: true, reconcile: false, refund: false },
      failureCode: "transaction_failed",
    };
  }
  if (transaction.scenario === "refund") {
    return {
      ...baseStatus(transaction),
      kind: "refund",
      phase: "refunded",
      operationalState: "refunded",
      reportAvailable: true,
      finalOutcome: "refunded",
      escrowReference: `escrow-${transaction.id}`,
      refundReference: `refund-${transaction.id}`,
    };
  }
  if (transaction.scenario === "failure") {
    return {
      ...baseStatus(transaction),
      operationalState: "failed",
      failureCode: "transaction_failed",
    };
  }
  if (transaction.scenario === "result-unavailable") {
    return settledStatus(transaction, { result: false, report: true });
  }
  if (transaction.scenario === "report-unavailable") {
    return settledStatus(transaction, { result: true, report: false });
  }
  if (transaction.statusReads === 1 && !transaction.reconciled && !transaction.resumed) {
    return baseStatus(transaction);
  }
  return settledStatus(transaction);
}

function report(transaction) {
  const refunded = transaction.scenario === "refund";
  return {
    workflowVersion: 1,
    agreementId: `agreement-${transaction.id}`,
    agreementRootEventId: `root-${transaction.id}`,
    requesterPublicKey: "11".repeat(32),
    providerPublicKey,
    escrowAuthorityPublicKey: "33".repeat(32),
    selectedReferences: {
      providerPublicKey,
      providerDefinitionReference: "31990:provider:p002-e2e",
      offerReference: "offer-e2e-signed-reference",
      escrowDescriptorReference: "32121:provider:pip01-e2e",
    },
    amountSats: "350",
    unit: "sat",
    lifecycle: refunded
      ? [{ state: "proposed", eventId: "event-proposed" }, { state: "refunded", eventId: "event-refunded" }]
      : [{ state: "proposed", eventId: "event-proposed" }, { state: "settled", eventId: "event-settled" }],
    escrowReference: `escrow-${transaction.id}`,
    ...(refunded
      ? { refundReference: `refund-${transaction.id}`, finalOutcome: "refunded" }
      : {
          resultReference: `result-${transaction.id}`,
          settlementReference: `settlement-${transaction.id}`,
          finalOutcome: "settled",
        }),
  };
}

function scenarioFrom(document) {
  for (const scenario of [
    "reconciliation",
    "resume",
    "refund",
    "failure",
    "result-unavailable",
    "report-unavailable",
  ]) {
    if (document.includes(`SCENARIO:${scenario}`)) return scenario;
  }
  return "success";
}

function transactionForPath(pathname) {
  const match = pathname.match(/^\/api\/transactions\/([A-Za-z0-9_-]+)(?:\/(result|report|resume|reconcile))?$/);
  if (!match) return undefined;
  return { transaction: transactions.get(match[1]), operation: match[2], id: match[1] };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  if (url.pathname === "/__test/state") {
    return json(response, 200, {
      counts,
      transactionIds: [...transactions.keys()],
      scenarios: Object.fromEntries([...transactions].map(([id, value]) => [id, value.scenario])),
    });
  }
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    return json(response, 401, { error: "Unauthorized", code: "unauthorized" });
  }
  if (url.pathname === "/api/runtime/start-demo" && request.method === "POST") {
    counts.demoStart += 1;
    try {
      const input = await body(request);
      if (typeof input.walletKey !== "string") throw new Error("invalid");
      const existing = demoWallets.get(input.walletKey);
      if (existing) return json(response, 200, { ok: true, generation: existing.generation });
      demoWallets.set(input.walletKey, { generation: 1, availableSats: 1000 });
      return json(response, 200, { ok: true, generation: 1 });
    } catch {
      return json(response, 400, { error: "Invalid", code: "invalid_request" });
    }
  }
  if (url.pathname === "/api/runtime/wallet-balance" && request.method === "POST") {
    counts.demoStatus += 1;
    try {
      const input = await body(request);
      if (typeof input.walletKey !== "string") throw new Error("invalid");
      const wallet = demoWallets.get(input.walletKey);
      if (!wallet) return json(response, 400, { error: "Not started", code: "invalid_request" });
      return json(response, 200, {
        generation: wallet.generation,
        availableSats: wallet.availableSats,
        resetAvailable: true,
        accountingPending: false,
      });
    } catch {
      return json(response, 400, { error: "Invalid", code: "invalid_request" });
    }
  }
  if (url.pathname === "/api/runtime/reset-demo" && request.method === "POST") {
    counts.demoReset += 1;
    try {
      const input = await body(request);
      if (typeof input.walletKey !== "string" || typeof input.idempotencyKey !== "string") {
        throw new Error("invalid");
      }
      const wallet = demoWallets.get(input.walletKey);
      if (!wallet) return json(response, 400, { error: "Not started", code: "invalid_request" });
      const resetKey = `${input.walletKey}:${input.idempotencyKey}`;
      const priorGeneration = demoResetIdempotency.get(resetKey);
      if (priorGeneration !== undefined) {
        return json(response, 200, { ok: true, generation: priorGeneration });
      }
      wallet.generation += 1;
      wallet.availableSats = 1000;
      demoResetIdempotency.set(resetKey, wallet.generation);
      return json(response, 200, { ok: true, generation: wallet.generation });
    } catch {
      return json(response, 400, { error: "Invalid", code: "invalid_request" });
    }
  }
  if (url.pathname === "/api/transactions" && request.method === "POST") {
    counts.create += 1;
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string") return json(response, 400, { error: "Invalid", code: "invalid_request" });
    const existing = idempotency.get(key);
    if (existing) return json(response, 202, { transactionId: existing });
    try {
      const input = await body(request);
      if (typeof input.privateDocument !== "string") throw new Error("invalid");
      sequence += 1;
      const id = `txn_e2e_${String(sequence).padStart(4, "0")}`;
      transactions.set(id, {
        id,
        scenario: scenarioFrom(input.privateDocument),
        statusReads: 0,
        reconciled: false,
        resumed: false,
      });
      idempotency.set(key, id);
      return json(response, 202, { transactionId: id });
    } catch {
      return json(response, 400, { error: "Invalid", code: "invalid_request" });
    }
  }
  const match = transactionForPath(url.pathname);
  if (!match?.transaction) return json(response, 404, { error: "Not found", code: "transaction_not_found" });
  const transaction = match.transaction;
  if (!match.operation && request.method === "GET") {
    counts.status += 1;
    return json(response, 200, status(transaction));
  }
  if (match.operation === "result" && request.method === "GET") {
    counts.result += 1;
    if (transaction.scenario === "result-unavailable") {
      return json(response, 409, { error: "Unavailable", code: "result_not_available" });
    }
    return json(response, 200, { summary: `PRIVATE-SUMMARY-FOR-${transaction.id}` });
  }
  if (match.operation === "report" && request.method === "GET") {
    counts.report += 1;
    if (transaction.scenario === "report-unavailable" || transaction.scenario === "failure") {
      return json(response, 409, { error: "Unavailable", code: "report_not_available" });
    }
    return json(response, 200, report(transaction));
  }
  if (match.operation === "resume" && request.method === "POST") {
    counts.resume += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    transaction.resumed = true;
    return json(response, 200, report(transaction));
  }
  if (match.operation === "reconcile" && request.method === "POST") {
    counts.reconcile += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    transaction.reconciled = true;
    return json(response, 200, settledStatus(transaction));
  }
  return json(response, 405, { error: "Invalid", code: "invalid_request" });
});

server.listen(PORT, HOST);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
