import { mkdir, rename, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

import {
  LOCAL_ROOT,
  loadLocalEnvironment,
  resolveLocalStatePath,
} from "./local-env.mjs";
import { inspectLocalState, stateHasEconomicRisk } from "./local-state.mjs";

const forced = process.argv.includes("--force") || process.env.PACTAGENT_LOCAL_RESET_FORCE === "1";
if (!forced) {
  console.error("State reset requires explicit confirmation: npm run local:reset-state -- --force");
  process.exit(2);
}

const environment = loadLocalEnvironment();
const stateDirectory = resolveLocalStatePath(environment);
const localRelative = relative(LOCAL_ROOT, stateDirectory);
if (!localRelative || localRelative.startsWith("..") || resolve(LOCAL_ROOT, localRelative) !== stateDirectory) {
  console.error("Refusing to reset a state directory outside the project .local directory.");
  process.exit(1);
}

let exists = false;
try {
  exists = (await stat(stateDirectory)).isDirectory();
} catch {
  exists = false;
}
if (!exists) {
  await mkdir(stateDirectory, { recursive: true });
  console.log(`PASS: created fresh local state directory ${stateDirectory}`);
  process.exit(0);
}

const snapshot = await inspectLocalState(stateDirectory);
if (stateHasEconomicRisk(snapshot)) {
  console.error("Refusing reset: configured state contains active exposure, reconciliation, ambiguity, or an expired unresolved escrow.");
  process.exit(1);
}
if (snapshot.incompleteTransactions.length > 0) {
  console.error("Refusing reset: configured state contains incomplete transactions requiring operator review.");
  process.exit(1);
}

const archiveRoot = resolve(LOCAL_ROOT, "state-archive");
await mkdir(archiveRoot, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
const archivePath = resolve(archiveRoot, `${basename(stateDirectory)}-${timestamp}`);
await rename(stateDirectory, archivePath);
await mkdir(stateDirectory, { recursive: true });
console.log(`PASS: previous safe state archived at ${archivePath}`);
console.log(`PASS: created fresh local state directory ${stateDirectory}`);
