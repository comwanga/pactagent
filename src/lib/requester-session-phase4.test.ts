import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as currentTransaction, DELETE as closeTransaction } from "@/app/api/requester/session/current-transaction/route";
import { POST as createTransaction } from "@/app/api/requester/transactions/route";
import { GET as transactionStatus } from "@/app/api/requester/transactions/[id]/route";
import { GET as privateResult } from "@/app/api/requester/transactions/[id]/result/route";
import { GET as safeReport } from "@/app/api/requester/transactions/[id]/report/route";
import { POST as resumeTransaction } from "@/app/api/requester/transactions/[id]/resume/route";
import { POST as reconcileTransaction } from "@/app/api/requester/transactions/[id]/reconcile/route";
import { POST as refundTransaction } from "@/app/api/requester/transactions/[id]/refund/route";
import {
  configureRequesterSessionStoreForTesting,
  createSqliteRequesterSessionStore,
  type RequesterSessionStore,
} from "./requester-session-store.server";
import { REQUESTER_SESSION_COOKIE, requesterSessionHash } from "./requester-session.server";

const ORIGIN = "http://pactagent.local";
const TRANSACTION_ID = "txn_0123456789abcdef0123456789abcdef";
const PRIVATE_DOCUMENT = "PHASE4-PRIVATE-DOCUMENT-SENTINEL";
const PRIVATE_PROMPT = "PHASE4-PRIVATE-PROMPT-SENTINEL";
const RUNTIME_TOKEN = "PHASE4-RUNTIME-BEARER-SENTINEL";
const FUNDING_REFERENCE = "PHASE4-FUNDING-SENTINEL";

let directory: string;
let databasePath: string;
let store: RequesterSessionStore;

function requesterHeaders(cookie?: string): HeadersInit {
  return {
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    ...(cookie ? { cookie } : {}),
  };
}

function request(path: string, method = "GET", cookie?: string): Request {
  return new Request(`${ORIGIN}${path}`, { method, headers: requesterHeaders(cookie) });
}

function createRequest(cookie?: string): Request {
  return new Request(`${ORIGIN}/api/requester/transactions`, {
    method: "POST",
    headers: {
      ...requesterHeaders(cookie),
      "content-type": "application/json",
      "idempotency-key": "phase4-stable-idempotency-key",
    },
    body: JSON.stringify({
      privateDocument: PRIVATE_DOCUMENT,
      privatePrompt: PRIVATE_PROMPT,
      mediaType: "text/plain",
      maximumBudgetSats: 500,
    }),
  });
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Requester session cookie was not set");
  return setCookie.slice(0, setCookie.indexOf(";"));
}

function runtimeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function createOwnedSession(): Promise<{ cookie: string; fetcher: ReturnType<typeof vi.fn> }> {
  const fetcher = vi.fn(async () => runtimeResponse({ transactionId: TRANSACTION_ID }, 202));
  vi.stubGlobal("fetch", fetcher);
  const response = await createTransaction(createRequest());
  expect(response.status).toBe(202);
  return { cookie: cookieFrom(response), fetcher };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pactagent-requester-session-"));
  databasePath = join(directory, "requester-sessions.sqlite");
  store = createSqliteRequesterSessionStore(databasePath);
  configureRequesterSessionStoreForTesting(store);
  vi.stubEnv("PACTAGENT_REQUESTER_UI_ORIGIN", ORIGIN);
  vi.stubEnv("PACTAGENT_RUNTIME_API_BASE", "http://runtime.internal:3000");
  vi.stubEnv("PACTAGENT_RUNTIME_API_TOKEN", RUNTIME_TOKEN);
  vi.stubEnv("PACTAGENT_LIVE_FUNDING_REFERENCE", FUNDING_REFERENCE);
});

