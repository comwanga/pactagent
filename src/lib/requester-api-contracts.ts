/**
 * Browser-safe, allowlisted representations of the Issue #33 transaction API.
 *
 * This module deliberately has no imports from the runtime or workflow. It is
 * safe to include in a client bundle and validates every response at the HTTP
 * boundary instead of trusting arbitrary JSON.
 */

import {
  DOCUMENT_SOURCE_MAXIMUM_BYTES,
  documentSourceBytes,
} from "../domain/document-size";

export type RequesterDocumentMediaType = "text/plain" | "application/pdf";

export const REQUESTER_DOCUMENT_MAXIMUM_BYTES = DOCUMENT_SOURCE_MAXIMUM_BYTES;
export const REQUESTER_PROMPT_MAXIMUM_BYTES = 64 * 1024;

export interface RequesterTransactionCreateInput {
  /**
   * UTF-8 document text for text/plain, or standard base64-encoded PDF bytes
   * for application/pdf. This is the representation consumed unchanged by
   * the #33 runtime, private-task transport, and document-summary provider.
   */
  readonly privateDocument: string;
  readonly mediaType: RequesterDocumentMediaType;
  readonly privatePrompt?: string;
  readonly maximumBudgetSats: number;
}

export interface RequesterTransactionAccepted {
  readonly transactionId: string;
}

export interface RequesterCurrentTransaction {
  readonly transactionId: string | null;
}

export interface RequesterCurrentTransactionCleared {
  readonly cleared: true;
}

export type RequesterLifecycleState =
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

export type RequesterReportLifecycleState =
  | Exclude<RequesterLifecycleState, "initialized">
  | "expired"
  | "rejected"
  | "disputed";

export type RequesterOperationalState =
  | "active"
  | "failed"
  | "reconciliation_required"
  | "resolved_not_funded"
  | "refunded"
  | "settled";

export type RequesterReconciliationState =
  | "funding_reconciliation_required"
  | "release_reconciliation_required"
  | "refund_reconciliation_required";

export type RequesterFailureReason =
  | "invalid_configuration"
  | "discovery_failed"
  | "decision_rejected"
  | "agreement_publication_failed"
  | "escrow_failed"
  | "reconciliation_required"
  | "private_transport_failed"
  | "private_task_transport_too_large"
  | "execution_failed"
  | "completion_failed"
  | "settlement_failed"
  | "reconstruction_failed"
  | "privacy_boundary_violation"
  | "unexpected_state";

