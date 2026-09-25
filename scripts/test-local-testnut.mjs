import { randomUUID } from "node:crypto";

import {
  childEnvironmentWithCa,
  loadLocalEnvironment,
  resolveLocalCaPath,
  resolveLocalStatePath,
  runtimeBaseUrl,
} from "./local-env.mjs";
import { runLocalDoctor } from "./local-doctor.mjs";
import { nextBinary, runChecked } from "./local-process.mjs";
import { startCapturedRuntime, stopCapturedRuntime } from "./local-runtime-child.mjs";
import {
  cashuOperationSnapshot,
  inspectLocalState,
  settlementSnapshot,
} from "./local-state.mjs";

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { response, body };
}

async function waitForTerminalStatus(baseUrl, authorization, transactionId) {
  const deadline = Date.now() + 120_000;
  let activeObserved = false;
  let activeContractObserved = false;
  while (Date.now() < deadline) {
    const status = await jsonRequest(`${baseUrl}/api/transactions/${transactionId}`, {
      headers: { authorization },
    });
    if (!status.response.ok) throw new Error("Transaction status could not be read");
    const body = status.body;
    if (body?.phase !== "settled" && body?.phase !== "refunded") {
      activeObserved = true;
      activeContractObserved ||=
        typeof body?.selectedOffer?.providerPublicKey === "string" &&
        typeof body?.selectedOffer?.providerDefinitionReference === "string" &&
        typeof body?.selectedOffer?.offerReference === "string" &&
        typeof body?.selectedOffer?.escrowDescriptorReference === "string" &&
        body?.selectedOffer?.amountSats === "350" &&
        body?.selectedOffer?.unit === "sat" &&
        body?.requesterDecision?.source === "deterministic" &&
        body?.requesterDecision?.authorized === true &&
        body?.requesterDecision?.policy?.selectedProviderMatchesDiscovery === true &&
        body?.requesterDecision?.policy?.stableReferencesMatch === true &&
        body?.requesterDecision?.policy?.withinRequesterBudget === true &&
        body?.requesterDecision?.policy?.cashuCompatible === true &&
        body?.requesterDecision?.policy?.priceAllowed === true &&
        body?.requesterDecision?.policy?.executionDurationAllowed === true &&
        typeof body?.availableActions?.resume === "boolean" &&
        typeof body?.availableActions?.reconcile === "boolean";
    }
    if (
      body?.operationalState === "failed" ||
      body?.operationalState === "reconciliation_required" ||
      body?.operationalState === "resolved_not_funded" ||
      body?.phase === "refunded" ||
      body?.phase === "settled"
    ) {
      return { status, activeObserved, activeContractObserved };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Transaction did not reach an authoritative outcome in time");
}

function relayEvents(relayUrl, authors, since) {
  return new Promise((resolve, reject) => {
    const subscription = `acceptance-${Date.now()}`;
    const events = [];
    const socket = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Relay privacy scan timed out"));
    }, 15_000);
    const finish = (error) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(events);
    };
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", subscription, { authors, since, limit: 500 }]));
    });
    socket.addEventListener("message", (message) => {
      try {
        const value = JSON.parse(String(message.data));
        if (value[0] === "EVENT" && value[1] === subscription) events.push(value[2]);
        if (value[0] === "EOSE" && value[1] === subscription) finish();
      } catch {
        finish(new Error("Relay privacy scan returned malformed data"));
      }
    });
    socket.addEventListener("error", () => finish(new Error("Relay privacy scan failed")));
  });
}

async function failSafely(baseUrl, authorization, transactionId, startResult, before, stateDirectory) {
  const status = await jsonRequest(`${baseUrl}/api/transactions/${transactionId}`, {
    headers: { authorization },
  }).catch(() => undefined);
  const after = cashuOperationSnapshot(stateDirectory);
  const added = [...after.operations.keys()].filter((key) => !before.operations.has(key));
  console.error(`FAIL: controlled transaction stopped with ${String(startResult?.body?.code ?? "internal_error")}`);
  console.error(`Durable phase: ${String(status?.body?.phase ?? "unknown")}`);
  console.error(`New economic operation records: ${added.length}`);
  if (status?.body?.reconciliationRequired === true) {
    console.error("RECONCILIATION REQUIRED — no automatic retry was attempted");
  }
}

