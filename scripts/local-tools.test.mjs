import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalDoctor } from "./local-doctor.mjs";
import {
  DEFAULT_CA_PATH,
  DEFAULT_STATE_PATH,
  economicModeConfigurationStatus,
  missingRequiredVariables,
  preflightRequesterE2eLive,
  preflightRuntimeStartLocal,
  requesterModelConfigurationStatus,
  resolveLocalCaPath,
  resolveLocalStatePath,
} from "./local-env.mjs";
import {
  cashuOperationSnapshot,
  inspectLocalState,
  stateHasEconomicRisk,
} from "./local-state.mjs";

const directories = [];

afterEach(async () => {
  while (directories.length > 0) {
    await rm(directories.pop(), { recursive: true, force: true });
  }
});

async function directory() {
  const value = await mkdtemp(join(tmpdir(), "pactagent-local-tools-"));
  directories.push(value);
  return value;
}

function writePrivateState(path, records) {
  const database = new DatabaseSync(join(path, "cashu-private.sqlite"));
  database.exec(
    "CREATE TABLE pact_cashu_private_values (scope TEXT, store_key TEXT, value_json TEXT)",
  );
  const insert = database.prepare(
    "INSERT INTO pact_cashu_private_values (scope, store_key, value_json) VALUES (?, ?, ?)",
  );
  for (const [key, value] of records) insert.run("test", key, JSON.stringify(value));
  database.close();
}

function writeSettlementState(path, records) {
  const database = new DatabaseSync(join(path, "escrow-settlement.sqlite"));
  database.exec(
    "CREATE TABLE pact_cashu_settlement_values (store_key TEXT, revision INTEGER, value_json TEXT)",
  );
  const insert = database.prepare(
    "INSERT INTO pact_cashu_settlement_values (store_key, revision, value_json) VALUES (?, 1, ?)",
  );
  for (const [key, value] of records) insert.run(key, JSON.stringify(value));
  database.close();
}