export interface RequesterSelectedOffer {
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

export interface RequesterAvailableActions {
  readonly resume: boolean;
  readonly reconcile: boolean;
  readonly refund: boolean;
}

export interface RequesterTransactionStatus {
  readonly transactionId: string;
  readonly kind: "successful" | "refund";
  readonly phase: RequesterLifecycleState;
  readonly operationalState: RequesterOperationalState;
  readonly agreementId: string;
  readonly selectedOffer: RequesterSelectedOffer;
  readonly requesterDecision?: RequesterDecisionProjection;
  readonly availableActions: RequesterAvailableActions;
  readonly resultAvailable: boolean;
  readonly reportAvailable: boolean;
  readonly failureCode?: "transaction_failed";
  readonly failureReason?: RequesterFailureReason;
  readonly agreementRootEventId?: string;
  readonly finalOutcome?: "settled" | "refunded";
  readonly resultReference?: string;
  readonly escrowReference?: string;
  readonly settlementReference?: string;
  readonly refundReference?: string;
  readonly reconciliationRequired?: true;
  readonly reconciliationState?: RequesterReconciliationState;
}

export interface RequesterDemoWallet {
  readonly economicMode: "demo";
  readonly started: boolean;
  readonly generation?: number;
  readonly balance?: Readonly<{ availableSats: number }>;
  readonly resetAvailable?: boolean;
  readonly accountingPending?: boolean;
  readonly disclosure?: "Demo sats — no monetary value";
}

export interface RequesterDemoWalletStarted {
  readonly economicMode: "demo";
  readonly generation: number;
  readonly disclosure: "Demo sats — no monetary value";
}

export interface RequesterPrivateResult {
  readonly summary: string;
}

export interface RequesterSafeReport {
  readonly workflowVersion: 1;
  readonly agreementId: string;
  readonly agreementRootEventId: string;
  readonly requesterPublicKey: string;
  readonly providerPublicKey: string;
  readonly escrowAuthorityPublicKey: string;
  readonly selectedReferences: Readonly<{
    providerPublicKey: string;
    providerDefinitionReference: string;
    offerReference: string;
    escrowDescriptorReference: string;
  }>;
  readonly amountSats: string;
  readonly unit: "sat";
  readonly lifecycle: ReadonlyArray<Readonly<{
    state: RequesterReportLifecycleState;
    eventId: string;
  }>>;
  readonly escrowReference: string;
  readonly resultReference?: string;
  readonly settlementReference?: string;
  readonly refundReference?: string;
  readonly finalOutcome: "settled" | "refunded";
}

export type RequesterApiErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "document_too_large"
  | "result_not_available"
  | "report_not_available"
  | "transaction_in_progress"
  | "transaction_not_found"
  | "corrupt_record"
  | "invalid_configuration"
  | "not_running"
  | "reconciliation_required"
  | "internal_error"
  | "runtime_unavailable"
  | "upstream_invalid_response";

export interface RequesterApiErrorDto {
  readonly error: string;
  readonly code: RequesterApiErrorCode;
}

export class RequesterContractError extends Error {
  constructor(message = "Response does not match the requester API contract") {
    super(message);
    this.name = "RequesterContractError";
  }
}

export class RequesterDocumentTooLargeError extends RequesterContractError {
  constructor() {
    super("Document exceeds the 1 MiB source limit");
    this.name = "RequesterDocumentTooLargeError";
  }
}

export function parseRequesterTransactionCreateInput(value: unknown): RequesterTransactionCreateInput {
  const parsed = object(value);
  exactKeys(
    parsed,
    ["privateDocument", "mediaType", "maximumBudgetSats"],
    ["privatePrompt"],
  );
  if (
    parsed.mediaType !== "text/plain" &&
    parsed.mediaType !== "application/pdf"
  ) {
    throw new RequesterContractError();
  }
  if (
    !Number.isSafeInteger(parsed.maximumBudgetSats) ||
    (parsed.maximumBudgetSats as number) <= 0
  ) {
    throw new RequesterContractError();
  }
  const privateDocument = nonEmptyText(parsed.privateDocument);
  const sourceBytes = documentSourceBytes(privateDocument, parsed.mediaType);
  if (sourceBytes === undefined) throw new RequesterContractError();
  if (sourceBytes > REQUESTER_DOCUMENT_MAXIMUM_BYTES) {
    throw new RequesterDocumentTooLargeError();
  }
  if (
    parsed.privatePrompt !== undefined &&
    new TextEncoder().encode(text(parsed.privatePrompt)).byteLength > REQUESTER_PROMPT_MAXIMUM_BYTES
  ) {
    throw new RequesterContractError();
  }
  return Object.freeze({
    privateDocument,
    mediaType: parsed.mediaType,
    ...(parsed.privatePrompt === undefined
      ? {}
      : { privatePrompt: text(parsed.privatePrompt) }),
    maximumBudgetSats: parsed.maximumBudgetSats as number,
  });
}

type JsonObject = Record<string, unknown>;

const LIFECYCLE_STATES = new Set<RequesterLifecycleState>([
  "initialized",
  "proposed",
  "accepted",
  "escrow_funded",
  "task_delivered",
  "result_submitted",
  "result_verified",
  "release_authorized",
  "settled",
  "refund_authorized",
  "refunded",
]);
const REPORT_LIFECYCLE_STATES = new Set<RequesterReportLifecycleState>([
  ...[...LIFECYCLE_STATES].filter((state) => state !== "initialized"),
  "expired",
  "rejected",
  "disputed",
] as RequesterReportLifecycleState[]);
const OPERATIONAL_STATES = new Set<RequesterOperationalState>([
  "active",
  "failed",
  "reconciliation_required",
  "resolved_not_funded",
  "refunded",
  "settled",
]);
const FAILURE_REASONS = new Set<RequesterFailureReason>([
  "invalid_configuration",
  "discovery_failed",
  "decision_rejected",
  "agreement_publication_failed",
  "escrow_failed",
  "reconciliation_required",
  "private_transport_failed",
  "private_task_transport_too_large",
  "execution_failed",
  "completion_failed",
  "settlement_failed",
  "reconstruction_failed",
  "privacy_boundary_violation",
  "unexpected_state",
]);
const RECONCILIATION_STATES = new Set<RequesterReconciliationState>([
  "funding_reconciliation_required",
  "release_reconciliation_required",
  "refund_reconciliation_required",
]);
const ERROR_CODES = new Set<RequesterApiErrorCode>([
  "unauthorized",
  "invalid_request",
  "document_too_large",
  "result_not_available",
  "report_not_available",
  "transaction_in_progress",
  "transaction_not_found",
  "corrupt_record",
  "invalid_configuration",
  "not_running",
  "reconciliation_required",
  "internal_error",
  "runtime_unavailable",
  "upstream_invalid_response",
]);

function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequesterContractError();
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  const permitted = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !permitted.has(key))
  ) {
    throw new RequesterContractError();
  }
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new RequesterContractError();
  return value;
}