const baseEnvironment = loadLocalEnvironment();
const caPath = resolveLocalCaPath(baseEnvironment);
const environment = childEnvironmentWithCa(baseEnvironment, caPath);
const doctor = await runLocalDoctor({ environment });
if (!doctor.ok) {
  console.error("Refusing Testnut acceptance because local:doctor is not green.");
  process.exit(1);
}

const baseUrl = runtimeBaseUrl(environment);
try {
  const occupied = await fetch(`${baseUrl}/api/status`);
  if (occupied.ok) {
    console.error("Refusing Testnut acceptance while another PactAgent runtime owns the local API port.");
    process.exit(1);
  }
} catch {
  // Expected: this command owns and restarts its runtime child.
}

const token = environment.PACTAGENT_RUNTIME_API_TOKEN;
const fundingReference = environment.PACTAGENT_LIVE_FUNDING_REFERENCE;
const stateDirectory = resolveLocalStatePath(environment);
const authorization = `Bearer ${token}`;
const before = cashuOperationSnapshot(stateDirectory);
const beforeState = await inspectLocalState(stateDirectory);

console.log("Building the production-like runtime before the opt-in Testnut acceptance.");
await runChecked(process.execPath, [nextBinary, "build"], { env: environment });

let runtime;
let restartedRuntime;
let privateDocument;
let privatePrompt;
try {
  runtime = await startCapturedRuntime(environment, baseUrl);
  const bootstrap = await jsonRequest(`${baseUrl}/api/runtime/bootstrap`, {
    method: "POST",
    headers: { authorization },
  });
  if (!bootstrap.response.ok || bootstrap.body?.ready !== true) {
    throw new Error("Runtime bootstrap did not become ready");
  }

  const nonce = randomUUID();
  const idempotencyKey = `local-testnut-${nonce}`;
  privateDocument = `Controlled PactAgent Testnut document ${nonce}. This exact marker verifies the private result.`;
  privatePrompt = `Summarize only the controlled local Testnut document ${nonce}.`;
  const startedAt = Math.floor(Date.now() / 1000) - 5;
  const started = await jsonRequest(`${baseUrl}/api/transactions`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      privateDocument,
      mediaType: "text/plain",
      privatePrompt,
      maximumBudgetSats: 500,
      fundingReference,
    }),
  });
  if (!started.response.ok) {
    console.error(`FAIL: transaction acceptance stopped with ${String(started.body?.code ?? "internal_error")}`);
    process.exitCode = 1;
  } else {
    const transactionId = started.body?.transactionId;
    if (typeof transactionId !== "string") throw new Error("Runtime did not return a transaction ID");
    const observed = await waitForTerminalStatus(baseUrl, authorization, transactionId);
    const status = observed.status;
    if (status.body?.operationalState !== "settled") {
      await failSafely(baseUrl, authorization, transactionId, status, before, stateDirectory);
      process.exitCode = 1;
    } else {
      const [report, result] = await Promise.all([
        jsonRequest(`${baseUrl}/api/transactions/${transactionId}/report`, { headers: { authorization } }),
        jsonRequest(`${baseUrl}/api/transactions/${transactionId}/result`, { headers: { authorization } }),
      ]);
      const after = cashuOperationSnapshot(stateDirectory);
      const addedOperations = [...after.operations.entries()]
        .filter(([key]) => !before.operations.has(key))
        .map(([, value]) => value);
      const fundingSubmissions = addedOperations.filter(
        (operation) => operation.kind === "lock" && operation.status === "succeeded",
      ).length;
      const releaseSubmissions = addedOperations.filter(
        (operation) => operation.kind === "spend" && operation.status === "succeeded",
      ).length;
      const afterState = await inspectLocalState(stateDirectory);
      const newRoots = afterState.agreementRoots.filter(
        (root) => !beforeState.agreementRoots.includes(root),
      );
      const escrow = settlementSnapshot(stateDirectory).find(
        (entry) => entry.storeKey.startsWith("escrow:") &&
          entry.value?.agreementRoot === report.body?.agreementRootEventId,
      );
      const publicText = JSON.stringify({ status: status.body, report: report.body });
      const authors = [
        report.body?.requesterPublicKey,
        report.body?.providerPublicKey,
        report.body?.escrowAuthorityPublicKey,
      ];
      const events = authors.every((value) => typeof value === "string")
        ? await relayEvents(environment.PACTAGENT_LIVE_RELAY_URL, authors, startedAt)
        : [];
      const publicClean = !publicText.includes(privateDocument) && !publicText.includes(privatePrompt);
      const relayText = JSON.stringify(events);
      const relayClean = !relayText.includes(privateDocument) && !relayText.includes(privatePrompt);
      const logsClean = !runtime.logs().includes(privateDocument) && !runtime.logs().includes(privatePrompt);
      const lifecycle = Array.isArray(report.body?.lifecycle)
        ? report.body.lifecycle.map((entry) => entry.state)
        : [];
      const expectedLifecycle = [
        "accepted",
        "escrow_funded",
        "task_delivered",
        "result_submitted",
        "result_verified",
        "release_authorized",
        "settled",
      ];
      const assertions = [
        started.response.status === 202,
        started.body?.transactionId === transactionId,
        observed.activeObserved,
        observed.activeContractObserved,
        status.response.ok && status.body?.phase === "settled",
        status.body?.operationalState === "settled",
        status.body?.selectedOffer?.amountSats === "350" && status.body?.selectedOffer?.unit === "sat",
        status.body?.requesterDecision?.source === "deterministic",
        status.body?.requesterDecision?.authorized === true,
        status.body?.availableActions?.resume === false && status.body?.availableActions?.reconcile === false,
        status.body?.resultAvailable === true && status.body?.reportAvailable === true,
        report.response.ok && report.body?.amountSats === "350" && report.body?.finalOutcome === "settled",
        JSON.stringify(lifecycle) === JSON.stringify(expectedLifecycle),
        result.response.ok && result.body?.summary === privateDocument,
        fundingSubmissions === 1,
        releaseSubmissions === 1,
        addedOperations.length === 2,
        newRoots.length === 1 && newRoots[0] === report.body?.agreementRootEventId,
        escrow?.value?.state === "settled",
        publicClean && relayClean && logsClean,
        afterState.activeExposureSats === 0n,
        afterState.reconciliationOperations.length === 0,
        afterState.reconciliationEscrows.length === 0,
      ];
      if (assertions.some((value) => !value)) {
        console.error("FAIL: controlled Testnut transaction completed with an invariant mismatch");
        process.exitCode = 1;
      } else {
        await stopCapturedRuntime(runtime);
        runtime = undefined;
        restartedRuntime = await startCapturedRuntime(environment, baseUrl);
        const [reloadedStatus, reloadedReport] = await Promise.all([
          jsonRequest(`${baseUrl}/api/transactions/${transactionId}`, { headers: { authorization } }),
          jsonRequest(`${baseUrl}/api/transactions/${transactionId}/report`, { headers: { authorization } }),
        ]);
        if (
          !reloadedStatus.response.ok ||
          reloadedStatus.body?.phase !== "settled" ||
          reloadedStatus.body?.requesterDecision?.source !== "deterministic" ||
          reloadedStatus.body?.resultAvailable !== true ||
          reloadedStatus.body?.reportAvailable !== true ||
          !reloadedReport.response.ok ||
          reloadedReport.body?.finalOutcome !== "settled"
        ) {
          console.error("FAIL: durable reload did not remain settled");
          process.exitCode = 1;
        } else {
          console.log(JSON.stringify({
            transactionId,
            agreementRootEventId: report.body.agreementRootEventId,
            offerSats: report.body.amountSats,
            finalState: status.body.phase,
            fundingSubmissions,
            releaseSubmissions,
            privateResultCorrect: true,
            safeReport: true,
            privacyClean: true,
            durableReloadSettled: true,
          }, null, 2));
          console.log("CONTROLLED 350-SAT LOCAL ACCEPTANCE PASSED END TO END");
        }
      }
    }
  }
} catch {
  console.error("FAIL: controlled Testnut acceptance encountered a local runtime error");
  process.exitCode = 1;
} finally {
  if (restartedRuntime) await stopCapturedRuntime(restartedRuntime);
  if (runtime) await stopCapturedRuntime(runtime);
}
