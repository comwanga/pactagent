import { describe, expect, it, vi } from "vitest";
import { createPactAgentRuntime } from "./pactagent-runtime";
import { createPrivateDataCipher, PrivateDataError } from "./private-data";
import { PrivateTransactionRecords } from "./private-transaction-records";
import { buildFixture, buildRuntimeConfig, sharedStores, startInput, transactionId, ROOT_TIME } from "./pactagent-runtime-test-fixture";
import { DeterministicPactAgentClock } from "./pactagent-workflow";
import { PRIVATE_DATA_SWEEP_INTERVAL_MS } from "./private-data-policy";

const cipher = () => createPrivateDataCipher({ test: "71".repeat(32) }, "test");
function fixture() {
  const stores = sharedStores();
  const built = buildRuntimeConfig(buildFixture(), stores);
  const config = { ...built.config, privateData: { cipher: cipher(), retentionSeconds: 10 }, privateDataAccountingComplete: async () => true };
  return { ...built, stores, config, clock: config.dependencies.clock as DeterministicPactAgentClock };
}

describe("Issue #66 runtime private-data lifecycle", () => {
  it("runs startup and periodic maintenance and cancels scheduling on shutdown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture(); const runtime = createPactAgentRuntime(f.config);
    const maintenance = vi.spyOn(runtime, "maintainPrivateData");
    try {
      await runtime.start(); await runtime.maintainPrivateData();
      const startupCalls = maintenance.mock.calls.length;
      await vi.advanceTimersByTimeAsync(PRIVATE_DATA_SWEEP_INTERVAL_MS);
      await runtime.maintainPrivateData();
      expect(maintenance.mock.calls.length).toBeGreaterThan(startupCalls);
      await runtime.shutdown();
      const shutdownCalls = maintenance.mock.calls.length;
      await vi.advanceTimersByTimeAsync(PRIVATE_DATA_SWEEP_INTERVAL_MS * 2);
      expect(maintenance).toHaveBeenCalledTimes(shutdownCalls);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await runtime.shutdown(); maintenance.mockRestore(); vi.useRealTimers(); }
  });
  it("never signs or writes while inspecting legacy terminal history, even in local-provider mode", async () => {
    const f = fixture(); const runtime = createPactAgentRuntime(f.config);
    const signers = [f.config.identities.requesterSigner, f.config.identities.providerSigner, f.config.identities.escrowAuthoritySigner];
    const spies = signers.map(signer => vi.spyOn(signer, "sign"));
    await runtime.start();
    try {
      const { transactionId: id, report } = await runtime.startTransaction(startInput("private-readonly-001"));
      const source = (await Promise.all(spies[1].mock.results.filter(result => result.type === "return").map(result => result.value)))
        .find(event => event.tags.some((tag: readonly string[]) => tag[0] === "t" && tag[1] === "pactagent/escrow-authority@1"));
      // Local mode need not publish this source. Historical reads must never recreate it.
      const records = new PrivateTransactionRecords(f.stores.privateStore, cipher());
      const legacy = await records.read(id) as Record<string, unknown>;
      delete legacy.terminalReport; delete legacy.retentionStartedAt;
      await f.stores.privateStore.write("transaction", id, legacy);
      spies.forEach(spy => spy.mockClear());
      const raw = await f.stores.privateStore.read("transaction", id);
      const before = { events: f.relay.events.length, prepares: f.cashu.prepareCalls, spends: f.cashu.spendCalls };
      await expect(runtime.report(id)).rejects.toMatchObject({ code: "report_not_available" });
      expect(await f.stores.privateStore.read("transaction", id)).toEqual(raw);
      expect(source).toBeDefined();
      f.relay.events.push(source!);
      expect(await runtime.report(id)).toEqual(report);
      spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
      expect(await f.stores.privateStore.read("transaction", id)).toEqual(raw);
      expect({ events: f.relay.events.length - 1, prepares: f.cashu.prepareCalls, spends: f.cashu.spendCalls }).toEqual(before);
    } finally { spies.forEach(spy => spy.mockRestore()); await runtime.shutdown(); }
  }, 30_000);

  it("waits for wallet accounting and coalesces simultaneous maintenance", async () => {
    const f = fixture(); let accounting = false;
    const runtime = createPactAgentRuntime({ ...f.config, privateDataAccountingComplete: async () => accounting });
    await runtime.start();
    try {
      const { transactionId: id } = await runtime.startTransaction(startInput("private-accounting-001"));
      const records = new PrivateTransactionRecords(f.stores.privateStore, cipher());
      await runtime.maintainPrivateData(); f.clock.advance(100);
      expect(await records.read(id)).not.toHaveProperty("retentionStartedAt");
      accounting = true;
      await runtime.maintainPrivateData();
      expect(await records.read(id)).toHaveProperty("retentionStartedAt", f.clock.now());
      f.clock.advance(10);
      await Promise.all([runtime.maintainPrivateData(), runtime.maintainPrivateData()]);
      expect(await records.read(id)).toHaveProperty("purgedAt");
    } finally { await runtime.shutdown(); }
  }, 30_000);
  it("encrypts new rows and preserves reports/status/idempotency after an expired terminal purge", async () => {
    const f = fixture(); const runtime = createPactAgentRuntime(f.config);
    await runtime.start();
    try {
      const input = startInput("private-retention-001");
      const { transactionId: id, report } = await runtime.startTransaction(input);
      expect(JSON.stringify(await f.stores.privateStore.read("transaction", id))).not.toContain(input.privateDocument);
      await runtime.maintainPrivateData();
      f.clock.advance(10);
      const before = { events: f.relay.events.length, prepares: f.cashu.prepareCalls, spends: f.cashu.spendCalls };
      await runtime.maintainPrivateData();
      const record = await new PrivateTransactionRecords(f.stores.privateStore, cipher()).read(id);
      expect(record).not.toHaveProperty("privateTerms"); expect(record).not.toHaveProperty("privateSaltHex");
      expect(record).toHaveProperty("purgedAt");
      f.relay.reconnect = async () => { throw new Error("offline"); };
      expect(await runtime.report(id)).toEqual(report);
      expect(await runtime.status(id)).toMatchObject({ phase: "settled", operationalState: "settled", reportAvailable: true, availableActions: { resume: false, refund: false, reconcile: false } });
      expect((await runtime.acceptTransaction(input)).transactionId).toBe(id);
      expect({ events: f.relay.events.length, prepares: f.cashu.prepareCalls, spends: f.cashu.spendCalls }).toEqual(before);
      await runtime.shutdown();
      const restarted = createPactAgentRuntime(f.config); await restarted.start();
      try { expect(await restarted.report(id)).toEqual(report); }
      finally { await restarted.shutdown(); }
    } finally { await runtime.shutdown(); }
  }, 30_000);

  it("retains private data when a competing storage revision wins the purge race", async () => {
    const f = fixture(); let compete = false;
    const base = f.stores.privateStore;
    const store = { ...base, async compareAndSet(scope: string, id: string, expected: unknown, value: unknown) {
      const proposed = scope === "transaction" ? cipher().open(scope, id, value) as Record<string, unknown> : undefined;
      if (compete && proposed?.purgedAt !== undefined) {
        compete = false;
        const previous = cipher().open(scope, id, expected) as Record<string, unknown>;
        await base.compareAndSet!(scope, id, expected, cipher().seal(scope, id, { ...previous, storageRevision: Number(previous.storageRevision) + 1 }));
      }
      return base.compareAndSet!(scope, id, expected, value);
    } };
    const runtime = createPactAgentRuntime({ ...f.config, privateStore: store }); await runtime.start();
    try {
      const { transactionId: id } = await runtime.startTransaction(startInput("private-purge-race-001"));
      await runtime.maintainPrivateData(); f.clock.advance(10); compete = true;
      expect(await runtime.maintainPrivateData()).toMatchObject({ purged: 0, failed: 1 });
      const record = await new PrivateTransactionRecords(base, cipher()).read(id);
      expect(record).toHaveProperty("privateTerms"); expect(record).not.toHaveProperty("purgedAt");
      expect(await runtime.maintainPrivateData()).toMatchObject({ purged: 1, failed: 0 });
    } finally { await runtime.shutdown(); }
  }, 30_000);

  it("does not convert relay retrieval failure into report unavailability or a retention timestamp", async () => {
    const f = fixture(); const runtime = createPactAgentRuntime(f.config); await runtime.start();
    try {
      const { transactionId: id } = await runtime.startTransaction(startInput("private-relay-failure-001"));
      const records = new PrivateTransactionRecords(f.stores.privateStore, cipher());
      const legacy = await records.read(id) as Record<string, unknown>;
      delete legacy.terminalReport; delete legacy.retentionStartedAt;
      await f.stores.privateStore.write("transaction", id, legacy);
      const query = vi.spyOn(f.relay, "queryEvents").mockRejectedValue(new Error("private fixture relay unavailable"));
      try {
        await expect(runtime.report(id)).rejects.toMatchObject({ code: "retrieval_failure" });
        expect(await runtime.maintainPrivateData()).toMatchObject({ failed: 1, purged: 0 });
        expect(await records.read(id)).not.toHaveProperty("retentionStartedAt");
        expect(await records.read(id)).toHaveProperty("privateTerms");
      } finally { query.mockRestore(); }
    } finally { await runtime.shutdown(); }
  }, 30_000);

  it("keeps verified settlement independent of a missing legacy result and returns report_not_available", async () => {
    const f = fixture(); const runtime = createPactAgentRuntime(f.config);
    await runtime.start();
    try {
      const { transactionId: id } = await runtime.startTransaction(startInput("private-legacy-result-001"));
      const records = new PrivateTransactionRecords(f.stores.privateStore, cipher());
      const legacy = await records.read(id) as Record<string, unknown>;
      delete legacy.terminalReport; delete legacy.retentionStartedAt; delete legacy.reportUnavailable;
      await f.stores.privateStore.write("transaction", id, legacy);
      f.relay.events.splice(0, f.relay.events.length, ...f.relay.events.filter(event => event.kind !== 1059));
      const before = { events: f.relay.events.length, spends: f.cashu.spendCalls };
      await expect(runtime.report(id)).rejects.toMatchObject({ code: "report_not_available" });
      await runtime.maintainPrivateData(); f.clock.advance(10); await runtime.maintainPrivateData();
      expect(await runtime.status(id)).toMatchObject({ phase: "settled", operationalState: "settled", reportAvailable: false, availableActions: { resume: false, refund: false, reconcile: false } });
      expect(await records.read(id)).not.toHaveProperty("privateTerms");
      await expect(runtime.report(id)).rejects.toMatchObject({ code: "report_not_available" });
      expect({ events: f.relay.events.length, spends: f.cashu.spendCalls }).toEqual(before);
    } finally { await runtime.shutdown(); }
  }, 30_000);

  it("retains nonterminal private material past the window and fails closed with a wrong restart key", async () => {
    const f = fixture(); const id = transactionId("private-inflight-001");
    const legacy = { version: 1, transactionId: id, idempotencyKey: "private-inflight-001", kind: "successful", phase: "initialized", agreementId: "private-inflight-agreement", agreementCreatedAt: ROOT_TIME, agreementExpiresAt: ROOT_TIME + 900, fundingReference: "funding-reference-0001", privateTerms: { source_document: "PRIVATE-RECOVERY", input_media_type: "text/plain" }, privateSaltHex: "37".repeat(32) };
    await f.stores.privateStore.write("transaction", id, legacy);
    const runtime = createPactAgentRuntime(f.config); await runtime.start();
    f.clock.advance(365 * 86400); await runtime.maintainPrivateData(); await runtime.shutdown();
    const wrong = createPactAgentRuntime({ ...f.config, privateData: { cipher: createPrivateDataCipher({ test: "72".repeat(32) }, "test"), retentionSeconds: 10 } });
    await wrong.start();
    try { await expect(wrong.status(id)).rejects.toThrow(PrivateDataError); }
    finally { await wrong.shutdown(); }
    expect(await new PrivateTransactionRecords(f.stores.privateStore, cipher()).read(id)).toMatchObject({ privateTerms: legacy.privateTerms, privateSaltHex: legacy.privateSaltHex });
    expect(f.cashu.prepareCalls).toBe(0); expect(f.cashu.spendCalls).toBe(0);
  });
});
