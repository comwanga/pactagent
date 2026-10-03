import "server-only";

import { NextResponse } from "next/server";

import {
  parseRequesterTransactionCreateInput,
  REQUESTER_DOCUMENT_MAXIMUM_BYTES,
  REQUESTER_PROMPT_MAXIMUM_BYTES,
  type RequesterApiErrorDto,
  type RequesterTransactionCreateInput,
} from "@/lib/requester-api-contracts";
import {
  createRequesterRuntimeTransportFromEnv,
  RequesterTransportConfigurationError,
  type RequesterRuntimeTransport,
  type RequesterTransportResponse,
} from "@/lib/requester-runtime-transport.server";
import { requesterSessionStoreFromEnv } from "@/lib/requester-session-store.server";
import { readRequesterSession } from "@/lib/requester-session.server";

// JSON may escape one input byte as six ASCII bytes (for example, control
// characters). This is a wire limit only; the contract parser enforces the
// authoritative 1,000,000/65,536-byte private-input limits after decoding.
const MAXIMUM_BROWSER_REQUEST_BYTES =
  6 * (REQUESTER_DOCUMENT_MAXIMUM_BYTES + REQUESTER_PROMPT_MAXIMUM_BYTES) + 16 * 1024;
const RESPONSE_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  Vary: "Origin, Sec-Fetch-Site",
});

export function requesterJson(
  body: unknown,
  init: Omit<ResponseInit, "headers"> & { headers?: Record<string, string> } = {},
): NextResponse {
  return NextResponse.json(body, {
    ...init,
    headers: { ...init.headers, ...RESPONSE_HEADERS },
  });
}

export function unauthorizedRequester(): NextResponse {
  return requesterJson(
    { error: "Unauthorized", code: "unauthorized" } satisfies RequesterApiErrorDto,
    { status: 401 },
  );
}

export function unownedRequesterTransaction(): NextResponse {
  return requesterJson(
    { error: "Transaction not found", code: "transaction_not_found" } satisfies RequesterApiErrorDto,
    { status: 404 },
  );
}

/**
 * Browser-facing CSRF/origin gate. This is intentionally not represented as a
 * requester identity model; #33 currently has only one runtime-wide bearer.
 */
export function isTrustedRequesterRequest(request: Request): boolean {
  const configuredOrigin = process.env.PACTAGENT_REQUESTER_UI_ORIGIN;
  if (!configuredOrigin) return false;
  let expectedOrigin: string;
  try {
    const configured = new URL(configuredOrigin);
    if (
      (configured.protocol !== "http:" && configured.protocol !== "https:") ||
      configured.username !== "" ||
      configured.password !== "" ||
      (configured.pathname !== "/" && configured.pathname !== "") ||
      configured.search !== "" ||
      configured.hash !== ""
    ) return false;
    expectedOrigin = configured.origin;
    // Next.js may normalize Request.url to localhost even when the browser
    // connected through the configured host. Host is browser-forbidden and
    // preserves that public authority; fall back to Request.url in direct
    // route tests where no Host header exists.
    const requestUrl = new URL(request.url);
    const presentedHost = request.headers.get("host") ?? requestUrl.host;
    if (presentedHost !== configured.host || requestUrl.protocol !== configured.protocol) return false;
  } catch {
    return false;
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    try {
      return new URL(origin).origin === expectedOrigin;
    } catch {
      return false;
    }
  }
  return fetchSite === "same-origin";
}

export function runtimeTransport(fundingReferenceOverride?: string): RequesterRuntimeTransport {
  return createRequesterRuntimeTransportFromEnv(fundingReferenceOverride);
}

/** Checks requester ownership before a route constructs or calls the #33 transport. */
export function requesterOwnsTransaction(request: Request, transactionId: string): boolean {
  const store = requesterSessionStoreFromEnv();
  const session = readRequesterSession(request, store);
  return session !== undefined && store.ownsTransaction(session.hash, transactionId, Date.now());
}

export function unavailableRequester(error: unknown): NextResponse {
  const status = error instanceof RequesterTransportConfigurationError ? 503 : 500;
  // Server-side operator log only; responses remain redacted. Error messages
  // produced by the runtime are sanitized by design (no keys, proofs, or
  // private task material).
  console.error(
    "requester transport failure:",
    error instanceof Error ? error.message : String(error),
  );
  return requesterJson(
    { error: "The transaction service is unavailable", code: "runtime_unavailable" } satisfies RequesterApiErrorDto,
    { status },
  );
}

export function transportResponse<T>(result: RequesterTransportResponse<T>): NextResponse {
  return requesterJson(result.body, { status: result.status });
}

export async function readRequesterCreateInput(request: Request): Promise<RequesterTransactionCreateInput> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAXIMUM_BROWSER_REQUEST_BYTES) {
      throw new RangeError("Request is too large");
    }
  }
  if (!request.body) throw new SyntaxError("Request body is empty");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAXIMUM_BROWSER_REQUEST_BYTES) {
      await reader.cancel();
      throw new RangeError("Request is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return parseRequesterTransactionCreateInput(JSON.parse(raw) as unknown);
}
