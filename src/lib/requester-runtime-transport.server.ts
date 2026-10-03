import "server-only";

import {
  parseRequesterApiError,
  parseRequesterPrivateResult,
  parseRequesterRecoveryResult,
  parseRequesterSafeReport,
  parseRequesterTransactionAccepted,
  parseRequesterTransactionStatus,
  RequesterContractError,
  type RequesterApiErrorCode,
  type RequesterApiErrorDto,
  type RequesterPrivateResult,
  type RequesterRecoveryResult,
  type RequesterSafeReport,
  type RequesterTransactionAccepted,
  type RequesterTransactionCreateInput,
  type RequesterTransactionStatus,
} from "./requester-api-contracts";

const MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024;
const TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

const SAFE_ERROR_MESSAGES: Readonly<Record<RequesterApiErrorCode, string>> = Object.freeze({
  unauthorized: "Unauthorized",
  invalid_request: "The transaction request is invalid",
  result_not_available: "The private result is not available",
  report_not_available: "The report is not available",
  transaction_in_progress: "The transaction is already in progress",
  transaction_not_found: "The transaction was not found",
  corrupt_record: "The transaction record is unavailable",
  invalid_configuration: "The transaction service is not configured",
  not_running: "The transaction service is not running",
  reconciliation_required: "The transaction requires reconciliation",
  internal_error: "The transaction service could not complete the request",
  runtime_unavailable: "The transaction service is unavailable",
  upstream_invalid_response: "The transaction service returned an invalid response",
});

export interface RequesterRuntimeTransportConfig {
  readonly apiBase: string;
  readonly apiToken: string;
  readonly fundingReference?: string;
  readonly fetch?: typeof fetch;
}

export interface RequesterTransportSuccess<T> {
  readonly ok: true;
  readonly status: number;
  readonly body: T;
}

export interface RequesterTransportFailure {
  readonly ok: false;
  readonly status: number;
  readonly body: RequesterApiErrorDto;
}

export type RequesterTransportResponse<T> = RequesterTransportSuccess<T> | RequesterTransportFailure;

export interface RequesterRuntimeDemoMutation {
  readonly ok: true;
  readonly generation: number;
}

export interface RequesterRuntimeDemoStatus {
  readonly generation: number;
  readonly availableSats: number;
  readonly resetAvailable: boolean;
  readonly accountingPending: boolean;
}

export class RequesterTransportConfigurationError extends Error {
  constructor() {
    super("Requester runtime transport is not configured");
    this.name = "RequesterTransportConfigurationError";
  }
}

function configured(value: string | undefined): string {
  if (!value) throw new RequesterTransportConfigurationError();
  return value;
}

function normalizeApiBase(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RequesterTransportConfigurationError();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new RequesterTransportConfigurationError();
  }
  return new URL(url.origin);
}

function operationPath(transactionId: string, operation?: "result" | "report" | "resume" | "reconcile" | "refund"): string {
  if (!TRANSACTION_ID.test(transactionId)) throw new RequesterContractError("Transaction identifier is invalid");
  const path = `/api/transactions/${encodeURIComponent(transactionId)}`;
  return operation === undefined ? path : `${path}/${operation}`;
}

function redactedError(code: RequesterApiErrorCode): RequesterApiErrorDto {
  return Object.freeze({ code, error: SAFE_ERROR_MESSAGES[code] });
}

function demoMutation(value: unknown): RequesterRuntimeDemoMutation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RequesterContractError();
  const parsed = value as Record<string, unknown>;
  if (
    Object.keys(parsed).length !== 2 ||
    parsed.ok !== true ||
    !Number.isSafeInteger(parsed.generation) ||
    (parsed.generation as number) < 1
  ) throw new RequesterContractError();
  return Object.freeze({ ok: true, generation: parsed.generation as number });
}

function demoStatus(value: unknown): RequesterRuntimeDemoStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RequesterContractError();
  const parsed = value as Record<string, unknown>;
  if (
    Object.keys(parsed).length !== 4 ||
    !Number.isSafeInteger(parsed.generation) ||
    (parsed.generation as number) < 1 ||
    !Number.isSafeInteger(parsed.availableSats) ||
    (parsed.availableSats as number) < 0 ||
    typeof parsed.resetAvailable !== "boolean" ||
    typeof parsed.accountingPending !== "boolean"
  ) throw new RequesterContractError();
  return Object.freeze({
    generation: parsed.generation as number,
    availableSats: parsed.availableSats as number,
    resetAvailable: parsed.resetAvailable,
    accountingPending: parsed.accountingPending,
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (!contentType?.includes("application/json")) throw new RequesterContractError();
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAXIMUM_RESPONSE_BYTES) {
      throw new RequesterContractError();
    }
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAXIMUM_RESPONSE_BYTES) {
    throw new RequesterContractError();
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new RequesterContractError();
  }
}

