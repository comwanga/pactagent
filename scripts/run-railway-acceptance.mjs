import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

import {
  readRailwayServiceVariables,
  requireRailwayVariable,
} from "./railway-config.mjs";
import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";

/*
 * Issue #39 production acceptance runner.
 *
 * Drives the real public Railway deployment through the judge flow using
 * Playwright (e2e-live/railway-production.spec.ts), then performs a
 * READ-ONLY relay privacy scan proving the synthetic private task/result
 * material never appeared in public relay events.
 *
 * Secret values are read from Railway into memory only and are never
 * printed or passed to the browser test process.
 */

const root = process.cwd();
const webVariables = readRailwayServiceVariables("pactagent-web");

const webOrigin = requireRailwayVariable(webVariables, "PACTAGENT_REQUESTER_UI_ORIGIN", "pactagent-web");
const relayUrl = requireRailwayVariable(webVariables, "PACTAGENT_LIVE_RELAY_URL", "pactagent-web");
const providerPublicKey = requireRailwayVariable(webVariables, "PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY", "pactagent-web");
const requesterPrivateKey = requireRailwayVariable(webVariables, "PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY", "pactagent-web");

const requesterPublicKey = getPublicKey(hexToBytes(requesterPrivateKey));
const marker = `RAILWAY-ACCEPTANCE-${randomBytes(8).toString("hex")}`;

function configuredOrigin(value) {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Railway requester origin configuration is invalid");
  }
  return url.origin;
}

const requesterOrigin = configuredOrigin(webOrigin);

async function preflight() {
  const response = await fetch(`${requesterOrigin}/`, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Public web returned HTTP ${response.status}`);
}

function runPlaywright() {
  const childEnvironment = { ...process.env };
  // The browser-test process receives only the public origin and marker.
  for (const name of [
    "PACTAGENT_ECONOMIC_MODE",
    "PACTAGENT_RUNTIME_API_BASE",
    "PACTAGENT_RUNTIME_API_TOKEN",
    "PACTAGENT_LIVE_RELAY_URL",
    "PACTAGENT_CASHU_TEST_MINT_URL",
    "PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY",
    "PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY",
    "PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY",
    "PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY",
    "PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY",
    "PACTAGENT_LIVE_NORMAL_SPEND_KEY",
    "PACTAGENT_LIVE_REFUND_SPEND_KEY",
    "PACTAGENT_LIVE_FUNDING_TOKEN",
    "PACTAGENT_LIVE_FUNDING_REFERENCE",
    "PACTAGENT_LIVE_STATE_DIRECTORY",
    "PACTAGENT_DEMO_CASHU_MINT_URL",
    "PACTAGENT_DEMO_STATE_DIRECTORY",
    "PACTAGENT_DEMO_NORMAL_SPEND_KEY",
    "PACTAGENT_DEMO_REFUND_SPEND_KEY",
    "PACTAGENT_DEMO_FUNDING_REFERENCE",
    "PACTAGENT_REQUESTER_SESSION_DATABASE",
    "PACTAGENT_REQUESTER_MODEL_PROVIDER",
    "PACTAGENT_REQUESTER_MODEL_NAME",
    "PACTAGENT_REQUESTER_MODEL_API_KEY",
    "PACTAGENT_PROVIDER_MODE",
    "PACTAGENT_PROVIDER_STATE_DIRECTORY",
    "PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY",
    "MINT_PRIVATE_KEY",
  ]) {
    delete childEnvironment[name];
  }
  childEnvironment.PACTAGENT_REQUESTER_UI_ORIGIN = requesterOrigin;
  childEnvironment.PACTAGENT_RAILWAY_MARKER = marker;
  childEnvironment.PLAYWRIGHT_SPEC = "railway-production";

  const playwright = spawn(process.execPath, [
    resolve(root, "node_modules", "@playwright", "test", "cli.js"),
    "test",
    "--config=playwright.live.config.ts",
    "e2e-live/railway-production.spec.ts",
    ...process.argv.slice(2),
  ], {
    cwd: root,
    env: childEnvironment,
    stdio: "inherit",
  });

  return new Promise((resolveExit, reject) => {
    playwright.once("error", reject);
    playwright.once("exit", (code) => resolveExit(code ?? 1));
  });
}

function relayPrivacyScan() {
  return new Promise((resolveScan, reject) => {
    const subscription = `railway-privacy-${Date.now()}`;
    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("relay privacy scan timed out"));
    }, 30_000);
    const seen = [];
    let eose = false;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(["REQ", subscription, {
        authors: [requesterPublicKey, providerPublicKey],
        limit: 1000,
      }]));
    });
    ws.addEventListener("message", (message) => {
      let value;
      try {
        value = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (value[0] === "EVENT" && value[2]) seen.push(value[2]);
      if (value[0] === "EOSE" && value[1] === subscription) eose = true;
      if (eose) {
        clearTimeout(timer);
        ws.close();
        const serialized = JSON.stringify(seen);
        const leaked = serialized.includes(marker);
        resolveScan({ eventCount: seen.length, leaked });
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("relay privacy scan connection failed"));
    });
  });
}

async function main() {
  console.log(`Railway production acceptance — ${new Date().toISOString()}`);
  console.log(`Public web origin: ${requesterOrigin}`);
  console.log(`Relay URL: ${relayUrl}`);
  console.log(`Provider public key: ${providerPublicKey}`);

  await preflight();
  console.log("Preflight: public web reachable over trusted HTTPS.");

  console.log("Running the public judge-flow browser acceptance...");
  const exitCode = await runPlaywright();
  if (exitCode !== 0) {
    console.error("Railway production acceptance FAILED in the browser phase.");
    process.exit(exitCode);
  }

  console.log("Browser acceptance passed. Running the relay privacy scan...");
  const scan = await relayPrivacyScan();
  if (scan.leaked) {
    console.error(`Relay privacy scan FAILED: private marker present in ${scan.eventCount} inspected events.`);
    process.exit(1);
  }
  console.log(`Relay privacy scan PASS: no private material in ${scan.eventCount} inspected relay events.`);
  console.log("Railway production acceptance PASS.");
}

main().catch((error) => {
  console.error(`Railway production acceptance crashed: ${error.message}`);
  process.exit(1);
});
