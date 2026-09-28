export interface RuntimeBootstrap {
  readonly mintUrl: string;
  readonly unit: "sat";
  readonly ready: true;
}

export interface SelectedOffer {
  readonly providerPublicKey: string;
  readonly providerDefinitionReference: string;
  readonly offerReference: string;
  readonly escrowDescriptorReference: string;
  readonly amountSats: string;
  readonly unit: "sat";
}

export interface RequesterDecisionProjection {
  readonly source: "deterministic" | "model";
  readonly recommendation: Readonly<{
    action: "recommend";
    providerPublicKey: string;
    offerReference: string;
    amountSats: string;
  }>;
  readonly policy: Readonly<{
    selectedProviderMatchesDiscovery: true;
    stableReferencesMatch: true;
    withinRequesterBudget: true;
    cashuCompatible: true;
    priceAllowed: true;
    executionDurationAllowed: true;
  }>;
  readonly authorized: true;
}

export type RuntimePhase =
  | "initialized"
  | "proposed"
  | "accepted"
  | "escrow_funded"
  | "task_delivered"
  | "result_submitted"
  | "result_verified"
  | "release_authorized"
  | "settled"
  | "refund_authorized"
  | "refunded";

export type OperationalState =
  | "active"
  | "failed"
  | "reconciliation_required"
  | "resolved_not_funded"
  | "refunded"
  | "settled";

export type ReconciliationState =
  | "funding_reconciliation_required"
  | "release_reconciliation_required"
  | "refund_reconciliation_required";

export interface TransactionStatus {
  readonly transactionId: string;
  readonly kind: "successful" | "refund";
  readonly phase: RuntimePhase;
  readonly operationalState: OperationalState;
  readonly agreementId: string;
  readonly selectedOffer: SelectedOffer;
  readonly requesterDecision?: RequesterDecisionProjection;
  readonly availableActions: Readonly<{ resume: boolean; reconcile: boolean }>;
  readonly resultAvailable: boolean;
  readonly reportAvailable: boolean;
  readonly failureCode?: "transaction_failed";
  readonly agreementRootEventId?: string;
  readonly finalOutcome?: "settled" | "refunded";
  readonly resultReference?: string;
  readonly escrowReference?: string;
  readonly settlementReference?: string;
  readonly refundReference?: string;
  readonly reconciliationRequired?: true;
  readonly reconciliationState?: ReconciliationState;
}

export interface WorkflowReport {
  readonly workflowVersion: 1;
  readonly agreementId: string;
  readonly agreementRootEventId: string;
  readonly requesterPublicKey: string;
  readonly providerPublicKey: string;
  readonly escrowAuthorityPublicKey: string;
  readonly selectedReferences: {
    readonly providerPublicKey: string;
    readonly providerDefinitionReference: string;
    readonly offerReference: string;
    readonly escrowDescriptorReference: string;
  };
  readonly amountSats: string;
  readonly unit: "sat";
  readonly lifecycle: ReadonlyArray<{
    readonly state: RuntimePhase;
    readonly eventId: string;
  }>;
  readonly escrowReference: string;
  readonly resultReference?: string;
  readonly settlementReference?: string;
  readonly refundReference?: string;
  readonly finalOutcome: "settled" | "refunded";
}

export interface PrivateResult {
  readonly summary: string;
}

export interface ApiError {
  readonly error: string;
  readonly code: string;
}

export class PactAgentApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "PactAgentApiClientError";
    this.code = code;
    this.status = status;
  }
}

function authHeaders(apiToken?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  return headers;
}

const SAME_ORIGIN: RequestCredentials = "same-origin";

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) {
    const error = body as ApiError;
    throw new PactAgentApiClientError(
      error.code ?? "http_error",
      error.error ?? `HTTP ${response.status}`,
      response.status,
    );
  }
  return body as T;
}

export function isWorkflowReport(value: unknown): value is WorkflowReport {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { workflowVersion?: unknown }).workflowVersion === 1 &&
    typeof (value as { finalOutcome?: unknown }).finalOutcome === "string"
  );
}

