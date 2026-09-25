import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

import { findForbiddenPublicMaterial } from "../domain/forbidden-material";
import { WebSocketNostrRelayAdapter } from "./nostr-relay";
import { readLiveDemoConfigFromEnv } from "./pactagent-workflow.live";

/*
 * Issue #33 black-box acceptance layer (opt-in, live only).
 *
 * Launches the built application (`next start`) as a separate process and
 * interacts only over HTTP with a bearer token — never importing the workflow,
 * runtime, or any `src/lib/*` internals. It drives the complete 350-sat golden
 * path against the explicitly configured test relay + Cashu test mint, then
 * kills and relaunches the process against the same SQLite files to exercise
 * restart recovery, and finally scans every public response and captured
 * process output for private markers.
 *
 * Requires `next build` first (see the `test:blackbox` script). Missing live
 * configuration skips the whole suite cleanly — never a fallback.
 */

const liveConfig = readLiveDemoConfigFromEnv();
const REPO_ROOT = process.cwd();
const NEXT_BIN = join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");
const LIVE_ENV_PREFIX = "PACTAGENT_LIVE_";

const collectedBodies: string[] = [];
const collectedPublicBodies: string[] = [];
const collectedOutput: string[] = [];
const collectedUrls: string[] = [];
const collectedRelayEvents: string[] = [];

interface ServerHandle {
  child: ChildProcess;
  baseUrl: string;
}

async function startServer(env: Record<string, string | undefined>): Promise<ServerHandle> {
  const port = 4500 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port), "-H", "localhost"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => collectedOutput.push(String(chunk)));
  child.stderr?.on("data", (chunk) => collectedOutput.push(String(chunk)));

  const baseUrl = `http://localhost:${port}`;
  await waitForReady(baseUrl, child);
  return { child, baseUrl };
}

