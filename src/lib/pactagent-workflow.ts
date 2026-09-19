import { createHash } from "node:crypto";
import { findForbiddenPublicMaterial } from "../domain/forbidden-material";
import type { NostrPublicKey, SignedNostrEvent } from "../domain/nostr";
import type { Sats } from "../domain/money";
import {
  DOCUMENT_SUMMARY_PROFILE_ID,
  PactPrivateCommitmentSalt,
  createPactAgreementId,
  createPactAgreementTransition,
  createPactCompletionDecision,
  createPactEscrowAuthorityBinding,
  createPactEscrowAuthoritySource,
  createPactResultReference,
  createPactTermsCommitment,
  verifyPactTermsCommitment,
  type DocumentSummaryPrivateResult,
  type DocumentSummaryPrivateTerms,
  type PactAgreementContext,
  type PactAgreementHistory,
  type PactAgreementReferences,
  type PactAgreementState,
  type PactCompletionDecision,
  type PactServiceAgreementRoot,
  type PactTermsCommitment,
} from "../domain/pact-service-agreement";
import { summarizeDocument } from "../domain/document-summary-service";
import type { RequesterPolicy } from "../domain/pact-agents";
import type { NostrRelayAdapter } from "./nostr-relay";
import type { NostrSigner } from "../domain/nostr";
import {
  createPactServiceAgreementRootFromDiscovery,
  retrieveAndReconstructPactAgreement,
  signAndPublishPactAgreementTransition,
  signAndPublishPactServiceAgreementRoot,
} from "./pact-service-agreement-publication";
import { discoverProviders, type DiscoveryResult } from "./provider-discovery";
import {
  runRequesterDecision,
  type ApprovedRequesterDecision,
  type RequesterDecision,
  type RequesterDecisionBounds,
  type RequesterDecisionIntent,
  type RequesterDecisionModel,
} from "./requester-decision";
import {
  publishGiftWrap,
  retrieveAndOpenPrivateResult,
  retrieveAndOpenPrivateTask,
  sealPrivateResult,
  sealPrivateTask,
  type NostrEncrypter,
  type PrivateTaskPayload,
} from "./private-task-transport";
import type { PrivateTaskProvenance } from "../domain/private-task-transport";
import {
  createPactCashuEscrowSettlementCoordinator,
  type PactCashuClock,
  type PactCashuEscrowSettlementStore,
} from "./cashu-escrow-settlement";
import type {
  CashuPrivateValueDeliveryPort,
  CashuTestMintPort,
  PrivateCashuFunding,
  PrivateCashuSpendingKey,
} from "./cashu-test-mint";

/*
 * PactAgent end-to-end application workflow (Issue #16).
 *
 * This module composes the existing boundaries from Issues #4–#15 into the
 * smallest executable transaction sequence required to complete a
 * document-summary@1 service agreement through Nostr, NIP-59 private transport,
 * and Cashu escrow settlement.
 *
 * It does NOT implement a new protocol, lifecycle engine, discovery system,
 * settlement engine, authority model, wallet, or generic orchestration
 * framework. Every capability is consumed from its existing boundary.
 *
 * The workflow is reusable application/runtime composition — it exists outside
 * test/demo code and may be invoked by test harnesses, demonstrations, or a
 * future API surface. It must not expose signer, relay, lifecycle, or Cashu
 * capabilities to the requester model.
 */

export const PACTAGENT_WORKFLOW_VERSION = 1;

export type PactAgentWorkflowErrorCode =
  | "invalid_configuration"
  | "discovery_failed"
  | "decision_rejected"
  | "agreement_publication_failed"
  | "escrow_failed"
  | "private_transport_failed"
  | "execution_failed"
  | "completion_failed"
  | "settlement_failed"
  | "reconstruction_failed"
  | "privacy_boundary_violation"
  | "unexpected_state";

export class PactAgentWorkflowError extends Error {
  readonly code: PactAgentWorkflowErrorCode;

  constructor(code: PactAgentWorkflowErrorCode, message: string) {
    super(message);
    this.name = "PactAgentWorkflowError";
    this.code = code;
  }

  toJSON(): Readonly<{ name: string; code: PactAgentWorkflowErrorCode; message: string }> {
    return Object.freeze({ name: this.name, code: this.code, message: this.message });
  }
}

function workflowError(code: PactAgentWorkflowErrorCode, message: string): never {
  throw new PactAgentWorkflowError(code, message);
}

/** Deterministic clock used by the workflow and settlement coordinator. */
export class DeterministicPactAgentClock implements PactCashuClock {
  #value: number;

