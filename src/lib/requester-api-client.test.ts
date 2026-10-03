import { describe, expect, it, vi } from "vitest";

import { RequesterApiClient, RequesterApiClientError } from "./requester-api-client";
import { safeReportFixture, safeStatusFixture } from "./requester-api-test-fixtures";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

describe("requester browser API client", () => {
  it("keeps private creation fields out of URLs and uses no-store", async () => {
    const privateDocument = "PRIVATE document text";
    const privatePrompt = "PRIVATE prompt text";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return json({ transactionId: "txn_0123456789abcdef0123456789abcdef" }, 202);
    }) as unknown as typeof fetch;
    const client = new RequesterApiClient({
      fetch: fetcher,
      generateIdempotencyKey: () => "stable-key-0001",
    });

    await client.createSubmission({
      privateDocument,
      privatePrompt,
      mediaType: "text/plain",
      maximumBudgetSats: 500,
    }).submit();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/requester/transactions");
    expect(calls[0].url).not.toContain(privateDocument);
    expect(calls[0].url).not.toContain(privatePrompt);
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.cache).toBe("no-store");
    expect(new Headers(calls[0].init?.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      privateDocument,
      privatePrompt,
      mediaType: "text/plain",
      maximumBudgetSats: 500,
    });
  });

  it("preserves one key across a duplicate click and a retry", async () => {
    const seenKeys: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seenKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (seenKeys.length === 1) {
        await firstGate;
        return json({ error: "The transaction service is unavailable", code: "runtime_unavailable" }, 503);
      }
      return json({ transactionId: "txn_0123456789abcdef0123456789abcdef" }, 202);
    }) as unknown as typeof fetch;
    const generate = vi.fn(() => "stable-key-0002");
    const submission = new RequesterApiClient({ fetch: fetcher, generateIdempotencyKey: generate })
      .createSubmission({ privateDocument: "private", mediaType: "text/plain", maximumBudgetSats: 500 });

    const first = submission.submit();
    const duplicate = submission.submit();
    expect(fetcher).toHaveBeenCalledTimes(1);
    releaseFirst();
    await expect(first).rejects.toBeInstanceOf(RequesterApiClientError);
    await expect(duplicate).rejects.toBeInstanceOf(RequesterApiClientError);
    await expect(submission.submit()).resolves.toEqual({
      transactionId: "txn_0123456789abcdef0123456789abcdef",
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(submission.idempotencyKey).toBe("stable-key-0002");
    expect(seenKeys).toEqual(["stable-key-0002", "stable-key-0002"]);
  });

  it("maps resume and reconcile only to their corresponding endpoints", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return json(safeReportFixture());
    }) as unknown as typeof fetch;
    const client = new RequesterApiClient({ fetch: fetcher });
    const id = safeStatusFixture().transactionId;

    await client.resume(id);
    await client.reconcile(id);

    expect(calls).toEqual([
      { url: `/api/requester/transactions/${id}/resume`, method: "POST" },
      { url: `/api/requester/transactions/${id}/reconcile`, method: "POST" },
    ]);
  });

  it("maps private result and safe report only to their corresponding GET endpoints", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return calls.length === 1
        ? json({ summary: "requester-private-summary" })
        : json(safeReportFixture());
    }) as unknown as typeof fetch;
    const client = new RequesterApiClient({ fetch: fetcher });
    const id = safeStatusFixture().transactionId;

    await client.privateResult(id);
    await client.report(id);

    expect(calls).toEqual([
      { url: `/api/requester/transactions/${id}/result`, method: "GET" },
      { url: `/api/requester/transactions/${id}/report`, method: "GET" },
    ]);
  });

  it("uses exact no-store session recovery and close capabilities", async () => {
    const calls: Array<{ url: string; method?: string; cache?: RequestCache }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, cache: init?.cache });
      return calls.length === 1
        ? json({ transactionId: safeStatusFixture().transactionId })
        : json({ cleared: true });
    }) as unknown as typeof fetch;
    const client = new RequesterApiClient({ fetch: fetcher });

    await expect(client.currentTransaction()).resolves.toEqual({
      transactionId: safeStatusFixture().transactionId,
    });
    await expect(client.closeCurrentTransaction()).resolves.toEqual({ cleared: true });
    expect(calls).toEqual([
      { url: "/api/requester/session/current-transaction", method: "GET", cache: "no-store" },
      { url: "/api/requester/session/current-transaction", method: "DELETE", cache: "no-store" },
    ]);
  });

  it("fails closed when a successful response has extra fields", async () => {
    const fetcher = vi.fn(async () => json({ ...safeStatusFixture(), privatePrompt: "leak" })) as unknown as typeof fetch;
    const client = new RequesterApiClient({ fetch: fetcher });
    await expect(client.status(safeStatusFixture().transactionId)).rejects.toMatchObject({
      status: 502,
      detail: { code: "upstream_invalid_response" },
    });
  });
});