function nonEmptyText(value: unknown): string {
  const parsed = text(value);
  if (parsed.length === 0) throw new RequesterContractError();
  return parsed;
}

function satsText(value: unknown): string {
  const parsed = text(value);
  if (!/^\d+$/.test(parsed)) throw new RequesterContractError();
  return parsed;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new RequesterContractError();
  return value;
}

function literalTrue(value: unknown): true {
  if (value !== true) throw new RequesterContractError();
  return true;
}

function optionalText(value: JsonObject, key: string): string | undefined {
  return value[key] === undefined ? undefined : nonEmptyText(value[key]);
}

function selectedOffer(value: unknown): RequesterSelectedOffer {
  const parsed = object(value);
  exactKeys(parsed, [
    "providerPublicKey",
    "providerDefinitionReference",
    "offerReference",
    "escrowDescriptorReference",
    "amountSats",
    "unit",
  ]);
  if (parsed.unit !== "sat") throw new RequesterContractError();
  return Object.freeze({
    providerPublicKey: nonEmptyText(parsed.providerPublicKey),
    providerDefinitionReference: nonEmptyText(parsed.providerDefinitionReference),
    offerReference: nonEmptyText(parsed.offerReference),
    escrowDescriptorReference: nonEmptyText(parsed.escrowDescriptorReference),
    amountSats: satsText(parsed.amountSats),
    unit: "sat",
  });
}

function requesterDecision(value: unknown): RequesterDecisionProjection {
  const parsed = object(value);
  exactKeys(parsed, ["source", "recommendation", "policy", "authorized"]);
  if (parsed.source !== "deterministic" && parsed.source !== "model") {
    throw new RequesterContractError();
  }
  const recommendation = object(parsed.recommendation);
  exactKeys(recommendation, ["action", "providerPublicKey", "offerReference", "amountSats"]);
  if (recommendation.action !== "recommend") throw new RequesterContractError();
  const policy = object(parsed.policy);
  exactKeys(policy, [
    "selectedProviderMatchesDiscovery",
    "stableReferencesMatch",
    "withinRequesterBudget",
    "cashuCompatible",
    "priceAllowed",
    "executionDurationAllowed",
  ]);
  return Object.freeze({
    source: parsed.source,
    recommendation: Object.freeze({
      action: "recommend",
      providerPublicKey: nonEmptyText(recommendation.providerPublicKey),
      offerReference: nonEmptyText(recommendation.offerReference),
      amountSats: satsText(recommendation.amountSats),
    }),
    policy: Object.freeze({
      selectedProviderMatchesDiscovery: literalTrue(policy.selectedProviderMatchesDiscovery),
      stableReferencesMatch: literalTrue(policy.stableReferencesMatch),
      withinRequesterBudget: literalTrue(policy.withinRequesterBudget),
      cashuCompatible: literalTrue(policy.cashuCompatible),
      priceAllowed: literalTrue(policy.priceAllowed),
      executionDurationAllowed: literalTrue(policy.executionDurationAllowed),
    }),
    authorized: literalTrue(parsed.authorized),
  });
}

