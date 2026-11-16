import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PactAgentRuntimeError, type PactAgentRuntime, type PactAgentRuntimeConfig } from "./pactagent-runtime";
import type { PactAgentRuntimeEnv } from "./pactagent-runtime.live";

const factories = vi.hoisted(() => ({ environment: vi.fn(), runtime: vi.fn() }));
vi.mock("./pactagent-runtime.live", () => ({ createPactAgentRuntimeFromEnv: factories.environment }));
vi.mock("./pactagent-runtime", async (original) => ({
  ...await original<typeof import("./pactagent-runtime")>(),
  createPactAgentRuntime: factories.runtime,
}));

import { PactAgentWorkflowError } from "./pactagent-workflow";

import * as singleton from "./pactagent-runtime-singleton";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function environment() {
  const runtime = { start: vi.fn(async () => {}), shutdown: vi.fn(async () => {}) };
  return {
    runtime: runtime as unknown as PactAgentRuntime,
    composition: { runtimeMode: "hosted", externalProvider: true, providerPublicKey: "test-provider" },
    close: vi.fn(),
  } as unknown as PactAgentRuntimeEnv;
}

beforeEach(() => {
  singleton.resetPactAgentRuntime();
  factories.environment.mockReset();
  factories.runtime.mockReset();
});
afterEach(async () => {
  await singleton.shutdownPactAgentRuntime().catch(() => undefined);
  singleton.resetPactAgentRuntime();
});

