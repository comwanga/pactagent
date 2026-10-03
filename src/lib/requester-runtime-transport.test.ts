import { describe, expect, it, vi } from "vitest";

import { safeReportFixture, safeStatusFixture } from "./requester-api-test-fixtures";
import { RequesterRuntimeTransport } from "./requester-runtime-transport.server";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

describe("server-only requester runtime transport", () => {
  it("attaches the runtime bearer only to #33 and uses no-store", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return json(safeStatusFixture());
    }) as unknown as typeof fetch;
    const transport = new RequesterRuntimeTransport({
      apiBase: "http://runtime.internal:3000",
      apiToken: "SERVER-ONLY-RUNTIME-TOKEN",
      fundingReference: "SERVER-ONLY-FUNDING-REFERENCE",
      fetch: fetcher,
    });

    await expect(transport.status(safeStatusFixture().transactionId)).resolves.toMatchObject({ ok: true });
    expect(calls[0].url).toBe(`http://runtime.internal:3000/api/transactions/${safeStatusFixture().transactionId}`);
    expect(new Headers(calls[0].init?.headers).get("authorization"))
      .toBe("Bearer SERVER-ONLY-RUNTIME-TOKEN");
    expect(calls[0].init?.cache).toBe("no-store");
    expect(calls[0].init?.redirect).toBe("error");
  });

  it("redacts an upstream unauthorized response instead of exposing auth detail", async () => {
    const fetcher = vi.fn(async () => json({ error: "Bearer SERVER-ONLY-RUNTIME-TOKEN is wrong", code: "unauthorized" }, 401)) as unknown as typeof fetch;
    const transport = new RequesterRuntimeTransport({
      apiBase: "http://runtime.internal:3000",
      apiToken: "SERVER-ONLY-RUNTIME-TOKEN",
      fundingReference: "SERVER-ONLY-FUNDING-REFERENCE",
      fetch: fetcher,
    });

    const result = await transport.status(safeStatusFixture().transactionId);
    expect(result).toEqual({
      ok: false,
      status: 502,
      body: { error: "The transaction service is unavailable", code: "runtime_unavailable" },
    });
    expect(JSON.stringify(result)).not.toContain("SERVER-ONLY-RUNTIME-TOKEN");
  });

  it("uses only the exact #33 resume and reconcile endpoints", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return json(safeReportFixture());
    }) as unknown as typeof fetch;
    const transport = new RequesterRuntimeTransport({
      apiBase: "https://runtime.example",
      apiToken: "token",
      fundingReference: "funding-reference",
      fetch: fetcher,
    });
    const id = safeStatusFixture().transactionId;

    await transport.resume(id);
    await transport.reconcile(id);

    expect(calls).toEqual([
      { url: `https://runtime.example/api/transactions/${id}/resume`, method: "POST" },
      { url: `https://runtime.example/api/transactions/${id}/reconcile`, method: "POST" },
    ]);
  });

  it("uses only the exact #33 result and report endpoints", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return calls.length === 1
        ? json({ summary: "requester-private-summary" })
        : json(safeReportFixture());
    }) as unknown as typeof fetch;
    const transport = new RequesterRuntimeTransport({
      apiBase: "https://runtime.example",
      apiToken: "token",
      fundingReference: "funding-reference",
      fetch: fetcher,
    });
    const id = safeStatusFixture().transactionId;

    await transport.privateResult(id);
    await transport.report(id);

    expect(calls).toEqual([
      { url: `https://runtime.example/api/transactions/${id}/result`, method: "GET" },
      { url: `https://runtime.example/api/transactions/${id}/report`, method: "GET" },
    ]);
  });

  it("uses bearer-protected body-only runtime endpoints for Demo wallet operations", async () => {
    const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as unknown,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (String(input).endsWith("wallet-balance")) {
        return json({ generation: 1, availableSats: 1000, resetAvailable: true, accountingPending: false });
      }
      return json({ ok: true, generation: String(input).endsWith("reset-demo") ? 2 : 1 });
    }) as unknown as typeof fetch;
    const transport = new RequesterRuntimeTransport({
      apiBase: "https://runtime.example",
      apiToken: "server-token",
      fetch: fetcher,
    });
    await transport.startDemo("server-derived-wallet");
    await transport.demoWalletStatus("server-derived-wallet");
    await transport.resetDemo("server-derived-wallet", "reset-intent-0001");
    expect(calls.map((call) => call.url)).toEqual([
      "https://runtime.example/api/runtime/start-demo",
      "https://runtime.example/api/runtime/wallet-balance",
      "https://runtime.example/api/runtime/reset-demo",
    ]);
    expect(calls[2].body).toEqual({ walletKey: "server-derived-wallet", idempotencyKey: "reset-intent-0001" });
    expect(calls.every((call) => call.authorization === "Bearer server-token")).toBe(true);
    expect(calls.every((call) => !call.url.includes("server-derived-wallet"))).toBe(true);
  });
});
