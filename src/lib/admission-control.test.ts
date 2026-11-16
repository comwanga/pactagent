import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionLimitError, RequestBudgets, TransactionAdmission, readAdmissionLimits, reserveWalletAllocation, processTransactionAdmission } from "./admission-control";
import { publicClientKey, admitRequester } from "./requester-admission.server";
import { createSqliteRequesterSessionStore, configureRequesterSessionStoreForTesting } from "./requester-session-store.server";
import { createSqliteCashuPrivateStore } from "./cashu-test-mint";
import { ensureRequesterSession, REQUESTER_SESSION_COOKIE } from "./requester-session.server";
import { GET as currentTransaction } from "@/app/api/requester/session/current-transaction/route";
import { safeRetryAfter } from "./requester-api-contracts";
import { RequesterRuntimeTransport } from "./requester-runtime-transport.server";
import { transportResponse } from "@/app/api/requester/transactions/http";
import { RequesterApiClient } from "./requester-api-client";

const directories: string[] = [];
const close: (() => void)[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "pactagent-admission-"));
  directories.push(path);
  return path;
}
function sessionStore(path = join(directory(), "sessions.sqlite")) {
  const store = createSqliteRequesterSessionStore(path);
  close.push(() => store.close());
  return store;
}
function request(headers: Record<string, string> = {}) {
  return new Request("https://example.test/api/requester/session/current-transaction", {
    headers: { origin: "https://example.test", "sec-fetch-site": "same-origin", "x-real-ip": "192.0.2.1", ...headers },
  });
}
afterEach(() => {
  configureRequesterSessionStoreForTesting(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (close.length) close.pop()!();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("Issue #65 identity and request budgets", () => {
  it("uses only the Railway edge address and ignores other spoofed forwarding identities", () => {
    const env = { NODE_ENV: "production" as const, RAILWAY_ENVIRONMENT_ID: "test-environment" };
    const key = publicClientKey(request(), env);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("192.0.2.1");
    expect(publicClientKey(request({ "x-forwarded-for": "198.51.100.1", forwarded: "for=198.51.100.2", "cf-connecting-ip": "198.51.100.3" }), env)).toBe(key);
    expect(publicClientKey(request({ "x-real-ip": "2001:db8::1" }), env)).toBe(publicClientKey(request({ "x-real-ip": "2001:0db8:0:0:0:0:0:1" }), env));
  });

  it.each(["", "unknown", "192.0.2.1, 192.0.2.2", "fe80::1%eth0", "127.1"]) ("fails closed for invalid Railway identity %s", value => {
    expect(() => publicClientKey(request({ "x-real-ip": value }), { RAILWAY_ENVIRONMENT_ID: "test" })).toThrow(AdmissionLimitError);
  });

  it("rejects missing identity even if X-Forwarded-For is present", () => {
    const req = request({ "x-forwarded-for": "192.0.2.1" }); req.headers.delete("x-real-ip");
    expect(() => publicClientKey(req, { RAILWAY_ENVIRONMENT_ID: "test" })).toThrow(AdmissionLimitError);
  });

  it("never trusts forwarded addresses in local mode", () => {
    const env = { PACTAGENT_REQUESTER_UI_ORIGIN: "http://localhost:3000", NODE_ENV: "production" as const };
    expect(publicClientKey(request({ "x-real-ip": "192.0.2.2" }), env)).toBe(publicClientKey(request(), env));
    expect(() => publicClientKey(request(), { NODE_ENV: "production", PACTAGENT_REQUESTER_UI_ORIGIN: "https://example.test" })).toThrow(TypeError);
  });

  it("enforces windows, isolates keys, and retains unexpired budgets when full", () => {
    const budgets = new RequestBudgets(2);
    budgets.consume("a", 2, 1_000); budgets.consume("a", 2, 1_000);
    expect(() => budgets.consume("a", 2, 1_000)).toThrow(AdmissionLimitError);
    budgets.consume("recovery-client", 1, 1_000, "recovery");
    budgets.consume("b", 2, 1_000);
    expect(() => budgets.consume("c", 2, 1_000)).toThrow(AdmissionLimitError);
    expect(() => budgets.consume("a", 2, 1_000)).toThrow(AdmissionLimitError);
    budgets.consume("c", 2, 60_000);
    budgets.consume("a", 2, 60_000);
  });

  it("isolates session budgets while preserving recovery capacity and IP accounting across session rotation", () => {
    vi.stubEnv("PACTAGENT_BFF_SESSION_PER_MINUTE", "1");
    vi.stubEnv("PACTAGENT_BFF_IP_PER_MINUTE", "4");
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "test");
    const store = sessionStore(), budgets = new RequestBudgets();
    const one = ensureRequesterSession(request(), store, 1000), two = ensureRequesterSession(request(), store, 1000);
    const first = request({ cookie: `${REQUESTER_SESSION_COOKIE}=${one.newSecret}` });
    const second = request({ cookie: `${REQUESTER_SESSION_COOKIE}=${two.newSecret}` });
    admitRequester(first, store, { budgets, nowMs: 1000 });
    expect(() => admitRequester(first, store, { budgets, nowMs: 1000 })).toThrow(AdmissionLimitError);
    admitRequester(second, store, { budgets, nowMs: 1000 });
    admitRequester(first, store, { recovery: true, budgets, nowMs: 1000 });
    admitRequester(request(), store, { budgets, nowMs: 1000 });
    expect(() => admitRequester(request(), store, { budgets, nowMs: 1000 })).toThrow(AdmissionLimitError);
  });

  it("returns a typed redacted 429 and correct Retry-After before creating more sessions", async () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "test");
    vi.stubEnv("PACTAGENT_REQUESTER_UI_ORIGIN", "https://example.test");
    vi.stubEnv("PACTAGENT_BFF_IP_PER_MINUTE", "1");
    vi.spyOn(Date, "now").mockReturnValue(1000);
    configureRequesterSessionStoreForTesting(sessionStore());
    const first = currentTransaction(request()); expect(first.status).toBe(200);
    const limited = currentTransaction(request({ "x-forwarded-for": "198.51.100.1", cookie: first.headers.get("set-cookie")! }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("59");
    const body = await limited.json(); expect(body.code).toBe("rate_limited");
    expect(JSON.stringify(body)).not.toMatch(/192\.0\.2|pactagent_requester_session|session_hash/);
    expect(limited.headers.has("set-cookie")).toBe(false);
  });

  it("enforces per-session route budgets without logging credentials or affecting another session", async () => {
    vi.stubEnv("PACTAGENT_REQUESTER_UI_ORIGIN", "https://example.test");
    vi.stubEnv("PACTAGENT_BFF_SESSION_PER_MINUTE", "1");
    const store = sessionStore(); configureRequesterSessionStoreForTesting(store);
    const one = ensureRequesterSession(request(), store), two = ensureRequesterSession(request(), store);
    const req = request({ cookie: `${REQUESTER_SESSION_COOKIE}=${one.newSecret}` });
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(currentTransaction(req).status).toBe(200);
    const limited = currentTransaction(req); expect(limited.status).toBe(429);
    expect((await limited.json()).code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(currentTransaction(request({ cookie: `${REQUESTER_SESSION_COOKIE}=${two.newSecret}` })).status).toBe(200);
    expect(logger).not.toHaveBeenCalled();
  });

  it("rejects missing Railway identity at the route boundary without consuming a daily session allowance", async () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "test");
    vi.stubEnv("PACTAGENT_REQUESTER_UI_ORIGIN", "https://example.test");
    vi.stubEnv("PACTAGENT_SESSIONS_PER_DAY", "1");
    configureRequesterSessionStoreForTesting(sessionStore());
    const missing = request(); missing.headers.delete("x-real-ip");
    const rejected = currentTransaction(missing);
    expect(rejected.status).toBe(429); expect(rejected.headers.get("retry-after")).toBe("60");
    expect(rejected.headers.has("set-cookie")).toBe(false);
    expect(currentTransaction(request()).status).toBe(200);
  });
});

describe("Issue #65 durable daily accounting", () => {
  it("fails closed on malformed persisted session accounting instead of granting more sessions", () => {
    vi.stubEnv("PACTAGENT_SESSIONS_PER_DAY", "1");
    const path = join(directory(), "sessions.sqlite"), first = sessionStore(path);
    first.create("a".repeat(64), 1000, 10 * 86_400_000);
    first.close();
    const db = new DatabaseSync(path);
    db.exec("UPDATE requester_creation_usage SET count = 'broken'"); db.close();
    const reopened = sessionStore(path);
    expect(() => reopened.create("b".repeat(64), 1000, 10 * 86_400_000)).toThrow("Requester session storage is unavailable");
    expect(() => reopened.create("c".repeat(64), 1000, 10 * 86_400_000)).toThrow();
  });

  it("atomically caps sessions across connections and reopen, rolls over, and rolls back failed inserts", async () => {
    vi.stubEnv("PACTAGENT_SESSIONS_PER_DAY", "2");
    const path = join(directory(), "sessions.sqlite"), first = sessionStore(path), second = sessionStore(path);
    first.create("a".repeat(64), 1000, 10 * 86_400_000);
    expect(() => first.create("a".repeat(64), 1000, 10 * 86_400_000)).toThrow();
    const results = await Promise.allSettled([second, first].map((store, i) => Promise.resolve().then(() => store.create(String(i).repeat(64), 1000, 10 * 86_400_000))));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    first.close(); second.close();
    const reopened = sessionStore(path);
    expect(() => reopened.create("b".repeat(64), 1000, 10 * 86_400_000)).toThrow(AdmissionLimitError);
    reopened.create("b".repeat(64), 86_400_000, 10 * 86_400_000);
    expect(() => reopened.create("c".repeat(64), 1000, 10 * 86_400_000)).toThrow(AdmissionLimitError);
  });

  it("returns 429 for the daily session cap without a session cookie", async () => {
    vi.stubEnv("PACTAGENT_SESSIONS_PER_DAY", "1");
    vi.stubEnv("PACTAGENT_REQUESTER_UI_ORIGIN", "https://example.test");
    configureRequesterSessionStoreForTesting(sessionStore());
    expect(currentTransaction(request()).status).toBe(200);
    const response = currentTransaction(request());
    expect(response.status).toBe(429); expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await response.json()).code).toBe("rate_limited");
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("serializes wallet allocation accounting across connections, survives reopen, and rolls over", async () => {
    const path = join(directory(), "private.sqlite");
    const a = createSqliteCashuPrivateStore(path), b = createSqliteCashuPrivateStore(path);
    close.push(() => a.close(), () => b.close());
    const results = await Promise.allSettled([reserveWalletAllocation(a, 1, 1000), reserveWalletAllocation(b, 1, 1000)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    close.pop()!(); close.pop()!();
    const reopened = createSqliteCashuPrivateStore(path); close.push(() => reopened.close());
    await expect(reserveWalletAllocation(reopened, 1, 1000)).rejects.toBeInstanceOf(AdmissionLimitError);
    await reserveWalletAllocation(reopened, 1, 86_400_000);
    await expect(reserveWalletAllocation(reopened, 1, 1000)).rejects.toBeInstanceOf(AdmissionLimitError);
    expect(await reopened.list!("resource-admission")).toEqual(["wallet-allocations"]);
  });
});

describe("Issue #65 admission configuration and permits", () => {
  it.each([["17", 17], ["invalid", 1]] as const)("preserves a redacted typed 429 through runtime, BFF, and browser with Retry-After %s", async (header, expected) => {
    const transport = new RequesterRuntimeTransport({
      apiBase: "http://runtime.internal", apiToken: "SERVER-TOKEN",
      fetch: async () => new Response(JSON.stringify({ code: "rate_limited", error: "SECRET-INTERNAL-ERROR" }), {
        status: 429, headers: { "content-type": "application/json", "retry-after": header },
      }),
    });
    const result = await transport.startDemo("session-wallet");
    const response = transportResponse(result);
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe(String(expected));
    expect(JSON.stringify(result)).not.toMatch(/SECRET-INTERNAL-ERROR|SERVER-TOKEN/);
    const browser = new RequesterApiClient({ fetch: async () => response });
    await expect(browser.startDemo()).rejects.toMatchObject({ status: 429, detail: { code: "rate_limited" }, retryAfterSeconds: expected });
  });

  it("preserves typed 429 errors when separate module copies share the process gate", async () => {
    const gate = processTransactionAdmission();
    const release = Array.from({ length: gate.newCapacity }, () => gate.acquire("new"));
    try {
      vi.resetModules();
      const other = await import("./admission-control");
      const api = await import("./pactagent-runtime-singleton");
      expect(other.processTransactionAdmission()).toBe(gate);
      let error: unknown;
      try { other.processTransactionAdmission().acquire("new"); } catch (caught) { error = caught; }
      expect(error).not.toBeInstanceOf(other.AdmissionLimitError);
      expect(other.isAdmissionLimitError(error)).toBe(true);
      expect(other.admissionHeaders(error)).toEqual({ "Retry-After": "1" });
      expect(api.apiStatusForError(error)).toBe(429);
      expect(api.toApiError(error).code).toBe("rate_limited");
    } finally { release.forEach(release => release()); }
  });
  it.each(["", "0", "-1", "1.5", "NaN", " 2", "99999999999999999999"])("rejects unsafe configuration %s", value => {
    expect(() => readAdmissionLimits({ PACTAGENT_NEW_TRANSACTION_CAPACITY: value })).toThrow(TypeError);
  });

  it("does not leak permits after rejection, failure, or repeated release; recovery is independent", async () => {
    const gate = new TransactionAdmission(2, 1);
    const one = gate.acquire("new"), two = gate.acquire("new");
    expect(() => gate.acquire("new")).toThrow(AdmissionLimitError);
    await expect(gate.run("recovery", async () => { throw new Error("controlled failure"); })).rejects.toThrow("controlled failure");
    const recovery = gate.acquire("recovery"); expect(() => gate.acquire("recovery")).toThrow(AdmissionLimitError); recovery();
    one(); one(); const replacement = gate.acquire("new"); expect(() => gate.acquire("new")).toThrow(AdmissionLimitError);
    two(); replacement();
    await gate.run("new", async () => undefined);
  });

  it.each([null, "", "0", "-1", "tomorrow", "1.5", "99999999999999999999"])("sanitizes invalid Retry-After %s", value => {
    expect(safeRetryAfter(value)).toBe(1);
  });
});
