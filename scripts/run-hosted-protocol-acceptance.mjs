import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import WebSocket from "ws";

import { LOCAL_ROOT, loadLocalEnvironment } from "./local-env.mjs";
import { nextBinary, runChecked, runCommand, waitFor } from "./local-process.mjs";

/*
 * Container-backed acceptance harness for Issue #38 (hosted Nostr/P002).
 *
 * F38-02: This harness orchestrates the FULL production E2E path:
 *
 * 1. Hosted Strfry + Caddy (WSS) + Demo Mint infrastructure (docker compose hosted)
 *    with DETERMINISTIC ISOLATED relay state per run (F38-02C)
 * 2. Standalone PactAgent Provider Service (Node.js background PROCESS — NOT in-process)
 * 3. Actual Next.js requester/runtime server
 * 4. End-to-end protocol test through REAL HTTP BFF/runtime API (F38-02B)
 * 5. Relay persistence proof (F38-02E)
 *
 * Usage:
 *   node scripts/run-hosted-protocol-acceptance.mjs
 */

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const ACCEPTANCE_STATE = resolve(LOCAL_ROOT, "hosted-acceptance");
const ACCEPTANCE_CA_PATH = resolve(ACCEPTANCE_STATE, "caddy-root.crt");
const HOSTED_COMPOSE_FILE = resolve(PROJECT_ROOT, "compose.hosted.yml");

function openAcceptanceWebSocket(url) {
  return new WebSocket(url, { ca: readFileSync(ACCEPTANCE_CA_PATH) });
}

/*
 * F38-02C: Deterministic relay isolation.
 * Each acceptance run gets a unique Strfry data directory to prevent
 * stale provider advertisements from affecting selection.
 */
function uniqueRunId() {
  return Date.now().toString(36) + "-" + randomBytes(4).toString("hex");
}

async function reserveEphemeralPort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("Unable to reserve an acceptance port"));
        return;
      }
      const { port } = address;
      server.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

async function ensureInfrastructure(environment, runId, composeEnv) {
  console.log(`Starting hosted Strfry + Caddy (WSS) + Demo Mint infrastructure (run ${runId})...`);

  // Hosted and local edges intentionally use the same host ports. Stop only
  // the local relay edge; its persistent data is not removed and is restored
  // after acceptance.
  await runChecked("docker", ["compose", "-f", resolve(PROJECT_ROOT, "compose.local.yml"), "stop", "caddy", "strfry"], {
    env: environment,
  }).catch(() => undefined);

  // F38-02C: Clean only this unique acceptance project before starting.
  await runChecked("docker", ["compose", "-f", HOSTED_COMPOSE_FILE, "-p", composeEnv.COMPOSE_PROJECT_NAME, "down", "-v"], {
    env: composeEnv,
  }).catch(() => undefined);

  await runChecked("docker", [
    "compose",
    "-f",
    HOSTED_COMPOSE_FILE,
    "-p",
    `pactagent-hosted-${runId}`,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "60",
  ], { env: composeEnv });

  // Also start the demo mint from local compose
  await runChecked("docker", [
    "compose",
    "-f",
    resolve(PROJECT_ROOT, "compose.local.yml"),
    "up",
    "-d",
    "demo-mint",
    "--wait",
    "--wait-timeout",
    "60",
  ], { env: environment });

  await runChecked("docker", [
    "cp",
    "pactagent-hosted-caddy:/data/caddy/pki/authorities/local/root.crt",
    ACCEPTANCE_CA_PATH,
  ], { env: composeEnv });
  if (statSync(ACCEPTANCE_CA_PATH).size === 0) {
    throw new Error("Hosted acceptance Caddy root CA export is empty");
  }

  // Wait for Caddy WSS to be ready
  const wssUrl = environment.PACTAGENT_HOSTED_PROTOCOL_URL || "wss://localhost:8443";
  await waitFor(async () => {
    try {
      const socket = openAcceptanceWebSocket(wssUrl);
      return new Promise((resolvePromise) => {
        const timer = setTimeout(() => { socket.close(); resolvePromise(false); }, 3_000);
        socket.addEventListener("open", () => { clearTimeout(timer); socket.close(); resolvePromise(true); });
        socket.addEventListener("error", () => { clearTimeout(timer); resolvePromise(false); });
      });
    } catch { return false; }
  }, { timeoutMs: 30_000, intervalMs: 1_000 });

  console.log("PASS: Caddy WSS relay is ready");
}