export function isTransactionStatus(value: unknown): value is TransactionStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { transactionId?: unknown }).transactionId === "string" &&
    typeof (value as { operationalState?: unknown }).operationalState === "string"
  );
}

export class PactAgentApiClient {
  readonly #baseURL: string;
  readonly #apiToken?: string;

  /**
   * @param apiToken Optional bearer token for non-browser API consumers.
   *   The browser UI does NOT pass a token; it authenticates via an httpOnly
   *   session cookie minted by POST /api/session, so the secret never reaches
   *   client-side JavaScript.
   * @param baseURL Optional API base; defaults to NEXT_PUBLIC_PACTAGENT_API_BASE.
   */
  constructor(apiToken?: string, baseURL?: string) {
    this.#apiToken = apiToken;
    this.#baseURL =
      baseURL ??
      (typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_PACTAGENT_API_BASE ?? ""
        : "");
  }

  async getSession(): Promise<SessionInfo> {
    const response = await fetch(`${this.#baseURL}/api/session`, {
      method: "GET",
      headers: authHeaders(this.#apiToken),
      credentials: SAME_ORIGIN,
      cache: "no-store",
    });
    return parseResponse<SessionInfo>(response);
  }

  async startSession(input: {
    readonly token?: string;
    readonly demoCode?: string;
    readonly fundingReference?: string;
  }): Promise<SessionInfo> {
    const response = await fetch(`${this.#baseURL}/api/session`, {
      method: "POST",
      headers: authHeaders(this.#apiToken),
      credentials: SAME_ORIGIN,
      cache: "no-store",
      body: JSON.stringify({
        ...(input.token ? { token: input.token } : {}),
        ...(input.demoCode ? { demoCode: input.demoCode } : {}),
        ...(input.fundingReference ? { fundingReference: input.fundingReference } : {}),
      }),
    });
    return parseResponse<SessionInfo>(response);
  }

  async endSession(): Promise<void> {
    const response = await fetch(`${this.#baseURL}/api/session`, {
      method: "DELETE",
      headers: authHeaders(this.#apiToken),
      credentials: SAME_ORIGIN,
      cache: "no-store",
    });
    await parseResponse<void>(response);
  }

  async bootstrap(): Promise<RuntimeBootstrap> {
    const response = await fetch(`${this.#baseURL}/api/runtime/bootstrap`, {
      method: "POST",
      headers: authHeaders(this.#apiToken),
      credentials: SAME_ORIGIN,
      cache: "no-store",
    });
    return parseResponse<RuntimeBootstrap>(response);
  }

  async startTransaction(input: {
    readonly idempotencyKey: string;
    readonly fundingReference?: string;
    readonly privateDocument: string;
    readonly mediaType: "text/plain" | "application/pdf";
    readonly privatePrompt?: string;
    readonly maximumBudgetSats: string;
  }): Promise<{ transactionId: string }> {
    const response = await fetch(`${this.#baseURL}/api/transactions`, {
      method: "POST",
      headers: {
        ...authHeaders(this.#apiToken),
        "Idempotency-Key": input.idempotencyKey,
      },
      credentials: SAME_ORIGIN,
      body: JSON.stringify({
        privateDocument: input.privateDocument,
        mediaType: input.mediaType,
        ...(input.privatePrompt ? { privatePrompt: input.privatePrompt } : {}),
        maximumBudgetSats: input.maximumBudgetSats,
        ...(input.fundingReference ? { fundingReference: input.fundingReference } : {}),
      }),
      cache: "no-store",
    });
    return parseResponse<{ transactionId: string }>(response);
  }

  async getStatus(transactionId: string): Promise<TransactionStatus> {
    const response = await fetch(`${this.#baseURL}/api/transactions/${transactionId}`, {
      method: "GET",
      headers: authHeaders(this.#apiToken),
      credentials: SAME_ORIGIN,
      cache: "no-store",
    });
    return parseResponse<TransactionStatus>(response);
  }

  async getReport(transactionId: string): Promise<WorkflowReport> {
    const response = await fetch(`${this.#baseURL}/api/transactions/${transactionId}/report`, {
      method: "GET",
      headers: authHeaders(this.#apiToken),
      credentials: SAME_ORIGIN,
      cache: "no-store",
    });
    return parseResponse<WorkflowReport>(response);
  }

  async getPrivateResult(transactionId: string): Promise<PrivateResult> {
    const response = await fetch(`${this.#baseURL}/api/transactions/${transactionId}/result`, {
      method: "GET",
      headers: authHeaders(this.#apiToken),
      credentials: SAME_ORIGIN,
      cache: "no-store",
    });
    return parseResponse<PrivateResult>(response);
  }

  async resume(transactionId: string): Promise<WorkflowReport> {
    const response = await fetch(`${this.#baseURL}/api/transactions/${transactionId}/resume`, {
      method: "POST",
      headers: authHeaders(this.#apiToken),
      credentials: SAME_ORIGIN,
      cache: "no-store",
    });
    return parseResponse<WorkflowReport>(response);
  }

  async reconcile(transactionId: string): Promise<WorkflowReport | TransactionStatus> {
    const response = await fetch(`${this.#baseURL}/api/transactions/${transactionId}/reconcile`, {
      method: "POST",
      headers: authHeaders(this.#apiToken),
      credentials: SAME_ORIGIN,
      cache: "no-store",
    });
    return parseResponse<WorkflowReport | TransactionStatus>(response);
  }
}

const STORAGE_KEY = "pactagent:txn";
const IDEMPOTENCY_KEY = "pactagent:idem";

/*
 * Reload-recovery state. Only the transaction id and the client-generated
 * idempotency key (a random value, not private material) are retained in
 * sessionStorage. Per the issue privacy rule, the source document, prompt,
 * private summary, credentials, AND the funding reference are NEVER stored in
 * JS-accessible browser storage; the funding reference lives in an httpOnly
 * cookie managed by /api/session, and the auth token never reaches the client.
 */
export function retainTransactionId(transactionId: string): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  window.sessionStorage.setItem(STORAGE_KEY, transactionId);
}

export function loadRetainedTransactionId(): string | undefined {
  if (typeof window === "undefined" || !window.sessionStorage) return undefined;
  const value = window.sessionStorage.getItem(STORAGE_KEY);
  return value ?? undefined;
}

export function clearRetainedTransactionId(): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  window.sessionStorage.removeItem(STORAGE_KEY);
}

export function retainIdempotencyKey(key: string): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  window.sessionStorage.setItem(IDEMPOTENCY_KEY, key);
}

export function loadRetainedIdempotencyKey(): string | undefined {
  if (typeof window === "undefined" || !window.sessionStorage) return undefined;
  return window.sessionStorage.getItem(IDEMPOTENCY_KEY) ?? undefined;
}

export function clearRetainedIdempotencyKey(): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  window.sessionStorage.removeItem(IDEMPOTENCY_KEY);
}

export function clearAllRetained(): void {
  clearRetainedTransactionId();
  clearRetainedIdempotencyKey();
}

export function generateIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SessionInfo is returned by /api/session. The runtime bearer token is NEVER
 * in this object — it lives only in an httpOnly cookie. `demoAvailable`
 * indicates whether the server will mint a one-click demo session.
 */
export interface SessionInfo {
  readonly authenticated: boolean;
  readonly demoAvailable: boolean;
}

const FRIENDLY_ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "Authorization failed — check your runtime token.",
  transaction_not_found: "This transaction no longer exists on the runtime.",
  transaction_in_progress: "The agent is already executing this transaction.",
  result_not_available: "The private result isn't available yet.",
  report_not_available: "The terminal report isn't available yet.",
  reconciliation_required: "This transaction needs reconciliation.",
  invalid_request: "The request was rejected by the runtime.",
  internal_error: "The runtime hit an internal error.",
};

export function friendlyErrorMessage(error: unknown): string {
  if (error instanceof PactAgentApiClientError) {
    return FRIENDLY_ERROR_MESSAGES[error.code] ?? "The runtime could not complete that request.";
  }
  if (error instanceof Error && error.message === "Failed to fetch") return "The runtime is unavailable.";
  return "Something went wrong.";
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof PactAgentApiClientError && error.status === 404;
}
