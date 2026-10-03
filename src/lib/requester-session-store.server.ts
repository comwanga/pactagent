import "server-only";

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SESSION_HASH = /^[a-f0-9]{64}$/;
const TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/;

export class RequesterSessionStoreError extends Error {
  constructor(message = "Requester session storage is unavailable") {
    super(message);
    this.name = "RequesterSessionStoreError";
  }
}

export interface RequesterSessionStore {
  create(sessionHash: string, createdAtMs: number, expiresAtMs: number): void;
  exists(sessionHash: string, nowMs: number): boolean;
  bindTransaction(sessionHash: string, transactionId: string, nowMs: number): void;
  ownsTransaction(sessionHash: string, transactionId: string, nowMs: number): boolean;
  currentTransaction(sessionHash: string, nowMs: number): string | undefined;
  clearCurrentTransaction(sessionHash: string, nowMs: number): boolean;
  bindDemoWallet(sessionHash: string, walletKey: string, nowMs: number): void;
  demoWalletKey(sessionHash: string, nowMs: number): string | undefined;
  close(): void;
}

function validSessionHash(value: string): string {
  if (!SESSION_HASH.test(value)) throw new RequesterSessionStoreError();
  return value;
}

function validTransactionId(value: string): string {
  if (!TRANSACTION_ID.test(value)) throw new RequesterSessionStoreError();
  return value;
}

function nonEmptyText(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw new RequesterSessionStoreError();
  return value;
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RequesterSessionStoreError();
  return value;
}

/**
 * Dedicated durable requester ownership storage. It intentionally contains no
 * request payload, private result, runtime credential, funding material, key,
 * proof, or workflow record. The opaque browser cookie is stored only as a
 * one-way SHA-256 digest.
 */
