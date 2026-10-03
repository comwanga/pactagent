import { spawn } from "node:child_process";
import { resolve } from "node:path";

import {
  loadLocalEnvironment,
  preflightRequesterE2eLive,
  resolveLocalCaPath,
} from "./local-env.mjs";

const root = process.cwd();
const environment = loadLocalEnvironment();

const preflight = preflightRequesterE2eLive(environment);
if (preflight.action === "exit") {
  console.error(preflight.detail);
  process.exit(preflight.code);
}
if (preflight.action === "skip") {
  for (const category of preflight.categories) {
    console.log(`SKIP: ${category} unavailable.`);
  }
  console.log("SKIP: live requester browser acceptance was not run.");
  process.exit(0);
}

const caPath = resolveLocalCaPath(environment);

function configuredOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Live requester origin configuration is invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Live requester origin configuration is invalid");
  }
  if (["3410", "3411"].includes(url.port)) {
    throw new Error("Live requester origin points at the deterministic test lane");
  }
  return url.origin;
}

const requesterOrigin = configuredOrigin(environment.PACTAGENT_REQUESTER_UI_ORIGIN);
const runtimeOrigin = configuredOrigin(environment.PACTAGENT_RUNTIME_API_BASE);
if ([requesterOrigin, runtimeOrigin].some((origin) => origin.includes("/__test"))) {
  throw new Error("Live configuration points at a test-only endpoint");
}

let readiness;
try {
  readiness = await fetch(`${requesterOrigin}/`, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
} catch {
  throw new Error("Configured live requester application is unavailable");
}
if (!readiness.ok) {
  throw new Error(`Configured live requester application returned HTTP ${readiness.status}`);
}

const childEnvironment = {
  ...process.env,
  NODE_EXTRA_CA_CERTS: caPath,
  PACTAGENT_REQUESTER_UI_ORIGIN: requesterOrigin,
};

// The browser-test process receives only the public requester origin. The real
// Next/#33 processes were started separately with their server-only live
// configuration; Playwright neither needs nor receives any of those secrets.
for (const name of [
  "PACTAGENT_ECONOMIC_MODE",
  "PACTAGENT_RUNTIME_API_BASE",
  "PACTAGENT_RUNTIME_API_TOKEN",
  "PACTAGENT_LIVE_RELAY_URL",
  "PACTAGENT_CASHU_TEST_MINT_URL",
  "PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY",
  "PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY",
  "PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY",
  "PACTAGENT_LIVE_NORMAL_SPEND_KEY",
  "PACTAGENT_LIVE_REFUND_SPEND_KEY",
  "PACTAGENT_LIVE_FUNDING_TOKEN",
  "PACTAGENT_LIVE_FUNDING_REFERENCE",
  "PACTAGENT_LIVE_STATE_DIRECTORY",
  "PACTAGENT_REQUESTER_SESSION_DATABASE",
  "PACTAGENT_REQUESTER_MODEL_PROVIDER",
  "PACTAGENT_REQUESTER_MODEL_NAME",
  "PACTAGENT_REQUESTER_MODEL_API_KEY",
]) {
  delete childEnvironment[name];
}

console.log("LIVE: running black-box requester acceptance against the configured public origin.");
const playwright = spawn(process.execPath, [
  resolve(root, "node_modules", "@playwright", "test", "cli.js"),
  "test",
  "--config=playwright.live.config.ts",
  ...process.argv.slice(2),
], {
  cwd: root,
  env: childEnvironment,
  stdio: "inherit",
});

const exitCode = await new Promise((resolveExit) => {
  playwright.on("exit", (code) => resolveExit(code ?? 1));
});
process.exit(exitCode);