export function parseRequesterTransactionAccepted(value: unknown): RequesterTransactionAccepted {
  const parsed = object(value);
  exactKeys(parsed, ["transactionId"]);
  return Object.freeze({ transactionId: nonEmptyText(parsed.transactionId) });
}

export function parseRequesterCurrentTransaction(value: unknown): RequesterCurrentTransaction {
  const parsed = object(value);
  exactKeys(parsed, ["transactionId"]);
  return Object.freeze({
    transactionId: parsed.transactionId === null ? null : nonEmptyText(parsed.transactionId),
  });
}

export function parseRequesterCurrentTransactionCleared(value: unknown): RequesterCurrentTransactionCleared {
  const parsed = object(value);
  exactKeys(parsed, ["cleared"]);
  if (parsed.cleared !== true) throw new RequesterContractError();
  return Object.freeze({ cleared: true });
}

export function parseRequesterTransactionStatus(value: unknown): RequesterTransactionStatus {
  const parsed = object(value);
  exactKeys(
    parsed,
    [
      "transactionId",
      "kind",
      "phase",
      "operationalState",
      "agreementId",
      "selectedOffer",
      "availableActions",
      "resultAvailable",
      "reportAvailable",
    ],
    [
      "requesterDecision",
      "failureCode",
      "failureReason",
      "agreementRootEventId",
      "finalOutcome",
      "resultReference",
      "escrowReference",
      "settlementReference",
      "refundReference",
      "reconciliationRequired",
      "reconciliationState",
    ],
  );
  if (parsed.kind !== "successful" && parsed.kind !== "refund") throw new RequesterContractError();
  if (!LIFECYCLE_STATES.has(parsed.phase as RequesterLifecycleState)) throw new RequesterContractError();
  if (!OPERATIONAL_STATES.has(parsed.operationalState as RequesterOperationalState)) {
    throw new RequesterContractError();
  }
  if (parsed.failureCode !== undefined && parsed.failureCode !== "transaction_failed") {
    throw new RequesterContractError();
  }
  if (
    parsed.failureReason !== undefined &&
    !FAILURE_REASONS.has(parsed.failureReason as RequesterFailureReason)
  ) {
    throw new RequesterContractError();
  }
  if (parsed.finalOutcome !== undefined && parsed.finalOutcome !== "settled" && parsed.finalOutcome !== "refunded") {
    throw new RequesterContractError();
  }
  if (
    parsed.reconciliationState !== undefined &&
    !RECONCILIATION_STATES.has(parsed.reconciliationState as RequesterReconciliationState)
  ) {
    throw new RequesterContractError();
  }
  if (parsed.reconciliationRequired !== undefined) literalTrue(parsed.reconciliationRequired);
  const actions = object(parsed.availableActions);
  exactKeys(actions, ["resume", "reconcile", "refund"]);
  return Object.freeze({
    transactionId: nonEmptyText(parsed.transactionId),
    kind: parsed.kind,
    phase: parsed.phase as RequesterLifecycleState,
    operationalState: parsed.operationalState as RequesterOperationalState,
    agreementId: nonEmptyText(parsed.agreementId),
    selectedOffer: selectedOffer(parsed.selectedOffer),
    ...(parsed.requesterDecision === undefined ? {} : { requesterDecision: requesterDecision(parsed.requesterDecision) }),
    availableActions: Object.freeze({
      resume: boolean(actions.resume),
      reconcile: boolean(actions.reconcile),
      refund: boolean(actions.refund),
    }),
    resultAvailable: boolean(parsed.resultAvailable),
    reportAvailable: boolean(parsed.reportAvailable),
    ...(parsed.failureCode === undefined ? {} : { failureCode: "transaction_failed" as const }),
    ...(parsed.failureReason === undefined
      ? {}
      : { failureReason: parsed.failureReason as RequesterFailureReason }),
    ...(optionalText(parsed, "agreementRootEventId") === undefined ? {} : { agreementRootEventId: optionalText(parsed, "agreementRootEventId")! }),
    ...(parsed.finalOutcome === undefined ? {} : { finalOutcome: parsed.finalOutcome }),
    ...(optionalText(parsed, "resultReference") === undefined ? {} : { resultReference: optionalText(parsed, "resultReference")! }),
    ...(optionalText(parsed, "escrowReference") === undefined ? {} : { escrowReference: optionalText(parsed, "escrowReference")! }),
    ...(optionalText(parsed, "settlementReference") === undefined ? {} : { settlementReference: optionalText(parsed, "settlementReference")! }),
    ...(optionalText(parsed, "refundReference") === undefined ? {} : { refundReference: optionalText(parsed, "refundReference")! }),
    ...(parsed.reconciliationRequired === undefined ? {} : { reconciliationRequired: true as const }),
    ...(parsed.reconciliationState === undefined
      ? {}
      : { reconciliationState: parsed.reconciliationState as RequesterReconciliationState }),
  });
}