export function createSqliteRequesterSessionStore(databasePath: string): RequesterSessionStore {
  if (typeof databasePath !== "string" || databasePath.length === 0 || databasePath === ":memory:") {
    throw new RequesterSessionStoreError();
  }
  const resolvedPath = resolve(databasePath);
  let database: DatabaseSync;
  try {
    mkdirSync(dirname(resolvedPath), { recursive: true });
    database = new DatabaseSync(resolvedPath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS requester_sessions (
        session_hash TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        current_transaction_id TEXT
      );
      CREATE TABLE IF NOT EXISTS requester_transaction_ownership (
        session_hash TEXT NOT NULL,
        transaction_id TEXT NOT NULL UNIQUE,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (session_hash, transaction_id),
        FOREIGN KEY (session_hash) REFERENCES requester_sessions(session_hash) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS demo_wallet_ownership (
        session_hash TEXT PRIMARY KEY,
        wallet_key TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY (session_hash) REFERENCES requester_sessions(session_hash) ON DELETE CASCADE
      );
    `);
    chmodSync(resolvedPath, 0o600);
  } catch {
    throw new RequesterSessionStoreError();
  }

  const cleanupExpired = database.prepare(
    "DELETE FROM requester_sessions WHERE expires_at_ms <= ?",
  );
  const insertSession = database.prepare(`
    INSERT INTO requester_sessions (session_hash, created_at_ms, expires_at_ms, current_transaction_id)
    VALUES (?, ?, ?, NULL)
  `);
  const findSession = database.prepare(`
    SELECT session_hash FROM requester_sessions
    WHERE session_hash = ? AND expires_at_ms > ?
  `);
  const insertOwnership = database.prepare(`
    INSERT OR IGNORE INTO requester_transaction_ownership (session_hash, transaction_id, created_at_ms)
    VALUES (?, ?, ?)
  `);
  const readOwner = database.prepare(`
    SELECT session_hash FROM requester_transaction_ownership WHERE transaction_id = ?
  `);
  const setCurrent = database.prepare(`
    UPDATE requester_sessions SET current_transaction_id = ?
    WHERE session_hash = ? AND expires_at_ms > ?
  `);
  const readOwned = database.prepare(`
    SELECT o.transaction_id
    FROM requester_transaction_ownership o
    JOIN requester_sessions s ON s.session_hash = o.session_hash
    WHERE o.session_hash = ? AND o.transaction_id = ? AND s.expires_at_ms > ?
  `);
  const readCurrent = database.prepare(`
    SELECT s.current_transaction_id, o.transaction_id AS owned_transaction_id
    FROM requester_sessions s
    LEFT JOIN requester_transaction_ownership o
      ON o.session_hash = s.session_hash AND o.transaction_id = s.current_transaction_id
    WHERE s.session_hash = ? AND s.expires_at_ms > ?
  `);
  const clearCurrent = database.prepare(`
    UPDATE requester_sessions SET current_transaction_id = NULL
    WHERE session_hash = ? AND expires_at_ms > ?
  `);
  const insertDemoWallet = database.prepare(`
    INSERT OR IGNORE INTO demo_wallet_ownership (session_hash, wallet_key, created_at_ms)
    VALUES (?, ?, ?)
  `);
  const readDemoWalletKey = database.prepare(`
    SELECT d.wallet_key
    FROM demo_wallet_ownership d
    JOIN requester_sessions s ON s.session_hash = d.session_hash
    WHERE d.session_hash = ? AND s.expires_at_ms > ?
  `);
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw new RequesterSessionStoreError();
  };
  const cleanup = (nowMs: number): void => {
    cleanupExpired.run(validTimestamp(nowMs));
  };

  return Object.freeze({
    create(sessionHash: string, createdAtMs: number, expiresAtMs: number): void {
      ensureOpen();
      const hash = validSessionHash(sessionHash);
      const created = validTimestamp(createdAtMs);
      const expires = validTimestamp(expiresAtMs);
      if (expires <= created) throw new RequesterSessionStoreError();
      try {
        cleanup(created);
        insertSession.run(hash, created, expires);
      } catch (error) {
        if (error instanceof RequesterSessionStoreError) throw error;
        throw new RequesterSessionStoreError();
      }
    },

    exists(sessionHash: string, nowMs: number): boolean {
      ensureOpen();
      try {
        const hash = validSessionHash(sessionHash);
        const now = validTimestamp(nowMs);
        cleanup(now);
        return findSession.get(hash, now) !== undefined;
      } catch (error) {
        if (error instanceof RequesterSessionStoreError) throw error;
        throw new RequesterSessionStoreError();
      }
    },

    bindTransaction(sessionHash: string, transactionId: string, nowMs: number): void {
      ensureOpen();
      const hash = validSessionHash(sessionHash);
      const id = validTransactionId(transactionId);
      const now = validTimestamp(nowMs);
      try {
        database.exec("BEGIN IMMEDIATE");
        cleanup(now);
        if (findSession.get(hash, now) === undefined) throw new RequesterSessionStoreError();
        insertOwnership.run(hash, id, now);
        const owner = readOwner.get(id) as { session_hash?: unknown } | undefined;
        if (owner?.session_hash !== hash) throw new RequesterSessionStoreError();
        if (setCurrent.run(id, hash, now).changes !== 1) throw new RequesterSessionStoreError();
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
        if (error instanceof RequesterSessionStoreError) throw error;
        throw new RequesterSessionStoreError();
      }
    },

    ownsTransaction(sessionHash: string, transactionId: string, nowMs: number): boolean {
      ensureOpen();
      try {
        const hash = validSessionHash(sessionHash);
        const id = validTransactionId(transactionId);
        const now = validTimestamp(nowMs);
        cleanup(now);
        return readOwned.get(hash, id, now) !== undefined;
      } catch (error) {
        if (error instanceof RequesterSessionStoreError) throw error;
        throw new RequesterSessionStoreError();
      }
    },

    currentTransaction(sessionHash: string, nowMs: number): string | undefined {
      ensureOpen();
      try {
        const hash = validSessionHash(sessionHash);
        const now = validTimestamp(nowMs);
        cleanup(now);
        const row = readCurrent.get(hash, now) as {
          current_transaction_id?: unknown;
          owned_transaction_id?: unknown;
        } | undefined;
        if (!row || row.current_transaction_id === null || row.current_transaction_id === undefined) {
          return undefined;
        }
        if (
          typeof row.current_transaction_id !== "string" ||
          row.owned_transaction_id !== row.current_transaction_id ||
          !TRANSACTION_ID.test(row.current_transaction_id)
        ) {
          throw new RequesterSessionStoreError();
        }
        return row.current_transaction_id;
      } catch (error) {
        if (error instanceof RequesterSessionStoreError) throw error;
        throw new RequesterSessionStoreError();
      }
    },

    clearCurrentTransaction(sessionHash: string, nowMs: number): boolean {
      ensureOpen();
      try {
        const hash = validSessionHash(sessionHash);
        const now = validTimestamp(nowMs);
        cleanup(now);
        return clearCurrent.run(hash, now).changes === 1;
      } catch (error) {
        if (error instanceof RequesterSessionStoreError) throw error;
        throw new RequesterSessionStoreError();
      }
    },

    bindDemoWallet(sessionHash: string, walletKey: string, nowMs: number): void {
      ensureOpen();
      const hash = validSessionHash(sessionHash);
      const key = nonEmptyText(walletKey);
      const now = validTimestamp(nowMs);
      try {
        database.exec("BEGIN IMMEDIATE");
        cleanup(now);
        if (findSession.get(hash, now) === undefined) throw new RequesterSessionStoreError();
        insertDemoWallet.run(hash, key, now);
        const existing = readDemoWalletKey.get(hash, now) as { wallet_key?: unknown } | undefined;
        if (existing?.wallet_key !== key) throw new RequesterSessionStoreError();
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
        if (error instanceof RequesterSessionStoreError) throw error;
        throw new RequesterSessionStoreError();
      }
    },

    demoWalletKey(sessionHash: string, nowMs: number): string | undefined {
      ensureOpen();
      try {
        const hash = validSessionHash(sessionHash);
        const now = validTimestamp(nowMs);
        cleanup(now);
        const row = readDemoWalletKey.get(hash, now) as { wallet_key?: unknown } | undefined;
        if (row === undefined) return undefined;
        if (typeof row.wallet_key !== "string" || row.wallet_key.length === 0) {
          throw new RequesterSessionStoreError();
        }
        return row.wallet_key;
      } catch (error) {
        if (error instanceof RequesterSessionStoreError) throw error;
        throw new RequesterSessionStoreError();
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      database.close();
    },
  });
}

let configuredStore: RequesterSessionStore | undefined;

export function requesterSessionStoreFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RequesterSessionStore {
  if (configuredStore) return configuredStore;
  const explicitPath = environment.PACTAGENT_REQUESTER_SESSION_DATABASE;
  // Mode-aware default state directory (Issue #36, Blocker 1): demo sessions
  // default under the demo state boundary; live sessions under the live state
  // boundary. Demo never resolves PACTAGENT_LIVE_STATE_DIRECTORY for session
  // storage.
  const economicMode = environment.PACTAGENT_ECONOMIC_MODE?.trim();
  const defaultStateDirectory = economicMode === "demo"
    ? environment.PACTAGENT_DEMO_STATE_DIRECTORY
    : environment.PACTAGENT_LIVE_STATE_DIRECTORY;
  const databasePath = explicitPath ?? (defaultStateDirectory ? join(defaultStateDirectory, "requester-sessions.sqlite") : undefined);
  if (!databasePath) throw new RequesterSessionStoreError();
  configuredStore = createSqliteRequesterSessionStore(databasePath);
  return configuredStore;
}

/** Test-only dependency seam; production route code always uses the durable environment store. */
export function configureRequesterSessionStoreForTesting(store: RequesterSessionStore | undefined): void {
  configuredStore = store;
}
