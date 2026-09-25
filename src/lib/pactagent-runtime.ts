import { createHash, randomBytes } from "node:crypto";
import { getEventHash } from "nostr-tools/pure";

import { sats, type Sats } from "../domain/money";
import { type SignedNostrEvent, type UnsignedNostrEvent } from "../domain/nostr";
import {
  createPactAgreementId,
  createPactCompletionDecision,
  createPactEscrowAuthorityBinding,
  createPactEscrowAuthoritySource,
  DOCUMENT_SUMMARY_PROFILE_ID,
  PactPrivateCommitmentSalt,
  parsePactAgreementTransitionEvent,
  type DocumentSummaryPrivateTerms,
  type PactAgreementContext,
  type PactAgreementHistory,
  type PactAgreementReferences,
  type PactAgreementState,
  type PactCompletionDecision,
  type PactServiceAgreementRoot,
} from "../domain/pact-service-agreement";
import {
  createPactAgentWorkflow,
  PactAgentWorkflowError,
  type PactAgentParticipantIdentities,
  type PactAgentWorkflowDependencies,
  type PactAgentWorkflowReport,
  type PactAgentWorkflowProgress,
  type PactAgentWorkflowResumePhase,
  type PactAgentWorkflowResumeState,
} from "./pactagent-workflow";
import type { PactCashuEscrowOperationalState } from "./cashu-escrow-settlement";
import { type CashuPrivateStore, type PrivateCashuFunding } from "./cashu-test-mint";
import { type ApprovedRequesterDecision } from "./requester-decision";
import { type SelectedProviderReferences } from "./provider-discovery";
import { retrieveAndOpenPrivateResult } from "./private-task-transport";
import {
  PactAgreementPublicationError,
  retrieveAndReconstructPactAgreement,
  retrievePactAgreementTransitions,
  retrievePactServiceAgreementRoot,
} from "./pact-service-agreement-publication";

/*
 * PactAgent long-lived runtime (Issue #33).
 *
 * Owns the long-lived dependencies and creates an isolated PactAgentWorkflow
 * per transaction. It persists the minimum private recovery state required by
 * Step 1 so a restarted runtime can reconstruct and resume an interrupted
 * transaction without creating a second agreement or repeating economic work.
 *
 * No HTTP surface; start/status/resume/reconcile are internal methods.
 */

export type PactAgentRuntimeErrorCode =
  | "invalid_request"
  | "result_not_available"
  | "report_not_available"
  | "transaction_in_progress"
  | "transaction_not_found"
  | "corrupt_record"
  | "invalid_configuration"
  | "not_running";

export class PactAgentRuntimeError extends Error {
  readonly code: PactAgentRuntimeErrorCode;

  constructor(code: PactAgentRuntimeErrorCode, message: string) {
    super(message);
    this.name = "PactAgentRuntimeError";
    this.code = code;
  }
}

export interface PactAgentRuntimeConfig {
  readonly identities: PactAgentParticipantIdentities;
  readonly dependencies: PactAgentWorkflowDependencies;
  /** Durable private store reused for the transaction recovery records. */
  readonly privateStore: CashuPrivateStore;
  /** Stable Pontmore references (P001/P002/PIP-01) reused for context reconstruction. */
  readonly references: PactAgreementReferences;
  /** Deterministic provider selection used to rebuild the requester decision. */
  readonly selectedReferences: SelectedProviderReferences;
  /** Resolves one opaque reference through the trusted private-funding boundary. */
  readonly resolveFunding: (reference: string) => Promise<PrivateCashuFunding>;
  /** Identifies the recommendation adapter without granting it authority. */
  readonly requesterDecisionSource?: "deterministic" | "model";
}

export type PactAgentRuntimePhase = "initialized" | PactAgentWorkflowResumePhase;
export type PactAgentRuntimeReconciliationState = Extract<
  PactCashuEscrowOperationalState,
  | "funding_reconciliation_required"
  | "release_reconciliation_required"
  | "refund_reconciliation_required"
>;

export type PactAgentRuntimeOperationalState =
  | "active"
  | "failed"
  | "reconciliation_required"
  | "resolved_not_funded"
  | "refunded"
  | "settled";