export function parseRequesterPrivateResult(value: unknown): RequesterPrivateResult {
  const parsed = object(value);
  exactKeys(parsed, ["summary"]);
  return Object.freeze({ summary: text(parsed.summary) });
}

export function parseRequesterSafeReport(value: unknown): RequesterSafeReport {
  const parsed = object(value);
  exactKeys(
    parsed,
    [
      "workflowVersion",
      "agreementId",
      "agreementRootEventId",
      "requesterPublicKey",
      "providerPublicKey",
      "escrowAuthorityPublicKey",
      "selectedReferences",
      "amountSats",
      "unit",
      "lifecycle",
      "escrowReference",
      "finalOutcome",
    ],
    ["resultReference", "settlementReference", "refundReference"],
  );
  if (parsed.workflowVersion !== 1 || parsed.unit !== "sat") throw new RequesterContractError();
  if (parsed.finalOutcome !== "settled" && parsed.finalOutcome !== "refunded") {
    throw new RequesterContractError();
  }
  const references = object(parsed.selectedReferences);
  exactKeys(references, [
    "providerPublicKey",
    "providerDefinitionReference",
    "offerReference",
    "escrowDescriptorReference",
  ]);
  if (!Array.isArray(parsed.lifecycle)) throw new RequesterContractError();
  const lifecycle = parsed.lifecycle.map((entry) => {
    const transition = object(entry);
    exactKeys(transition, ["state", "eventId"]);
    if (!REPORT_LIFECYCLE_STATES.has(transition.state as RequesterReportLifecycleState)) {
      throw new RequesterContractError();
    }
    return Object.freeze({
      state: transition.state as RequesterReportLifecycleState,
      eventId: nonEmptyText(transition.eventId),
    });
  });
  return Object.freeze({
    workflowVersion: 1,
    agreementId: nonEmptyText(parsed.agreementId),
    agreementRootEventId: nonEmptyText(parsed.agreementRootEventId),
    requesterPublicKey: nonEmptyText(parsed.requesterPublicKey),
    providerPublicKey: nonEmptyText(parsed.providerPublicKey),
    escrowAuthorityPublicKey: nonEmptyText(parsed.escrowAuthorityPublicKey),
    selectedReferences: Object.freeze({
      providerPublicKey: nonEmptyText(references.providerPublicKey),
      providerDefinitionReference: nonEmptyText(references.providerDefinitionReference),
      offerReference: nonEmptyText(references.offerReference),
      escrowDescriptorReference: nonEmptyText(references.escrowDescriptorReference),
    }),
    amountSats: satsText(parsed.amountSats),
    unit: "sat",
    lifecycle: Object.freeze(lifecycle),
    escrowReference: nonEmptyText(parsed.escrowReference),
    ...(optionalText(parsed, "resultReference") === undefined ? {} : { resultReference: optionalText(parsed, "resultReference")! }),
    ...(optionalText(parsed, "settlementReference") === undefined ? {} : { settlementReference: optionalText(parsed, "settlementReference")! }),
    ...(optionalText(parsed, "refundReference") === undefined ? {} : { refundReference: optionalText(parsed, "refundReference")! }),
    finalOutcome: parsed.finalOutcome,
  });
}

