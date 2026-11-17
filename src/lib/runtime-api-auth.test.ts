import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import {
  isAuthorized,
  validateRuntimeApiToken,
} from "@/lib/pactagent-runtime-singleton";
import { PactAgentRuntimeError } from "@/lib/pactagent-runtime";

const VALID_TOKEN = "test-runtime-token-valid-0123";

function nextRequestWithHost(url: string, host: string): NextRequest {
  const headers = new Headers();
  headers.set("host", host);
  return new NextRequest(url, { headers }) as NextRequest;
}

describe("Issue #67 runtime API origin restriction", () => {
  it("allows loopback hosts on protected routes", () => {
    for (const host of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "127.0.0.1", "localhost", "[::1]"]) {
      const response = proxy(nextRequestWithHost("http://localhost/api/transactions", host));
      expect(response.status).toBe(200);
    }
    for (const host of ["127.0.0.1:3000", "localhost:3000"]) {
      const response = proxy(nextRequestWithHost("http://localhost/api/runtime/bootstrap", host));
      expect(response.status).toBe(200);
    }
  });

  it("returns 404 for non-loopback hosts on protected routes", () => {
    for (const host of ["pactagent.up.railway.app", "example.com:3000", "10.0.0.1:3000", "192.168.1.1"]) {
      const response = proxy(nextRequestWithHost("http://localhost/api/transactions", host));
      expect(response.status).toBe(404);
    }
    for (const host of ["pactagent.up.railway.app"]) {
      const response = proxy(nextRequestWithHost("http://localhost/api/runtime/bootstrap", host));
      expect(response.status).toBe(404);
    }
  });

  it("does not pass through with a valid token but public host", () => {
    const headers = new Headers();
    headers.set("host", "pactagent.up.railway.app");
    headers.set("authorization", `Bearer ${VALID_TOKEN}`);
    const request = new NextRequest("http://localhost/api/transactions", { headers }) as NextRequest;
    const response = proxy(request);
    expect(response.status).toBe(404);
  });

  it("ignores X-Forwarded-Host spoofing", () => {
    const headers = new Headers();
    headers.set("host", "pactagent.up.railway.app");
    headers.set("x-forwarded-host", "127.0.0.1:3000");
    const request = new NextRequest("http://localhost/api/transactions", { headers }) as NextRequest;
    const response = proxy(request);
    expect(response.status).toBe(404);
  });

  it("returns 404 for missing host header on protected routes", () => {
    const request = new NextRequest("http://localhost/api/transactions") as NextRequest;
    const response = proxy(request);
    expect(response.status).toBe(404);
  });
});

describe("Issue #67 constant-time bearer verification", () => {
  it("authorizes a valid bearer token", () => {
    const request = new Request("http://localhost/api/transactions", {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(isAuthorized(request, VALID_TOKEN)).toBe(true);
  });

  it("rejects missing Authorization header", () => {
    const request = new Request("http://localhost/api/transactions");
    expect(isAuthorized(request, VALID_TOKEN)).toBe(false);
  });

  it("rejects malformed authorization scheme", () => {
    for (const scheme of ["Basic abc", "bearer abc", "Bearer", "Bearer  ", "Token abc"]) {
      const request = new Request("http://localhost/api/transactions", {
        headers: { authorization: scheme },
      });
      expect(isAuthorized(request, VALID_TOKEN)).toBe(false);
    }
  });

  it("rejects incorrect token of different and same length", () => {
    const wrong = "wrong-runtime-token-valid-0456";
    expect(isAuthorized(
      new Request("http://localhost", { headers: { authorization: `Bearer ${wrong}` } }),
      VALID_TOKEN,
    )).toBe(false);
    expect(isAuthorized(
      new Request("http://localhost", { headers: { authorization: `Bearer ${VALID_TOKEN}x` } }),
      VALID_TOKEN,
    )).toBe(false);
    expect(isAuthorized(
      new Request("http://localhost", { headers: { authorization: `Bearer ${VALID_TOKEN.slice(0, -1)}` } }),
      VALID_TOKEN,
    )).toBe(false);
  });

  it("rejects empty or undefined token configuration", () => {
    const request = new Request("http://localhost", {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(isAuthorized(request, undefined)).toBe(false);
    expect(isAuthorized(request, "")).toBe(false);
    expect(isAuthorized(request, "short")).toBe(false);
  });

  it("produces identical ciphertext for repeated identical plaintext", () => {
    const request1 = new Request("http://localhost", {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const request2 = new Request("http://localhost", {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(isAuthorized(request1, VALID_TOKEN)).toBe(isAuthorized(request2, VALID_TOKEN));
  });

  it("does not leak token value in error from validateRuntimeApiToken", () => {
    vi.stubEnv("PACTAGENT_RUNTIME_API_TOKEN", "leaked-secret-token-abcd");
    try {
      expect(() => validateRuntimeApiToken()).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("Issue #67 token validation at startup", () => {
  it("accepts a valid token", () => {
    expect(() => validateRuntimeApiToken({
      PACTAGENT_RUNTIME_API_TOKEN: "valid-cryptographic-token-0123",
    })).not.toThrow();
  });

  it("rejects missing token", () => {
    expect(() => validateRuntimeApiToken({})).toThrow(PactAgentRuntimeError);
  });

  it("rejects below-minimum-length token", () => {
    expect(() => validateRuntimeApiToken({
      PACTAGENT_RUNTIME_API_TOKEN: "short",
    })).toThrow(PactAgentRuntimeError);
    expect(() => validateRuntimeApiToken({
      PACTAGENT_RUNTIME_API_TOKEN: "123456789012345",
    })).toThrow(PactAgentRuntimeError);
  });

  it("rejects invalid characters", () => {
    expect(() => validateRuntimeApiToken({
      PACTAGENT_RUNTIME_API_TOKEN: "token with spaces!",
    })).toThrow(PactAgentRuntimeError);
    expect(() => validateRuntimeApiToken({
      PACTAGENT_RUNTIME_API_TOKEN: "token;injection",
    })).toThrow(PactAgentRuntimeError);
    expect(() => validateRuntimeApiToken({
      PACTAGENT_RUNTIME_API_TOKEN: "token\nnewline",
    })).toThrow(PactAgentRuntimeError);
  });

  it("rejects exactly 15 characters but accepts 16", () => {
    expect(() => validateRuntimeApiToken({
      PACTAGENT_RUNTIME_API_TOKEN: "abcdefghijklmnop",
    })).not.toThrow();
    expect(() => validateRuntimeApiToken({
      PACTAGENT_RUNTIME_API_TOKEN: "abcdefghijklmno",
    })).toThrow(PactAgentRuntimeError);
  });

  it("error does not contain the token value", () => {
    const secret = "super-secret-token-leaked-value";
    try {
      validateRuntimeApiToken({ PACTAGENT_RUNTIME_API_TOKEN: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    const short = "ab";
    try {
      validateRuntimeApiToken({ PACTAGENT_RUNTIME_API_TOKEN: short });
    } catch (error) {
      expect(String(error)).not.toContain("ab");
    }
  });
});