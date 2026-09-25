import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPactEscrowAuthoritySource,
  PACT_SERVICE_AGREEMENT_ROOT_TYPE,
  validatePactServiceAgreementRoot,
} from "../domain/pact-service-agreement";
import type { SignedNostrEvent } from "../domain/nostr";
import { buildFixture, transactionId } from "./pactagent-runtime-test-fixture";
import { createSqlitePactCashuEscrowSettlementStore } from "./cashu-escrow-settlement";

interface ProcessMessage {
  type: "checkpoint" | "ready" | "result" | "error" | "fatal";
  name?: string;
  transactionId?: string;
  report?: { agreementId: string; agreementRootEventId: string; finalOutcome: string };
  message?: string;
  port?: number;
}

interface RelayState {
  events: SignedNostrEvent[];
  connectCalls: number;
  disconnectCalls: number;
}

interface BackendState {
  prepareLockCalls: number;
  prepareSpendCalls: number;
  submitLockCalls: number;
  submitSpendCalls: number;
  inspectCalls: number;
  restoreCalls: number;
  callLog: string[];
}

interface RunningChild {
  child: ChildProcess;
  messages: ProcessMessage[];
  stdout: string[];
  stderr: string[];
  waitForMessage(predicate: (message: ProcessMessage) => boolean): Promise<ProcessMessage>;
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const CHILD_ENTRY = join(process.cwd(), "src", "lib", "pactagent-runtime-process-child.ts");
const VITE_NODE = join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs");
const VITE_CONFIG = join(process.cwd(), "vite.process.config.ts");
const IDEMPOTENCY_KEY = "process-idempotency-0001";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pactagent-process-"));
  directories.push(directory);
  return directory;
}