  constructor(initial: number) {
    if (!Number.isSafeInteger(initial) || initial < 0) {
      workflowError("invalid_configuration", "Deterministic clock initial value is invalid");
    }
    this.#value = initial;
  }

  now(): number {
    return this.#value;
  }

  advanceTo(value: number): void {
    if (!Number.isSafeInteger(value) || value < this.#value) {
      workflowError("invalid_configuration", "Clock cannot move backwards");
    }
    this.#value = value;
  }

  advance(seconds: number): void {
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
      workflowError("invalid_configuration", "Clock advancement is invalid");
    }
    this.#value += seconds;
  }
}

export interface PactAgentParticipantIdentities {
  readonly requesterSigner: NostrSigner;
  readonly providerSigner: NostrSigner;
  readonly escrowAuthoritySigner: NostrSigner;
  readonly requesterEncrypter: NostrEncrypter;
  readonly providerEncrypter: NostrEncrypter;
}

export interface PactAgentWorkflowDependencies {
  readonly relay: NostrRelayAdapter;
  readonly clock: PactCashuClock;
  readonly requesterPolicy: RequesterPolicy;
  readonly decisionModel: RequesterDecisionModel;
  readonly decisionBounds: RequesterDecisionBounds;
  readonly cashu: CashuTestMintPort;
  readonly privateDelivery: CashuPrivateValueDeliveryPort;
  readonly settlementStore: PactCashuEscrowSettlementStore;
  readonly mintUrl: string;
  readonly normalSpendKey: PrivateCashuSpendingKey;
  readonly refundSpendKey: PrivateCashuSpendingKey;
}

export interface PactAgentWorkflowConfig {
  readonly identities: PactAgentParticipantIdentities;
  readonly dependencies: PactAgentWorkflowDependencies;
}

/** Safe structured report returned by a completed workflow run. */
export interface PactAgentWorkflowReport {
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
    readonly state: PactAgreementState;
    readonly eventId: string;
  }>;
  readonly escrowReference: string;
  readonly resultReference?: string;
  readonly settlementReference?: string;
  readonly refundReference?: string;
  readonly finalOutcome: "settled" | "refunded";
}

interface WorkflowState {
  discovery: DiscoveryResult | undefined;
  decision: ApprovedRequesterDecision | undefined;
  context: PactAgreementContext | undefined;
  references: PactAgreementReferences | undefined;
  privateTerms: DocumentSummaryPrivateTerms | undefined;
  privateSalt: PactPrivateCommitmentSalt | undefined;
  termsCommitment: PactTermsCommitment | undefined;
  escrowReference: string | undefined;
  escrowVersion: number | undefined;
  resultReference: string | undefined;
  completionDecision: PactCompletionDecision | undefined;
  report: PactAgentWorkflowReport | undefined;
}

function assertNoForbiddenMaterial(value: unknown, label: string): void {
  const reason = findForbiddenPublicMaterial(value);
  if (reason !== undefined) {
    workflowError(
      "privacy_boundary_violation",
      `${label} contains forbidden private material`,
    );
  }
}

function preparationIdempotencyKey(agreementRootEventId: string): string {
  const hash = createHash("sha256").update(agreementRootEventId).digest("hex").slice(0, 56);
  return `prep${hash}`;
}

export class PactAgentWorkflow {
  readonly #identities: PactAgentParticipantIdentities;
  readonly #dependencies: PactAgentWorkflowDependencies;
  readonly #state: WorkflowState;

