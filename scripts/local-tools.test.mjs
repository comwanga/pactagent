import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CA_PATH,
  DEFAULT_STATE_PATH,
  missingRequiredVariables,
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
    expect(missingRequiredVariables({})).toContain("PACTAGENT_LIVE_FUNDING_TOKEN");
    expect(missingRequiredVariables({})).not.toContain("NODE_EXTRA_CA_CERTS");
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