function spawnRuntime(
  directory: string,
  options: {
    action: "start" | "resume" | "status" | "signal" | "http";
    checkpoint?: "after_root" | "after_funding_success" | "after_ambiguous";
    transactionId?: string;
    submitMode?: "ambiguous" | "ambiguous_spend";
    inspectionMode?: "unspent" | "spent" | "pending" | "mixed";
  },
): RunningChild {
  const child = spawn(process.execPath, [VITE_NODE, "--config", VITE_CONFIG, CHILD_ENTRY], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PACTAGENT_RUNTIME_API_TOKEN: "PROCESS-AUTHORIZATION-MARKER",
      PACT_PROCESS_STATE_DIRECTORY: directory,
      PACT_PROCESS_ACTION: options.action,
      PACT_PROCESS_IDEMPOTENCY_KEY: IDEMPOTENCY_KEY,
      ...(options.checkpoint === undefined ? {} : { PACT_PROCESS_CHECKPOINT: options.checkpoint }),
      ...(options.transactionId === undefined
        ? {}
        : { PACT_PROCESS_TRANSACTION_ID: options.transactionId }),
      ...(options.submitMode === undefined ? {} : { PACT_PROCESS_SUBMIT_MODE: options.submitMode }),
      ...(options.inspectionMode === undefined
        ? {}
        : { PACT_PROCESS_INSPECTION_MODE: options.inspectionMode }),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: ProcessMessage[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const listeners = new Set<() => void>();
  let partial = "";
  child.stdout?.on("data", (chunk) => {
    const text = String(chunk);
    stdout.push(text);
    partial += text;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("PACT_PROCESS:")) continue;
      messages.push(JSON.parse(line.slice("PACT_PROCESS:".length)) as ProcessMessage);
      listeners.forEach((listener) => listener());
    }
  });
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

  return {
    child,
    messages,
    stdout,
    stderr,
    waitForMessage(predicate) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<ProcessMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Timed out waiting for child message. stderr=${stderr.join("")}`));
        }, 60_000);
        const check = () => {
          const message = messages.find(predicate);
          if (!message) return;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(message);
        };
        listeners.add(check);
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          listeners.delete(check);
          reject(new Error(
            `Child exited before checkpoint (${code}/${signal}). stdout=${stdout.join("")} stderr=${stderr.join("")}`,
          ));
        });
      });
    },
    waitForExit() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
      }
      return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    },
  };
}

async function hardKillAt(
  directory: string,
  options: Parameters<typeof spawnRuntime>[1],
  checkpoint: string,
): Promise<RunningChild> {
  const running = spawnRuntime(directory, options);
  await running.waitForMessage((message) => message.type === "checkpoint" && message.name === checkpoint);
  running.child.kill("SIGKILL");
  const exited = await running.waitForExit();
  expect(exited.signal ?? exited.code).not.toBeNull();
  return running;
}

async function runToExit(
  directory: string,
  options: Parameters<typeof spawnRuntime>[1],
): Promise<{ message: ProcessMessage; child: RunningChild }> {
  const child = spawnRuntime(directory, options);
  const message = await child.waitForMessage(
    (candidate) => candidate.type === "result" || candidate.type === "error" || candidate.type === "fatal",
  );
  const exited = await child.waitForExit();
  expect(exited).toEqual({ code: 0, signal: null });
  return { message, child };
}

function readState<T>(directory: string, file: string): T {
  return JSON.parse(readFileSync(join(directory, file), "utf8")) as T;
}

async function waitForHttpStatus(
  baseUrl: string,
  headers: Record<string, string>,
  transaction: string,
  predicate: (status: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/transactions/${transaction}`, { headers });
    const status = await response.json() as Record<string, unknown>;
    if (response.status === 200 && predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for HTTP transaction ${transaction}`);
}

function backendState(directory: string): BackendState {
  if (!existsSync(join(directory, "backend.json"))) {
    return {
      prepareLockCalls: 0,
      prepareSpendCalls: 0,
      submitLockCalls: 0,
      submitSpendCalls: 0,
      inspectCalls: 0,
      restoreCalls: 0,
      callLog: [],
    };
  }
  return readState<BackendState>(directory, "backend.json");
}

function relayState(directory: string): RelayState {
  return readState<RelayState>(directory, "relay.json");
}

function agreementRoots(directory: string): SignedNostrEvent[] {
  return relayState(directory).events.filter((event) =>
    event.tags.some((tag) => tag[0] === "t" && tag[1] === PACT_SERVICE_AGREEMENT_ROOT_TYPE),
  );
}

function agreementIdFromRoot(root: SignedNostrEvent): string {
  return (JSON.parse(root.content) as { agreement_id: string }).agreement_id;
}

function publicStates(directory: string): string[] {
  return relayState(directory).events.flatMap((event) =>
    event.tags.filter((tag) => tag[0] === "t").map((tag) => tag[1]),
  );
}

function privateStoreMarkers(directory: string): string[] {
  const database = new DatabaseSync(join(directory, "cashu-private.sqlite"), { readOnly: true });
  try {
    const rows = database.prepare("SELECT value_json FROM pact_cashu_private_values").all() as Array<{
      value_json: string;
    }>;
    const markers: string[] = [];
    const visit = (value: unknown, key?: string): void => {
      if (typeof value === "string") {
        if (
          [
            "privateSaltHex",
            "secret",
            "C",
            "witness",
            "privateBlindingMaterial",
            "spendingKeyHex",
          ].includes(key ?? "") &&
          value.length > 0
        ) {
          markers.push(value);
        }
      } else if (Array.isArray(value)) {
        value.forEach((entry) => visit(entry));
      } else if (typeof value === "object" && value !== null) {
        Object.entries(value).forEach(([entryKey, entry]) => visit(entry, entryKey));
      }
    };
    rows.forEach((row) => visit(JSON.parse(row.value_json) as unknown));
    return markers;
  } finally {
    database.close();
  }
}

function cashuRecoveryState(directory: string): {
  operationStatus?: string;
  preparedPresent: boolean;
  activeExposureSats: string;
} {
  const database = new DatabaseSync(join(directory, "cashu-private.sqlite"), { readOnly: true });
  try {
    const operationRows = database.prepare(
      "SELECT value_json FROM pact_cashu_private_values WHERE store_key LIKE 'operation:%'",
    ).all() as Array<{ value_json: string }>;
    const operation = operationRows
      .map((row) => JSON.parse(row.value_json) as { kind?: string; status?: string; prepared?: unknown })
      .find((value) => value.kind === "lock");
    const exposureRow = database.prepare(
      "SELECT value_json FROM pact_cashu_private_values WHERE store_key = 'exposure-ledger'",
    ).get() as { value_json?: string } | undefined;
    const exposure = exposureRow?.value_json
      ? JSON.parse(exposureRow.value_json) as {
          reservations?: Record<string, { amountSats: string; status: string }>;
        }
      : undefined;
    const activeExposure = Object.values(exposure?.reservations ?? {})
      .filter((reservation) => reservation.status !== "released")
      .reduce((total, reservation) => total + BigInt(reservation.amountSats), 0n);
    return {
      operationStatus: operation?.status,
      preparedPresent: operation?.prepared !== undefined,
      activeExposureSats: activeExposure.toString(),
    };
  } finally {
    database.close();
  }
}

function settlementState(directory: string): string | undefined {
  const database = new DatabaseSync(join(directory, "escrow-settlement.sqlite"), { readOnly: true });
  try {
    const rows = database.prepare(
      "SELECT value_json FROM pact_cashu_settlement_values WHERE store_key LIKE 'escrow:%'",
    ).all() as Array<{ value_json: string }>;
    return rows
      .map((row) => JSON.parse(row.value_json) as { state?: string })
      .find((record) => record.state !== undefined)?.state;
  } finally {
    database.close();
  }
}

async function installLegacyAuthoritySource(directory: string, offsetSeconds: number): Promise<void> {
  const fixture = buildFixture();
  const root = validatePactServiceAgreementRoot(agreementRoots(directory)[0], fixture.references);
  const legacySource = createPactEscrowAuthoritySource({
    root,
    references: fixture.references,
    authority: fixture.identities.escrowAuthoritySigner.publicKey,
    createdAt: root.event.created_at + offsetSeconds,
  });
  const signedLegacySource = await fixture.identities.providerSigner.sign(legacySource.event);
  const store = createSqlitePactCashuEscrowSettlementStore(
    join(directory, "escrow-settlement.sqlite"),
  );
  try {
    const binding = (await store.read(`agreement-escrow:${root.event.id}`)) as {
      escrowReference: string;
    };
    const key = `escrow:${binding.escrowReference}`;
    const record = (await store.read(key)) as { revision: number };
    await expect(store.compareAndSet(key, record.revision, {
      ...record,
      revision: record.revision + 1,
      escrowAuthoritySource: signedLegacySource.id,
    })).resolves.toBe(true);
  } finally {
    store.close();
  }
}

describe("PactAgent separate-process restart acceptance", () => {
  it("recovers a legacy +4 authority source through ALL-UNSPENT cleanup without submission", async () => {
    const directory = await stateDirectory();
    const started = await runToExit(directory, {
      action: "start",
      submitMode: "ambiguous",
    });
    expect(started.message).toMatchObject({
      type: "error",
      message: expect.stringContaining("reconciliation"),
    });
    expect(settlementState(directory)).toBe("funding_reconciliation_required");
    expect(cashuRecoveryState(directory)).toEqual({
      operationStatus: "submitted_unknown",
      preparedPresent: true,
      activeExposureSats: "351",
    });
    const before = backendState(directory);
    expect(before).toMatchObject({
      submitLockCalls: 1,
      submitSpendCalls: 0,
      inspectCalls: 0,
      restoreCalls: 0,
    });

    await installLegacyAuthoritySource(directory, 4);
    const recovered = await runToExit(directory, {
      action: "resume",
      transactionId: transactionId(IDEMPOTENCY_KEY),
    });
    expect(recovered.message).toMatchObject({
      type: "error",
      name: "PactAgentWorkflowError",
      message: "Escrow prepare or fund failed",
    });
    expect(cashuRecoveryState(directory)).toEqual({
      operationStatus: "not_submitted",
      preparedPresent: false,
      activeExposureSats: "0",
    });
    const after = backendState(directory);
    expect(after.submitLockCalls).toBe(before.submitLockCalls);
    expect(after.submitSpendCalls).toBe(before.submitSpendCalls);
    expect(after.inspectCalls).toBe(before.inspectCalls + 1);
    expect(after.restoreCalls).toBe(before.restoreCalls);
  }, 90_000);

  it("kills after agreement publication and resumes the same agreement before economic work", async () => {
    const directory = await stateDirectory();
    await hardKillAt(
      directory,
      { action: "start", checkpoint: "after_root" },
      "after_root",
    );
    const originalRoot = agreementRoots(directory);
    expect(originalRoot).toHaveLength(1);
    expect(backendState(directory).submitLockCalls).toBe(0);

    const resumed = await runToExit(directory, { action: "start" });
    expect(resumed.message.type).toBe("result");
    expect(resumed.message.transactionId).toBe(transactionId(IDEMPOTENCY_KEY));
    expect(resumed.message.report).toMatchObject({
      agreementId: agreementIdFromRoot(originalRoot[0]),
      agreementRootEventId: originalRoot[0].id,
      finalOutcome: "settled",
    });
    expect(agreementRoots(directory).map((event) => event.id)).toEqual([originalRoot[0].id]);
    expect(backendState(directory)).toMatchObject({
      prepareLockCalls: 1,
      submitLockCalls: 1,
      submitSpendCalls: 1,
    });
  }, 90_000);

  it("kills after durable Cashu funding success and reuses it before publishing escrow_funded", async () => {
    const directory = await stateDirectory();
    await hardKillAt(
      directory,
      { action: "start", checkpoint: "after_funding_success" },
      "after_funding_success",
    );
    const before = backendState(directory);
    const root = agreementRoots(directory)[0];
    expect(before).toMatchObject({ prepareLockCalls: 1, submitLockCalls: 1 });
    expect(publicStates(directory)).not.toContain("escrow_funded");

    const resumed = await runToExit(directory, {
      action: "resume",
      transactionId: transactionId(IDEMPOTENCY_KEY),
    });
    expect(resumed.message.report).toMatchObject({
      agreementId: agreementIdFromRoot(root),
      agreementRootEventId: root.id,
      finalOutcome: "settled",
    });
    const after = backendState(directory);
    expect(after.prepareLockCalls).toBe(before.prepareLockCalls);
    expect(after.submitLockCalls).toBe(before.submitLockCalls);
    expect(after.submitSpendCalls).toBe(1);
    expect(publicStates(directory)).toContain("escrow_funded");
    expect(agreementRoots(directory)).toHaveLength(1);
  }, 90_000);

  it("kills with submitted_unknown+prepared and restores ALL SPENT through NUT-07 then NUT-09", async () => {
    const directory = await stateDirectory();
    await hardKillAt(
      directory,
      { action: "start", checkpoint: "after_ambiguous", submitMode: "ambiguous" },
      "after_ambiguous",
    );
    const before = backendState(directory);
    expect(before).toMatchObject({ submitLockCalls: 1, inspectCalls: 0, restoreCalls: 0 });
    expect(publicStates(directory)).not.toContain("escrow_funded");

    const resumed = await runToExit(directory, {
      action: "resume",
      transactionId: transactionId(IDEMPOTENCY_KEY),
      inspectionMode: "spent",
    });
    expect(resumed.message.report?.finalOutcome).toBe("settled");
    const after = backendState(directory);
    expect(after.submitLockCalls).toBe(1);
    expect(after.inspectCalls).toBe(1);
    expect(after.restoreCalls).toBe(1);
    expect(after.submitSpendCalls).toBe(1);
    expect(after.callLog.slice(before.callLog.length, before.callLog.length + 2)).toEqual([
      "inspect",
      "restore",
    ]);
    expect(publicStates(directory)).toContain("escrow_funded");
  }, 90_000);

  it.each(["pending", "mixed"] as const)(
    "keeps %s ambiguity in reconciliation_required without public advancement or resubmit",
    async (inspectionMode) => {
      const directory = await stateDirectory();
      await hardKillAt(
        directory,
        { action: "start", checkpoint: "after_ambiguous", submitMode: "ambiguous" },
        "after_ambiguous",
      );
      const before = backendState(directory);
      const resumed = await runToExit(directory, {
        action: "resume",
        transactionId: transactionId(IDEMPOTENCY_KEY),
        inspectionMode,
      });
      expect(resumed.message).toMatchObject({
        type: "error",
        message: expect.stringContaining("reconciliation"),
      });
      const after = backendState(directory);
      expect(after.submitLockCalls).toBe(before.submitLockCalls);
      expect(after.inspectCalls).toBe(before.inspectCalls + 1);
      expect(after.restoreCalls).toBe(before.restoreCalls);
      expect(after.submitSpendCalls).toBe(0);
      expect(after.callLog[before.callLog.length]).toBe("inspect");
      expect(publicStates(directory)).not.toContain("escrow_funded");
      expect(agreementRoots(directory)).toHaveLength(1);
    },
    90_000,
  );

  it.each([
    ["funding", "ambiguous", "pending", "funding_reconciliation_required"],
    ["funding", "ambiguous", "mixed", "funding_reconciliation_required"],
    ["release", "ambiguous_spend", "pending", "release_reconciliation_required"],
    ["release", "ambiguous_spend", "mixed", "release_reconciliation_required"],
  ] as const)(
    "exposes redacted %s %s reconciliation through HTTP without resubmitting",
    async (economicStage, submitMode, inspectionMode, reconciliationState) => {
      const directory = await stateDirectory();
      const running = spawnRuntime(directory, {
        action: "http",
        submitMode,
        inspectionMode,
      });
      const ready = await running.waitForMessage((message) => message.type === "ready");
      const baseUrl = `http://127.0.0.1:${ready.port}`;
      const headers = {
        authorization: "Bearer PROCESS-AUTHORIZATION-MARKER",
        "content-type": "application/json",
      };
      const started = await fetch(`${baseUrl}/api/transactions`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": `process-${economicStage}-${inspectionMode}` },
        body: JSON.stringify({
          privateDocument: `Private ${economicStage} ${inspectionMode} reconciliation document.`,
          mediaType: "text/plain",
          maximumBudgetSats: 500,
          fundingReference: "funding-reference-process",
        }),
      });
      const transaction = transactionId(`process-${economicStage}-${inspectionMode}`);
      expect(started.status).toBe(202);
      await expect(started.json()).resolves.toEqual({ transactionId: transaction });
      const status = await waitForHttpStatus(
        baseUrl,
        headers,
        transaction,
        (candidate) =>
          candidate.reconciliationRequired === true &&
          (candidate.availableActions as { reconcile?: unknown } | undefined)?.reconcile === true,
      );
      expect(status).toMatchObject({
        transactionId: transaction,
        operationalState: "reconciliation_required",
        reconciliationRequired: true,
        reconciliationState,
        availableActions: { resume: false, reconcile: true },
      });
      const before = backendState(directory);
      const reconciled = await fetch(`${baseUrl}/api/transactions/${transaction}/reconcile`, {
        method: "POST",
        headers,
      });
      expect(reconciled.status).toBe(500);
      await expect(reconciled.json()).resolves.toMatchObject({
        code: "reconciliation_required",
      });
      const after = backendState(directory);
      expect(after.submitLockCalls).toBe(before.submitLockCalls);
      expect(after.submitSpendCalls).toBe(before.submitSpendCalls);
      expect(after.inspectCalls).toBe(before.inspectCalls + 1);
      if (economicStage === "funding") {
        expect(publicStates(directory)).not.toContain("escrow_funded");
      } else {
        expect(publicStates(directory)).toContain("release_authorized");
        expect(publicStates(directory)).not.toContain("settled");
      }
      running.child.send?.("shutdown-http");
      expect(await running.waitForExit()).toEqual({ code: 0, signal: null });
    },
    90_000,
  );

  it("returns the authoritative accepted status after ALL-UNSPENT funding cleanup", async () => {
    const directory = await stateDirectory();
    const running = spawnRuntime(directory, {
      action: "http",
      submitMode: "ambiguous",
      inspectionMode: "unspent",
    });
    const ready = await running.waitForMessage((message) => message.type === "ready");
    const baseUrl = `http://127.0.0.1:${ready.port}`;
    const headers = {
      authorization: "Bearer PROCESS-AUTHORIZATION-MARKER",
      "content-type": "application/json",
    };
    const idempotencyKey = "process-funding-unspent";
    const started = await fetch(`${baseUrl}/api/transactions`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": idempotencyKey },
      body: JSON.stringify({
        privateDocument: "Private funding all-unspent reconciliation document.",
        mediaType: "text/plain",
        maximumBudgetSats: 500,
        fundingReference: "funding-reference-process",
      }),
    });
    const transaction = transactionId(idempotencyKey);
    expect(started.status).toBe(202);
    await expect(started.json()).resolves.toEqual({ transactionId: transaction });
    await waitForHttpStatus(
      baseUrl,
      headers,
      transaction,
      (candidate) =>
        candidate.reconciliationRequired === true &&
        (candidate.availableActions as { reconcile?: unknown } | undefined)?.reconcile === true,
    );
    const before = backendState(directory);
    const reconciled = await fetch(`${baseUrl}/api/transactions/${transaction}/reconcile`, {
      method: "POST",
      headers,
    });
    expect(reconciled.status).toBe(200);
    const reconciledBody = await reconciled.json() as Record<string, unknown>;
    expect(reconciledBody).toEqual(expect.objectContaining({
      transactionId: transaction,
      kind: "successful",
      phase: "accepted",
    }));
    expect(reconciledBody.reconciliationRequired).toBeUndefined();
    expect(reconciledBody.reconciliationState).toBeUndefined();
    expect(reconciledBody.finalOutcome).toBeUndefined();
    expect(reconciledBody).toMatchObject({
      operationalState: "resolved_not_funded",
      availableActions: { resume: false, reconcile: false },
      resultAvailable: false,
      reportAvailable: false,
    });
    const after = backendState(directory);
    expect(after.submitLockCalls).toBe(before.submitLockCalls);
    expect(after.submitSpendCalls).toBe(before.submitSpendCalls);
    expect(after.inspectCalls).toBe(before.inspectCalls + 1);
    expect(after.restoreCalls).toBe(before.restoreCalls);
    expect(cashuRecoveryState(directory)).toEqual({
      operationStatus: "not_submitted",
      preparedPresent: false,
      activeExposureSats: "0",
    });
    expect(settlementState(directory)).toBe("prepared");
    expect(publicStates(directory)).not.toContain("escrow_funded");

    running.child.send?.("shutdown-http");
    expect(await running.waitForExit()).toEqual({ code: 0, signal: null });
  }, 90_000);

  it("keeps unique private markers out of actual HTTP, relay, URL, log, report, and metrics surfaces", async () => {
    const directory = await stateDirectory();
    const running = spawnRuntime(directory, { action: "http" });
    const ready = await running.waitForMessage((message) => message.type === "ready");
    expect(ready.port).toEqual(expect.any(Number));
    const baseUrl = `http://127.0.0.1:${ready.port}`;
    const authorization = "PROCESS-AUTHORIZATION-MARKER";
    const publicBodies: string[] = [];
    const urls: string[] = [];
    const request = async (
      path: string,
      init: RequestInit = {},
      isPrivateResult = false,
    ): Promise<{ response: Response; body: string }> => {
      const url = `${baseUrl}${path}`;
      urls.push(url);
      const response = await fetch(url, init);
      const body = await response.text();
      if (!isPrivateResult) publicBodies.push(body);
      return { response, body };
    };
    const authorizedHeaders = { authorization: `Bearer ${authorization}` };
    const started = await request("/api/transactions", {
      method: "POST",
      headers: {
        ...authorizedHeaders,
        "content-type": "application/json",
        "idempotency-key": "privacy-process-idempotency",
      },
      body: JSON.stringify({
        privateDocument: "PROCESS-DOCUMENT-MARKER PROCESS-RESULT-MARKER Bitcoin document.",
        privatePrompt: "PROCESS-PROMPT-MARKER Summarize privately.",
        mediaType: "text/plain",
        maximumBudgetSats: 500,
        fundingReference: "PROCESS-FUNDING-REFERENCE-MARKER",
      }),
    });
    expect(started.response.status).toBe(202);
    const startedBody = JSON.parse(started.body) as { transactionId: string };
    const transactionPath = `/api/transactions/${startedBody.transactionId}`;
    await waitForHttpStatus(
      baseUrl,
      authorizedHeaders,
      startedBody.transactionId,
      (candidate) => candidate.reportAvailable === true && candidate.resultAvailable === true,
    );
    const status = await request(transactionPath, { headers: authorizedHeaders });
    const report = await request(`${transactionPath}/report`, { headers: authorizedHeaders });
    const result = await request(
      `${transactionPath}/result`,
      { headers: authorizedHeaders },
      true,
    );
    expect(status.response.status).toBe(200);
    expect(report.response.status).toBe(200);
    expect(result.response.status).toBe(200);
    const summary = (JSON.parse(result.body) as { summary: string }).summary;
    expect(summary).toContain("PROCESS-DOCUMENT-MARKER");
    expect(summary).toContain("PROCESS-RESULT-MARKER");

    expect((await request(`${transactionPath}/result`)).response.status).toBe(401);
    expect((await request("/api/transactions", {
      method: "POST",
      headers: {
        ...authorizedHeaders,
        "content-type": "application/json",
        "idempotency-key": "privacy-invalid",
      },
      body: JSON.stringify({
        privateDocument: "PROCESS-DOCUMENT-MARKER",
        rawCashuToken: "PROCESS-RAW-TOKEN-MARKER",
      }),
    })).response.status).toBe(400);
    expect((await request("/api/metrics")).response.status).toBe(404);

    running.child.send?.("shutdown-http");
    expect(await running.waitForExit()).toEqual({ code: 0, signal: null });
    const privateMarkers = [
      "PROCESS-DOCUMENT-MARKER",
      "PROCESS-PROMPT-MARKER",
      "PROCESS-RESULT-MARKER",
      authorization,
      "PROCESS-FUNDING-REFERENCE-MARKER",
      "PROCESS-RAW-TOKEN-MARKER",
      "1f".repeat(32),
      "20".repeat(32),
      "21".repeat(32),
      "15".repeat(32),
      "16".repeat(32),
      ...privateStoreMarkers(directory),
    ];
    for (const body of publicBodies) {
      for (const marker of privateMarkers) expect(body).not.toContain(marker);
    }
    for (const url of urls) {
      for (const marker of privateMarkers) expect(url).not.toContain(marker);
    }
    for (const event of relayState(directory).events.map((entry) => JSON.stringify(entry))) {
      for (const marker of privateMarkers) expect(event).not.toContain(marker);
    }
    for (const output of [...running.stdout, ...running.stderr]) {
      for (const marker of privateMarkers) expect(output).not.toContain(marker);
    }
  }, 90_000);

  it("handles a real SIGTERM once, disconnects and closes durable stores, and exits bounded", async () => {
    const directory = await stateDirectory();
    const running = spawnRuntime(directory, { action: "signal" });
    await running.waitForMessage((message) => message.type === "ready");
    const started = Date.now();
    if (process.platform === "win32") running.child.send?.("emit-sigterm");
    else running.child.kill("SIGTERM");
    const exited = await running.waitForExit();
    expect(exited).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(relayState(directory)).toMatchObject({ connectCalls: 1, disconnectCalls: 1 });
    expect(readState<{ storeCloseCalls: number }>(directory, "lifecycle.json")).toEqual({
      storeCloseCalls: 1,
    });
  }, 30_000);
});