  constructor(config: PactAgentWorkflowConfig) {
    this.#identities = config.identities;
    this.#dependencies = config.dependencies;
    this.#state = {
      discovery: undefined,
      decision: undefined,
      context: undefined,
      references: undefined,
      privateTerms: undefined,
      privateSalt: undefined,
      termsCommitment: undefined,
      escrowReference: undefined,
      escrowVersion: undefined,
      resultReference: undefined,
      completionDecision: undefined,
      report: undefined,
    };
  }

  get requesterPublicKey(): NostrPublicKey {
    return this.#identities.requesterSigner.publicKey;
  }

  get providerPublicKey(): NostrPublicKey {
    return this.#identities.providerSigner.publicKey;
  }

  get escrowAuthorityPublicKey(): NostrPublicKey {
    return this.#identities.escrowAuthoritySigner.publicKey;
  }

  get clock(): PactCashuClock {
    return this.#dependencies.clock;
  }

  #now(): number {
    return this.#dependencies.clock.now();
  }

  #resetState(): void {
    this.#state.discovery = undefined;
    this.#state.decision = undefined;
    this.#state.context = undefined;
    this.#state.references = undefined;
    this.#state.privateTerms = undefined;
    this.#state.privateSalt = undefined;
    this.#state.termsCommitment = undefined;
    this.#state.escrowReference = undefined;
    this.#state.escrowVersion = undefined;
    this.#state.resultReference = undefined;
    this.#state.completionDecision = undefined;
    this.#state.report = undefined;
  }

  async #discoverProviders(): Promise<DiscoveryResult> {
    let discovery: DiscoveryResult;
    try {
      discovery = await discoverProviders({
        requesterPolicy: this.#dependencies.requesterPolicy,
        capability: "document-summary",
        relay: this.#dependencies.relay,
        now: this.#now(),
      });
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("discovery_failed", "Provider discovery failed");
    }
    if (!discovery.selected) {
      workflowError("discovery_failed", "No compatible provider was discovered");
    }
    this.#state.discovery = discovery;
    return discovery;
  }

  async #runRequesterDecision(
    intent: RequesterDecisionIntent,
    discovery: DiscoveryResult,
  ): Promise<ApprovedRequesterDecision> {
    let decision: RequesterDecision;
    try {
      decision = await runRequesterDecision({
        intent,
        requesterPolicy: this.#dependencies.requesterPolicy,
        discovery,
        model: this.#dependencies.decisionModel,
        bounds: this.#dependencies.decisionBounds,
      });
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("decision_rejected", "Requester decision failed");
    }
    if (decision.status !== "approved") {
      workflowError(
        "decision_rejected",
        `Requester decision was rejected: ${decision.reason}`,
      );
    }
    this.#state.decision = decision;
    return decision;
  }

  async #publishProposal(
    requesterDefinition: SignedNostrEvent,
    discovery: DiscoveryResult,
    privateTerms: DocumentSummaryPrivateTerms,
    privateSalt: PactPrivateCommitmentSalt,
    agreementId: string,
    expiresAt: number,
  ): Promise<PactAgreementContext> {
    const termsCommitment = createPactTermsCommitment(
      DOCUMENT_SUMMARY_PROFILE_ID,
      privateTerms,
      privateSalt,
    );
    if (!verifyPactTermsCommitment(termsCommitment, DOCUMENT_SUMMARY_PROFILE_ID, privateTerms, privateSalt)) {
      workflowError("completion_failed", "Terms commitment verification failed before publication");
    }
    this.#state.privateTerms = privateTerms;
    this.#state.privateSalt = privateSalt;
    this.#state.termsCommitment = termsCommitment;

    const draft = createPactServiceAgreementRootFromDiscovery({
      requesterDefinition,
      selection: discovery.selected!,
      agreementId,
      expiresAt,
      termsCommitment,
      createdAt: this.#now(),
    });

    let signedRoot: PactServiceAgreementRoot<SignedNostrEvent>;
    try {
      signedRoot = await signAndPublishPactServiceAgreementRoot({
        root: draft.root,
        references: draft.references,
        signer: this.#identities.requesterSigner,
        relay: this.#dependencies.relay,
      });
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("agreement_publication_failed", "Agreement proposal publication failed");
    }

    const references = draft.references;
    this.#state.references = references;

    const authoritySource = createPactEscrowAuthoritySource({
      root: signedRoot,
      references,
      authority: this.escrowAuthorityPublicKey,
      createdAt: this.#now() + 1,
    });

    let signedSource: SignedNostrEvent;
    try {
      signedSource = await this.#identities.providerSigner.sign(authoritySource.event);
    } catch {
      workflowError("agreement_publication_failed", "Escrow authority source signing failed");
    }

    const escrowAuthority = createPactEscrowAuthorityBinding({
      root: signedRoot,
      references,
      authority: this.escrowAuthorityPublicKey,
      source: signedSource,
    });

    const context: PactAgreementContext = {
      root: signedRoot,
      references,
      escrowAuthority,
    };
    this.#state.context = context;
    return context;
  }

  async #providerAccepts(context: PactAgreementContext, history: SignedNostrEvent[]): Promise<SignedNostrEvent> {
    try {
      const signed = await signAndPublishPactAgreementTransition({
        context,
        history,
        transition: createPactAgreementTransition({
          context,
          history,
          predecessorEventId: null,
          nextState: "accepted",
          actor: this.providerPublicKey,
          actorRole: "provider",
          createdAt: this.#now(),
        }),
        signer: this.#identities.providerSigner,
        relay: this.#dependencies.relay,
      });
      return signed.event;
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("agreement_publication_failed", "Provider acceptance publication failed");
    }
  }

  async #prepareAndFundEscrow(
    context: PactAgreementContext,
    history: SignedNostrEvent[],
    funding: PrivateCashuFunding,
  ): Promise<{ escrowReference: string; version: number }> {
    const coordinator = createPactCashuEscrowSettlementCoordinator({
      mintUrl: this.#dependencies.mintUrl,
      cashu: this.#dependencies.cashu,
      privateDelivery: this.#dependencies.privateDelivery,
      store: this.#dependencies.settlementStore,
      escrowAuthoritySigner: this.#identities.escrowAuthoritySigner,
      normalSpendKey: this.#dependencies.normalSpendKey,
      refundSpendKey: this.#dependencies.refundSpendKey,
      relay: this.#dependencies.relay,
      clock: this.#dependencies.clock,
    });

    let prepared, funded;
    try {
      prepared = await coordinator.prepareEscrow({
        idempotencyKey: preparationIdempotencyKey(context.root.event.id),
        context,
        history,
      });
      funded = await coordinator.fundEscrow({
        idempotencyKey: "wf-fund-escrow-001",
        escrowReference: prepared.escrow.escrowReference,
        expectedVersion: prepared.escrow.version,
        context,
        history,
        funding,
      });
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("escrow_failed", "Escrow prepare or fund failed");
    }

    if (funded.outcome === "reconciliation_required") {
      workflowError("escrow_failed", "Escrow funding requires reconciliation");
    }
    if (funded.outcome !== "confirmed") {
      workflowError("escrow_failed", "Escrow funding was not confirmed");
    }

    this.#state.escrowReference = funded.escrow.escrowReference;
    this.#state.escrowVersion = funded.escrow.version;
    return { escrowReference: funded.escrow.escrowReference, version: funded.escrow.version };
  }

  async #deliverPrivateTask(
    context: PactAgreementContext,
    privateTerms: DocumentSummaryPrivateTerms,
  ): Promise<void> {
    const provenance: PrivateTaskProvenance = {
      agreementId: context.root.content.agreement_id,
      agreementRoot: context.root.event.id,
      authorizedSender: this.requesterPublicKey,
      recipient: this.providerPublicKey,
    };

    const payload = {
      source_document: privateTerms.source_document,
      input_media_type: privateTerms.input_media_type,
      ...(privateTerms.private_prompt !== undefined
        ? { private_prompt: privateTerms.private_prompt }
        : {}),
    };

    let sealed;
    try {
      sealed = await sealPrivateTask(
        payload,
        this.#identities.requesterEncrypter,
        provenance,
        this.#now(),
      );
      await publishGiftWrap(sealed.wrapEvent, this.#dependencies.relay);
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("private_transport_failed", "Private task delivery failed");
    }
  }

  async #providerReceivesAndDeliversTask(
    context: PactAgreementContext,
    history: SignedNostrEvent[],
  ): Promise<PrivateTaskPayload> {
    const provenance: PrivateTaskProvenance = {
      agreementId: context.root.content.agreement_id,
      agreementRoot: context.root.event.id,
      authorizedSender: this.requesterPublicKey,
      recipient: this.providerPublicKey,
    };

    let task: PrivateTaskPayload;
    try {
      task = await retrieveAndOpenPrivateTask(
        this.providerPublicKey,
        this.#identities.providerEncrypter,
        provenance,
        this.#dependencies.relay,
      );
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("private_transport_failed", "Private task retrieval failed");
    }

    try {
      await signAndPublishPactAgreementTransition({
        context,
        history,
        transition: createPactAgreementTransition({
          context,
          history,
          predecessorEventId: history.at(-1)?.id ?? null,
          nextState: "task_delivered",
          actor: this.providerPublicKey,
          actorRole: "provider",
          createdAt: this.#now(),
        }),
        signer: this.#identities.providerSigner,
        relay: this.#dependencies.relay,
      });
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("agreement_publication_failed", "Task delivered transition failed");
    }

    return task!;
  }

  async #providerExecutesAndReturnsResult(
    context: PactAgreementContext,
    history: SignedNostrEvent[],
    task: PrivateTaskPayload,
  ): Promise<string> {
    const outcome = summarizeDocument({
      source_document: task.source_document,
      input_media_type: task.input_media_type,
      ...(task.private_prompt !== undefined
        ? { private_prompt: task.private_prompt }
        : {}),
      agreementRoot: context.root.event.id,
    });

    if (outcome.status !== "completed") {
      workflowError(
        "execution_failed",
        `Document summary execution failed: ${outcome.errorCode}`,
      );
    }

    const privateResult: DocumentSummaryPrivateResult = { summary: outcome.summary };
    const resultReference = createPactResultReference(
      DOCUMENT_SUMMARY_PROFILE_ID,
      context.root.event.id,
      privateResult,
    );
    this.#state.resultReference = resultReference;

    const resultProvenance: PrivateTaskProvenance = {
      agreementId: context.root.content.agreement_id,
      agreementRoot: context.root.event.id,
      authorizedSender: this.providerPublicKey,
      recipient: this.requesterPublicKey,
    };

    try {
      const sealed = await sealPrivateResult(
        privateResult,
        this.#identities.providerEncrypter,
        resultProvenance,
        this.#now(),
      );
      await publishGiftWrap(sealed.wrapEvent, this.#dependencies.relay);
      if (sealed.resultReference !== resultReference) {
        workflowError("completion_failed", "Result reference mismatch between executor and transport");
      }
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("private_transport_failed", "Private result delivery failed");
    }

    try {
      await signAndPublishPactAgreementTransition({
        context,
        history,
        transition: createPactAgreementTransition({
          context,
          history,
          predecessorEventId: history.at(-1)?.id ?? null,
          nextState: "result_submitted",
          actor: this.providerPublicKey,
          actorRole: "provider",
          resultReference,
          createdAt: this.#now(),
        }),
        signer: this.#identities.providerSigner,
        relay: this.#dependencies.relay,
      });
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("agreement_publication_failed", "Result submitted transition failed");
    }

    return resultReference;
  }

  async #requesterVerifiesAndAuthorizesRelease(
    context: PactAgreementContext,
    history: SignedNostrEvent[],
    resultReference: string,
  ): Promise<void> {
    const resultProvenance: PrivateTaskProvenance = {
      agreementId: context.root.content.agreement_id,
      agreementRoot: context.root.event.id,
      authorizedSender: this.providerPublicKey,
      recipient: this.requesterPublicKey,
    };

    let privateResult: DocumentSummaryPrivateResult;
    try {
      privateResult = await retrieveAndOpenPrivateResult(
        this.requesterPublicKey,
        this.#identities.requesterEncrypter,
        resultProvenance,
        this.#dependencies.relay,
      );
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("private_transport_failed", "Private result retrieval failed");
    }

    let completionDecision: PactCompletionDecision;
    try {
      completionDecision = createPactCompletionDecision({
        context,
        history,
        privateTerms: this.#state.privateTerms!,
        privateSalt: this.#state.privateSalt!,
        privateResult,
      });
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("completion_failed", "Completion verification failed");
    }
    this.#state.completionDecision = completionDecision;
    this.#state.context = { ...context, completionDecisions: [completionDecision] };

    const verifiedContext: PactAgreementContext = {
      ...context,
      completionDecisions: [completionDecision],
    };

    try {
      await signAndPublishPactAgreementTransition({
        context: verifiedContext,
        history,
        transition: createPactAgreementTransition({
          context: verifiedContext,
          history,
          predecessorEventId: history.at(-1)?.id ?? null,
          nextState: "result_verified",
          actor: this.requesterPublicKey,
          actorRole: "requester",
          resultReference,
          createdAt: this.#now(),
        }),
        signer: this.#identities.requesterSigner,
        relay: this.#dependencies.relay,
      });
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("agreement_publication_failed", "Result verification transition failed");
    }

    const verifiedHistory = await this.#collectHistoryEvents(verifiedContext);
    try {
      await signAndPublishPactAgreementTransition({
        context: verifiedContext,
        history: verifiedHistory,
        transition: createPactAgreementTransition({
          context: verifiedContext,
          history: verifiedHistory,
          predecessorEventId: verifiedHistory.at(-1)?.id ?? null,
          nextState: "release_authorized",
          actor: this.requesterPublicKey,
          actorRole: "requester",
          createdAt: this.#now(),
        }),
        signer: this.#identities.requesterSigner,
        relay: this.#dependencies.relay,
      });
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("agreement_publication_failed", "Release authorization transition failed");
    }
  }

  async #releaseEscrow(
    context: PactAgreementContext,
    history: SignedNostrEvent[],
    resultReference: string,
    escrowReference: string,
    escrowVersion: number,
  ): Promise<{ settlementReference: string; finalVersion: number }> {
    const coordinator = createPactCashuEscrowSettlementCoordinator({
      mintUrl: this.#dependencies.mintUrl,
      cashu: this.#dependencies.cashu,
      privateDelivery: this.#dependencies.privateDelivery,
      store: this.#dependencies.settlementStore,
      escrowAuthoritySigner: this.#identities.escrowAuthoritySigner,
      normalSpendKey: this.#dependencies.normalSpendKey,
      refundSpendKey: this.#dependencies.refundSpendKey,
      relay: this.#dependencies.relay,
      clock: this.#dependencies.clock,
    });

    let authorized, settled;
    try {
      authorized = await coordinator.submitReleaseAuthorization({
        idempotencyKey: "wf-authorize-release-1",
        escrowReference,
        expectedVersion: escrowVersion,
        context,
        history,
        resultReference,
      });
      settled = await coordinator.releaseEscrow({
        idempotencyKey: "wf-release-escrow-1",
        escrowReference,
        expectedVersion: authorized.escrow.version,
        context,
        history,
      });
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("settlement_failed", "Cashu release failed");
    }

    if (settled.outcome === "reconciliation_required") {
      workflowError("settlement_failed", "Cashu release requires reconciliation");
    }
    if (settled.outcome !== "confirmed") {
      workflowError("settlement_failed", "Cashu release was not confirmed");
    }

    if (!settled.escrow.settlementReference) {
      workflowError("settlement_failed", "Settlement reference is missing");
    }

    return {
      settlementReference: settled.escrow.settlementReference!,
      finalVersion: settled.escrow.version,
    };
  }

  async #reconstructHistory(context: PactAgreementContext): Promise<PactAgreementHistory> {
    try {
      return await retrieveAndReconstructPactAgreement({
        context,
        relay: this.#dependencies.relay,
      });
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("reconstruction_failed", "Agreement reconstruction failed");
    }
  }

  #buildReport(
    context: PactAgreementContext,
    history: PactAgreementHistory,
    settlementReference?: string,
    refundReference?: string,
  ): PactAgentWorkflowReport {
    const report: PactAgentWorkflowReport = {
      workflowVersion: 1,
      agreementId: context.root.content.agreement_id,
      agreementRootEventId: context.root.event.id,
      requesterPublicKey: this.requesterPublicKey,
      providerPublicKey: this.providerPublicKey,
      escrowAuthorityPublicKey: this.escrowAuthorityPublicKey,
      selectedReferences: {
        providerPublicKey: this.#state.decision!.selection.providerPublicKey,
        providerDefinitionReference: this.#state.decision!.selection.providerDefinitionReference,
        offerReference: this.#state.decision!.selection.offerReference,
        escrowDescriptorReference: this.#state.decision!.selection.escrowDescriptorReference,
      },
      amountSats: context.root.content.amount_sats,
      unit: "sat",
      lifecycle: history.transitions.map((t) => ({
        state: t.content.state,
        eventId: t.event.id,
      })),
      escrowReference: this.#state.escrowReference!,
      ...(this.#state.resultReference !== undefined
        ? { resultReference: this.#state.resultReference }
        : {}),
      ...(settlementReference !== undefined ? { settlementReference } : {}),
      ...(refundReference !== undefined ? { refundReference } : {}),
      finalOutcome: refundReference !== undefined ? "refunded" : "settled",
    };
    assertNoForbiddenMaterial(report, "Workflow report");
    this.#state.report = report;
    return report;
  }

  async #collectHistoryEvents(context: PactAgreementContext): Promise<SignedNostrEvent[]> {
    try {
      const history = await retrieveAndReconstructPactAgreement({
        context,
        relay: this.#dependencies.relay,
      });
      return history.transitions.map((t) => t.event);
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("reconstruction_failed", "Agreement history collection failed");
    }
  }

  async runSuccessfulTransaction(input: {
    readonly requesterDefinition: SignedNostrEvent;
    readonly privateDocument: string;
    readonly mediaType: "text/plain" | "application/pdf";
    readonly privatePrompt?: string;
    readonly maximumBudgetSats: Sats;
    readonly agreementId?: string;
    readonly expiresAt?: number;
    readonly funding: PrivateCashuFunding;
  }): Promise<PactAgentWorkflowReport> {
    this.#resetState();
    const privateTerms: DocumentSummaryPrivateTerms = {
      source_document: input.privateDocument,
      input_media_type: input.mediaType,
      ...(input.privatePrompt !== undefined ? { private_prompt: input.privatePrompt } : {}),
    };
    assertNoForbiddenMaterial(privateTerms, "Private terms");

    const intent: RequesterDecisionIntent = {
      capabilityProfile: DOCUMENT_SUMMARY_PROFILE_ID,
      maximumBudgetSats: input.maximumBudgetSats,
      instruction: input.privatePrompt ?? "Summarize document",
    };

    const discovery = await this.#discoverProviders();
    await this.#runRequesterDecision(intent, discovery);

    const privateSalt = new PactPrivateCommitmentSalt();
    const agreementId = input.agreementId ?? createPactAgreementId();
    const expiresAt = input.expiresAt ?? this.#now() + 600;

    const context = await this.#publishProposal(
      input.requesterDefinition,
      discovery,
      privateTerms,
      privateSalt,
      agreementId,
      expiresAt,
    );

    const acceptedEvent = await this.#providerAccepts(context, []);
    const fundingHistory = [acceptedEvent];

    await this.#prepareAndFundEscrow(context, fundingHistory, input.funding);
    const fundedHistory = await this.#collectHistoryEvents(context);

    await this.#deliverPrivateTask(context, privateTerms);
    const task = await this.#providerReceivesAndDeliversTask(context, fundedHistory);

    const taskDeliveredHistory = await this.#collectHistoryEvents(context);
    const resultReference = await this.#providerExecutesAndReturnsResult(
      context,
      taskDeliveredHistory,
      task,
    );

    const resultSubmittedHistory = await this.#collectHistoryEvents(context);
    await this.#requesterVerifiesAndAuthorizesRelease(context, resultSubmittedHistory, resultReference);

    const verifiedContext = this.#state.context!;
    const releaseAuthorizedHistory = await this.#collectHistoryEvents(verifiedContext);
    const { settlementReference } = await this.#releaseEscrow(
      verifiedContext,
      releaseAuthorizedHistory,
      resultReference,
      this.#state.escrowReference!,
      this.#state.escrowVersion!,
    );

    const finalHistory = await this.#reconstructHistory(verifiedContext);
    if (finalHistory.status !== "ok") {
      workflowError("reconstruction_failed", "Agreement history is forked");
    }
    const expectedStates: PactAgreementState[] = [
      "accepted",
      "escrow_funded",
      "task_delivered",
      "result_submitted",
      "result_verified",
      "release_authorized",
      "settled",
    ];
    const actualStates = finalHistory.transitions.map((t) => t.content.state);
    if (actualStates.length !== expectedStates.length || expectedStates.some((s, i) => actualStates[i] !== s)) {
      workflowError(
        "unexpected_state",
        `Lifecycle does not match canonical order: ${actualStates.join(" -> ")}`,
      );
    }

    return this.#buildReport(verifiedContext, finalHistory, settlementReference);
  }

  async runRefundTransaction(input: {
    readonly requesterDefinition: SignedNostrEvent;
    readonly privateDocument: string;
    readonly mediaType: "text/plain" | "application/pdf";
    readonly privatePrompt?: string;
    readonly maximumBudgetSats: Sats;
    readonly agreementId?: string;
    readonly expiresAt?: number;
    readonly funding: PrivateCashuFunding;
  }): Promise<PactAgentWorkflowReport> {
    this.#resetState();
    const privateTerms: DocumentSummaryPrivateTerms = {
      source_document: input.privateDocument,
      input_media_type: input.mediaType,
      ...(input.privatePrompt !== undefined ? { private_prompt: input.privatePrompt } : {}),
    };
    assertNoForbiddenMaterial(privateTerms, "Private terms");

    const intent: RequesterDecisionIntent = {
      capabilityProfile: DOCUMENT_SUMMARY_PROFILE_ID,
      maximumBudgetSats: input.maximumBudgetSats,
      instruction: input.privatePrompt ?? "Summarize document",
    };

    const discovery = await this.#discoverProviders();
    await this.#runRequesterDecision(intent, discovery);

    const privateSalt = new PactPrivateCommitmentSalt();
    const agreementId = input.agreementId ?? createPactAgreementId();
    const expiresAt = input.expiresAt ?? this.#now() + 600;

    const context = await this.#publishProposal(
      input.requesterDefinition,
      discovery,
      privateTerms,
      privateSalt,
      agreementId,
      expiresAt,
    );

    const acceptedEvent = await this.#providerAccepts(context, []);
    const fundingHistory = [acceptedEvent];

    await this.#prepareAndFundEscrow(context, fundingHistory, input.funding);
    await this.#collectHistoryEvents(context);

    const coordinator = createPactCashuEscrowSettlementCoordinator({
      mintUrl: this.#dependencies.mintUrl,
      cashu: this.#dependencies.cashu,
      privateDelivery: this.#dependencies.privateDelivery,
      store: this.#dependencies.settlementStore,
      escrowAuthoritySigner: this.#identities.escrowAuthoritySigner,
      normalSpendKey: this.#dependencies.normalSpendKey,
      refundSpendKey: this.#dependencies.refundSpendKey,
      relay: this.#dependencies.relay,
      clock: this.#dependencies.clock,
    });

    const escrowRecord = await this.#dependencies.settlementStore.read(
      `escrow:${this.#state.escrowReference}`,
    );
    const record = escrowRecord as { locktime?: number } | undefined;
    if (!record?.locktime || !Number.isSafeInteger(record.locktime)) {
      workflowError("escrow_failed", "Escrow locktime is not available for refund demonstration");
    }

    if (this.#dependencies.clock instanceof DeterministicPactAgentClock) {
      const rejectedBeforeLocktime = await this.refundRejectedBeforeLocktime(
        context,
        record.locktime!,
      );
      if (!rejectedBeforeLocktime) {
        workflowError("unexpected_state", "Refund was not rejected before locktime");
      }
      this.#dependencies.clock.advanceTo(record.locktime!);
    }

    const refundAuthorizedHistory = await this.#collectHistoryEvents(context);

    let authorized, refunded;
    try {
      authorized = await coordinator.submitRefundAuthorization({
        idempotencyKey: "wf-authorize-refund-1",
        escrowReference: this.#state.escrowReference!,
        expectedVersion: this.#state.escrowVersion!,
        context,
        history: refundAuthorizedHistory,
        basis: "timeout",
      });
      refunded = await coordinator.refundEscrow({
        idempotencyKey: "wf-refund-escrow-1",
        escrowReference: this.#state.escrowReference!,
        expectedVersion: authorized.escrow.version,
        context,
        history: refundAuthorizedHistory,
      });
    } catch (error) {
      if (error instanceof PactAgentWorkflowError) throw error;
      workflowError("settlement_failed", "Cashu refund failed");
    }

    if (refunded.outcome === "reconciliation_required") {
      workflowError("settlement_failed", "Cashu refund requires reconciliation");
    }
    if (refunded.outcome !== "confirmed") {
      workflowError("settlement_failed", "Cashu refund was not confirmed");
    }

    if (!refunded.escrow.refundReference) {
      workflowError("settlement_failed", "Refund reference is missing");
    }

    const finalHistory = await this.#reconstructHistory(context);
    if (finalHistory.status !== "ok") {
      workflowError("reconstruction_failed", "Agreement history is forked");
    }
    const expectedStates: PactAgreementState[] = [
      "accepted",
      "escrow_funded",
      "refund_authorized",
      "refunded",
    ];
    const actualStates = finalHistory.transitions.map((t) => t.content.state);
    if (actualStates.length !== expectedStates.length || expectedStates.some((s, i) => actualStates[i] !== s)) {
      workflowError(
        "unexpected_state",
        `Refund lifecycle does not match canonical order: ${actualStates.join(" -> ")}`,
      );
    }

    return this.#buildReport(context, finalHistory, undefined, refunded.escrow.refundReference);
  }

  async refundRejectedBeforeLocktime(
    context: PactAgreementContext,
    locktime: number,
  ): Promise<boolean> {
    const history = await this.#collectHistoryEvents(context);
    const coordinator = createPactCashuEscrowSettlementCoordinator({
      mintUrl: this.#dependencies.mintUrl,
      cashu: this.#dependencies.cashu,
      privateDelivery: this.#dependencies.privateDelivery,
      store: this.#dependencies.settlementStore,
      escrowAuthoritySigner: this.#identities.escrowAuthoritySigner,
      normalSpendKey: this.#dependencies.normalSpendKey,
      refundSpendKey: this.#dependencies.refundSpendKey,
      relay: this.#dependencies.relay,
      clock: this.#dependencies.clock,
    });

    try {
      await signAndPublishPactAgreementTransition({
        context,
        history,
        transition: createPactAgreementTransition({
          context,
          history,
          predecessorEventId: history.at(-1)?.id ?? null,
          nextState: "refund_authorized",
          actor: this.requesterPublicKey,
          actorRole: "requester",
          reasonCode: "timeout",
          createdAt: locktime,
        }),
        signer: this.#identities.requesterSigner,
        relay: this.#dependencies.relay,
      });

      const refundAuthorizedHistory = await this.#collectHistoryEvents(context);
      await coordinator.submitRefundAuthorization({
        idempotencyKey: "wf-authorize-refund-rejected",
        escrowReference: this.#state.escrowReference!,
        expectedVersion: this.#state.escrowVersion!,
        context,
        history: refundAuthorizedHistory,
        basis: "timeout",
      });
      return false;
    } catch {
      return true;
    }
  }
}

export function createPactAgentWorkflow(config: PactAgentWorkflowConfig): PactAgentWorkflow {
  return new PactAgentWorkflow(config);
}