export interface PactAgentRuntimeRequesterDecision {
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

export interface PactAgentRuntimeSelectedOffer {
  readonly providerPublicKey: string;
  readonly providerDefinitionReference: string;
  readonly offerReference: string;
  readonly escrowDescriptorReference: string;
  readonly amountSats: string;
  readonly unit: "sat";
}

const RECONCILIATION_STATES: ReadonlySet<string> = new Set([
  "funding_reconciliation_required",
  "release_reconciliation_required",
  "refund_reconciliation_required",
]);

/** Safe, secret-free projection returned by status(). */
export interface PactAgentRuntimeStatus {
  readonly transactionId: string;
  readonly kind: "successful" | "refund";
  readonly phase: PactAgentRuntimePhase;
  readonly operationalState: PactAgentRuntimeOperationalState;
  readonly agreementId: string;
  readonly selectedOffer: PactAgentRuntimeSelectedOffer;
  readonly requesterDecision?: PactAgentRuntimeRequesterDecision;
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
  readonly reconciliationState?: PactAgentRuntimeReconciliationState;
}

export type PactAgentRuntimeReconcileResult = PactAgentWorkflowReport | PactAgentRuntimeStatus;

export interface PactAgentRuntimeStartInput {
  readonly idempotencyKey: string;
  readonly fundingReference: string;
  readonly privateDocument: string;
  readonly mediaType: "text/plain" | "application/pdf";
  readonly privatePrompt?: string;
  readonly maximumBudgetSats: Sats;
}

export interface PactAgentRuntimeStartResult {
  readonly transactionId: string;
  readonly report: PactAgentWorkflowReport;
}

export interface PactAgentRuntimeAcceptedResult {
  readonly transactionId: string;
}

const RECORD_VERSION = 1;
const TRANSACTION_SCOPE = "transaction";
const RESUME_PHASES: ReadonlySet<string> = new Set([
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

interface DurableTransactionRecord {
  readonly version: 1;
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly kind: "successful" | "refund";
  readonly phase: PactAgentRuntimePhase;
  readonly agreementId: string;
  readonly agreementRootEventId?: string;
  readonly agreementCreatedAt: number;
  readonly agreementExpiresAt: number;
  readonly fundingReference: string;
  readonly maximumBudgetSats?: string;
  readonly selectedOffer?: PactAgentRuntimeSelectedOffer;
  readonly requesterDecision?: PactAgentRuntimeRequesterDecision;
  readonly failureCode?: "transaction_failed";
  readonly privateTerms: DocumentSummaryPrivateTerms;
  readonly privateSaltHex: string;
  readonly escrowReference?: string;
  readonly escrowVersion?: number;
  readonly resultReference?: string;
  readonly settlementReference?: string;
  readonly refundReference?: string;
}

function deriveTransactionId(idempotencyKey: string): string {
  return `txn_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

function validateIdempotencyKey(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)) {
    throw new PactAgentRuntimeError("invalid_request", "Idempotency key is invalid");
  }
  return value;
}

function validateFundingReference(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(value)) {
    throw new PactAgentRuntimeError("invalid_request", "Funding reference is invalid");
  }
  return value;
}

function parseSelectedOffer(value: unknown): PactAgentRuntimeSelectedOffer | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new PactAgentRuntimeError("corrupt_record", "Selected offer projection is malformed");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.providerPublicKey !== "string" ||
    typeof candidate.providerDefinitionReference !== "string" ||
    typeof candidate.offerReference !== "string" ||
    typeof candidate.escrowDescriptorReference !== "string" ||
    typeof candidate.amountSats !== "string" ||
    !/^\d+$/.test(candidate.amountSats) ||
    candidate.unit !== "sat"
  ) {
    throw new PactAgentRuntimeError("corrupt_record", "Selected offer projection is malformed");
  }
  return Object.freeze({
    providerPublicKey: candidate.providerPublicKey,
    providerDefinitionReference: candidate.providerDefinitionReference,
    offerReference: candidate.offerReference,
    escrowDescriptorReference: candidate.escrowDescriptorReference,
    amountSats: candidate.amountSats,
    unit: "sat",
  });
}

function parseRequesterDecision(value: unknown): PactAgentRuntimeRequesterDecision | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new PactAgentRuntimeError("corrupt_record", "Requester decision projection is malformed");
  }
  const candidate = value as Record<string, unknown>;
  const recommendation = candidate.recommendation as Record<string, unknown> | undefined;
  const policy = candidate.policy as Record<string, unknown> | undefined;
  if (
    (candidate.source !== "deterministic" && candidate.source !== "model") ||
    candidate.authorized !== true ||
    recommendation?.action !== "recommend" ||
    typeof recommendation.providerPublicKey !== "string" ||
    typeof recommendation.offerReference !== "string" ||
    typeof recommendation.amountSats !== "string" ||
    !/^\d+$/.test(recommendation.amountSats) ||
    policy?.selectedProviderMatchesDiscovery !== true ||
    policy.stableReferencesMatch !== true ||
    policy.withinRequesterBudget !== true ||
    policy.cashuCompatible !== true ||
    policy.priceAllowed !== true ||
    policy.executionDurationAllowed !== true
  ) {
    throw new PactAgentRuntimeError("corrupt_record", "Requester decision projection is malformed");
  }
  return Object.freeze({
    source: candidate.source,
    recommendation: Object.freeze({
      action: "recommend",
      providerPublicKey: recommendation.providerPublicKey,
      offerReference: recommendation.offerReference,
      amountSats: recommendation.amountSats,
    }),
    policy: Object.freeze({
      selectedProviderMatchesDiscovery: true,
      stableReferencesMatch: true,
      withinRequesterBudget: true,
      cashuCompatible: true,
      priceAllowed: true,
      executionDurationAllowed: true,
    }),
    authorized: true,
  });
}

function parseDurableTransactionRecord(value: unknown): DurableTransactionRecord {
  if (typeof value !== "object" || value === null) {
    throw new PactAgentRuntimeError("corrupt_record", "Transaction record is not an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== RECORD_VERSION) {
    throw new PactAgentRuntimeError("corrupt_record", "Transaction record version is unsupported");
  }
  if (
    typeof candidate.transactionId !== "string" ||
    typeof candidate.idempotencyKey !== "string" ||
    (candidate.kind !== "successful" && candidate.kind !== "refund") ||
    typeof candidate.phase !== "string" ||
    !RESUME_PHASES.has(candidate.phase) ||
    typeof candidate.agreementId !== "string" ||
    (candidate.agreementRootEventId !== undefined &&
      (typeof candidate.agreementRootEventId !== "string" ||
        !/^[0-9a-f]{64}$/.test(candidate.agreementRootEventId))) ||
    (candidate.agreementCreatedAt !== undefined && !Number.isSafeInteger(candidate.agreementCreatedAt)) ||
    (candidate.agreementExpiresAt !== undefined && !Number.isSafeInteger(candidate.agreementExpiresAt)) ||
    (candidate.fundingReference !== undefined && typeof candidate.fundingReference !== "string") ||
    (candidate.maximumBudgetSats !== undefined &&
      (typeof candidate.maximumBudgetSats !== "string" || !/^\d+$/.test(candidate.maximumBudgetSats))) ||
    (candidate.failureCode !== undefined && candidate.failureCode !== "transaction_failed") ||
    typeof candidate.privateSaltHex !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.privateSaltHex)
  ) {
    throw new PactAgentRuntimeError("corrupt_record", "Transaction record identity is malformed");
  }
  const privateTerms = parsePrivateTerms(candidate.privateTerms);
  const selectedOffer = parseSelectedOffer(candidate.selectedOffer);
  const requesterDecision = parseRequesterDecision(candidate.requesterDecision);
  return Object.freeze({
    version: 1,
    transactionId: candidate.transactionId,
    idempotencyKey: candidate.idempotencyKey,
    kind: candidate.kind,
    phase: candidate.phase as PactAgentRuntimePhase,
    agreementId: candidate.agreementId,
    ...(candidate.agreementRootEventId === undefined
      ? {}
      : { agreementRootEventId: candidate.agreementRootEventId }),
    agreementCreatedAt: (candidate.agreementCreatedAt as number | undefined) ?? 0,
    agreementExpiresAt: (candidate.agreementExpiresAt as number | undefined) ?? 1,
    fundingReference:
      candidate.fundingReference === undefined
        ? "legacy-configured-funding"
        : validateFundingReference(candidate.fundingReference),
    ...(candidate.maximumBudgetSats === undefined
      ? {}
      : { maximumBudgetSats: candidate.maximumBudgetSats as string }),
    ...(selectedOffer === undefined ? {} : { selectedOffer }),
    ...(requesterDecision === undefined ? {} : { requesterDecision }),
    ...(candidate.failureCode === undefined ? {} : { failureCode: "transaction_failed" as const }),
    privateTerms,
    privateSaltHex: candidate.privateSaltHex,
    ...(candidate.escrowReference === undefined ? {} : { escrowReference: candidate.escrowReference as string }),
    ...(candidate.escrowVersion === undefined ? {} : { escrowVersion: candidate.escrowVersion as number }),
    ...(candidate.resultReference === undefined ? {} : { resultReference: candidate.resultReference as string }),
    ...(candidate.settlementReference === undefined
      ? {}
      : { settlementReference: candidate.settlementReference as string }),
    ...(candidate.refundReference === undefined ? {} : { refundReference: candidate.refundReference as string }),
  });
}

function parsePrivateTerms(value: unknown): DocumentSummaryPrivateTerms {
  if (typeof value !== "object" || value === null) {
    throw new PactAgentRuntimeError("corrupt_record", "Persisted private terms are invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((k) => !["source_document", "input_media_type", "private_prompt"].includes(k))) {
    throw new PactAgentRuntimeError("corrupt_record", "Persisted private terms have unsupported fields");
  }
  if (
    typeof candidate.source_document !== "string" ||
    candidate.source_document.length === 0 ||
    (candidate.input_media_type !== "text/plain" && candidate.input_media_type !== "application/pdf") ||
    (candidate.private_prompt !== undefined && typeof candidate.private_prompt !== "string")
  ) {
    throw new PactAgentRuntimeError("corrupt_record", "Persisted private terms are malformed");
  }
  return Object.freeze({
    source_document: candidate.source_document,
    input_media_type: candidate.input_media_type,
    ...(candidate.private_prompt === undefined ? {} : { private_prompt: candidate.private_prompt as string }),
  });
}

function serializeDurableTransactionRecord(record: DurableTransactionRecord): unknown {
  return {
    version: 1,
    transactionId: record.transactionId,
    idempotencyKey: record.idempotencyKey,
    kind: record.kind,
    phase: record.phase,
    agreementId: record.agreementId,
    ...(record.agreementRootEventId === undefined
      ? {}
      : { agreementRootEventId: record.agreementRootEventId }),
    agreementCreatedAt: record.agreementCreatedAt,
    agreementExpiresAt: record.agreementExpiresAt,
    fundingReference: record.fundingReference,
    ...(record.maximumBudgetSats === undefined ? {} : { maximumBudgetSats: record.maximumBudgetSats }),
    ...(record.selectedOffer === undefined ? {} : { selectedOffer: record.selectedOffer }),
    ...(record.requesterDecision === undefined ? {} : { requesterDecision: record.requesterDecision }),
    ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode }),
    privateTerms: record.privateTerms,
    privateSaltHex: record.privateSaltHex,
    ...(record.escrowReference === undefined ? {} : { escrowReference: record.escrowReference }),
    ...(record.escrowVersion === undefined ? {} : { escrowVersion: record.escrowVersion }),
    ...(record.resultReference === undefined ? {} : { resultReference: record.resultReference }),
    ...(record.settlementReference === undefined ? {} : { settlementReference: record.settlementReference }),
    ...(record.refundReference === undefined ? {} : { refundReference: record.refundReference }),
  };
}

function mapStateToResumePhase(state: PactAgreementState): PactAgentWorkflowResumePhase | undefined {
  switch (state) {
    case "proposed":
    case "accepted":
    case "escrow_funded":
    case "task_delivered":
    case "result_submitted":
    case "result_verified":
    case "release_authorized":
    case "settled":
    case "refund_authorized":
    case "refunded":
      return state;
    default:
      return undefined;
  }
}

function buildDecision(selectedReferences: SelectedProviderReferences): ApprovedRequesterDecision {
  return Object.freeze({
    status: "approved",
    reason: "approved",
    capabilityProfile: DOCUMENT_SUMMARY_PROFILE_ID,
    selection: Object.freeze({ ...selectedReferences }),
    amountSats: "350",
  });
}

function buildSelectedOffer(selectedReferences: SelectedProviderReferences): PactAgentRuntimeSelectedOffer {
  return Object.freeze({
    ...selectedReferences,
    amountSats: "350",
    unit: "sat",
  });
}

function buildRequesterDecisionProjection(
  source: "deterministic" | "model",
  decision: ApprovedRequesterDecision,
): PactAgentRuntimeRequesterDecision {
  return Object.freeze({
    source,
    recommendation: Object.freeze({
      action: "recommend",
      providerPublicKey: decision.selection.providerPublicKey,
      offerReference: decision.selection.offerReference,
      amountSats: decision.amountSats,
    }),
    policy: Object.freeze({
      selectedProviderMatchesDiscovery: true,
      stableReferencesMatch: true,
      withinRequesterBudget: true,
      cashuCompatible: true,
      priceAllowed: true,
      executionDurationAllowed: true,
    }),
    authorized: true,
  });
}

function eventHash(event: UnsignedNostrEvent): string {
  return getEventHash({ ...event, tags: event.tags.map((tag) => [...tag]) });
}

async function reconstructContext(
  root: PactServiceAgreementRoot<SignedNostrEvent>,
  references: PactAgreementReferences,
  identities: PactAgentParticipantIdentities,
  expectedAuthoritySourceReference?: string,
): Promise<PactAgreementContext> {
  const canonicalAuthoritySource = createPactEscrowAuthoritySource({
    root,
    references,
    authority: identities.escrowAuthoritySigner.publicKey,
    createdAt: root.event.created_at + 1,
  });
  let authoritySource = canonicalAuthoritySource;
  if (
    expectedAuthoritySourceReference !== undefined &&
    eventHash(canonicalAuthoritySource.event) !== expectedAuthoritySourceReference
  ) {
    let legacyAuthoritySource: ReturnType<typeof createPactEscrowAuthoritySource> | undefined;
    for (
      let createdAt = root.event.created_at;
      createdAt <= root.content.expires_at;
      createdAt += 1
    ) {
      const candidateEvent = { ...canonicalAuthoritySource.event, created_at: createdAt };
      if (eventHash(candidateEvent) === expectedAuthoritySourceReference) {
        legacyAuthoritySource = createPactEscrowAuthoritySource({
          root,
          references,
          authority: identities.escrowAuthoritySigner.publicKey,
          createdAt,
        });
        break;
      }
    }
    if (!legacyAuthoritySource) {
      throw new PactAgentRuntimeError(
        "corrupt_record",
        "Stored escrow authority source does not match the agreement",
      );
    }
    authoritySource = legacyAuthoritySource;
  }
  const signedSource = await identities.providerSigner.sign(authoritySource.event);
  if (
    expectedAuthoritySourceReference !== undefined &&
    signedSource.id !== expectedAuthoritySourceReference
  ) {
    throw new PactAgentRuntimeError(
      "corrupt_record",
      "Stored escrow authority source signature is invalid",
    );
  }
  const escrowAuthority = createPactEscrowAuthorityBinding({
    root,
    references,
    authority: identities.escrowAuthoritySigner.publicKey,
    source: signedSource,
  });
  return { root, references, escrowAuthority };
}

async function reconstructCompletionDecision(
  context: PactAgreementContext,
  rawEvents: readonly SignedNostrEvent[],
  privateTerms: DocumentSummaryPrivateTerms,
  privateSalt: PactPrivateCommitmentSalt,
  identities: PactAgentParticipantIdentities,
  relay: PactAgentWorkflowDependencies["relay"],
): Promise<PactCompletionDecision> {
  const privateResult = await retrieveAndOpenPrivateResult(
    identities.requesterSigner.publicKey,
    identities.requesterEncrypter,
    {
      agreementId: context.root.content.agreement_id,
      agreementRoot: context.root.event.id,
      authorizedSender: identities.providerSigner.publicKey,
      recipient: identities.requesterSigner.publicKey,
    },
    relay,
  );
  const upToSubmitted = rawEvents.filter((event) => {
    const state = parsePactAgreementTransitionEvent(event, DOCUMENT_SUMMARY_PROFILE_ID).content.state;
    return (
      state === "accepted" ||
      state === "escrow_funded" ||
      state === "task_delivered" ||
      state === "result_submitted"
    );
  });
  return createPactCompletionDecision({
    context,
    history: upToSubmitted,
    privateTerms,
    privateSalt,
    privateResult,
  });
}

function resultReferenceFromHistory(history: PactAgreementHistory): string | undefined {
  const submitted = history.transitions.find((t) => t.content.state === "result_submitted");
  return submitted?.content.result_reference;
}

export class PactAgentRuntime {
  readonly #config: PactAgentRuntimeConfig;
  readonly #decision: ApprovedRequesterDecision;
  readonly #selectedOffer: PactAgentRuntimeSelectedOffer;
  readonly #decisionSource: "deterministic" | "model";
  readonly #executions = new Map<string, Promise<void>>();
  #started = false;

  constructor(config: PactAgentRuntimeConfig) {
    this.#config = config;
    this.#decision = buildDecision(config.selectedReferences);
    this.#selectedOffer = buildSelectedOffer(config.selectedReferences);
    this.#decisionSource = config.requesterDecisionSource ?? "deterministic";
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await this.#config.dependencies.relay.connect();
    this.#started = true;
  }

  async shutdown(): Promise<void> {
    if (!this.#started) return;
    await Promise.allSettled(this.#executions.values());
    this.#started = false;
    await this.#config.dependencies.relay.disconnect();
  }

  #ensureRunning(): void {
    if (!this.#started) {
      throw new PactAgentRuntimeError("not_running", "PactAgent runtime is not running");
    }
  }

  #newWorkflow() {
    return createPactAgentWorkflow({
      identities: this.#config.identities,
      dependencies: this.#config.dependencies,
    });
  }

  async #loadRecord(transactionId: string): Promise<DurableTransactionRecord | undefined> {
    const raw = await this.#config.privateStore.read(TRANSACTION_SCOPE, transactionId);
    if (raw === undefined) return undefined;
    return parseDurableTransactionRecord(raw);
  }

  async #persistRecord(record: DurableTransactionRecord): Promise<void> {
    await this.#config.privateStore.write(
      TRANSACTION_SCOPE,
      record.transactionId,
      serializeDurableTransactionRecord(record),
    );
  }

  async #reconstructAgreementState(
    agreementId: string,
    privateTerms: DocumentSummaryPrivateTerms,
    privateSaltHex: string,
  ): Promise<{
    root: PactServiceAgreementRoot<SignedNostrEvent>;
    context: PactAgreementContext;
    history: PactAgreementHistory;
    phase: PactAgentWorkflowResumePhase;
    completionDecision?: PactCompletionDecision;
  }> {
    const root = await retrievePactServiceAgreementRoot({
      agreementId,
      references: this.#config.references,
      relay: this.#config.dependencies.relay,
    });
    const expectedAuthoritySourceReference = await this.#readEscrowAuthoritySourceReference(
      root.event.id,
    );
    const baseContext = await reconstructContext(
      root,
      this.#config.references,
      this.#config.identities,
      expectedAuthoritySourceReference,
    );

    const rawEvents = await retrievePactAgreementTransitions({
      context: baseContext,
      relay: this.#config.dependencies.relay,
    });
    const needsDecision = rawEvents.some((event) => {
      const state = parsePactAgreementTransitionEvent(
        event,
        DOCUMENT_SUMMARY_PROFILE_ID,
      ).content.state;
      return state === "result_verified" || state === "release_authorized" || state === "settled";
    });

    let context = baseContext;
    let completionDecision: PactCompletionDecision | undefined;
    if (needsDecision) {
      const salt = new PactPrivateCommitmentSalt(Buffer.from(privateSaltHex, "hex"));
      completionDecision = await reconstructCompletionDecision(
        baseContext,
        rawEvents,
        privateTerms,
        salt,
        this.#config.identities,
        this.#config.dependencies.relay,
      );
      context = { ...baseContext, completionDecisions: [completionDecision] };
    }

    const history = await retrieveAndReconstructPactAgreement({
      context,
      relay: this.#config.dependencies.relay,
    });
    const phase = mapStateToResumePhase(history.currentState);
    if (!phase) {
      throw new PactAgentRuntimeError("corrupt_record", "Agreement state is not resumable");
    }
    return { root, context, history, phase, completionDecision };
  }

  async #readEscrowAuthoritySourceReference(rootEventId: string): Promise<string | undefined> {
    const binding = (await this.#config.dependencies.settlementStore.read(
      `agreement-escrow:${rootEventId}`,
    )) as { escrowReference?: unknown } | undefined;
    if (binding === undefined) return undefined;
    if (typeof binding.escrowReference !== "string") {
      throw new PactAgentRuntimeError("corrupt_record", "Agreement escrow binding is malformed");
    }
    const record = (await this.#config.dependencies.settlementStore.read(
      `escrow:${binding.escrowReference}`,
    )) as { escrowAuthoritySource?: unknown } | undefined;
    if (record === undefined) return undefined;
    if (
      typeof record.escrowAuthoritySource !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.escrowAuthoritySource)
    ) {
      throw new PactAgentRuntimeError("corrupt_record", "Escrow authority source is malformed");
    }
    return record.escrowAuthoritySource;
  }

  async #readEscrowReferenceAndVersion(
    rootEventId: string,
  ): Promise<{
    reference: string;
    revision: number;
    reconciliationState?: PactAgentRuntimeReconciliationState;
    operationalState?: string;
    fundingOperationStatus?: string;
  } | undefined> {
    const binding = (await this.#config.dependencies.settlementStore.read(
      `agreement-escrow:${rootEventId}`,
    )) as { escrowReference?: string } | undefined;
    if (!binding?.escrowReference) return undefined;
    const record = (await this.#config.dependencies.settlementStore.read(
      `escrow:${binding.escrowReference}`,
    )) as {
      revision?: number;
      state?: unknown;
      operations?: Record<string, { status?: unknown }>;
    } | undefined;
    if (typeof record?.revision !== "number") return undefined;
    const reconciliationState =
      typeof record.state === "string" && RECONCILIATION_STATES.has(record.state)
        ? (record.state as PactAgentRuntimeReconciliationState)
        : undefined;
    return {
      reference: binding.escrowReference,
      revision: record.revision,
      ...(typeof record.state === "string" ? { operationalState: record.state } : {}),
      ...(typeof record.operations?.["wf-fund-escrow-001"]?.status === "string"
        ? { fundingOperationStatus: record.operations["wf-fund-escrow-001"].status }
        : {}),
      ...(reconciliationState === undefined ? {} : { reconciliationState }),
    };
  }

  async startTransaction(input: PactAgentRuntimeStartInput): Promise<PactAgentRuntimeStartResult> {
    this.#ensureRunning();
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const transactionId = deriveTransactionId(idempotencyKey);
    return this.#config.privateStore.withExclusiveLock(TRANSACTION_SCOPE, transactionId, async () => {
      const existing = await this.#loadRecord(transactionId);
      const record = existing ?? this.#createInitialRecord(transactionId, idempotencyKey, input);
      if (!existing) await this.#persistRecord(record);
      const report = await this.#executeAndPersist(record);
      return { transactionId, report };
    });
  }

  /**
   * Durably accepts one logical transaction and schedules its execution under
   * the long-lived runtime. The returned identity is immediately pollable.
   */
  async acceptTransaction(input: PactAgentRuntimeStartInput): Promise<PactAgentRuntimeAcceptedResult> {
    this.#ensureRunning();
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const transactionId = deriveTransactionId(idempotencyKey);
    const accepted = await this.#config.privateStore.withExclusiveLock(
      TRANSACTION_SCOPE,
      transactionId,
      async () => {
        const existing = await this.#loadRecord(transactionId);
        if (existing) return { record: existing, created: false as const };
        const record = this.#createInitialRecord(transactionId, idempotencyKey, input);
        // The transaction identity is durable before execution can publish or
        // perform any economic work.
        await this.#persistRecord(record);
        return { record, created: true as const };
      },
    );
    if (accepted.created) this.#scheduleExecution(accepted.record);
    return Object.freeze({ transactionId });
  }

  #createInitialRecord(
    transactionId: string,
    idempotencyKey: string,
    input: PactAgentRuntimeStartInput,
  ): DurableTransactionRecord {
    const privateTerms: DocumentSummaryPrivateTerms = {
      source_document: input.privateDocument,
      input_media_type: input.mediaType,
      ...(input.privatePrompt === undefined ? {} : { private_prompt: input.privatePrompt }),
    };
    const saltBytes = randomBytes(32);
    const agreementId = createPactAgreementId();
    const agreementCreatedAt = this.#config.dependencies.clock.now();
    const agreementExpiresAt = agreementCreatedAt + 600;
    return Object.freeze({
      version: 1,
      transactionId,
      idempotencyKey,
      kind: "successful",
      phase: "initialized",
      agreementId,
      agreementCreatedAt,
      agreementExpiresAt,
      fundingReference: validateFundingReference(input.fundingReference),
      maximumBudgetSats: input.maximumBudgetSats.toString(),
      selectedOffer: this.#selectedOffer,
      privateTerms,
      privateSaltHex: Buffer.from(saltBytes).toString("hex"),
    });
  }

  #scheduleExecution(record: DurableTransactionRecord): void {
    if (this.#executions.has(record.transactionId)) return;
    const execution = Promise.resolve()
      .then(async () => {
        try {
          await this.#executeAndPersist(record);
        } catch {
          // The safe durable failure/reconciliation projection is authoritative.
          // API callers observe it through status rather than an unhandled task.
        }
      })
      .finally(() => {
        this.#executions.delete(record.transactionId);
      });
    this.#executions.set(record.transactionId, execution);
  }

  async #executeAndPersist(record: DurableTransactionRecord): Promise<PactAgentWorkflowReport> {
    let workflow: ReturnType<typeof createPactAgentWorkflow> | undefined;
    try {
      let report: PactAgentWorkflowReport;
      if (record.phase === "initialized") {
        try {
          report = await this.#resumeExisting(record);
        } catch (error) {
          if (!(error instanceof PactAgreementPublicationError) || error.code !== "agreement_not_found") {
            throw error;
          }
          workflow = this.#newWorkflow();
          report = await this.#runPreparedTransaction(record, workflow);
        }
      } else {
        report = await this.#resumeExisting(record);
      }
      const latest = (await this.#loadRecord(record.transactionId)) ?? record;
      await this.#persistRecoveredRecord(latest, report);
      return report;
    } catch (error) {
      const latest = (await this.#loadRecord(record.transactionId)) ?? record;
      await this.#persistInterruptedRecord(latest, workflow?.escrowCheckpoint, error);
      throw error;
    }
  }

  async #runPreparedTransaction(
    record: DurableTransactionRecord,
    workflow: ReturnType<typeof createPactAgentWorkflow>,
  ): Promise<PactAgentWorkflowReport> {
    const funding = await this.#config.resolveFunding(record.fundingReference);
    const salt = new PactPrivateCommitmentSalt(Buffer.from(record.privateSaltHex, "hex"));
    const onRequesterDecision = async (decision: ApprovedRequesterDecision): Promise<void> => {
      const current = (await this.#loadRecord(record.transactionId)) ?? record;
      await this.#persistRecord({
        ...current,
        requesterDecision: buildRequesterDecisionProjection(this.#decisionSource, decision),
        failureCode: undefined,
      });
    };
    const onProgress = async (progress: PactAgentWorkflowProgress): Promise<void> => {
      const current = (await this.#loadRecord(record.transactionId)) ?? record;
      await this.#persistRecord({
        ...current,
        phase: progress.phase,
        agreementRootEventId: progress.agreementRootEventId,
        ...(progress.escrowReference === undefined ? {} : { escrowReference: progress.escrowReference }),
        ...(progress.escrowVersion === undefined ? {} : { escrowVersion: progress.escrowVersion }),
        ...(progress.resultReference === undefined ? {} : { resultReference: progress.resultReference }),
        failureCode: undefined,
      });
    };

    return workflow.runSuccessfulTransaction({
      requesterDefinition: this.#config.references.requesterDefinition,
      privateDocument: record.privateTerms.source_document,
      mediaType: record.privateTerms.input_media_type,
      privatePrompt: record.privateTerms.private_prompt,
      maximumBudgetSats: sats(BigInt(record.maximumBudgetSats ?? this.#selectedOffer.amountSats)),
      agreementId: record.agreementId,
      createdAt: record.agreementCreatedAt,
      expiresAt: record.agreementExpiresAt,
      privateSalt: salt,
      funding,
      onRequesterDecision,
      onProgress,
    });
  }

  async #persistInterruptedRecord(
    initialRecord: DurableTransactionRecord,
    escrowCheckpoint: Readonly<{ escrowReference?: string; escrowVersion?: number }> | undefined,
    error?: unknown,
  ): Promise<void> {
    let recoveredRecord = initialRecord;
    try {
      const { root, history, phase } = await this.#reconstructAgreementState(
        initialRecord.agreementId,
        initialRecord.privateTerms,
        initialRecord.privateSaltHex,
      );
      const storedEscrow = await this.#readEscrowReferenceAndVersion(root.event.id);
      const escrowReference = escrowCheckpoint?.escrowReference ?? storedEscrow?.reference;
      const escrowVersion = escrowCheckpoint?.escrowVersion ?? storedEscrow?.revision;
      recoveredRecord = {
        ...initialRecord,
        phase,
        agreementRootEventId: root.event.id,
        ...(escrowReference === undefined || escrowVersion === undefined
          ? {}
          : { escrowReference, escrowVersion }),
        ...(resultReferenceFromHistory(history) === undefined
          ? {}
          : { resultReference: resultReferenceFromHistory(history) }),
      };
    } catch {
      // Keep the pre-effect initialized record. A later resume may reconstruct
      // an eventually visible root, but can never allocate a second agreement.
    }
    await this.#persistRecord({
      ...recoveredRecord,
      ...(error instanceof PactAgentWorkflowError && error.code === "reconciliation_required"
        ? { failureCode: undefined }
        : { failureCode: "transaction_failed" as const }),
    });
  }

  async #persistRecoveredRecord(
    record: DurableTransactionRecord,
    report: PactAgentWorkflowReport,
  ): Promise<void> {
    const escrow = await this.#readEscrowReferenceAndVersion(report.agreementRootEventId);
    await this.#persistRecord({
      ...record,
      failureCode: undefined,
      selectedOffer: record.selectedOffer ?? this.#selectedOffer,
      requesterDecision:
        record.requesterDecision ?? buildRequesterDecisionProjection(this.#decisionSource, this.#decision),
      kind: report.finalOutcome === "refunded" ? "refund" : "successful",
      phase: report.finalOutcome === "refunded" ? "refunded" : "settled",
      agreementRootEventId: report.agreementRootEventId,
      escrowReference: report.escrowReference,
      ...(escrow === undefined ? {} : { escrowVersion: escrow.revision }),
      ...(report.resultReference === undefined ? {} : { resultReference: report.resultReference }),
      ...(report.settlementReference === undefined
        ? {}
        : { settlementReference: report.settlementReference }),
      ...(report.refundReference === undefined ? {} : { refundReference: report.refundReference }),
    });
  }

  async #statusForRecord(record: DurableTransactionRecord): Promise<PactAgentRuntimeStatus> {
    const escrow = record.agreementRootEventId
      ? await this.#readEscrowReferenceAndVersion(record.agreementRootEventId)
      : undefined;
    const executing = this.#executions.has(record.transactionId);
    const reportAvailable = record.phase === "settled" || record.phase === "refunded";
    const resolvedNotFunded =
      record.phase === "accepted" &&
      escrow?.operationalState === "prepared" &&
      escrow.fundingOperationStatus === "failed";
    const operationalState: PactAgentRuntimeOperationalState =
      record.phase === "settled"
        ? "settled"
        : record.phase === "refunded"
          ? "refunded"
          : escrow?.reconciliationState !== undefined
            ? "reconciliation_required"
            : resolvedNotFunded
              ? "resolved_not_funded"
              : record.failureCode === "transaction_failed"
                ? "failed"
                : "active";
    const expired = this.#config.dependencies.clock.now() >= record.agreementExpiresAt;
    const resumable =
      !executing &&
      !reportAvailable &&
      operationalState !== "reconciliation_required" &&
      operationalState !== "resolved_not_funded" &&
      (!expired || escrow !== undefined);
    const requesterDecision =
      record.requesterDecision ??
      (record.phase === "initialized"
        ? undefined
        : buildRequesterDecisionProjection(this.#decisionSource, this.#decision));
    return Object.freeze({
      transactionId: record.transactionId,
      kind: record.kind,
      phase: record.phase,
      operationalState,
      agreementId: record.agreementId,
      selectedOffer: record.selectedOffer ?? this.#selectedOffer,
      ...(requesterDecision === undefined ? {} : { requesterDecision }),
      availableActions: Object.freeze({
        resume: resumable,
        reconcile: !executing && operationalState === "reconciliation_required",
      }),
      resultAvailable: record.resultReference !== undefined,
      reportAvailable,
      ...(operationalState === "failed" ? { failureCode: "transaction_failed" as const } : {}),
      ...(record.agreementRootEventId === undefined
        ? {}
        : { agreementRootEventId: record.agreementRootEventId }),
      ...(record.settlementReference !== undefined ? { settlementReference: record.settlementReference } : {}),
      ...(record.refundReference !== undefined ? { refundReference: record.refundReference } : {}),
      ...(record.resultReference !== undefined ? { resultReference: record.resultReference } : {}),
      ...(record.escrowReference !== undefined ? { escrowReference: record.escrowReference } : {}),
      ...(escrow?.reconciliationState === undefined
        ? {}
        : {
            reconciliationRequired: true as const,
            reconciliationState: escrow.reconciliationState,
          }),
      ...(record.phase === "settled" ? { finalOutcome: "settled" as const } : {}),
      ...(record.phase === "refunded" ? { finalOutcome: "refunded" as const } : {}),
    });
  }

  async status(transactionId: string): Promise<PactAgentRuntimeStatus> {
    this.#ensureRunning();
    const record = await this.#loadRecord(transactionId);
    if (!record) {
      throw new PactAgentRuntimeError("transaction_not_found", "Transaction was not found");
    }
    return this.#statusForRecord(record);
  }

  async resume(transactionId: string): Promise<PactAgentWorkflowReport> {
    this.#ensureRunning();
    if (this.#executions.has(transactionId)) {
      throw new PactAgentRuntimeError("transaction_in_progress", "Transaction execution is already in progress");
    }
    return this.#config.privateStore.withExclusiveLock(TRANSACTION_SCOPE, transactionId, async () => {
      const record = await this.#loadRecord(transactionId);
      if (!record) {
        throw new PactAgentRuntimeError("transaction_not_found", "Transaction was not found");
      }
      return this.#executeAndPersist(record);
    });
  }

  async reconcile(transactionId: string): Promise<PactAgentRuntimeReconcileResult> {
    this.#ensureRunning();
    if (this.#executions.has(transactionId)) {
      throw new PactAgentRuntimeError("transaction_in_progress", "Transaction execution is already in progress");
    }
    return this.#config.privateStore.withExclusiveLock(TRANSACTION_SCOPE, transactionId, async () => {
      const record = await this.#loadRecord(transactionId);
      if (!record) {
        throw new PactAgentRuntimeError("transaction_not_found", "Transaction was not found");
      }
      const before = record.agreementRootEventId
        ? await this.#readEscrowReferenceAndVersion(record.agreementRootEventId)
        : undefined;
      try {
        const report = await this.#resumeExisting(record, true);
        await this.#persistRecoveredRecord(record, report);
        return report;
      } catch (error) {
        if (
          error instanceof PactAgentWorkflowError &&
          error.code === "escrow_failed" &&
          before?.operationalState === "funding_reconciliation_required"
        ) {
          const after = record.agreementRootEventId
            ? await this.#readEscrowReferenceAndVersion(record.agreementRootEventId)
            : undefined;
          if (
            after?.reference === before.reference &&
            after.operationalState === "prepared" &&
            after.fundingOperationStatus === "failed"
          ) {
            return this.#statusForRecord(record);
          }
        }
        throw error;
      }
    });
  }

  /** Safe terminal report; only available once the transaction reached a terminal outcome. */
  async report(transactionId: string): Promise<PactAgentWorkflowReport> {
    this.#ensureRunning();
    const record = await this.#loadRecord(transactionId);
    if (!record) {
      throw new PactAgentRuntimeError("transaction_not_found", "Transaction was not found");
    }
    if (!record.agreementRootEventId) {
      throw new PactAgentRuntimeError("report_not_available", "Report is not available");
    }
    if (record.phase !== "settled" && record.phase !== "refunded") {
      throw new PactAgentRuntimeError("report_not_available", "Report is not available");
    }
    return this.#resumeExisting(record);
  }

  /** Complete private summary, available only to the authorized requester. */
  async privateResult(transactionId: string): Promise<{ summary: string }> {
    this.#ensureRunning();
    const record = await this.#loadRecord(transactionId);
    if (!record) {
      throw new PactAgentRuntimeError("transaction_not_found", "Transaction was not found");
    }
    if (!record.agreementRootEventId) {
      throw new PactAgentRuntimeError("result_not_available", "Private result is not available");
    }
    if (!record.resultReference) {
      throw new PactAgentRuntimeError("result_not_available", "Private result is not available");
    }
    const payload = await retrieveAndOpenPrivateResult(
      this.#config.identities.requesterSigner.publicKey,
      this.#config.identities.requesterEncrypter,
      {
        agreementId: record.agreementId,
        agreementRoot: record.agreementRootEventId,
        authorizedSender: this.#config.identities.providerSigner.publicKey,
        recipient: this.#config.identities.requesterSigner.publicKey,
      },
      this.#config.dependencies.relay,
    );
    return { summary: payload.summary };
  }

  /** Inspects the configured mint and returns safe, secret-free readiness information. */
  async bootstrap(): Promise<Readonly<{ mintUrl: string; unit: "sat"; ready: true }>> {
    this.#ensureRunning();
    const capabilities = await this.#config.dependencies.cashu.inspectCapabilities();
    if (capabilities.unit !== "sat") {
      throw new PactAgentRuntimeError("invalid_configuration", "Configured mint does not use sat");
    }
    return Object.freeze({ mintUrl: capabilities.mintUrl, unit: "sat", ready: true });
  }

  async #resumeExisting(
    record: DurableTransactionRecord,
    reconcileOnly = false,
  ): Promise<PactAgentWorkflowReport> {
    const { root, context, history, phase, completionDecision } = await this.#reconstructAgreementState(
      record.agreementId,
      record.privateTerms,
      record.privateSaltHex,
    );
    const salt = new PactPrivateCommitmentSalt(Buffer.from(record.privateSaltHex, "hex"));

    if (reconcileOnly) {
      const existingEscrow = await this.#readEscrowReferenceAndVersion(root.event.id);
      if (!existingEscrow) {
        throw new PactAgentRuntimeError(
          "invalid_request",
          "No existing economic state is available to reconcile",
        );
      }
    }

    let escrowReference = record.escrowReference;
    let escrowVersion = record.escrowVersion;
    if (
      phase !== "proposed" &&
      phase !== "accepted" &&
      (escrowReference === undefined || escrowVersion === undefined)
    ) {
      const escrow = await this.#readEscrowReferenceAndVersion(root.event.id);
      escrowReference = escrow?.reference;
      escrowVersion = escrow?.revision;
    }

    let resultReference = record.resultReference;
    if (resultReference === undefined) {
      resultReference = resultReferenceFromHistory(history);
    }

    let settlementReference = record.settlementReference;
    if (phase === "settled" && settlementReference === undefined) {
      const escrowRecord = (await this.#config.dependencies.settlementStore.read(
        `escrow:${escrowReference}`,
      )) as { settlementReference?: string } | undefined;
      settlementReference = escrowRecord?.settlementReference;
    }

    const resumeState: PactAgentWorkflowResumeState = {
      kind: record.kind,
      phase,
      privateTerms: record.privateTerms,
      privateSalt: salt,
      context,
      decision: this.#decision,
      funding:
        phase === "proposed" || phase === "accepted"
          ? await this.#config.resolveFunding(record.fundingReference)
          : undefined,
      escrowReference,
      escrowVersion,
      resultReference,
      completionDecision,
      settlementReference,
      refundReference: record.refundReference,
    };

    const workflow = this.#newWorkflow();
    if (record.kind === "refund") {
      return workflow.resumeRefundTransaction(resumeState, { reconcileOnly });
    }
    return workflow.resumeSuccessfulTransaction(resumeState, { reconcileOnly });
  }
}

export function createPactAgentRuntime(config: PactAgentRuntimeConfig): PactAgentRuntime {
  return new PactAgentRuntime(config);
}
