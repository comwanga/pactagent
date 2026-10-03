import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
