import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PactAgentApiClient,
  PactAgentApiClientError,
  generateIdempotencyKey,
  loadRetainedTransactionId,
  retainTransactionId,
  clearRetainedTransactionId,
} from "./pactagent-api-client";

describe("PactAgent API client", () => {
  it("generates a stable-length idempotency key", () => {
    const key = generateIdempotencyKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const key2 = generateIdempotencyKey();
    expect(key2).not.toBe(key);
  });

  describe("session storage retention (browser environment)", () => {
    beforeEach(() => {
      const store = new Map<string, string>();
      (globalThis as unknown as { window: { sessionStorage: Storage } }).window = {
        sessionStorage: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => void store.set(key, value),
          removeItem: (key: string) => void store.delete(key),
          clear: () => store.clear(),
          key: (index: number) => Array.from(store.keys())[index] ?? null,
          get length() {
            return store.size;
          },
        } as Storage,
      };
    });

    afterEach(() => {
      delete (globalThis as unknown as { window?: unknown }).window;
    });

    it("retains and loads a transaction ID in session storage", () => {
      retainTransactionId("txn_test123");
      expect(loadRetainedTransactionId()).toBe("txn_test123");
      clearRetainedTransactionId();
      expect(loadRetainedTransactionId()).toBeUndefined();
    });
  });

  it("returns undefined for loadRetainedTransactionId outside browser", () => {
    expect(loadRetainedTransactionId()).toBeUndefined();
  });

  it("constructs with an API token and base URL", () => {
    const client = new PactAgentApiClient("test-token", "http://localhost:9999");
    expect(client).toBeInstanceOf(PactAgentApiClient);
  });

  it("sends the token-mode funding reference to the session endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: unknown;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ authenticated: true, demoAvailable: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await new PactAgentApiClient(undefined, "http://localhost").startSession({
        token: "runtime-token",
        fundingReference: "opaque-funding-reference",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestBody).toEqual({
      token: "runtime-token",
      fundingReference: "opaque-funding-reference",
    });
  });

  it("PactAgentApiClientError carries code and status", () => {
    const error = new PactAgentApiClientError("not_found", "Transaction not found", 404);
    expect(error.code).toBe("not_found");
    expect(error.status).toBe(404);
    expect(error.message).toBe("Transaction not found");
    expect(error.name).toBe("PactAgentApiClientError");
  });

  it("redacts unknown runtime error messages", async () => {
    const response = await import("./pactagent-api-client");
    expect(response.friendlyErrorMessage(
      new response.PactAgentApiClientError("unexpected", "private runtime details", 500),
    )).toBe("The runtime could not complete that request.");
  });
});