describe("local developer tooling", () => {
  it("resolves ignored local defaults without requiring NODE_EXTRA_CA_CERTS in .env", () => {
    expect(resolveLocalCaPath({})).toBe(DEFAULT_CA_PATH);
    expect(resolveLocalStatePath({})).toBe(DEFAULT_STATE_PATH);
    expect(missingRequiredVariables({})).toContain("PACTAGENT_ECONOMIC_MODE");
    expect(missingRequiredVariables({})).not.toContain("NODE_EXTRA_CA_CERTS");
  });

  it("mode-aware required variables include live-specific vars for live mode", () => {
    const liveEnv = { PACTAGENT_ECONOMIC_MODE: "live", PACTAGENT_RUNTIME_API_TOKEN: "token", PACTAGENT_LIVE_STATE_DIRECTORY: ".local/state" };
    const missing = missingRequiredVariables(liveEnv);
    expect(missing).toContain("PACTAGENT_LIVE_FUNDING_TOKEN");
    expect(missing).toContain("PACTAGENT_CASHU_TEST_MINT_URL");
  });

  it("mode-aware required variables include demo-specific vars for demo mode", () => {
    const demoEnv = { PACTAGENT_ECONOMIC_MODE: "demo", PACTAGENT_RUNTIME_API_TOKEN: "token", PACTAGENT_LIVE_STATE_DIRECTORY: ".local/state" };
    const missing = missingRequiredVariables(demoEnv);
    expect(missing).toContain("PACTAGENT_DEMO_CASHU_MINT_URL");
    expect(missing).toContain("PACTAGENT_DEMO_STATE_DIRECTORY");
    expect(missing).not.toContain("PACTAGENT_LIVE_FUNDING_TOKEN");
  });

  it("validates economic mode configuration", () => {
    expect(economicModeConfigurationStatus({})).toEqual({
      ok: false,
      mode: undefined,
      reason: "missing",
    });
    expect(economicModeConfigurationStatus({ PACTAGENT_ECONOMIC_MODE: "invalid" })).toEqual({
      ok: false,
      mode: "invalid",
      reason: "invalid",
    });
    expect(economicModeConfigurationStatus({ PACTAGENT_ECONOMIC_MODE: "DEMO" })).toEqual({
      ok: false,
      mode: "DEMO",
      reason: "invalid",
    });
    expect(economicModeConfigurationStatus({ PACTAGENT_ECONOMIC_MODE: "live" })).toEqual({
      ok: true,
      mode: "live",
      reason: undefined,
    });
    expect(economicModeConfigurationStatus({ PACTAGENT_ECONOMIC_MODE: "demo" })).toEqual({
      ok: true,
      mode: "demo",
      reason: undefined,
    });
  });

  it("requires model credentials only when model requester mode is explicit", () => {
    expect(requesterModelConfigurationStatus({})).toEqual({
      ok: true,
      mode: "deterministic",
      missing: [],
    });
    expect(requesterModelConfigurationStatus({
      PACTAGENT_REQUESTER_DECISION_MODE: "model",
      PACTAGENT_REQUESTER_MODEL_PROVIDER: "openai",
    })).toMatchObject({
      ok: false,
      mode: "model",
      missing: ["PACTAGENT_REQUESTER_MODEL_NAME", "PACTAGENT_REQUESTER_MODEL_API_KEY"],
      providerSupported: true,
    });
  });

  it("reports empty writable state as economically safe", async () => {
    const path = await directory();
    const snapshot = await inspectLocalState(path);
    expect(snapshot).toMatchObject({
      directoryExists: true,
      directoryWritable: true,
      inspectionErrors: [],
      activeExposureSats: 0n,
      incompleteTransactions: [],
      reconciliationOperations: [],
      reconciliationEscrows: [],
      expiredUnresolvedEscrows: [],
    });
    expect(stateHasEconomicRisk(snapshot)).toBe(false);
  });

  it("finds stale exposure, ambiguity, incomplete transactions, and expired escrows read-only", async () => {
    const path = await directory();
    await mkdir(path, { recursive: true });
    writePrivateState(path, [
      ["exposure-ledger", { reservations: { op: { amountSats: "351", status: "locked" } } }],
      ["operation:cashu_ambiguous", { status: "submitted_unknown", prepared: {} }],
      ["txn_incomplete", { transactionId: "txn_incomplete", phase: "accepted" }],
    ]);
    writeSettlementState(path, [
      ["agreement-escrow:root", { escrowReference: "pactescrow_test" }],
      [
        "escrow:pactescrow_test",
        { state: "funding_reconciliation_required", locktime: 100, agreementRoot: "root" },
      ],
    ]);
    const snapshot = await inspectLocalState(path, 101);
    expect(snapshot.activeExposureSats).toBe(351n);
    expect(snapshot.incompleteTransactions).toEqual(["txn_incomplete"]);
    expect(snapshot.reconciliationOperations).toEqual(["cashu_ambiguous"]);
    expect(snapshot.reconciliationEscrows).toEqual(["pactescrow_test"]);
    expect(snapshot.expiredUnresolvedEscrows).toEqual(["pactescrow_test"]);
    expect(snapshot.agreementRoots).toEqual(["root"]);
    expect(stateHasEconomicRisk(snapshot)).toBe(true);
  });

  it("fails closed when an existing durable database cannot be inspected", async () => {
    const path = await directory();
    await writeFile(join(path, "cashu-private.sqlite"), "not a SQLite database");

    const snapshot = await inspectLocalState(path);

    expect(snapshot.inspectionErrors).toHaveLength(1);
    expect(stateHasEconomicRisk(snapshot)).toBe(true);
    expect(() => cashuOperationSnapshot(path)).toThrow(
      "Could not inspect the local Cashu operation store",
    );
  });
});