afterEach(() => {
  configureRequesterSessionStoreForTesting(undefined);
  store.close();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Phase 4 requester session ownership", () => {
  it("issues an opaque server session with hardened cookie attributes and stores only its digest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => runtimeResponse({ transactionId: TRANSACTION_ID }, 202)));
    const response = await createTransaction(createRequest());
    const setCookie = response.headers.get("set-cookie") ?? "";
    const cookie = cookieFrom(response);
    const secret = cookie.slice(`${REQUESTER_SESSION_COOKIE}=`.length);

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=strict");
    expect(setCookie).toContain("Path=/api/requester");
    expect(setCookie).not.toContain(RUNTIME_TOKEN);
    expect(setCookie).not.toContain(FUNDING_REFERENCE);
    expect(setCookie).not.toContain(PRIVATE_DOCUMENT);
    expect(setCookie).not.toContain(PRIVATE_PROMPT);

    store.close();
    configureRequesterSessionStoreForTesting(undefined);
    const bytes = readFileSync(databasePath).toString("latin1");
    expect(bytes).toContain(requesterSessionHash(secret));
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain(PRIVATE_DOCUMENT);
    expect(bytes).not.toContain(PRIVATE_PROMPT);
    expect(bytes).not.toContain(RUNTIME_TOKEN);
    store = createSqliteRequesterSessionStore(databasePath);
    configureRequesterSessionStoreForTesting(store);
  });

  it("marks the requester session cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await currentTransaction(request("/api/requester/session/current-transaction"));
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("recovers ownership after the durable store is reopened", () => {
    const secret = "A".repeat(43);
    const hash = requesterSessionHash(secret);
    const now = Date.now();
    store.create(hash, now, now + 60_000);
    store.bindTransaction(hash, TRANSACTION_ID, now);
    store.close();
    configureRequesterSessionStoreForTesting(undefined);
    store = createSqliteRequesterSessionStore(databasePath);
    configureRequesterSessionStoreForTesting(store);
    expect(store.currentTransaction(hash, now + 1)).toBe(TRANSACTION_ID);
    expect(store.ownsTransaction(hash, TRANSACTION_ID, now + 1)).toBe(true);
  });

  it("binds successful creation and recovers only the session-owned current transaction", async () => {
    const { cookie } = await createOwnedSession();
    const recovered = await currentTransaction(request(
      "/api/requester/session/current-transaction",
      "GET",
      cookie,
    ));
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("cache-control")).toBe("no-store");
    expect(await recovered.json()).toEqual({ transactionId: TRANSACTION_ID });

    const other = await currentTransaction(request("/api/requester/session/current-transaction"));
    expect(await other.json()).toEqual({ transactionId: null });
  });

  it.each([
    ["status", "GET", transactionStatus, ""],
    ["result", "GET", privateResult, "/result"],
    ["report", "GET", safeReport, "/report"],
    ["resume", "POST", resumeTransaction, "/resume"],
    ["reconcile", "POST", reconcileTransaction, "/reconcile"],
    ["refund", "POST", refundTransaction, "/refund"],
  ] as const)("rejects unowned %s before forwarding to #33", async (_name, method, route, suffix) => {
    const { fetcher } = await createOwnedSession();
    const callsAfterCreate = fetcher.mock.calls.length;
    const otherSession = await currentTransaction(request("/api/requester/session/current-transaction"));
    const otherCookie = cookieFrom(otherSession);
    const response = await route(
      request(`/api/requester/transactions/${TRANSACTION_ID}${suffix}`, method, otherCookie),
      { params: Promise.resolve({ id: TRANSACTION_ID }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Transaction not found", code: "transaction_not_found" });
    expect(fetcher).toHaveBeenCalledTimes(callsAfterCreate);
  });

  it("clears only the current recovery pointer and never mutates #33", async () => {
    const { cookie, fetcher } = await createOwnedSession();
    const callsAfterCreate = fetcher.mock.calls.length;
    const closed = await closeTransaction(request(
      "/api/requester/session/current-transaction",
      "DELETE",
      cookie,
    ));
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ cleared: true });
    expect(fetcher).toHaveBeenCalledTimes(callsAfterCreate);

    const recovered = await currentTransaction(request(
      "/api/requester/session/current-transaction",
      "GET",
      cookie,
    ));
    expect(await recovered.json()).toEqual({ transactionId: null });
    expect(store.ownsTransaction(requesterSessionHash(cookie.split("=")[1]), TRANSACTION_ID, Date.now())).toBe(true);
  });

  it("fails closed for missing or corrupt ownership sessions without forwarding", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await transactionStatus(
      request(`/api/requester/transactions/${TRANSACTION_ID}`, "GET", `${REQUESTER_SESSION_COOKIE}=corrupt`),
      { params: Promise.resolve({ id: TRANSACTION_ID }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Transaction not found", code: "transaction_not_found" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
