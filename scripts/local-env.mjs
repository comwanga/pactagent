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
  "PACTAGENT_ECONOMIC_MODE",
  "PACTAGENT_RUNTIME_API_TOKEN",
]);

export const REQUIRED_LIVE_VARIABLES = Object.freeze([
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

export const REQUIRED_DEMO_VARIABLES = Object.freeze([
  "PACTAGENT_DEMO_CASHU_MINT_URL",
  "PACTAGENT_DEMO_STATE_DIRECTORY",
  "PACTAGENT_DEMO_NORMAL_SPEND_KEY",
  "PACTAGENT_DEMO_REFUND_SPEND_KEY",
  "PACTAGENT_DEMO_FUNDING_REFERENCE",
  "PACTAGENT_LIVE_RELAY_URL",
  "PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY",
  "PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY",
  "PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY",
]);

export const SUPPORTED_ECONOMIC_MODES = Object.freeze(["demo", "live"]);

export function economicModeConfigurationStatus(environment) {
  const mode = environment.PACTAGENT_ECONOMIC_MODE?.trim();
  if (!mode) {
    return Object.freeze({ ok: false, mode: undefined, reason: "missing" });
  }
  if (!SUPPORTED_ECONOMIC_MODES.includes(mode)) {
    return Object.freeze({ ok: false, mode, reason: "invalid" });
  }
  return Object.freeze({ ok: true, mode, reason: undefined });
}

export const REQUIRED_REQUESTER_MODEL_VARIABLES = Object.freeze([
  "PACTAGENT_REQUESTER_MODEL_PROVIDER",
  "PACTAGENT_REQUESTER_MODEL_NAME",
  "PACTAGENT_REQUESTER_MODEL_API_KEY",
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

/**
 * Mode-aware economic state directory resolver (Issue #36, Blocker 6).
 *
 * Returns the demo state directory for demo mode and the live state directory
 * for live mode. Demo never resolves `PACTAGENT_LIVE_STATE_DIRECTORY`; live
 * never resolves `PACTAGENT_DEMO_STATE_DIRECTORY`.
 */
export function resolveEconomicStatePath(environment) {
  const mode = environment.PACTAGENT_ECONOMIC_MODE?.trim();
  if (mode === "demo") {
    return resolveProjectPath(
      environment.PACTAGENT_DEMO_STATE_DIRECTORY,
      resolve(LOCAL_ROOT, "pactagent-demo-state"),
    );
  }
  return resolveLocalStatePath(environment);
}

/**
 * Mode-aware economic mint URL resolver (Issue #36, Blocker 6). Returns the
 * demo mint URL for demo mode and the live mint URL for live mode. Demo never
 * resolves `PACTAGENT_CASHU_TEST_MINT_URL`; live never resolves
 * `PACTAGENT_DEMO_CASHU_MINT_URL`.
 */
export function resolveEconomicMintUrl(environment) {
  const mode = environment.PACTAGENT_ECONOMIC_MODE?.trim();
  if (mode === "demo") {
    return environment.PACTAGENT_DEMO_CASHU_MINT_URL?.trim();
  }
  return environment.PACTAGENT_CASHU_TEST_MINT_URL?.trim();
}

export function childEnvironmentWithCa(environment, caPath = resolveLocalCaPath(environment)) {
  return { ...environment, NODE_EXTRA_CA_CERTS: caPath };
}

export function missingRequiredVariables(environment) {
  const base = REQUIRED_LOCAL_VARIABLES.filter((name) => !environment[name]?.trim());
  const mode = environment.PACTAGENT_ECONOMIC_MODE?.trim();
  if (mode === "demo") {
    return [...base, ...REQUIRED_DEMO_VARIABLES.filter((name) => !environment[name]?.trim())];
  }
  if (mode === "live") {
    return [...base, ...REQUIRED_LIVE_VARIABLES.filter((name) => !environment[name]?.trim())];
  }
  return base;
}

export function requesterModelConfigurationStatus(environment) {
  const mode = environment.PACTAGENT_REQUESTER_DECISION_MODE?.trim() || "deterministic";
  if (mode === "deterministic") return Object.freeze({ ok: true, mode, missing: Object.freeze([]) });
  if (mode !== "model") {
    return Object.freeze({ ok: false, mode, missing: Object.freeze([]) });
  }
  const missing = REQUIRED_REQUESTER_MODEL_VARIABLES.filter(
    (name) => !environment[name]?.trim(),
  );
  const providerSupported = environment.PACTAGENT_REQUESTER_MODEL_PROVIDER?.trim() === "openai";
  return Object.freeze({
    ok: missing.length === 0 && providerSupported,
    mode,
    missing: Object.freeze(missing),
    providerSupported,
  });
}

export function runtimeBaseUrl(environment) {
  return environment.PACTAGENT_RUNTIME_API_BASE?.trim() || "http://localhost:3000";
}

/**
 * Real preflight validation for `runtime:start:local`.
 *
 * Extracted from scripts/runtime-start-local.mjs so tests can exercise the
 * actual decision path without spawning Next.js processes. Returns the
 * action the launcher should take: "proceed" or "exit" with a reason.
 *
 * The real entry point calls this function and then performs the action.
 */
export function preflightRuntimeStartLocal(environment) {
  const missing = missingRequiredVariables(environment);
  if (missing.length > 0) {
    return Object.freeze({
      action: "exit",
      code: 1,
      reason: "missing_variables",
      detail: `Missing required local environment variable names: ${missing.join(", ")}`,
    });
  }
  const economicMode = economicModeConfigurationStatus(environment);
  if (!economicMode.ok) {
    const detail = economicMode.reason === "missing"
      ? "PACTAGENT_ECONOMIC_MODE is missing"
      : economicMode.reason === "invalid"
        ? `PACTAGENT_ECONOMIC_MODE must be one of: demo, live (got: ${economicMode.mode})`
        : "PACTAGENT_ECONOMIC_MODE is invalid";
    return Object.freeze({
      action: "exit",
      code: 1,
      reason: economicMode.reason,
      detail: `Economic mode configuration error: ${detail}`,
    });
  }
  return Object.freeze({ action: "proceed" });
}

/**
 * Real preflight validation for `run-requester-e2e-live`.
 *
 * Extracted from scripts/run-requester-e2e-live.mjs so tests can exercise the
 * actual decision path without launching Playwright or fetching origins.
 *
 * Returns "proceed" (all config present and mode is live), "skip" (missing
 * config categories — safe skip), or "exit" (invalid/unavailable mode —
 * explicit configuration error).
 */
export function preflightRequesterE2eLive(environment) {
  const configurationCategories = [
    {
      label: "requester runtime authorization",
      names: [
        "PACTAGENT_RUNTIME_API_TOKEN",
        "PACTAGENT_RUNTIME_API_BASE",
        "PACTAGENT_REQUESTER_UI_ORIGIN",
      ],
    },
    {
      label: "live Nostr configuration",
      names: [
        "PACTAGENT_LIVE_RELAY_URL",
        "PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY",
        "PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY",
        "PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY",
      ],
    },
    {
      label: "Cashu test-mint configuration",
      names: [
        "PACTAGENT_CASHU_TEST_MINT_URL",
        "PACTAGENT_LIVE_NORMAL_SPEND_KEY",
        "PACTAGENT_LIVE_REFUND_SPEND_KEY",
        "PACTAGENT_LIVE_FUNDING_TOKEN",
        "PACTAGENT_LIVE_FUNDING_REFERENCE",
      ],
    },
    {
      label: "live state configuration",
      names: ["PACTAGENT_LIVE_STATE_DIRECTORY"],
    },
  ];

  const missingCategories = configurationCategories
    .filter(({ names }) => names.some((name) => !environment[name]?.trim()))
    .map(({ label }) => label);

  const requesterModel = requesterModelConfigurationStatus(environment);
  if (!requesterModel.ok) missingCategories.push("requester-decision configuration");

  const caPath = resolveLocalCaPath(environment);
  if (!existsSync(caPath)) missingCategories.push("local TLS/CA configuration");

  const economicMode = economicModeConfigurationStatus(environment);
  if (economicMode.reason === "missing") {
    missingCategories.push("economic mode configuration");
  } else if (!economicMode.ok) {
    const detail = economicMode.reason === "invalid"
      ? `PACTAGENT_ECONOMIC_MODE must be one of: demo, live (got: ${economicMode.mode})`
      : "PACTAGENT_ECONOMIC_MODE is invalid";
    return Object.freeze({
      action: "exit",
      code: 1,
      reason: economicMode.reason,
      detail: `Economic mode configuration error: ${detail}`,
    });
  }

  if (missingCategories.length > 0) {
    return Object.freeze({
      action: "skip",
      reason: "missing_categories",
      categories: Object.freeze([...new Set(missingCategories)]),
    });
  }

  return Object.freeze({ action: "proceed" });
}