export function parseRequesterApiError(value: unknown): RequesterApiErrorDto {
  const parsed = object(value);
  exactKeys(parsed, ["error", "code"]);
  if (!ERROR_CODES.has(parsed.code as RequesterApiErrorCode)) throw new RequesterContractError();
  return Object.freeze({
    error: nonEmptyText(parsed.error),
    code: parsed.code as RequesterApiErrorCode,
  });
}

export function parseRequesterDemoWallet(value: unknown): RequesterDemoWallet {
  const parsed = object(value);
  exactKeys(parsed, ["economicMode", "started"], ["generation", "balance", "resetAvailable", "accountingPending", "disclosure"]);
  if (parsed.economicMode !== "demo") throw new RequesterContractError();
  const started = boolean(parsed.started);
  if (started) {
    if (parsed.generation === undefined || parsed.balance === undefined ||
        parsed.resetAvailable === undefined || parsed.disclosure === undefined) {
      throw new RequesterContractError();
    }
    if (parsed.disclosure !== "Demo sats — no monetary value") throw new RequesterContractError();
    const gen = parsed.generation as number;
    if (!Number.isSafeInteger(gen) || gen < 1) throw new RequesterContractError();
    const balance = object(parsed.balance);
    exactKeys(balance, ["availableSats"]);
    const availableSats = balance.availableSats as number;
    if (!Number.isSafeInteger(availableSats) || availableSats < 0) {
      throw new RequesterContractError();
    }
    return Object.freeze({
      economicMode: "demo",
      started: true,
      generation: gen,
      balance: Object.freeze({ availableSats }),
      resetAvailable: boolean(parsed.resetAvailable),
      ...(parsed.accountingPending === undefined
        ? {}
        : { accountingPending: boolean(parsed.accountingPending) }),
      disclosure: "Demo sats — no monetary value",
    });
  }
  return Object.freeze({ economicMode: "demo", started: false });
}

export function parseRequesterDemoWalletStarted(value: unknown): RequesterDemoWalletStarted {
  const parsed = object(value);
  exactKeys(parsed, ["economicMode", "generation", "disclosure"]);
  if (parsed.economicMode !== "demo") throw new RequesterContractError();
  if (parsed.disclosure !== "Demo sats — no monetary value") throw new RequesterContractError();
  const gen = parsed.generation as number;
  if (!Number.isSafeInteger(gen) || gen < 1) throw new RequesterContractError();
  return Object.freeze({
    economicMode: "demo",
    generation: gen,
    disclosure: "Demo sats — no monetary value",
  });
}

export type RequesterRecoveryResult = RequesterSafeReport | RequesterTransactionStatus;

export function parseRequesterRecoveryResult(value: unknown): RequesterRecoveryResult {
  const parsed = object(value);
  return Object.hasOwn(parsed, "workflowVersion")
    ? parseRequesterSafeReport(parsed)
    : parseRequesterTransactionStatus(parsed);
}