async function waitForReady(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/status`);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Server did not become ready within 90s");
}

async function stopServer(server: ServerHandle): Promise<void> {
  if (server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      server.child.kill("SIGKILL");
      resolve();
    }, 5000);
    server.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function api(
  baseUrl: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  collectedUrls.push(`${baseUrl}${path}`);
  const body = await response.json();
  collectedBodies.push(JSON.stringify(body));
  if (!path.endsWith("/result")) collectedPublicBodies.push(JSON.stringify(body));
  return { response, body };
}

async function capturePublicSurface(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, init);
  collectedUrls.push(`${baseUrl}${path}`);
  collectedPublicBodies.push(await response.text());
  return response;
}

function readPrivateStoreMarkers(stateDir: string): string[] {
  const database = new DatabaseSync(join(stateDir, "cashu-private.sqlite"), { readOnly: true });
  try {
    const rows = database.prepare(
      "SELECT value_json FROM pact_cashu_private_values",
    ).all() as Array<{ value_json: string }>;
    const markers: string[] = [];
    const visit = (value: unknown, key?: string): void => {
      if (typeof value === "string") {
        if (["privateSaltHex", "secret", "C", "witness"].includes(key ?? "") && value.length > 0) {
          markers.push(value);
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry) => visit(entry));
        return;
      }
      if (typeof value === "object" && value !== null) {
        Object.entries(value).forEach(([entryKey, entry]) => visit(entry, entryKey));
      }
    };
    rows.forEach((row) => visit(JSON.parse(row.value_json) as unknown));
    return markers;
  } finally {
    database.close();
  }
}

describe.skipIf(!liveConfig)("PactAgent runtime black-box acceptance (live)", () => {
  const token = `bb-${randomBytes(12).toString("hex")}`;
  const idempotencyKey = `blackbox-${randomBytes(8).toString("hex")}`;
  const documentMarker = `PRIVATE-DOC-MARKER-${randomBytes(8).toString("hex")}`;
  const promptMarker = `PRIVATE-PROMPT-MARKER-${randomBytes(8).toString("hex")}`;
  const resultMarker = `PRIVATE-RESULT-MARKER-${randomBytes(8).toString("hex")}`;

  let stateDir: string;
  let server: ServerHandle | undefined;
  let transactionId: string;
  let agreementRootEventId: string;
  let privateStoreMarkers: string[] = [];

  afterAll(async () => {
    if (server) await stopServer(server);
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  it("completes the 350-sat golden path over HTTP only", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pactagent-bb-"));
    server = await startServer({
      PACTAGENT_RUNTIME_API_TOKEN: token,
      PACTAGENT_LIVE_STATE_DIRECTORY: stateDir,
    });

    const started = await api(server.baseUrl, token, "/api/transactions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({
        privateDocument: `${documentMarker} ${resultMarker} Bitcoin Lightning Cashu ecash escrow document.`,
        fundingReference: process.env.PACTAGENT_LIVE_FUNDING_REFERENCE,
        mediaType: "text/plain",
        privatePrompt: `${promptMarker} Summarize the settlement lifecycle.`,
        maximumBudgetSats: 500,
      }),
    });
    expect(started.response.status).toBe(202);
    expect(started.response.headers.get("location")).toBe(
      `/api/transactions/${(started.body as { transactionId: string }).transactionId}`,
    );
    transactionId = (started.body as { transactionId: string }).transactionId;

    const status = await api(server.baseUrl, token, `/api/transactions/${transactionId}`);
    expect(status.response.status).toBe(200);
    const statusBody = status.body as { finalOutcome?: string; agreementRootEventId: string };
    expect(statusBody.finalOutcome).toBe("settled");
    agreementRootEventId = statusBody.agreementRootEventId;

    const report = await api(server.baseUrl, token, `/api/transactions/${transactionId}/report`);
    expect(report.response.status).toBe(200);
    const reportBody = report.body as {
      finalOutcome: string;
      amountSats: string;
      unit: string;
      lifecycle: ReadonlyArray<{ state: string; eventId: string }>;
    };
    expect(reportBody.finalOutcome).toBe("settled");
    expect(reportBody.amountSats).toBe("350");
    expect(reportBody.unit).toBe("sat");
    // Canonical relay reconstruction: each lifecycle state appears exactly once, in order.
    expect(reportBody.lifecycle.map((entry) => entry.state)).toEqual([
      "proposed",
      "accepted",
      "escrow_funded",
      "task_delivered",
      "result_submitted",
      "result_verified",
      "release_authorized",
      "settled",
    ]);

    const result = await api(server.baseUrl, token, `/api/transactions/${transactionId}/result`);
    expect(result.response.status).toBe(200);
    const summary = (result.body as { summary: string }).summary;
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain(documentMarker);
    expect(summary).toContain(resultMarker);

    // The private document must never surface in public status/report DTOs.
    expect(JSON.stringify(statusBody)).not.toContain(documentMarker);
    expect(JSON.stringify(reportBody)).not.toContain(documentMarker);
    expect(JSON.stringify(statusBody)).not.toContain(promptMarker);
    expect(JSON.stringify(reportBody)).not.toContain(promptMarker);
    expect(JSON.stringify(statusBody)).not.toContain(resultMarker);
    expect(JSON.stringify(reportBody)).not.toContain(resultMarker);

    // The result endpoint is authorization-protected.
    const unauth = await capturePublicSurface(
      server.baseUrl,
      `/api/transactions/${transactionId}/result`,
    );
    expect(unauth.status).toBe(401);

    const validation = await capturePublicSurface(server.baseUrl, "/api/transactions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `${idempotencyKey}-invalid`,
      },
      body: JSON.stringify({ privateDocument: documentMarker, rawCashuToken: liveConfig?.fundingToken }),
    });
    expect(validation.status).toBe(400);
    const metrics = await capturePublicSurface(server.baseUrl, "/api/metrics");
    expect(metrics.status).toBe(404);

    privateStoreMarkers = readPrivateStoreMarkers(stateDir);
    const relay = new WebSocketNostrRelayAdapter(liveConfig!.relayUrl);
    await relay.connect();
    try {
      const events = await relay.queryEvents({ limit: 10_000 });
      collectedRelayEvents.push(...events.map((event) => JSON.stringify(event)));
    } finally {
      await relay.disconnect();
    }
  }, 180_000);

  it("resumes the same transaction after a process restart against the same SQLite files", async () => {
    expect(server).toBeDefined();
    await stopServer(server!);
    server = await startServer({
      PACTAGENT_RUNTIME_API_TOKEN: token,
      PACTAGENT_LIVE_STATE_DIRECTORY: stateDir,
    });

    const status = await api(server.baseUrl, token, `/api/transactions/${transactionId}`);
    expect(status.response.status).toBe(200);
    expect((status.body as { finalOutcome?: string }).finalOutcome).toBe("settled");

    const resume = await api(server.baseUrl, token, `/api/transactions/${transactionId}/resume`, {
      method: "POST",
    });
    expect(resume.response.status).toBe(200);
    const report = resume.body as { finalOutcome: string; agreementRootEventId: string };
    expect(report.finalOutcome).toBe("settled");
    // No second agreement: the reconstructed root must be the exact original event.
    expect(report.agreementRootEventId).toBe(agreementRootEventId);
  }, 180_000);

  it("emits no private material across responses, logs, or process output", () => {
    const privateMarkers = [
      documentMarker,
      promptMarker,
      resultMarker,
      token,
      ...privateStoreMarkers,
      liveConfig?.requesterPrivateKeyHex,
      liveConfig?.providerPrivateKeyHex,
      liveConfig?.escrowAuthorityPrivateKeyHex,
      liveConfig?.normalSpendKeyHex,
      liveConfig?.refundSpendKeyHex,
      liveConfig?.fundingToken,
      liveConfig?.fundingReference,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const body of collectedBodies) {
      expect(findForbiddenPublicMaterial(JSON.parse(body))).toBeUndefined();
    }
    for (const body of collectedPublicBodies) {
      for (const marker of privateMarkers) expect(body).not.toContain(marker);
    }
    for (const line of collectedOutput) {
      expect(findForbiddenPublicMaterial(line)).toBeUndefined();
      for (const marker of privateMarkers) expect(line).not.toContain(marker);
    }
    for (const url of collectedUrls) {
      for (const marker of privateMarkers) expect(url).not.toContain(marker);
    }
    for (const event of collectedRelayEvents) {
      expect(findForbiddenPublicMaterial(JSON.parse(event))).toBeUndefined();
      for (const marker of privateMarkers) expect(event).not.toContain(marker);
    }
  });

});

describe("PactAgent runtime black-box configuration failure", () => {
  it("fails explicitly when live configuration is missing, with no fallback", async () => {
    const token = `bb-missing-config-${randomBytes(12).toString("hex")}`;
    const stripped: Record<string, string | undefined> = { ...process.env };
    for (const key of Object.keys(stripped)) {
      if (key.startsWith(LIVE_ENV_PREFIX) || key === "PACTAGENT_CASHU_TEST_MINT_URL") {
        stripped[key] = undefined;
      }
    }
    stripped.PACTAGENT_RUNTIME_API_TOKEN = token;
    const noConfig = await startServer(stripped);
    try {
      const res = await fetch(`${noConfig.baseUrl}/api/transactions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": "no-config",
        },
        body: JSON.stringify({
          privateDocument: "x",
          mediaType: "text/plain",
          maximumBudgetSats: 500,
          fundingReference: "missing-config-funding",
        }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("invalid_configuration");
      expect(findForbiddenPublicMaterial(body)).toBeUndefined();
    } finally {
      await stopServer(noConfig);
    }
  }, 180_000);
});
