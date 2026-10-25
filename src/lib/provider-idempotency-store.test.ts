import { mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { nostrPublicKey, type NostrPublicKey } from "../domain/nostr";
import {
  createSqliteProviderIdempotencyStore,
  ProviderIdempotencyError,
  type ProviderOperationRecord,
} from "./provider-idempotency-store";

function createTestStore() {
  const dir = mkdtempSync(join(tmpdir(), "pactagent-idempotency-test-"));
  return createSqliteProviderIdempotencyStore(join(dir, "provider-ops.sqlite"));
}

const TEST_PUBKEY = nostrPublicKey("b".repeat(64)) as NostrPublicKey;

function createRecord(overrides: Partial<ProviderOperationRecord> = {}): ProviderOperationRecord {
  return Object.freeze({
    agreementRootEventId: "a".repeat(64),
    agreementId: "test-agreement",
    requesterPublicKey: TEST_PUBKEY,
    state: "received",
    resultReference: undefined,
    resultSummary: undefined,
    acceptedTransitionEventId: undefined,
    taskDeliveredTransitionEventId: undefined,
    resultSubmittedTransitionEventId: undefined,
    createdAt: 1000,
    updatedAt: 1000,
    failureCode: undefined,
    ...overrides,
  });
}

describe("ProviderIdempotencyStore", () => {
  it("writes and reads a record", async () => {
    const store = createTestStore();
    const record = createRecord();
    await store.write(record);
    const read = await store.read(record.agreementRootEventId);
    expect(read).toBeDefined();
    expect(read?.state).toBe("received");
    expect(read?.agreementId).toBe("test-agreement");
    store.close();
  });

  it("returns undefined for a missing record", async () => {
    const store = createTestStore();
    const read = await store.read("nonexistent");
    expect(read).toBeUndefined();
    store.close();
  });

  it("transitions state correctly through the full lifecycle", async () => {
    const store = createTestStore();
    await store.write(createRecord());
    const processing = await store.transitionState("a".repeat(64), "processing");
    expect(processing.state).toBe("processing");
    const prepared = await store.transitionState("a".repeat(64), "result_prepared", {
      resultReference: "result-ref",
      resultSummary: "test summary",
    });
    expect(prepared.state).toBe("result_prepared");
    expect(prepared.resultReference).toBe("result-ref");
    expect(prepared.resultSummary).toBe("test summary");
    const published = await store.transitionState("a".repeat(64), "result_published");
    expect(published.state).toBe("result_published");
    const complete = await store.transitionState("a".repeat(64), "complete");
    expect(complete.state).toBe("complete");
    store.close();
  });

  it("transitions processing to recovery_required for non-replay-safe capabilities", async () => {
    const store = createTestStore();
    await store.write(createRecord({ state: "processing" }));
    const recovery = await store.transitionState("a".repeat(64), "recovery_required", {
      failureCode: "uncertain_execution_crash",
    });
    expect(recovery.state).toBe("recovery_required");
    expect(recovery.failureCode).toBe("uncertain_execution_crash");
    store.close();
  });

  it("allows recovery_required to transition to result_published", async () => {
    const store = createTestStore();
    await store.write(createRecord({ state: "recovery_required" }));
    const published = await store.transitionState("a".repeat(64), "result_published");
    expect(published.state).toBe("result_published");
    store.close();
  });

  it("rejects invalid state transitions", async () => {
    const store = createTestStore();
    await store.write(createRecord({ state: "complete" }));
    await expect(store.transitionState("a".repeat(64), "processing")).rejects.toThrow(
      ProviderIdempotencyError,
    );
    store.close();
  });

  it("persists across restart (close and reopen same database)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pactagent-idempotency-restart-"));
    const dbPath = join(dir, "provider-ops.sqlite");
    const store1 = createSqliteProviderIdempotencyStore(dbPath);
    await store1.write(createRecord({ state: "processing" }));
    store1.close();

    const store2 = createSqliteProviderIdempotencyStore(dbPath);
    const read = await store2.read("a".repeat(64));
    expect(read).toBeDefined();
    expect(read?.state).toBe("processing");
    store2.close();
  });

  it("persists recovery_required across restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pactagent-idempotency-recovery-"));
    const dbPath = join(dir, "provider-ops.sqlite");
    const store1 = createSqliteProviderIdempotencyStore(dbPath);
    await store1.write(createRecord({ state: "recovery_required", failureCode: "uncertain_execution_crash" }));
    store1.close();

    const store2 = createSqliteProviderIdempotencyStore(dbPath);
    const read = await store2.read("a".repeat(64));
    expect(read).toBeDefined();
    expect(read?.state).toBe("recovery_required");
    expect(read?.failureCode).toBe("uncertain_execution_crash");
    store2.close();
  });

  it("allows same-state transitions (idempotent)", async () => {
    const store = createTestStore();
    await store.write(createRecord({ state: "complete" }));
    const result = await store.transitionState("a".repeat(64), "complete");
    expect(result.state).toBe("complete");
    store.close();
  });
});

