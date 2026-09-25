import { existsSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CheckStateEnum,
  Mint,
  Wallet,
  getDecodedToken,
} from "@cashu/cashu-ts";

import {
  childEnvironmentWithCa,
  loadLocalEnvironment,
  missingRequiredVariables,
  resolveLocalCaPath,
  resolveLocalStatePath,
} from "./local-env.mjs";
import { runSync } from "./local-process.mjs";
import { inspectLocalState } from "./local-state.mjs";

const REQUIRED_NUTS = Object.freeze([7, 9, 10, 11]);
const ACCEPTANCE_AMOUNT_SATS = 350n;
const RESERVED_SPEND_FEE_SATS = 1n;

function withTimeout(promise, label, timeoutMs = 15_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

function checkPort(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(2_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function inspectContainer(name) {
  const result = runSync("docker", ["inspect", "--format", "{{json .State}}", name]);
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return undefined;
  }
}

function relayRead(relayUrl) {
  return new Promise((resolve, reject) => {
    const subscription = `doctor-${Date.now()}`;
    const socket = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("relay read timed out"));
    }, 8_000);
    const finish = (error) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(true);
    };
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", subscription, { limit: 1 }]));
    });
    socket.addEventListener("message", (message) => {
      try {
        const value = JSON.parse(String(message.data));
        if (value[0] === "EOSE" && value[1] === subscription) finish();
      } catch {
        finish(new Error("relay returned malformed data"));
      }
    });
    socket.addEventListener("error", () => finish(new Error("relay handshake failed")));
  });
}

function add(checks, ok, label, detail) {
  checks.push(Object.freeze({ ok, label, detail }));
}

