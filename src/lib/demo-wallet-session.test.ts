import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSqliteRequesterSessionStore, type RequesterSessionStore } from "./requester-session-store.server";

/*
 * Issue #37: Session isolation tests for demo wallet ownership.
 *
 * Verifies that the session store correctly binds wallets to sessions and
 * enforces isolation: Session A cannot read Session B's wallet key.
 *
 * These are unit tests that do not require a live mint.
 */

const tempDirs: string[] = [];
afterAll(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows */ }
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pactagent-session-iso-"));
  tempDirs.push(dir);
  return dir;
}

const NOW = Date.now();
const SESSION_A_HASH = "a".repeat(64);
const SESSION_B_HASH = "b".repeat(64);
const WALLET_KEY_A = "wallet-key-session-a";
const WALLET_KEY_B = "wallet-key-session-b";

describe("Issue #37: RequesterSessionStore demo wallet isolation", () => {
  let store: RequesterSessionStore;

  beforeAll(async () => {
    const dir = await tempDir();
    store = createSqliteRequesterSessionStore(join(dir, "sessions.sqlite"));
    store.create(SESSION_A_HASH, NOW, NOW + 7 * 24 * 60 * 60 * 1000);
    store.create(SESSION_B_HASH, NOW, NOW + 7 * 24 * 60 * 60 * 1000);
  });

  it("bindDemoWallet associates a wallet key with a session", () => {
    store.bindDemoWallet(SESSION_A_HASH, WALLET_KEY_A, NOW);
    store.bindDemoWallet(SESSION_B_HASH, WALLET_KEY_B, NOW);
  });

  it("demoWalletKey returns the correct wallet key for each session", () => {
    expect(store.demoWalletKey(SESSION_A_HASH, NOW)).toBe(WALLET_KEY_A);
    expect(store.demoWalletKey(SESSION_B_HASH, NOW)).toBe(WALLET_KEY_B);
  });

  it("Session A wallet key != Session B wallet key", () => {
    const keyA = store.demoWalletKey(SESSION_A_HASH, NOW);
    const keyB = store.demoWalletKey(SESSION_B_HASH, NOW);
    expect(keyA).not.toBe(keyB);
  });

  it("demoWalletKey returns undefined for a session without a wallet", () => {
    const SESSION_C_HASH = "c".repeat(64);
    store.create(SESSION_C_HASH, NOW, NOW + 7 * 24 * 60 * 60 * 1000);
    expect(store.demoWalletKey(SESSION_C_HASH, NOW)).toBeUndefined();
  });

  it("demoWalletKey returns undefined for an unknown session", () => {
    expect(store.demoWalletKey("d".repeat(64), NOW)).toBeUndefined();
  });

  it("bindDemoWallet is idempotent and immutable for one requester session", () => {
    store.bindDemoWallet(SESSION_A_HASH, WALLET_KEY_A, NOW);
    expect(store.demoWalletKey(SESSION_A_HASH, NOW)).toBe(WALLET_KEY_A);
    expect(() => store.bindDemoWallet(SESSION_A_HASH, "new-wallet-key-a", NOW)).toThrow();
    expect(store.demoWalletKey(SESSION_A_HASH, NOW)).toBe(WALLET_KEY_A);
  });

  it("bindDemoWallet rejects an unknown session hash", () => {
    expect(() => store.bindDemoWallet("e".repeat(64), "wallet-key-e", NOW)).toThrow();
  });

  it("demoWalletKey rejects an invalid session hash", () => {
    expect(() => store.demoWalletKey("invalid", NOW)).toThrow();
  });
});