/*
 * Provider crash-state recovery tests (Issue #38 Final Blocker 2).
 *
 * Tests A-G: verify the provider state machine handles crashes at every
 * point without duplicating work for non-replay-safe capabilities.
 */

describe("Provider crash-state recovery (A-G)", () => {
  it("A: received → restart → safe execution permitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pactagent-crash-a-"));
    const dbPath = join(dir, "provider-ops.sqlite");
    const store1 = createSqliteProviderIdempotencyStore(dbPath);
    // Crash after "received" was persisted
    await store1.write(createRecord({ state: "received" }));
    store1.close();

    // Restart: should be able to transition to processing
    const store2 = createSqliteProviderIdempotencyStore(dbPath);
    const processing = await store2.transitionState("a".repeat(64), "processing");
    expect(processing.state).toBe("processing");
    store2.close();
  });

  it("B: processing → restart → replay_safe capability → permitted replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pactagent-crash-b-"));
    const dbPath = join(dir, "provider-ops.sqlite");
    const store1 = createSqliteProviderIdempotencyStore(dbPath);
    // Crash during processing
    await store1.write(createRecord({ state: "processing" }));
    store1.close();

    // Restart: replay_safe allows re-execution (transition to result_prepared)
    const store2 = createSqliteProviderIdempotencyStore(dbPath);
    const prepared = await store2.transitionState("a".repeat(64), "result_prepared", {
      resultReference: "result-ref",
      resultSummary: "summary",
    });
    expect(prepared.state).toBe("result_prepared");
    store2.close();
  });

  it("C: processing → restart → non_replay_safe → NO automatic re-execution → recovery_required", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pactagent-crash-c-"));
    const dbPath = join(dir, "provider-ops.sqlite");
    const store1 = createSqliteProviderIdempotencyStore(dbPath);
    // Crash during processing
    await store1.write(createRecord({ state: "processing" }));
    store1.close();

    // Restart: non_replay_safe enters recovery_required, NOT result_prepared
    const store2 = createSqliteProviderIdempotencyStore(dbPath);
    const recovery = await store2.transitionState("a".repeat(64), "recovery_required", {
      failureCode: "uncertain_execution_crash",
    });
    expect(recovery.state).toBe("recovery_required");
    expect(recovery.failureCode).toBe("uncertain_execution_crash");

    // Verify that recovery_required does NOT auto-transition to processing or result_prepared
    // (only to result_published/complete after operator or relay-based resolution)
    store2.close();
  });

  it("D: result_prepared → restart → publish stored result → no re-execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pactagent-crash-d-"));
    const dbPath = join(dir, "provider-ops.sqlite");
    const store1 = createSqliteProviderIdempotencyStore(dbPath);
    // Crash after result was prepared but before publication
    await store1.write(createRecord({
      state: "result_prepared",
      resultReference: "prepared-result-ref",
      resultSummary: "prepared summary",
    }));
    store1.close();

    // Restart: should publish the prepared result, NOT re-execute
    const store2 = createSqliteProviderIdempotencyStore(dbPath);
    const read = await store2.read("a".repeat(64));
    expect(read?.state).toBe("result_prepared");
    expect(read?.resultSummary).toBe("prepared summary");
    // Transition to result_published (simulating result publication)
    const published = await store2.transitionState("a".repeat(64), "result_published");
    expect(published.state).toBe("result_published");
    // result_prepared → processing is NOT a valid transition (no re-execution)
    await expect(store2.transitionState("a".repeat(64), "processing")).rejects.toThrow(
      ProviderIdempotencyError,
    );
    store2.close();
  });

  it("E: result_published → restart → reconcile → no re-execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pactagent-crash-e-"));
    const dbPath = join(dir, "provider-ops.sqlite");
    const store1 = createSqliteProviderIdempotencyStore(dbPath);
    // Crash after result was published
    await store1.write(createRecord({
      state: "result_published",
      resultReference: "published-result-ref",
      resultSummary: "published summary",
    }));
    store1.close();

    // Restart: should transition to complete, NOT re-execute
    const store2 = createSqliteProviderIdempotencyStore(dbPath);
    const complete = await store2.transitionState("a".repeat(64), "complete");
    expect(complete.state).toBe("complete");
    // result_published → processing is NOT a valid transition
    await expect(store2.transitionState("a".repeat(64), "processing")).rejects.toThrow(
      ProviderIdempotencyError,
    );
    store2.close();
  });

  it("F: complete → restart/replay → no execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pactagent-crash-f-"));
    const dbPath = join(dir, "provider-ops.sqlite");
    const store1 = createSqliteProviderIdempotencyStore(dbPath);
    await store1.write(createRecord({ state: "complete" }));
    store1.close();

    // Restart: complete stays complete. No transitions allowed except same.
    const store2 = createSqliteProviderIdempotencyStore(dbPath);
    const read = await store2.read("a".repeat(64));
    expect(read?.state).toBe("complete");
    // complete → processing is NOT valid
    await expect(store2.transitionState("a".repeat(64), "processing")).rejects.toThrow(
      ProviderIdempotencyError,
    );
    // complete → result_prepared is NOT valid
    await expect(store2.transitionState("a".repeat(64), "result_prepared")).rejects.toThrow(
      ProviderIdempotencyError,
    );
    store2.close();
  });

  it("G: relay redelivers agreement after complete → no execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pactagent-crash-g-"));
    const dbPath = join(dir, "provider-ops.sqlite");
    const store1 = createSqliteProviderIdempotencyStore(dbPath);
    await store1.write(createRecord({ state: "complete" }));
    store1.close();

    // Relay redelivers the same agreement root event. The store already has
    // a "complete" record. The provider service's #processAgreementRoot
    // checks the store first and calls #recoverFromState, which for "complete"
    // state just verifies relay state and returns without execution.
    const store2 = createSqliteProviderIdempotencyStore(dbPath);
    const read = await store2.read("a".repeat(64));
    expect(read?.state).toBe("complete");
    // No state change occurs — the record stays "complete"
    const same = await store2.transitionState("a".repeat(64), "complete");
    expect(same.state).toBe("complete");
    store2.close();
  });
});