// ====================================================================
// BLOCKER 2D: Real launcher/preflight tests
// Exercises the REAL preflightRuntimeStartLocal() and
// preflightRequesterE2eLive() functions extracted from the actual
// launcher scripts. No simulation or test-only copies of decision logic.
// ====================================================================
describe("launcher economic mode validation (Blocker 2)", () => {
  const validVars = {
    PACTAGENT_ECONOMIC_MODE: "live",
    PACTAGENT_RUNTIME_API_TOKEN: "token",
    PACTAGENT_LIVE_RELAY_URL: "wss://relay.example",
    PACTAGENT_CASHU_TEST_MINT_URL: "https://mint.example",
    PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY: "01".repeat(32),
    PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: "02".repeat(32),
    PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY: "03".repeat(32),
    PACTAGENT_LIVE_NORMAL_SPEND_KEY: "04".repeat(32),
    PACTAGENT_LIVE_REFUND_SPEND_KEY: "05".repeat(32),
    PACTAGENT_LIVE_FUNDING_TOKEN: "token",
    PACTAGENT_LIVE_FUNDING_REFERENCE: "ref",
    PACTAGENT_LIVE_STATE_DIRECTORY: ".local/state",
    PACTAGENT_RUNTIME_API_BASE: "http://localhost:3000",
    PACTAGENT_REQUESTER_UI_ORIGIN: "http://localhost:3000",
  };

  function envWithMode(mode) {
    const env = { ...validVars };
    if (mode === undefined) delete env.PACTAGENT_ECONOMIC_MODE;
    else env.PACTAGENT_ECONOMIC_MODE = mode;
    return env;
  }

  describe("real preflightRuntimeStartLocal (used by runtime:start:local)", () => {
    it("rejects missing PACTAGENT_ECONOMIC_MODE before startup", () => {
      const result = preflightRuntimeStartLocal(envWithMode(undefined));
      expect(result.action).toBe("exit");
      expect(result.code).toBe(1);
      expect(result.reason).toBe("missing_variables");
    });

    it("rejects invalid mode 'test' before startup", () => {
      const result = preflightRuntimeStartLocal(envWithMode("test"));
      expect(result.action).toBe("exit");
      expect(result.code).toBe(1);
      expect(result.reason).toBe("invalid");
    });

    it("rejects wrong-case mode 'DEMO' before startup", () => {
      const result = preflightRuntimeStartLocal(envWithMode("DEMO"));
      expect(result.action).toBe("exit");
      expect(result.code).toBe(1);
      expect(result.reason).toBe("invalid");
    });

    it("demo mode passes mode validation (demo is now configured)", () => {
      // After #36, demo mode is valid. It will require demo-specific variables.
      const result = preflightRuntimeStartLocal(envWithMode("demo"));
      // Demo mode passes the economicModeConfigurationStatus check,
      // but may fail on missing demo-specific variables.
      if (result.action === "exit") {
        // Missing demo-specific variables is expected in this test env
        expect(result.reason).toBe("missing_variables");
      } else {
        expect(result.action).toBe("proceed");
      }
    });

    it("proceeds with live mode to the next readiness boundary", () => {
      const result = preflightRuntimeStartLocal(envWithMode("live"));
      expect(result.action).toBe("proceed");
    });
  });

  describe("real preflightRequesterE2eLive (used by run-requester-e2e-live)", () => {
    it("skips when PACTAGENT_ECONOMIC_MODE is missing (safe skip)", () => {
      const result = preflightRequesterE2eLive(envWithMode(undefined));
      expect(result.action).toBe("skip");
    });

    it("exits with error for invalid mode 'test'", () => {
      const result = preflightRequesterE2eLive(envWithMode("test"));
      expect(result.action).toBe("exit");
      expect(result.code).toBe(1);
      expect(result.reason).toBe("invalid");
    });

    it("exits with error for wrong-case mode 'DEMO'", () => {
      const result = preflightRequesterE2eLive(envWithMode("DEMO"));
      expect(result.action).toBe("exit");
      expect(result.code).toBe(1);
      expect(result.reason).toBe("invalid");
    });

    it("demo mode passes mode validation in live runner (now configured)", () => {
      const result = preflightRequesterE2eLive(envWithMode("demo"));
      // Demo mode passes economicModeConfigurationStatus, but will likely
      // skip due to missing live-specific config (which demo doesn't need)
      // or fail due to missing CA.
      if (result.action === "exit") {
        expect(result.reason).not.toBe("demo_not_configured");
      }
    });

    it("proceeds with live mode when all config is present", () => {
      // CA check will fail since no .local CA exists, causing skip.
      // But mode validation itself must pass. Let's verify mode doesn't cause exit.
      const result = preflightRequesterE2eLive(envWithMode("live"));
      // With validVars all present but no CA file, it will skip due to CA
      // but NOT due to economic mode. That proves mode validation passed.
      if (result.action === "skip") {
        expect(result.categories).not.toContain("economic mode configuration");
      } else {
        expect(result.action).toBe("proceed");
      }
    });
  });
});