describe("shared runtime initialization ownership", () => {
  it("shares one first initialization across concurrent callers and route module copies", async () => {
    const ready = deferred<PactAgentRuntimeEnv>();
    const env = environment();
    factories.environment.mockReturnValue(ready.promise);
    const first = singleton.getPactAgentRuntime();
    vi.resetModules();
    const otherRoute = await import("./pactagent-runtime-singleton");
    const callers = [first, ...Array.from({ length: 32 }, () => otherRoute.getPactAgentRuntime())];
    expect(factories.environment).toHaveBeenCalledTimes(1);
    expect(singleton.getRunningPactAgentRuntimeComposition()).toBeUndefined();
    ready.resolve(env);
    expect((await Promise.all(callers)).every(value => value === env.runtime)).toBe(true);
    expect(await otherRoute.getPactAgentRuntime()).toBe(env.runtime);
    expect(otherRoute.getRunningPactAgentRuntimeComposition()).toBe(env.composition);
    expect(env.runtime.start).not.toHaveBeenCalled(); // Environment factory returns a started runtime.
    await Promise.all([singleton.shutdownPactAgentRuntime(), otherRoute.shutdownPactAgentRuntime()]);
    expect(env.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(env.close).toHaveBeenCalledTimes(1);
  });

  it("preserves cross-module runtime status codes and workflow redaction", async () => {
    vi.resetModules();
    const otherRoute = await import("./pactagent-runtime-singleton");
    for (const [code, status] of [["transaction_not_found", 404], ["transaction_in_progress", 409]] as const) {
      const error = new PactAgentRuntimeError(code, "Public runtime error");
      expect(otherRoute.apiStatusForError(error)).toBe(status);
      expect(otherRoute.toApiError(error)).toEqual({ code, error: "Public runtime error" });
    }
    for (const [code, status, message] of [
      ["privacy_boundary_violation", 500, "Internal error"],
      ["reconciliation_required", 409, "Transaction requires reconciliation"],
      ["execution_failed", 409, "The transaction could not be completed; check its status or refund after the timeout"],
    ] as const) {
      const error = new PactAgentWorkflowError(code, "PRIVATE-CAUSE");
      expect(otherRoute.apiStatusForError(error)).toBe(status);
      expect(otherRoute.toApiError(error).error).toBe(message);
      expect(JSON.stringify(otherRoute.toApiError(error))).not.toContain("PRIVATE-CAUSE");
    }
    for (const error of [
      { code: "transaction_not_found", message: "PRIVATE-CAUSE" },
      { [Symbol.for("pactagent.runtime-error")]: true, code: "unknown", message: "PRIVATE-CAUSE" },
      { [Symbol.for("pactagent.workflow-error")]: true, code: "execution_failed", message: 42 },
    ]) {
      expect(otherRoute.apiStatusForError(error)).toBe(500);
      expect(otherRoute.toApiError(error)).toEqual({ error: "Internal error", code: "internal_error" });
    }
  });

  it("propagates the same failed initialization to all callers and permits a fresh retry", async () => {
    const ready = deferred<PactAgentRuntimeEnv>();
    const env = environment();
    const failure = new Error("initialization failed after factory-owned cleanup");
    factories.environment.mockReturnValueOnce(ready.promise).mockResolvedValueOnce(env);
    const results = Promise.allSettled(Array.from({ length: 8 }, () => singleton.getPactAgentRuntime()));
    ready.reject(failure);
    for (const result of await results) expect(result).toEqual({ status: "rejected", reason: failure });
    expect(factories.environment).toHaveBeenCalledTimes(1);
    expect(singleton.getRunningPactAgentRuntimeComposition()).toBeUndefined();
    expect(await singleton.getPactAgentRuntime()).toBe(env.runtime);
    expect(factories.environment).toHaveBeenCalledTimes(2);
    await singleton.shutdownPactAgentRuntime();
    expect(env.close).toHaveBeenCalledTimes(1);
  });

  it("shares explicit startup and retries a failed start on the same configured runtime", async () => {
    const ready = deferred<void>();
    const env = environment();
    const start = vi.mocked(env.runtime.start).mockReturnValueOnce(ready.promise).mockResolvedValue(undefined);
    factories.runtime.mockReturnValue(env.runtime);
    singleton.configurePactAgentRuntime({} as PactAgentRuntimeConfig, env.close);
    const results = Promise.allSettled([singleton.getPactAgentRuntime(), singleton.getPactAgentRuntime()]);
    const failure = new Error("relay connection failed");
    ready.reject(failure);
    expect(await results).toEqual([{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
    expect(await singleton.getPactAgentRuntime()).toBe(env.runtime);
    expect(factories.runtime).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    await singleton.shutdownPactAgentRuntime();
    expect(env.close).toHaveBeenCalledTimes(1);
  });

  it("waits for initialization before shutdown and rejects reset or new startup while stopping", async () => {
    const ready = deferred<PactAgentRuntimeEnv>();
    const env = environment();
    factories.environment.mockReturnValue(ready.promise);
    const pending = Promise.allSettled([
      singleton.getPactAgentRuntime(), singleton.getPactAgentRuntime(),
    ]);
    const stopped = singleton.shutdownPactAgentRuntime();
    const duplicateStop = singleton.shutdownPactAgentRuntime();
    await expect(singleton.getPactAgentRuntime()).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(() => singleton.resetPactAgentRuntime()).toThrow("lifecycle is still in progress");
    expect(() => singleton.configurePactAgentRuntime({} as PactAgentRuntimeConfig)).toThrow("already configured");
    expect(env.close).not.toHaveBeenCalled();
    ready.resolve(env);
    for (const result of await pending) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "invalid_configuration" });
    }
    await Promise.all([stopped, duplicateStop]);
    expect(env.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(env.close).toHaveBeenCalledTimes(1);
    await expect(singleton.getPactAgentRuntime()).rejects.toMatchObject({ code: "invalid_configuration" });
    singleton.resetPactAgentRuntime();
    const next = environment();
    factories.environment.mockResolvedValue(next);
    expect(await singleton.getPactAgentRuntime()).toBe(next.runtime);
  });

  it("allows shutdown after initialization failure without inventing a second environment", async () => {
    const ready = deferred<PactAgentRuntimeEnv>();
    factories.environment.mockReturnValue(ready.promise);
    const outcome = singleton.getPactAgentRuntime().catch(error => error);
    const stopped = singleton.shutdownPactAgentRuntime();
    const failure = new Error("factory cleaned up a failed initialization");
    ready.reject(failure);
    expect(await outcome).toBe(failure);
    await stopped;
    expect(factories.environment).toHaveBeenCalledTimes(1);
    expect(singleton.getRunningPactAgentRuntimeComposition()).toBeUndefined();
  });

  it("does not repeat cleanup when close fails", async () => {
    const env = environment();
    const failure = new Error("store close failed");
    vi.mocked(env.close).mockImplementation(() => { throw failure; });
    factories.environment.mockResolvedValue(env);
    await singleton.getPactAgentRuntime();
    await expect(singleton.shutdownPactAgentRuntime()).rejects.toBe(failure);
    await expect(singleton.shutdownPactAgentRuntime()).rejects.toBe(failure);
    expect(env.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(env.close).toHaveBeenCalledTimes(1);
  });
});
