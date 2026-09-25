import { constants, existsSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function readRows(path, table, columns) {
  if (!existsSync(path)) return Object.freeze({ rows: [], error: undefined });
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const exists = database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!exists) return Object.freeze({ rows: [], error: undefined });
    return Object.freeze({
      rows: database.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all(),
      error: undefined,
    });
  } catch {
    return Object.freeze({ rows: [], error: `could not read ${path}` });
  } finally {
    database?.close();
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export async function inspectLocalState(stateDirectory, nowSeconds = Math.floor(Date.now() / 1000)) {
  let directoryExists = false;
  let directoryWritable = false;
  try {
    directoryExists = (await stat(stateDirectory)).isDirectory();
    if (directoryExists) {
      await access(stateDirectory, constants.R_OK | constants.W_OK);
      directoryWritable = true;
    }
  } catch {
    directoryWritable = false;
  }

  const privateRead = directoryExists
    ? readRows(join(stateDirectory, "cashu-private.sqlite"), "pact_cashu_private_values", [
        "store_key",
        "value_json",
      ])
    : Object.freeze({ rows: [], error: undefined });
  const settlementRead = directoryExists
    ? readRows(join(stateDirectory, "escrow-settlement.sqlite"), "pact_cashu_settlement_values", [
        "store_key",
        "value_json",
      ])
    : Object.freeze({ rows: [], error: undefined });
  const privateRows = privateRead.rows;
  const settlementRows = settlementRead.rows;
  const inspectionErrors = [privateRead.error, settlementRead.error].filter(
    (value) => value !== undefined,
  );

  let activeExposureSats = 0n;
  const incompleteTransactions = [];
  const reconciliationOperations = [];
  for (const row of privateRows) {
    const value = parseJson(row.value_json);
    if (!value || typeof value !== "object") continue;
    if (row.store_key === "exposure-ledger" && value.reservations) {
      for (const reservation of Object.values(value.reservations)) {
        if (reservation?.status === "released") continue;
        if (typeof reservation?.amountSats === "string" && /^\d+$/u.test(reservation.amountSats)) {
          activeExposureSats += BigInt(reservation.amountSats);
        }
      }
    }
    if (
      typeof value.transactionId === "string" &&
      typeof value.phase === "string" &&
      value.phase !== "settled" &&
      value.phase !== "refunded"
    ) {
      incompleteTransactions.push(value.transactionId);
    }
    if (
      row.store_key.startsWith("operation:") &&
      (value.status === "submitted_unknown" || value.status === "reconciliation_required")
    ) {
      reconciliationOperations.push(row.store_key.slice("operation:".length));
    }
  }

  const expiredUnresolvedEscrows = [];
  const reconciliationEscrows = [];
  const agreementRoots = [];
  for (const row of settlementRows) {
    const value = parseJson(row.value_json);
    if (!value || typeof value !== "object") continue;
    if (row.store_key.startsWith("agreement-escrow:")) {
      agreementRoots.push(row.store_key.slice("agreement-escrow:".length));
    }
    if (!row.store_key.startsWith("escrow:")) continue;
    const reference = row.store_key.slice("escrow:".length);
    if (typeof value.state === "string" && value.state.endsWith("_reconciliation_required")) {
      reconciliationEscrows.push(reference);
    }
    if (
      typeof value.locktime === "number" &&
      value.locktime <= nowSeconds &&
      value.state !== "settled" &&
      value.state !== "refunded"
    ) {
      expiredUnresolvedEscrows.push(reference);
    }
  }

  return Object.freeze({
    directoryExists,
    directoryWritable,
    inspectionErrors: Object.freeze(inspectionErrors),
    activeExposureSats,
    incompleteTransactions: Object.freeze(incompleteTransactions.sort()),
    reconciliationOperations: Object.freeze(reconciliationOperations.sort()),
    reconciliationEscrows: Object.freeze(reconciliationEscrows.sort()),
    expiredUnresolvedEscrows: Object.freeze(expiredUnresolvedEscrows.sort()),
    agreementRoots: Object.freeze(agreementRoots.sort()),
  });
}

export function stateHasEconomicRisk(snapshot) {
  return (
    snapshot.activeExposureSats > 0n ||
    snapshot.inspectionErrors.length > 0 ||
    snapshot.reconciliationOperations.length > 0 ||
    snapshot.reconciliationEscrows.length > 0 ||
    snapshot.expiredUnresolvedEscrows.length > 0
  );
}

export function cashuOperationSnapshot(stateDirectory) {
  const read = readRows(
    join(stateDirectory, "cashu-private.sqlite"),
    "pact_cashu_private_values",
    ["store_key", "value_json"],
  );
  if (read.error) throw new Error("Could not inspect the local Cashu operation store");
  const rows = read.rows;
  const operations = new Map();
  const transactions = new Map();
  for (const row of rows) {
    const value = parseJson(row.value_json);
    if (!value || typeof value !== "object") continue;
    if (row.store_key.startsWith("operation:")) {
      operations.set(row.store_key, Object.freeze({ kind: value.kind, status: value.status }));
    }
    if (typeof value.transactionId === "string") {
      transactions.set(value.transactionId, Object.freeze({ phase: value.phase, kind: value.kind }));
    }
  }
  return Object.freeze({ operations, transactions });
}

export function settlementSnapshot(stateDirectory) {
  const read = readRows(
    join(stateDirectory, "escrow-settlement.sqlite"),
    "pact_cashu_settlement_values",
    ["store_key", "value_json"],
  );
  if (read.error) throw new Error("Could not inspect the local settlement store");
  const rows = read.rows;
  return rows.map((row) => Object.freeze({ storeKey: row.store_key, value: parseJson(row.value_json) }));
}