describe("Issue #59 agreement poll cursor storage", () => {
  function testPath(): string {
    return join(mkdtempSync(join(tmpdir(), "pactagent-poll-cursor-store-")), "provider-ops.sqlite");
  }

  function writeRawCursor(path: string, valueJson: string): void {
    const database = new DatabaseSync(path);
    database
      .prepare(
        "INSERT INTO pact_provider_metadata (key, value_json, updated_at) VALUES ('agreement_poll_cursor', ?, 0) " +
          "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      )
      .run(valueJson);
    database.close();
  }

  it("returns undefined before any cursor is written", async () => {
    const store = createTestStore();
    await expect(store.readPollCursor()).resolves.toBeUndefined();
    store.close();
  });

  it("persists the cursor across close and reopen", async () => {
    const path = testPath();
    const first = createSqliteProviderIdempotencyStore(path);
    await first.writePollCursor(1_800_000_000);
    await first.writePollCursor(1_800_000_060);
    first.close();
    const second = createSqliteProviderIdempotencyStore(path);
    await expect(second.readPollCursor()).resolves.toBe(1_800_000_060);
    second.close();
  });

  it("keeps the cursor out of the operation records", async () => {
    const path = testPath();
    const store = createSqliteProviderIdempotencyStore(path);
    await store.writePollCursor(1_800_000_000);
    await expect(store.listIncompleteAgreementRootEventIds()).resolves.toEqual([]);
    await expect(store.countByState("received")).resolves.toBe(0);
    store.close();
    const database = new DatabaseSync(path);
    const rows = database.prepare("SELECT COUNT(*) AS cnt FROM pact_provider_operations").get() as { cnt: number };
    database.close();
    expect(rows.cnt).toBe(0);
  });

  it("rejects cursor values that are not non-negative safe Unix timestamps", async () => {
    const store = createTestStore();
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(store.writePollCursor(value)).rejects.toMatchObject({ code: "invalid_record" });
    }
    await expect(store.readPollCursor()).resolves.toBeUndefined();
    await store.writePollCursor(0);
    await expect(store.readPollCursor()).resolves.toBe(0);
    store.close();
  });

  it("fails closed on a corrupt or malformed persisted cursor", async () => {
    for (const valueJson of [
      "{not json",
      "null",
      JSON.stringify({ version: 2, created_at: 1_800_000_000 }),
      JSON.stringify({ version: 1, created_at: -5 }),
      JSON.stringify({ version: 1, created_at: 1.5 }),
      JSON.stringify({ version: 1, created_at: "1800000000" }),
      JSON.stringify({ version: 1 }),
    ]) {
      const path = testPath();
      createSqliteProviderIdempotencyStore(path).close();
      writeRawCursor(path, valueJson);
      const store = createSqliteProviderIdempotencyStore(path);
      await expect(store.readPollCursor()).rejects.toBeInstanceOf(ProviderIdempotencyError);
      await expect(store.readPollCursor()).rejects.toMatchObject({ code: "invalid_record" });
      store.close();
    }
  });

  it("reports a write to a closed store as a failure", async () => {
    const store = createTestStore();
    store.close();
    await expect(store.writePollCursor(1_800_000_000)).rejects.toMatchObject({ code: "store_unavailable" });
    await expect(store.readPollCursor()).rejects.toMatchObject({ code: "store_unavailable" });
  });

  it("opens a pre-#59 database without a metadata table and keeps its records", async () => {
    const path = testPath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE pact_provider_operations (
        agreement_root_event_id TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const record = createRecord({ state: "waiting_for_funding" });
    legacy
      .prepare("INSERT INTO pact_provider_operations (agreement_root_event_id, value_json, updated_at) VALUES (?, ?, ?)")
      .run(
        record.agreementRootEventId,
        JSON.stringify({
          version: 1,
          agreement_root_event_id: record.agreementRootEventId,
          agreement_id: record.agreementId,
          requester_public_key: record.requesterPublicKey,
          state: record.state,
          result_reference: null,
          result_summary: null,
          accepted_transition_event_id: null,
          task_delivered_transition_event_id: null,
          result_submitted_transition_event_id: null,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
          failure_code: null,
          prepared_event_json: null,
        }),
        record.updatedAt,
      );
    legacy.close();

    const store = createSqliteProviderIdempotencyStore(path);
    await expect(store.read(record.agreementRootEventId)).resolves.toMatchObject({ state: "waiting_for_funding" });
    await expect(store.readPollCursor()).resolves.toBeUndefined();
    await store.writePollCursor(1_800_000_000);
    await expect(store.listIncompleteAgreementRootEventIds()).resolves.toEqual([record.agreementRootEventId]);
    store.close();
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("lists incomplete operations, including unreadable rows, and excludes complete ones", async () => {
    const path = testPath();
    const store = createSqliteProviderIdempotencyStore(path);
    await store.write(createRecord({ agreementRootEventId: "1".repeat(64), state: "waiting_for_funding", updatedAt: 1 }));
    await store.write(createRecord({ agreementRootEventId: "2".repeat(64), state: "complete", updatedAt: 2 }));
    await store.write(createRecord({ agreementRootEventId: "3".repeat(64), state: "recovery_required", updatedAt: 3 }));
    await store.write(createRecord({
      agreementRootEventId: "4".repeat(64),
      state: "complete",
      resultSummary: 'a summary quoting "state":"received"',
      updatedAt: 4,
    }));
    store.close();
    const database = new DatabaseSync(path);
    database
      .prepare("INSERT INTO pact_provider_operations (agreement_root_event_id, value_json, updated_at) VALUES (?, ?, ?)")
      .run("5".repeat(64), "{corrupt", 5);
    database.close();

    const reopened = createSqliteProviderIdempotencyStore(path);
    await expect(reopened.listIncompleteAgreementRootEventIds()).resolves.toEqual([
      "1".repeat(64),
      "3".repeat(64),
      "5".repeat(64),
    ]);
    reopened.close();
  });
});