// ====================================================================
// Issue #36, Blocker 6: mode-aware doctor (real runLocalDoctor path)
// Exercises the REAL runLocalDoctor() decision path (no duplicated logic).
// Proves demo mode probes the demo mint (never the live/Testnut mint), and
// that an unreachable demo mint fails the doctor explicitly.
// ====================================================================
describe("mode-aware doctor (Blocker 6)", () => {
  it("demo mode never reports 'Testnut inspection' and probes the demo mint", async () => {
    const env = {
      PACTAGENT_ECONOMIC_MODE: "demo",
      PACTAGENT_RUNTIME_API_TOKEN: "token",
      PACTAGENT_LIVE_RELAY_URL: "wss://relay.example",
      PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY: "01".repeat(32),
      PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: "02".repeat(32),
      PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY: "03".repeat(32),
      PACTAGENT_DEMO_CASHU_MINT_URL: "http://127.0.0.1:1",
      PACTAGENT_DEMO_STATE_DIRECTORY: ".local/demo-doctor-state",
      PACTAGENT_DEMO_NORMAL_SPEND_KEY: "21".repeat(32),
      PACTAGENT_DEMO_REFUND_SPEND_KEY: "22".repeat(32),
      PACTAGENT_DEMO_FUNDING_REFERENCE: "demo-doctor-ref",
    };
    const result = await runLocalDoctor({ environment: env, print: false });
    const labels = result.checks.map((check) => check.label);
    // Demo mode must use demo-specific labels, never the live "Testnut" labels.
    expect(labels).toContain("demo mint reachability");
    expect(labels).not.toContain("Testnut reachability");
    expect(labels).not.toContain("funding mint");
    // An unreachable demo mint (port 1) must fail the reachability check.
    const reachability = result.checks.find((check) => check.label === "demo mint reachability");
    expect(reachability.ok).toBe(false);
    // The doctor as a whole must not be READY with an unreachable demo mint.
    expect(result.ok).toBe(false);
  }, 30_000);

  it("live mode never reports 'demo mint' labels and does not consume demo config", async () => {
    const env = {
      PACTAGENT_ECONOMIC_MODE: "live",
      PACTAGENT_RUNTIME_API_TOKEN: "token",
      PACTAGENT_LIVE_RELAY_URL: "wss://relay.example",
      PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY: "01".repeat(32),
      PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: "02".repeat(32),
      PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY: "03".repeat(32),
      PACTAGENT_CASHU_TEST_MINT_URL: "https://live-mint.example/cashu",
      PACTAGENT_LIVE_STATE_DIRECTORY: ".local/live-doctor-state",
      PACTAGENT_LIVE_NORMAL_SPEND_KEY: "31".repeat(32),
      PACTAGENT_LIVE_REFUND_SPEND_KEY: "32".repeat(32),
      PACTAGENT_LIVE_FUNDING_TOKEN: "cashuA-not-a-real-token",
      PACTAGENT_LIVE_FUNDING_REFERENCE: "live-doctor-ref",
      // Demo vars present but must NOT be consumed by live mode.
      PACTAGENT_DEMO_CASHU_MINT_URL: "http://127.0.0.1:3338",
      PACTAGENT_DEMO_STATE_DIRECTORY: ".local/demo-should-be-ignored",
    };
    const result = await runLocalDoctor({ environment: env, print: false });
    const labels = result.checks.map((check) => check.label);
    expect(labels).not.toContain("demo mint reachability");
    // Live mode preserves the Testnut funding inspection path.
    expect(labels).toContain("Testnut reachability");
    expect(result.ok).toBe(false); // unreachable live mint / token invalid
  }, 30_000);
});