export class RequesterRuntimeTransport {
  readonly #apiBase: URL;
  readonly #apiToken: string;
  readonly #fundingReference: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(config: RequesterRuntimeTransportConfig) {
    this.#apiBase = normalizeApiBase(config.apiBase);
    this.#apiToken = configured(config.apiToken);
    this.#fundingReference = config.fundingReference;
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async #request<T>(
    path: string,
    init: RequestInit,
    parse: (value: unknown) => T,
  ): Promise<RequesterTransportResponse<T>> {
    const url = new URL(path, this.#apiBase);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${this.#apiToken}`);
    headers.set("cache-control", "no-store");
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        headers,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
    } catch {
      return Object.freeze({ ok: false, status: 503, body: redactedError("runtime_unavailable") });
    }

    let body: unknown;
    try {
      body = await boundedJson(response);
    } catch {
      return Object.freeze({ ok: false, status: 502, body: redactedError("upstream_invalid_response") });
    }
    if (!response.ok) {
      try {
        const upstream = parseRequesterApiError(body);
        // A runtime 401 means the server-to-server credential is wrong. It is
        // not a browser authorization result and must not reveal auth detail.
        if (response.status === 401) {
          return Object.freeze({ ok: false, status: 502, body: redactedError("runtime_unavailable") });
        }
        return Object.freeze({
          ok: false,
          status: response.status,
          body: redactedError(upstream.code),
        });
      } catch {
        return Object.freeze({ ok: false, status: 502, body: redactedError("upstream_invalid_response") });
      }
    }
    try {
      return Object.freeze({ ok: true, status: response.status, body: parse(body) });
    } catch {
      return Object.freeze({ ok: false, status: 502, body: redactedError("upstream_invalid_response") });
    }
  }

  create(
    input: RequesterTransactionCreateInput,
    idempotencyKey: string,
  ): Promise<RequesterTransportResponse<RequesterTransactionAccepted>> {
    if (!IDEMPOTENCY_KEY.test(idempotencyKey) || !this.#fundingReference) {
      return Promise.resolve(Object.freeze({
        ok: false,
        status: 400,
        body: redactedError("invalid_request"),
      }));
    }
    return this.#request(
      "/api/transactions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ ...input, fundingReference: this.#fundingReference }),
      },
      parseRequesterTransactionAccepted,
    );
  }

  status(transactionId: string): Promise<RequesterTransportResponse<RequesterTransactionStatus>> {
    return this.#request(operationPath(transactionId), { method: "GET" }, parseRequesterTransactionStatus);
  }

  privateResult(transactionId: string): Promise<RequesterTransportResponse<RequesterPrivateResult>> {
    return this.#request(operationPath(transactionId, "result"), { method: "GET" }, parseRequesterPrivateResult);
  }

  report(transactionId: string): Promise<RequesterTransportResponse<RequesterSafeReport>> {
    return this.#request(operationPath(transactionId, "report"), { method: "GET" }, parseRequesterSafeReport);
  }

  resume(transactionId: string): Promise<RequesterTransportResponse<RequesterSafeReport>> {
    return this.#request(operationPath(transactionId, "resume"), { method: "POST" }, parseRequesterSafeReport);
  }

  reconcile(transactionId: string): Promise<RequesterTransportResponse<RequesterRecoveryResult>> {
    return this.#request(operationPath(transactionId, "reconcile"), { method: "POST" }, parseRequesterRecoveryResult);
  }

  refund(transactionId: string): Promise<RequesterTransportResponse<RequesterSafeReport>> {
    return this.#request(operationPath(transactionId, "refund"), { method: "POST" }, parseRequesterSafeReport);
  }

  startDemo(walletKey: string): Promise<RequesterTransportResponse<RequesterRuntimeDemoMutation>> {
    return this.#request(
      "/api/runtime/start-demo",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ walletKey }) },
      demoMutation,
    );
  }

  demoWalletStatus(walletKey: string): Promise<RequesterTransportResponse<RequesterRuntimeDemoStatus>> {
    return this.#request(
      "/api/runtime/wallet-balance",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ walletKey }) },
      demoStatus,
    );
  }

  resetDemo(
    walletKey: string,
    idempotencyKey: string,
  ): Promise<RequesterTransportResponse<RequesterRuntimeDemoMutation>> {
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return Promise.resolve(Object.freeze({ ok: false, status: 400, body: redactedError("invalid_request") }));
    }
    return this.#request(
      "/api/runtime/reset-demo",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletKey, idempotencyKey }),
      },
      demoMutation,
    );
  }
}

export function createRequesterRuntimeTransportFromEnv(
  fundingReferenceOverride?: string,
): RequesterRuntimeTransport {
  // Mode-aware funding reference (Issue #36, Blocker 1): demo reads ONLY the
  // demo funding reference; live reads ONLY the live funding reference. Demo
  // never consumes PACTAGENT_LIVE_FUNDING_REFERENCE and live never consumes
  // PACTAGENT_DEMO_FUNDING_REFERENCE. A missing mode-specific reference fails
  // cleanly — no fallback to the other mode.
  //
  // Issue #37: In demo mode, the funding reference is the requester session's
  // wallet key (passed as an override). In live mode, the env config is used.
  const economicMode = process.env.PACTAGENT_ECONOMIC_MODE?.trim();
  const fundingReference = fundingReferenceOverride
    ? fundingReferenceOverride
    : economicMode === "demo"
      ? undefined
      : configured(process.env.PACTAGENT_LIVE_FUNDING_REFERENCE);
  return new RequesterRuntimeTransport({
    apiBase: configured(process.env.PACTAGENT_RUNTIME_API_BASE),
    apiToken: configured(process.env.PACTAGENT_RUNTIME_API_TOKEN),
    ...(fundingReference === undefined ? {} : { fundingReference }),
  });
}
