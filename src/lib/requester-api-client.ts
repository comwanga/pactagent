"use client";

import {
  parseRequesterApiError,
  parseRequesterCurrentTransaction,
  parseRequesterCurrentTransactionCleared,
  parseRequesterDemoWallet,
  parseRequesterDemoWalletStarted,
  parseRequesterPrivateResult,
  parseRequesterRecoveryResult,
  parseRequesterSafeReport,
  parseRequesterTransactionAccepted,
  parseRequesterTransactionCreateInput,
  parseRequesterTransactionStatus,
  RequesterContractError,
  type RequesterApiErrorDto,
  type RequesterCurrentTransaction,
  type RequesterCurrentTransactionCleared,
  type RequesterDemoWallet,
  type RequesterDemoWalletStarted,
  type RequesterPrivateResult,
  type RequesterRecoveryResult,
  type RequesterSafeReport,
  type RequesterTransactionAccepted,
  type RequesterTransactionCreateInput,
  type RequesterTransactionStatus,
} from "./requester-api-contracts";

const TRANSACTIONS_PATH = "/api/requester/transactions";
const CURRENT_TRANSACTION_PATH = "/api/requester/session/current-transaction";
const DEMO_START_PATH = "/api/requester/demo/start";
const DEMO_STATUS_PATH = "/api/requester/demo";
const DEMO_RESET_PATH = "/api/requester/demo/reset";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/;

export class RequesterApiClientError extends Error {
  readonly status: number;
  readonly detail: RequesterApiErrorDto;

  constructor(status: number, detail: RequesterApiErrorDto) {
    super(detail.error);
    this.name = "RequesterApiClientError";
    this.status = status;
    this.detail = detail;
  }
}

export interface RequesterTransactionSubmission {
  /** Stable for this in-memory logical submission and reused by every retry. */
  readonly idempotencyKey: string;
  submit(): Promise<RequesterTransactionAccepted>;
}

export interface RequesterApiClientOptions {
  readonly fetch?: typeof fetch;
  readonly generateIdempotencyKey?: () => string;
}

/** The exact requester transaction capabilities exposed to the browser UI. */
export interface RequesterTransactionApi {
  currentTransaction(): Promise<RequesterCurrentTransaction>;
  closeCurrentTransaction(): Promise<RequesterCurrentTransactionCleared>;
  createSubmission(input: RequesterTransactionCreateInput): RequesterTransactionSubmission;
  status(transactionId: string): Promise<RequesterTransactionStatus>;
  privateResult(transactionId: string): Promise<RequesterPrivateResult>;
  report(transactionId: string): Promise<RequesterSafeReport>;
  resume(transactionId: string): Promise<RequesterSafeReport>;
  reconcile(transactionId: string): Promise<RequesterRecoveryResult>;
  refund(transactionId: string): Promise<RequesterSafeReport>;
  startDemo(): Promise<RequesterDemoWalletStarted>;
  demoWallet(): Promise<RequesterDemoWallet>;
  resetDemo(idempotencyKey?: string): Promise<RequesterDemoWalletStarted>;
}

function safeInvalidResponse(): RequesterApiErrorDto {
  return Object.freeze({
    error: "The transaction service returned an invalid response",
    code: "upstream_invalid_response",
  });
}

function transactionPath(transactionId: string, operation?: "result" | "report" | "resume" | "reconcile" | "refund"): string {
  if (!TRANSACTION_ID.test(transactionId)) {
    throw new RequesterApiClientError(400, Object.freeze({
      error: "Transaction identifier is invalid",
      code: "invalid_request",
    }));
  }
  const path = `${TRANSACTIONS_PATH}/${encodeURIComponent(transactionId)}`;
  return operation === undefined ? path : `${path}/${operation}`;
}

