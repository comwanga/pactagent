import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as createTransaction } from "@/app/api/requester/transactions/route";
import { GET as demoStatus } from "@/app/api/requester/demo/route";
import { POST as startDemo } from "@/app/api/requester/demo/start/route";
import { POST as resetDemo } from "@/app/api/requester/demo/reset/route";
import { isTrustedRequesterRequest } from "@/app/api/requester/transactions/http";
import {
  configureRequesterSessionStoreForTesting,
  createSqliteRequesterSessionStore,
  type RequesterSessionStore,
} from "@/lib/requester-session-store.server";
import { REQUESTER_DOCUMENT_MAXIMUM_BYTES } from "@/lib/requester-api-contracts";

let temporaryDirectory: string;
let sessionStore: RequesterSessionStore;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "pactagent-requester-bff-"));
  sessionStore = createSqliteRequesterSessionStore(join(temporaryDirectory, "sessions.sqlite"));
  configureRequesterSessionStoreForTesting(sessionStore);
});

function browserRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://pactagent.local/api/requester/transactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "stable-key-bff1",
      ...headers,
    },
    body: JSON.stringify({
      privateDocument: "PRIVATE-BFF-DOCUMENT",
      privatePrompt: "PRIVATE-BFF-PROMPT",
      mediaType: "text/plain",
      maximumBudgetSats: 500,
    }),
  });
}