async function startProviderService(environment) {
  console.log("Starting standalone PactAgent Provider Service process...");
  const child = spawn(process.execPath, [
    "--conditions=react-server",
    "--import", "tsx",
    resolve(PROJECT_ROOT, "scripts", "provider-start.mjs"),
  ], {
    cwd: PROJECT_ROOT,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let started = false;
  child.stdout?.on("data", (data) => {
    const text = String(data);
    if (text.includes("Provider Service started") || text.includes("provider_service_started")) {
      started = true;
    }
    if (process.env.PACTAGENT_ACCEPTANCE_VERBOSE) {
      console.log(`[provider] ${text.trim()}`);
    }
  });
  child.stderr?.on("data", (data) => {
    if (process.env.PACTAGENT_ACCEPTANCE_VERBOSE) {
      console.error(`[provider:err] ${String(data).trim()}`);
    }
  });

  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Provider process exited with code ${child.exitCode}`);
    if (!started) return false;
    try {
      const response = await fetch(environment.PACTAGENT_PROVIDER_READINESS_URL);
      if (!response.ok) return false;
      const readiness = await response.json();
      return readiness.processAlive === true &&
        readiness.protocolReady === true &&
        readiness.relayConnected === true &&
        readiness.artifactsPublished === true &&
        readiness.pollHealthy === true &&
        readiness.storeHealthy === true &&
        readiness.recoveryRequiredCount === 0;
    } catch {
      return false;
    }
  }, { timeoutMs: 30_000, intervalMs: 500 });
  console.log("PASS: Standalone Provider Service process is started and protocol-ready");
  return child;
}

async function startNextServer(environment) {
  console.log("Starting Next.js requester/runtime server...");
  const child = spawn(process.execPath, [nextBinary, "start"], {
    cwd: PROJECT_ROOT,
    env: { ...environment, NODE_ENV: "production" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let started = false;
  child.stdout?.on("data", (data) => {
    const text = String(data);
    if (text.includes("Ready") || text.includes("started server")) {
      started = true;
    }
    if (process.env.PACTAGENT_ACCEPTANCE_VERBOSE) {
      console.log(`[nextjs] ${text.trim()}`);
    }
  });
  child.stderr?.on("data", (data) => {
    if (process.env.PACTAGENT_ACCEPTANCE_VERBOSE) {
      console.error(`[nextjs:err] ${String(data).trim()}`);
    }
  });

  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`Next.js process exited with code ${child.exitCode}`);
    return Promise.resolve(started);
  }, { timeoutMs: 60_000, intervalMs: 1_000 });
  console.log("PASS: Next.js requester/runtime server is started");
  return child;
}

async function runAcceptanceTest(environment, testFile = "src/lib/hosted-protocol-full-e2e.live.test.ts") {
  console.log("Running hosted protocol full E2E acceptance tests...");
  const result = await runCommand(process.execPath, [
    resolve(PROJECT_ROOT, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--configLoader", "runner",
    "--config", "vitest.live.config.ts",
    "--maxWorkers=1",
    testFile,
  ], {
    cwd: PROJECT_ROOT,
    env: environment,
    stdio: "inherit",
  });

  if (result.code !== 0) {
    throw new Error(`Acceptance tests failed with code ${result.code}`);
  }
  console.log("PASS: Hosted protocol full E2E acceptance tests passed");
}

async function runHostedDoctor(environment) {
  console.log("Running hosted doctor against the live acceptance composition...");
  const result = await runCommand(process.execPath, [
    "--import", "tsx",
    resolve(PROJECT_ROOT, "scripts", "hosted-doctor.mjs"),
  ], {
    cwd: PROJECT_ROOT,
    env: environment,
    stdio: "inherit",
  });
  if (result.code !== 0) throw new Error(`Hosted doctor failed with code ${result.code}`);
  console.log("PASS: Hosted doctor verified the running provider, relay artifacts, and runtime composition");
}

/*
 * F38-02E: Actual Strfry persistence proof.
 * Publish a unique known harmless signed Nostr event, record its event ID,
 * query it before restart, stop Strfry, restart with same volume, query same ID.
 */
async function relayPersistenceProof(environment, composeEnv) {
  console.log("Testing relay persistence (F38-02E)...");
  const { generateSecretKey, finalizeEvent, getPublicKey } = await import("nostr-tools/pure");
  const { bytesToHex } = await import("nostr-tools/utils");

  // 1. Publish a unique known harmless signed Nostr event
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const uniqueTag = `persistence-probe-${Date.now()}-${bytesToHex(randomBytes(4))}`;
  const event = finalizeEvent({
    kind: 1,
    pubkey: pk,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["t", uniqueTag]],
    content: `PactAgent persistence probe ${uniqueTag}`,
  }, sk);

  const wssUrl = environment.PACTAGENT_HOSTED_PROTOCOL_URL || "wss://localhost:8443";
  // Publish + query before restart
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = openAcceptanceWebSocket(wssUrl);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["EVENT", event]));
    });
    socket.addEventListener("message", (msg) => {
      try {
        const value = JSON.parse(String(msg.data));
        if (value[0] === "OK" && value[1] === event.id) {
          socket.close();
          resolvePromise();
        }
      } catch { /* ignore */ }
    });
    socket.addEventListener("error", () => rejectPromise(new Error("publish failed")));
    setTimeout(() => { socket.close(); rejectPromise(new Error("publish timeout")); }, 5_000);
  });

  // 2. Query successfully before restart
  const foundBefore = await new Promise((resolvePromise) => {
    const socket = openAcceptanceWebSocket(wssUrl);
    const sub = `persistence-query-before-${Date.now()}`;
    let found = false;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", sub, { ids: [event.id] }]));
    });
    socket.addEventListener("message", (msg) => {
      try {
        const value = JSON.parse(String(msg.data));
        if (value[0] === "EVENT" && value[2]?.id === event.id) found = true;
        if (value[0] === "EOSE" && value[1] === sub) {
          socket.close();
          resolvePromise(found);
        }
      } catch { /* ignore */ }
    });
    socket.addEventListener("error", () => resolvePromise(false));
    setTimeout(() => { socket.close(); resolvePromise(false); }, 5_000);
  });

  if (!foundBefore) {
    throw new Error("F38-02E: Event not found before restart");
  }
  console.log(`PASS: Event ${event.id} found before restart`);

  // 3. Stop Strfry
  await runChecked("docker", ["compose", "-f", HOSTED_COMPOSE_FILE, "-p", composeEnv.COMPOSE_PROJECT_NAME, "stop", "strfry"], {
    env: composeEnv,
  });
  await new Promise((r) => setTimeout(r, 2_000));

  // 4. Restart Strfry with SAME volume
  await runChecked("docker", ["compose", "-f", HOSTED_COMPOSE_FILE, "-p", composeEnv.COMPOSE_PROJECT_NAME, "start", "strfry"], {
    env: composeEnv,
  });

  // Wait for WSS readiness
  await waitFor(async () => {
    try {
      const socket = openAcceptanceWebSocket(wssUrl);
      return new Promise((resolvePromise) => {
        const timer = setTimeout(() => { socket.close(); resolvePromise(false); }, 3_000);
        socket.addEventListener("open", () => { clearTimeout(timer); socket.close(); resolvePromise(true); });
        socket.addEventListener("error", () => { clearTimeout(timer); resolvePromise(false); });
      });
    } catch { return false; }
  }, { timeoutMs: 30_000, intervalMs: 1_000 });

  // 5. Query the EXACT SAME event ID after restart
  const foundAfter = await new Promise((resolvePromise) => {
    const socket = openAcceptanceWebSocket(wssUrl);
    const sub = `persistence-query-after-${Date.now()}`;
    let found = false;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", sub, { ids: [event.id] }]));
    });
    socket.addEventListener("message", (msg) => {
      try {
        const value = JSON.parse(String(msg.data));
        if (value[0] === "EVENT" && value[2]?.id === event.id) found = true;
        if (value[0] === "EOSE" && value[1] === sub) {
          socket.close();
          resolvePromise(found);
        }
      } catch { /* ignore */ }
    });
    socket.addEventListener("error", () => resolvePromise(false));
    setTimeout(() => { socket.close(); resolvePromise(false); }, 5_000);
  });

  if (!foundAfter) {
    throw new Error(`F38-02E: Event ${event.id} NOT found after restart — persistence failed`);
  }
  console.log(`PASS: Event ${event.id} found after restart (persistence proven)`);
}

async function cleanupInfrastructure(composeEnv, localEnvironment) {
  console.log("Cleaning up infrastructure...");
  await runChecked("docker", ["compose", "-f", HOSTED_COMPOSE_FILE, "-p", composeEnv.COMPOSE_PROJECT_NAME, "down", "-v"], {
    env: composeEnv,
  }).catch(() => undefined);
  await runChecked("docker", ["compose", "-f", resolve(PROJECT_ROOT, "compose.local.yml"), "up", "-d", "strfry", "caddy"], {
    env: localEnvironment,
  }).catch(() => undefined);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
}

async function main() {
  const repeatabilityAcceptance = process.argv.includes("--repeatability");
  const baseEnv = loadLocalEnvironment();
  const runId = uniqueRunId();
  const runtimePort = await reserveEphemeralPort();
  const providerReadinessPort = await reserveEphemeralPort();

  // Clean acceptance state
  rmSync(ACCEPTANCE_STATE, { recursive: true, force: true });
  mkdirSync(ACCEPTANCE_STATE, { recursive: true });

  const { generateSecretKey } = await import("nostr-tools/pure");
  const { bytesToHex } = await import("nostr-tools/utils");

  const providerPrivateKey = baseEnv.PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY || bytesToHex(generateSecretKey());
  const requesterPrivateKey = baseEnv.PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY || bytesToHex(generateSecretKey());
  const escrowPrivateKey = baseEnv.PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY || bytesToHex(generateSecretKey());

  const { getPublicKey } = await import("nostr-tools/pure");
  const escrowPubkey = getPublicKey(Uint8Array.from(Buffer.from(escrowPrivateKey, "hex")));
  const providerPubkey = getPublicKey(Uint8Array.from(Buffer.from(providerPrivateKey, "hex")));

  const wssUrl = "wss://localhost:8443";

  const sharedEnvironment = {
    ...baseEnv,
    PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY: requesterPrivateKey,
    PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY: providerPubkey,
    PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY: escrowPrivateKey,
    PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY: escrowPubkey,
    PACTAGENT_ECONOMIC_MODE: "demo",
    PACTAGENT_RUNTIME_MODE: "hosted",
    PACTAGENT_DEMO_CASHU_MINT_URL: "http://localhost:3338",
    PACTAGENT_DEMO_STATE_DIRECTORY: resolve(ACCEPTANCE_STATE, "demo-state"),
    PACTAGENT_DEMO_NORMAL_SPEND_KEY: bytesToHex(generateSecretKey()),
    PACTAGENT_DEMO_REFUND_SPEND_KEY: bytesToHex(generateSecretKey()),
    PACTAGENT_DEMO_FUNDING_REFERENCE: `hosted-acceptance-funding-${runId}`,
    PACTAGENT_DEMO_WALLET_INITIAL_BALANCE_SATS: "1000",
    PACTAGENT_LIVE_RELAY_URL: wssUrl,
    PACTAGENT_HOSTED_PROTOCOL_URL: wssUrl,
    PACTAGENT_HOSTED_WSS_HOSTNAME: "localhost",
    PACTAGENT_HOSTED_ACCEPTANCE: "true",
    PACTAGENT_RUNTIME_API_TOKEN: baseEnv.PACTAGENT_RUNTIME_API_TOKEN || "hosted-acceptance-token",
    PACTAGENT_RUNTIME_API_BASE: `http://localhost:${runtimePort}`,
    PACTAGENT_REQUESTER_UI_ORIGIN: `http://localhost:${runtimePort}`,
    PACTAGENT_PROVIDER_READINESS_URL: `http://127.0.0.1:${providerReadinessPort}/ready`,
    PACTAGENT_LOCAL_CA_PATH: ACCEPTANCE_CA_PATH,
    NODE_EXTRA_CA_CERTS: ACCEPTANCE_CA_PATH,
    PORT: String(runtimePort),
  };

  // The requester/runtime process receives provider PUBLIC identity only.
  const runtimeEnvironment = { ...sharedEnvironment };
  // Empty is intentional: loadLocalEnvironment must not refill this key from
  // the repository's developer .env inside the child process.
  runtimeEnvironment.PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY = "";

  // The standalone provider process alone receives its private authority.
  const providerEnvironment = {
    ...sharedEnvironment,
    PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: providerPrivateKey,
    PACTAGENT_PROVIDER_STATE_DIRECTORY: resolve(ACCEPTANCE_STATE, "provider-state"),
    PACTAGENT_PROVIDER_MODE: "hosted",
    PACTAGENT_PROVIDER_POLL_INTERVAL_MS: "1000",
    PACTAGENT_PROVIDER_READINESS_PORT: String(providerReadinessPort),
  };
  providerEnvironment.PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY = "";
  providerEnvironment.PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY = "";

  const composeEnv = {
    ...runtimeEnvironment,
    PACTAGENT_HOSTED_CADDYFILE: "Caddyfile-hosted-acceptance",
    COMPOSE_PROJECT_NAME: `pactagent-hosted-${runId}`,
  };

  let providerChild, nextChild;
  try {
    await ensureInfrastructure(runtimeEnvironment, runId, composeEnv);
    providerChild = await startProviderService(providerEnvironment);
    nextChild = await startNextServer(runtimeEnvironment);
    const acceptanceTestFile = repeatabilityAcceptance
      ? "src/lib/demo-repeatability-full-e2e.live.test.ts"
      : "src/lib/hosted-protocol-full-e2e.live.test.ts";
    await runAcceptanceTest(runtimeEnvironment, acceptanceTestFile);
    if (repeatabilityAcceptance) {
      console.log("Restarting the runtime against the same persisted Demo state...");
      await stopChild(nextChild);
      nextChild = await startNextServer(runtimeEnvironment);
      await runAcceptanceTest(
        { ...runtimeEnvironment, PACTAGENT_REPEATABILITY_RESTART_PHASE: "true" },
        acceptanceTestFile,
      );
    }
    await runHostedDoctor({
      ...runtimeEnvironment,
      PACTAGENT_PROVIDER_MODE: "hosted",
      PACTAGENT_PROVIDER_STATE_DIRECTORY: providerEnvironment.PACTAGENT_PROVIDER_STATE_DIRECTORY,
    });
    await relayPersistenceProof(runtimeEnvironment, composeEnv);
    console.log("\n========================================");
    console.log("ISSUE #38 HOSTED PROTOCOL ACCEPTANCE: PASS");
    console.log("========================================");
  } catch (error) {
    console.error(`\nISSUE #38 HOSTED PROTOCOL ACCEPTANCE: FAIL`);
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await stopChild(nextChild);
    await stopChild(providerChild);
    await cleanupInfrastructure(composeEnv, runtimeEnvironment);
  }
}

main();
