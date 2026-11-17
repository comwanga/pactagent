import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteCashuPrivateStore } from "./cashu-test-mint";
import { createPrivateDataCipher, privateDataConfigurationFromEnv, PrivateDataError } from "./private-data";
import { PrivateTransactionRecords } from "./private-transaction-records";

const keys = { first: "17".repeat(32), second: "29".repeat(32) };
const payload = { version: 1, transactionId: "txn_private", privateTerms: { source_document: "PRIVATE-SOURCE" }, privateSaltHex: "31".repeat(32) };

describe("Issue #66 authenticated transaction persistence", () => {
  it("round trips with fresh nonces and binds scope, identity and key metadata", () => {
    const cipher = createPrivateDataCipher(keys, "first");
    const first = cipher.seal("transaction", payload.transactionId, payload);
    const next = cipher.seal("transaction", payload.transactionId, payload);
    expect(first.nonce).not.toBe(next.nonce);
    expect(Buffer.from(first.nonce, "base64")).toHaveLength(12);
    expect(Buffer.from(first.tag, "base64")).toHaveLength(16);
    expect(cipher.open("transaction", payload.transactionId, first)).toEqual(payload);
    expect(JSON.stringify(first)).not.toContain("PRIVATE-SOURCE");
    expect(JSON.stringify(first)).not.toContain(payload.privateSaltHex);
    expect(() => cipher.open("other", payload.transactionId, first)).toThrow(PrivateDataError);
    expect(() => cipher.open("transaction", "another", first)).toThrow(PrivateDataError);
  });

  it("rejects tampering, malformed envelopes, wrong keys and unknown versions without plaintext fallback", () => {
    const cipher = createPrivateDataCipher(keys, "first");
    const envelope = cipher.seal("transaction", payload.transactionId, payload);
    for (const change of [
      { tag: Buffer.alloc(16).toString("base64") }, { tag: "short" },
      { ciphertext: Buffer.from("tampered").toString("base64") },
      { nonce: "bad!" }, { keyId: "second" }, { version: 99 }, { unexpected: true },
    ]) expect(() => cipher.open("transaction", payload.transactionId, { ...envelope, ...change })).toThrow(PrivateDataError);
    const wrong = createPrivateDataCipher({ first: keys.second }, "first");
    expect(() => wrong.open("transaction", payload.transactionId, envelope)).toThrow(PrivateDataError);
    expect(() => cipher.open("transaction", payload.transactionId, { ...envelope, privateTerms: payload.privateTerms })).toThrow(PrivateDataError);
    try { wrong.open("transaction", payload.transactionId, envelope); }
    catch (error) { expect(String(error)).not.toMatch(/PRIVATE-SOURCE|313131|292929/); }
  });

  it("requires explicit valid external keys and supports retained old keys", () => {
    for (const environment of [{}, { PACTAGENT_PRIVATE_DATA_KEYRING: "not-json" }, {
      PACTAGENT_PRIVATE_DATA_KEYRING: JSON.stringify({ first: "bad" }), PACTAGENT_PRIVATE_DATA_ACTIVE_KEY_ID: "first",
    }]) expect(() => privateDataConfigurationFromEnv(environment)).toThrow(PrivateDataError);
    const old = createPrivateDataCipher(keys, "first").seal("transaction", payload.transactionId, payload);
    expect(createPrivateDataCipher(keys, "second").open("transaction", payload.transactionId, old)).toEqual(payload);
    expect(() => createPrivateDataCipher({ second: keys.second }, "second").open("transaction", payload.transactionId, old)).toThrow(PrivateDataError);
  });

  it("validates retention configuration instead of silently disabling it", () => {
    const environment = { PACTAGENT_PRIVATE_DATA_KEYRING: JSON.stringify(keys), PACTAGENT_PRIVATE_DATA_ACTIVE_KEY_ID: "first" };
    expect(privateDataConfigurationFromEnv(environment).retentionSeconds).toBe(7 * 86400);
    expect(privateDataConfigurationFromEnv({ ...environment, PACTAGENT_PRIVATE_DATA_RETENTION_DAYS: "14" }).retentionSeconds).toBe(14 * 86400);
    for (const value of ["", "0", "-1", "1.5", "366", "Infinity", " 7", "07"])
      expect(() => privateDataConfigurationFromEnv({ ...environment, PACTAGENT_PRIVATE_DATA_RETENTION_DAYS: value })).toThrow(PrivateDataError);
  });

  it("rolls back interrupted SQLite migration and resolves concurrent migration without losing data", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "pact-private-rollback-")), "private.sqlite");
    const first = createSqliteCashuPrivateStore(path), second = createSqliteCashuPrivateStore(path);
    const database = new DatabaseSync(path);
    try {
      await first.write("transaction", payload.transactionId, payload);
      database.exec("CREATE TRIGGER interrupt_private_migration BEFORE UPDATE ON pact_cashu_private_values BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END");
      await expect(new PrivateTransactionRecords(first, createPrivateDataCipher(keys, "first")).read(payload.transactionId)).rejects.toThrow(PrivateDataError);
      expect(await second.read("transaction", payload.transactionId)).toEqual(payload);
      database.exec("DROP TRIGGER interrupt_private_migration");
      const results = await Promise.all([first, second].map(store => new PrivateTransactionRecords(store, createPrivateDataCipher(keys, "first")).read(payload.transactionId)));
      expect(results[0]).toEqual({ ...payload, storageRevision: 0 }); expect(results[1]).toEqual(results[0]);
      expect(JSON.stringify(await second.read("transaction", payload.transactionId))).not.toContain("PRIVATE-SOURCE");
    } finally { database.close(); first.close(); second.close(); }
  });

  it("migrates legacy rows atomically, preserves failed migrations, rotates and survives reopen", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "pact-private-")), "private.sqlite");
    let store = createSqliteCashuPrivateStore(path);
    await store.write("transaction", payload.transactionId, payload);
    const first = new PrivateTransactionRecords(store, createPrivateDataCipher(keys, "first"));
    expect(await first.read(payload.transactionId)).toEqual({ ...payload, storageRevision: 0 });
    const raw = await store.read("transaction", payload.transactionId);
    expect(JSON.stringify(raw)).not.toContain("PRIVATE-SOURCE");
    const rotated = new PrivateTransactionRecords(store, createPrivateDataCipher(keys, "second"));
    expect(await rotated.read(payload.transactionId)).toEqual({ ...payload, storageRevision: 0 });
    expect((await store.read("transaction", payload.transactionId) as { keyId: string }).keyId).toBe("second");
    await store.write("transaction", "legacy-failure", { ...payload, transactionId: "legacy-failure" });
    const failing = new PrivateTransactionRecords({ ...store, compareAndSet: async () => { throw new Error("disk unavailable"); } }, createPrivateDataCipher(keys, "second"));
    await expect(failing.read("legacy-failure")).rejects.toThrow(PrivateDataError);
    expect(await store.read("transaction", "legacy-failure")).toEqual({ ...payload, transactionId: "legacy-failure" });
    store.close();
    store = createSqliteCashuPrivateStore(path);
    try {
      expect(await new PrivateTransactionRecords(store, createPrivateDataCipher(keys, "second")).read(payload.transactionId)).toEqual({ ...payload, storageRevision: 0 });
    } finally { store.close(); }
  });

  it("rejects stale writers and prevents resurrecting private fields after purge", async () => {
    const store = createSqliteCashuPrivateStore(join(mkdtempSync(join(tmpdir(), "pact-private-cas-")), "private.sqlite"));
    try {
      const records = new PrivateTransactionRecords(store, createPrivateDataCipher(keys, "first"));
      await records.write(payload.transactionId, payload, 0);
      const current = await records.read(payload.transactionId) as typeof payload & { storageRevision: number };
      await records.write(payload.transactionId, { version: 1, transactionId: payload.transactionId, purgedAt: 100 }, current.storageRevision);
      await expect(records.write(payload.transactionId, current, current.storageRevision)).rejects.toThrow(PrivateDataError);
      await expect(records.write(payload.transactionId, current, current.storageRevision + 1)).rejects.toThrow(PrivateDataError);
      expect(await records.read(payload.transactionId)).not.toHaveProperty("privateTerms");
    } finally { store.close(); }
  });
});