function snapshotInput(input: RequesterTransactionCreateInput): RequesterTransactionCreateInput {
  try {
    return parseRequesterTransactionCreateInput(input);
  } catch {
    throw new RequesterApiClientError(400, Object.freeze({
      error: "Transaction request is invalid",
      code: "invalid_request",
    }));
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (!contentType?.includes("application/json")) throw new RequesterContractError();
  return response.json() as Promise<unknown>;
}

export class RequesterApiClient {
  readonly #fetch: typeof fetch;
  readonly #generateIdempotencyKey: () => string;

  constructor(options: RequesterApiClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#generateIdempotencyKey = options.generateIdempotencyKey ?? (() => `pact-${crypto.randomUUID()}`);
  }

  async #request<T>(
    path: string,
    init: RequestInit,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    let response: Response;
    try {
      response = await this.#fetch(path, {
        ...init,
        headers,
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
    } catch {
      throw new RequesterApiClientError(503, Object.freeze({
        error: "The transaction service is unavailable",
        code: "runtime_unavailable",
      }));
    }

    let body: unknown;
    try {
      body = await responseJson(response);
    } catch {
      throw new RequesterApiClientError(502, safeInvalidResponse());
    }
    if (!response.ok) {
      try {
        throw new RequesterApiClientError(response.status, parseRequesterApiError(body));
      } catch (error) {
        if (error instanceof RequesterApiClientError) throw error;
        throw new RequesterApiClientError(502, safeInvalidResponse());
      }
    }
    try {
      return parse(body);
    } catch {
      throw new RequesterApiClientError(502, safeInvalidResponse());
    }
  }

  createSubmission(input: RequesterTransactionCreateInput): RequesterTransactionSubmission {
    const request = snapshotInput(input);
    const idempotencyKey = this.#generateIdempotencyKey();
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new RequesterApiClientError(400, Object.freeze({
        error: "Idempotency key generation failed",
        code: "invalid_request",
      }));
    }

    let inFlight: Promise<RequesterTransactionAccepted> | undefined;
    let accepted: RequesterTransactionAccepted | undefined;
    const submit = (): Promise<RequesterTransactionAccepted> => {
      if (accepted) return Promise.resolve(accepted);
      if (inFlight) return inFlight;
      inFlight = this.#request(
        TRANSACTIONS_PATH,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify(request),
        },
        parseRequesterTransactionAccepted,
      ).then((result) => {
        accepted = result;
        return result;
      }).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    };

    return Object.freeze({ idempotencyKey, submit });
  }

  currentTransaction(): Promise<RequesterCurrentTransaction> {
    return this.#request(CURRENT_TRANSACTION_PATH, { method: "GET" }, parseRequesterCurrentTransaction);
  }

  closeCurrentTransaction(): Promise<RequesterCurrentTransactionCleared> {
    return this.#request(
      CURRENT_TRANSACTION_PATH,
      { method: "DELETE" },
      parseRequesterCurrentTransactionCleared,
    );
  }

  status(transactionId: string): Promise<RequesterTransactionStatus> {
    return this.#request(transactionPath(transactionId), { method: "GET" }, parseRequesterTransactionStatus);
  }

  privateResult(transactionId: string): Promise<RequesterPrivateResult> {
    return this.#request(transactionPath(transactionId, "result"), { method: "GET" }, parseRequesterPrivateResult);
  }

  report(transactionId: string): Promise<RequesterSafeReport> {
    return this.#request(transactionPath(transactionId, "report"), { method: "GET" }, parseRequesterSafeReport);
  }

  resume(transactionId: string): Promise<RequesterSafeReport> {
    return this.#request(transactionPath(transactionId, "resume"), { method: "POST" }, parseRequesterSafeReport);
  }

  reconcile(transactionId: string): Promise<RequesterRecoveryResult> {
    return this.#request(transactionPath(transactionId, "reconcile"), { method: "POST" }, parseRequesterRecoveryResult);
  }

  refund(transactionId: string): Promise<RequesterSafeReport> {
    return this.#request(transactionPath(transactionId, "refund"), { method: "POST" }, parseRequesterSafeReport);
  }

  startDemo(): Promise<RequesterDemoWalletStarted> {
    return this.#request(DEMO_START_PATH, { method: "POST" }, parseRequesterDemoWalletStarted);
  }

  demoWallet(): Promise<RequesterDemoWallet> {
    return this.#request(DEMO_STATUS_PATH, { method: "GET" }, parseRequesterDemoWallet);
  }

  resetDemo(idempotencyKey = this.#generateIdempotencyKey()): Promise<RequesterDemoWalletStarted> {
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return Promise.reject(new RequesterApiClientError(400, Object.freeze({
        error: "Demo reset request is invalid",
        code: "invalid_request",
      })));
    }
    return this.#request(
      DEMO_RESET_PATH,
      { method: "POST", headers: { "idempotency-key": idempotencyKey } },
      parseRequesterDemoWalletStarted,
    );
  }
}