afterEach(() => {
  configureRequesterSessionStoreForTesting(undefined);
  sessionStore.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("requester BFF routes", () => {
  it("rejects a request that did not pass the same-origin browser gate", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await createTransaction(browserRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Unauthorized", code: "unauthorized" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the browser-controlled Host when Next.js normalizes Request.url", () => {
    vi.stubEnv("PACTAGENT_REQUESTER_UI_ORIGIN", "http://pactagent.local");
    const normalized = new Request("http://localhost/api/requester/session/current-transaction", {
      headers: {
        host: "pactagent.local",
        origin: "http://pactagent.local",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(isTrustedRequesterRequest(normalized)).toBe(true);
    expect(isTrustedRequesterRequest(new Request(normalized, {
      headers: {
        ...Object.fromEntries(normalized.headers),
        host: "attacker.invalid",
      },
    }))).toBe(false);
  });

  it("keeps the runtime bearer and funding reference out of client-facing responses", async () => {
    const runtimeToken = "SERVER-ONLY-RUNTIME-TOKEN";
    const fundingReference = "SERVER-ONLY-FUNDING-REFERENCE";
    vi.stubEnv("PACTAGENT_RUNTIME_API_BASE", "http://runtime.internal:3000");
    vi.stubEnv("PACTAGENT_REQUESTER_UI_ORIGIN", "http://pactagent.local");
    vi.stubEnv("PACTAGENT_RUNTIME_API_TOKEN", runtimeToken);
    vi.stubEnv("PACTAGENT_LIVE_FUNDING_REFERENCE", fundingReference);
    let upstreamBody = "";
    let upstreamAuthorization = "";
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamBody = String(init?.body);
      upstreamAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ transactionId: "txn_0123456789abcdef0123456789abcdef" }), {
        status: 202,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await createTransaction(browserRequest({ origin: "http://pactagent.local" }));
    const visible = `${JSON.stringify(await response.json())}\n${JSON.stringify(Object.fromEntries(response.headers))}`;

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe("/api/requester/transactions/txn_0123456789abcdef0123456789abcdef");
    expect(upstreamAuthorization).toBe(`Bearer ${runtimeToken}`);
    expect(JSON.parse(upstreamBody)).toMatchObject({ fundingReference });
    expect(visible).not.toContain(runtimeToken);
    expect(visible).not.toContain(fundingReference);
    expect(visible).not.toContain("PRIVATE-BFF-DOCUMENT");
    expect(visible).not.toContain("PRIVATE-BFF-PROMPT");
  });

  it("accepts an exact-limit PDF representation and returns 413 for the first source byte over", async () => {
    vi.stubEnv("PACTAGENT_RUNTIME_API_BASE", "http://runtime.internal:3000");
    vi.stubEnv("PACTAGENT_REQUESTER_UI_ORIGIN", "http://pactagent.local");
    vi.stubEnv("PACTAGENT_RUNTIME_API_TOKEN", "SERVER-ONLY-RUNTIME-TOKEN");
    vi.stubEnv("PACTAGENT_LIVE_FUNDING_REFERENCE", "SERVER-ONLY-FUNDING-REFERENCE");
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ transactionId: "txn_0123456789abcdef0123456789abcdef" }),
      { status: 202, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetcher);
    const requestForBytes = (bytes: number) => new Request(
      "http://pactagent.local/api/requester/transactions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `pdf-boundary-${bytes}`,
          origin: "http://pactagent.local",
        },
        body: JSON.stringify({
          privateDocument: Buffer.alloc(bytes, 0xa5).toString("base64"),
          mediaType: "application/pdf",
          maximumBudgetSats: 500,
        }),
      },
    );

    const accepted = await createTransaction(requestForBytes(REQUESTER_DOCUMENT_MAXIMUM_BYTES));
    expect(accepted.status).toBe(202);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const rejected = await createTransaction(requestForBytes(REQUESTER_DOCUMENT_MAXIMUM_BYTES + 1));
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toEqual({
      error: "The document exceeds the 1 MiB upload limit",
      code: "document_too_large",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires Start Demo before a demo requester can create a transaction", async () => {
    vi.stubEnv("PACTAGENT_REQUESTER_UI_ORIGIN", "http://pactagent.local");
    vi.stubEnv("PACTAGENT_ECONOMIC_MODE", "demo");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await createTransaction(browserRequest({ origin: "http://pactagent.local" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Start Demo before creating a transaction",
      code: "invalid_request",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps Demo wallet identity server-derived across Start, balance, and Reset", async () => {
    vi.stubEnv("PACTAGENT_REQUESTER_UI_ORIGIN", "http://pactagent.local");
    vi.stubEnv("PACTAGENT_ECONOMIC_MODE", "demo");
    vi.stubEnv("PACTAGENT_RUNTIME_API_BASE", "http://runtime.internal:3000");
    vi.stubEnv("PACTAGENT_RUNTIME_API_TOKEN", "SERVER-ONLY-RUNTIME-TOKEN");
    const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({
        url: String(input),
        body,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (String(input).endsWith("/wallet-balance")) {
        return new Response(JSON.stringify({ generation: 1, availableSats: 1000, resetAvailable: true, accountingPending: false }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      return new Response(JSON.stringify({ ok: true, generation: String(input).endsWith("/reset-demo") ? 2 : 1 }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const headers = { origin: "http://pactagent.local", "sec-fetch-site": "same-origin" };
    const initial = await demoStatus(new Request("http://pactagent.local/api/requester/demo", { headers }));
    const cookie = (initial.headers.get("set-cookie") ?? "").split(";")[0];
    const started = await startDemo(new Request("http://pactagent.local/api/requester/demo/start", {
      method: "POST",
      headers: { ...headers, cookie },
    }));
    expect(started.status).toBe(200);
    const wallet = await demoStatus(new Request("http://pactagent.local/api/requester/demo", {
      headers: { ...headers, cookie },
    }));
    expect(await wallet.json()).toMatchObject({ started: true, balance: { availableSats: 1000 } });
    const reset = await resetDemo(new Request("http://pactagent.local/api/requester/demo/reset", {
      method: "POST",
      headers: { ...headers, cookie, "idempotency-key": "reset-request-0001" },
    }));
    expect(reset.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe("http://runtime.internal:3000/api/runtime/start-demo");
    expect(calls[1].url).toBe("http://runtime.internal:3000/api/runtime/wallet-balance");
    expect(calls[2].url).toBe("http://runtime.internal:3000/api/runtime/reset-demo");
    expect(calls[0].body.walletKey).toBe(calls[1].body.walletKey);
    expect(calls[1].body.walletKey).toBe(calls[2].body.walletKey);
    expect(calls[2].body.idempotencyKey).toBe("reset-request-0001");
    expect(calls.every((call) => call.authorization === "Bearer SERVER-ONLY-RUNTIME-TOKEN")).toBe(true);
    expect(calls.every((call) => !call.url.includes("walletKey"))).toBe(true);
  });

  it("does not expose or reset another requester session's Demo wallet", async () => {
    vi.stubEnv("PACTAGENT_REQUESTER_UI_ORIGIN", "http://pactagent.local");
    vi.stubEnv("PACTAGENT_ECONOMIC_MODE", "demo");
    vi.stubEnv("PACTAGENT_RUNTIME_API_BASE", "http://runtime.internal:3000");
    vi.stubEnv("PACTAGENT_RUNTIME_API_TOKEN", "SERVER-ONLY-RUNTIME-TOKEN");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, generation: 1 }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }));
    vi.stubGlobal("fetch", fetcher);
    const headers = { origin: "http://pactagent.local", "sec-fetch-site": "same-origin" };
    const initialA = await demoStatus(new Request("http://pactagent.local/api/requester/demo", { headers }));
    const cookieA = (initialA.headers.get("set-cookie") ?? "").split(";")[0];
    const sessionA = await startDemo(new Request("http://pactagent.local/api/requester/demo/start", {
      method: "POST",
      headers: { ...headers, cookie: cookieA },
    }));
    expect(sessionA.status).toBe(200);
    const sessionB = await demoStatus(new Request("http://pactagent.local/api/requester/demo", { headers }));
    expect(await sessionB.json()).toEqual({ economicMode: "demo", started: false });
    const cookieB = (sessionB.headers.get("set-cookie") ?? "").split(";")[0];
    const denied = await resetDemo(new Request("http://pactagent.local/api/requester/demo/reset", {
      method: "POST",
      headers: { ...headers, cookie: cookieB, "idempotency-key": "reset-request-0002" },
    }));
    expect(denied.status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
