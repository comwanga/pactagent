import { describe, expect, it } from "vitest";
import { AdmissionLimitError, TransactionAdmission } from "./admission-control";
import { createPactAgentRuntime } from "./pactagent-runtime";
import { buildFixture, buildRuntimeConfig, sharedStores, startInput } from "./pactagent-runtime-test-fixture";

describe("Issue #65 runtime admission", () => {
  it("releases an unscheduled permit when the store rejects after its callback, retaining recoverable state", async () => {
    const shared = sharedStores();
    const { config, cashu } = buildRuntimeConfig(buildFixture(), shared);
    const gate = new TransactionAdmission(1, 1);
    let rejectAfterCallback = true;
    const runtime = createPactAgentRuntime({
      ...config, transactionAdmission: gate,
      privateStore: {
        ...shared.privateStore,
        async withExclusiveLock(scope, key, operation) {
          const result = await shared.privateStore.withExclusiveLock(scope, key, operation);
          if (scope === "transaction" && rejectAfterCallback) {
            rejectAfterCallback = false;
            throw new Error("controlled post-callback lease failure");
          }
          return result;
        },
      },
    });
    await runtime.start();
    try {
      await expect(runtime.acceptTransaction(startInput("post-callback-lock-failure"))).rejects.toThrow("post-callback lease failure");
      const release = gate.acquire("new"); release();
      const ids = await shared.privateStore.list!("transaction");
      expect(ids).toHaveLength(1);
      expect((await runtime.status(ids[0])).phase).toBe("initialized");
      expect(cashu.prepareCalls).toBe(0); expect(cashu.spendCalls).toBe(0);
      expect((await runtime.resume(ids[0])).finalOutcome).toBe("settled");
      expect(cashu.prepareCalls).toBe(1); expect(cashu.spendCalls).toBe(1);
    } finally { await runtime.shutdown(); }
  });

  it("rejects N+1 before funding binding or durable acceptance across runtime objects, while recovery and duplicate acceptance remain available", async () => {
    const shared = sharedStores();
    const { config, cashu } = buildRuntimeConfig(buildFixture(), shared);
    const gate = new TransactionAdmission(2, 1);
    let unblock!: () => void, ready!: () => void;
    const waiting = new Promise<void>(resolve => { unblock = resolve; });
    const entered = new Promise<void>(resolve => { ready = resolve; });
    let bindings = 0;
    const limited = {
      ...config, transactionAdmission: gate,
      bindDemoTransactionFunding: async () => {
        if (++bindings === 2) ready();
        await waiting;
        throw new Error("controlled funding binding failure");
      },
    };
    const first = createPactAgentRuntime(limited), second = createPactAgentRuntime(limited);
    await first.start(); await second.start();
    try {
      const completed = await first.startTransaction(startInput("completed-before-capacity"));
      const pending = [first, second].map((runtime, i) => runtime.acceptTransaction(startInput(`pending-binding-${i}`)).catch(error => error));
      await entered;
      await expect(second.acceptTransaction(startInput("capacity-rejected-new"))).rejects.toBeInstanceOf(AdmissionLimitError);
      await expect(second.startTransaction(startInput("capacity-rejected-sync"))).rejects.toBeInstanceOf(AdmissionLimitError);
      expect(bindings).toBe(2);
      expect(await shared.privateStore.list!("transaction")).toEqual([completed.transactionId]);
      expect(await second.acceptTransaction(startInput("completed-before-capacity"))).toEqual({ transactionId: completed.transactionId });
      expect((await second.resume(completed.transactionId)).finalOutcome).toBe("settled");
      expect(cashu.prepareCalls).toBe(1); expect(cashu.spendCalls).toBe(1);
      unblock();
      for (const error of await Promise.all(pending)) expect(error.message).toBe("controlled funding binding failure");
      const one = gate.acquire("new"), two = gate.acquire("new"); one(); two();
    } finally {
      unblock();
      await first.shutdown(); await second.shutdown();
    }
  });

  it("releases scheduled-execution capacity after a persisted failure", async () => {
    const shared = sharedStores();
    const { config } = buildRuntimeConfig(buildFixture(), shared);
    const gate = new TransactionAdmission(1, 1);
    const runtime = createPactAgentRuntime({
      ...config, transactionAdmission: gate,
      resolveFunding: async () => { throw new Error("controlled funding resolution failure"); },
    });
    await runtime.start();
    const accepted = await runtime.acceptTransaction(startInput("scheduled-failure-capacity"));
    await runtime.shutdown(); // Waits for the actual scheduled operation; no timer-based permit release.
    const release = gate.acquire("new"); release();
    await runtime.start();
    expect((await runtime.status(accepted.transactionId)).operationalState).toBe("failed");
    await runtime.shutdown();
  });
});