export async function runLocalDoctor(options = {}) {
  const environment = options.environment ?? loadLocalEnvironment();
  const checks = [];
  const missing = missingRequiredVariables(environment);
  add(
    checks,
    missing.length === 0,
    "environment",
    missing.length === 0
      ? "all required variable names are present"
      : `missing variable names: ${missing.join(", ")}`,
  );

  const docker = runSync("docker", ["version", "--format", "{{.Server.Version}}"]).status === 0;
  add(checks, docker, "Docker", docker ? "daemon is available" : "daemon is unavailable");

  const strfry = docker ? inspectContainer("pactagent-local-strfry") : undefined;
  const caddy = docker ? inspectContainer("pactagent-local-caddy") : undefined;
  const strfryHealthy = strfry?.Running === true && strfry?.Health?.Status === "healthy";
  const caddyHealthy = caddy?.Running === true && caddy?.Health?.Status === "healthy";
  add(checks, strfryHealthy, "Strfry", strfryHealthy ? "running and healthy" : "not running and healthy");
  add(checks, caddyHealthy, "Caddy", caddyHealthy ? "running and healthy" : "not running and healthy");

  const [relayPort, tlsPort] = await Promise.all([checkPort(7777), checkPort(8443)]);
  add(checks, relayPort, "port 7777", relayPort ? "reachable" : "unreachable");
  add(checks, tlsPort, "port 8443", tlsPort ? "reachable" : "unreachable");

  const caPath = resolveLocalCaPath(environment);
  const caExists = existsSync(caPath);
  add(checks, caExists, "local CA", caExists ? `present at ${caPath}` : `missing at ${caPath}`);
  const expectedChildEnvironment = childEnvironmentWithCa(environment, caPath);
  const caInjected = process.env.NODE_EXTRA_CA_CERTS === expectedChildEnvironment.NODE_EXTRA_CA_CERTS;
  add(
    checks,
    caExists && caInjected,
    "runtime CA injection",
    caExists && caInjected ? "child received the resolved CA path before startup" : "launcher CA injection is unavailable",
  );

  const relayUrl = environment.PACTAGENT_LIVE_RELAY_URL;
  let nostrReadable = false;
  if (caExists && tlsPort && relayUrl) {
    try {
      await relayRead(relayUrl);
      nostrReadable = true;
    } catch {
      nostrReadable = false;
    }
  }
  add(checks, nostrReadable, "Nostr relay", nostrReadable ? "WSS handshake and read-only REQ/EOSE succeeded" : "WSS read failed");

  let fundingSummary;
  const mintUrl = environment.PACTAGENT_CASHU_TEST_MINT_URL;
  const fundingToken = environment.PACTAGENT_LIVE_FUNDING_TOKEN;
  if (mintUrl && fundingToken) {
    try {
      fundingSummary = await withTimeout((async () => {
        const mint = new Mint(mintUrl);
        const wallet = new Wallet(mint, { unit: "sat" });
        const [info, keysets] = await Promise.all([mint.getInfo(), mint.getKeySets(), wallet.loadMint()]);
        const activeSatKeysets = new Set(
          keysets.keysets
            .filter((keyset) => keyset.active === true && keyset.unit === "sat")
            .map((keyset) => keyset.id),
        );
        const decoded = getDecodedToken(fundingToken, keysets.keysets.map((keyset) => keyset.id));
        const states = await wallet.checkProofsStates(decoded.proofs);
        const unspentProofs = decoded.proofs.filter(
          (_, index) => states[index]?.state === CheckStateEnum.UNSPENT,
        );
        const availableSats = unspentProofs.reduce(
          (total, proof) => total + proof.amount.toBigInt(),
          0n,
        );
        const inputFeeSats = wallet.getFeesForProofs(unspentProofs).toBigInt();
        return Object.freeze({
          mintMatches: decoded.mint.replace(/\/+$/u, "") === mintUrl.replace(/\/+$/u, ""),
          unitSat: decoded.unit === undefined || decoded.unit === "sat",
          nuts: REQUIRED_NUTS.filter((nut) => info.nuts[String(nut)]?.supported === true),
          activeKeysetsAccepted: decoded.proofs.every((proof) => activeSatKeysets.has(proof.id)),
          proofCount: decoded.proofs.length,
          unspentCount: states.filter((state) => state.state === CheckStateEnum.UNSPENT).length,
          availableSats,
          estimatedRequiredSats: ACCEPTANCE_AMOUNT_SATS + RESERVED_SPEND_FEE_SATS + inputFeeSats,
        });
      })(), "Testnut inspection");
    } catch {
      fundingSummary = undefined;
    }
  }

  add(checks, fundingSummary !== undefined, "Testnut reachability", fundingSummary ? "read-only mint inspection succeeded" : "mint inspection failed");
  if (fundingSummary) {
    add(checks, fundingSummary.mintMatches, "funding mint", fundingSummary.mintMatches ? "matches configured Testnut mint" : "token belongs to another mint");
    add(checks, fundingSummary.unitSat, "funding unit", fundingSummary.unitSat ? "sat" : "not sat");
    const nutsOkay = fundingSummary.nuts.length === REQUIRED_NUTS.length;
    add(checks, nutsOkay, "mint capabilities", nutsOkay ? "NUT-07/09/10/11 available" : "required NUT capability missing");
    add(checks, fundingSummary.activeKeysetsAccepted, "funding keysets", fundingSummary.activeKeysetsAccepted ? "all proofs use active sat keysets" : "inactive or foreign keyset detected");
    const allUnspent = fundingSummary.proofCount > 0 && fundingSummary.unspentCount === fundingSummary.proofCount;
    add(checks, allUnspent, "funding proofs", allUnspent ? `${fundingSummary.unspentCount}/${fundingSummary.proofCount} UNSPENT` : `${fundingSummary.unspentCount}/${fundingSummary.proofCount} UNSPENT`);
    const sufficient = fundingSummary.availableSats >= fundingSummary.estimatedRequiredSats;
    add(checks, sufficient, "funding value", `${fundingSummary.availableSats} sats available; ${fundingSummary.estimatedRequiredSats} sats conservatively required`);
  }

  const stateDirectory = resolveLocalStatePath(environment);
  const state = await inspectLocalState(stateDirectory);
  add(checks, state.directoryExists, "state directory", state.directoryExists ? `exists at ${stateDirectory}` : `missing at ${stateDirectory}`);
  add(checks, state.directoryWritable, "state directory access", state.directoryWritable ? "readable and writable" : "not readable and writable");
  add(
    checks,
    state.inspectionErrors.length === 0,
    "state databases",
    state.inspectionErrors.length === 0
      ? "read-only inspection succeeded"
      : `${state.inspectionErrors.length} database file(s) could not be inspected`,
  );
  add(checks, state.activeExposureSats === 0n, "aggregate exposure", state.activeExposureSats === 0n ? "0 sats active" : `stale exposure ${state.activeExposureSats} sats in configured state directory`);
  add(checks, state.incompleteTransactions.length === 0, "incomplete transactions", state.incompleteTransactions.length === 0 ? "none" : `${state.incompleteTransactions.length} require operator review`);
  const reconciliationCount = state.reconciliationOperations.length + state.reconciliationEscrows.length;
  add(checks, reconciliationCount === 0, "reconciliation state", reconciliationCount === 0 ? "none" : `${reconciliationCount} operation(s) require reconciliation`);
  add(checks, state.expiredUnresolvedEscrows.length === 0, "expired escrows", state.expiredUnresolvedEscrows.length === 0 ? "none unresolved" : `${state.expiredUnresolvedEscrows.length} expired escrow(s) unresolved`);

  const ok = checks.every((check) => check.ok);
  if (options.print !== false) {
    for (const check of checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"}: ${check.label} — ${check.detail}`);
    }
    if (ok) console.log("PACTAGENT LOCAL ENVIRONMENT READY");
  }
  return Object.freeze({ ok, checks: Object.freeze(checks), environment, state, fundingSummary });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await runLocalDoctor();
  if (!result.ok) process.exitCode = 1;
}
