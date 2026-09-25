import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_ROOT = resolve(PROJECT_ROOT, ".local");
export const DEFAULT_CA_PATH = resolve(LOCAL_ROOT, "pactagent-ca", "root.crt");
export const DEFAULT_STATE_PATH = resolve(LOCAL_ROOT, "pactagent-state");
export const COMPOSE_FILE = resolve(PROJECT_ROOT, "compose.local.yml");

export const REQUIRED_LOCAL_VARIABLES = Object.freeze([
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
]);

export function loadLocalEnvironment(base = process.env) {
  const loaded = { ...base };
  const path = resolve(PROJECT_ROOT, ".env");
  if (existsSync(path)) {
    const parsed = parseEnv(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (loaded[key] === undefined) loaded[key] = value;
    }
  }
  return loaded;
}

export function resolveProjectPath(value, fallback) {
  const selected = value?.trim() || fallback;
  return isAbsolute(selected) ? resolve(selected) : resolve(PROJECT_ROOT, selected);
}

export function resolveLocalCaPath(environment) {
  return resolveProjectPath(environment.PACTAGENT_LOCAL_CA_PATH, DEFAULT_CA_PATH);
}

export function resolveLocalStatePath(environment) {
  return resolveProjectPath(environment.PACTAGENT_LIVE_STATE_DIRECTORY, DEFAULT_STATE_PATH);
}

export function childEnvironmentWithCa(environment, caPath = resolveLocalCaPath(environment)) {
  return { ...environment, NODE_EXTRA_CA_CERTS: caPath };
}

export function missingRequiredVariables(environment) {
  return REQUIRED_LOCAL_VARIABLES.filter((name) => !environment[name]?.trim());
}

export function runtimeBaseUrl(environment) {
  return environment.PACTAGENT_RUNTIME_API_BASE?.trim() || "http://localhost:3000";
}
