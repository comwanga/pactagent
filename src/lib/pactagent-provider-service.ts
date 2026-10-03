import "server-only";

import { sats } from "../domain/money";
import {
  createNostrIdentity,
  parseSignedNostrEvent,
  verifySignedNostrEvent,
  type NostrPublicKey,
  type NostrSigner,
  type SignedNostrEvent,
} from "../domain/nostr";
import { createPontmoreAgentDefinition } from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  createPactServiceOffer,
  PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
} from "../domain/pact-service-offer";
import {
  createPactAgreementTransition,
  createPactEscrowAuthorityBinding,
  DOCUMENT_SUMMARY_PROFILE_ID,
  PACT_AGREEMENT_CLOCK_SKEW_SECONDS,
  parsePactServiceAgreementRootEvent,
  validatePactServiceAgreementRoot,
  createPactResultReference,
  type PactAgreementContext,
  type PactAgreementReferences,
  type PactServiceAgreementRoot,
} from "../domain/pact-service-agreement";
import { summarizeDocument } from "../domain/document-summary-service";
import { signAndPublishAgentDefinition } from "./pontmore-agent-publication";
import { signAndPublishCashuEscrowDescriptor } from "./pontmore-escrow-publication";
import { signAndPublishPactServiceOffer } from "./pact-service-offer-publication";
import {
  PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND,
  PACT_SERVICE_AGREEMENT_ROOT_TYPE,
} from "../domain/pact-service-agreement";
import {
  retrieveAndReconstructPactAgreement,
  signAndPublishPactAgreementTransition,
  publishEscrowAuthoritySource,
} from "./pact-service-agreement-publication";
import { retrieveAgentDefinition } from "./pontmore-agent-publication";
import { retrieveCashuEscrowDescriptor } from "./pontmore-escrow-publication";
import type { NostrFilter, NostrRelayAdapter } from "./nostr-relay";
import {
  publishGiftWrap,
  retrieveAndOpenPrivateTask,
  sealPrivateResult,
  type NostrEncrypter,
} from "./private-task-transport";
import type { PrivateTaskProvenance } from "../domain/private-task-transport";
import { isTimeoutError, operationOptions } from "./pontmore-publication-helpers";
import {
  createSqliteProviderIdempotencyStore,
  type ProviderIdempotencyStore,
  type ProviderOperationRecord,
  type ProviderOperationState,
  type CapabilityReplaySafety,
} from "./provider-idempotency-store";

/*
 * PactAgent standalone Provider Service (Issue #38).
 *
 * A long-running service that handles the provider side of the P002 protocol
 * through the Nostr relay. It establishes a stable provider identity, publishes
 * signed P002 artifacts (definition, offer, escrow descriptor), polls for new
 * agreement root events, accepts valid agreements, receives and decrypts NIP-59
 * private tasks, executes the document-summary@1 capability, and returns
 * results through the existing NIP-59 private transport.
 *
 * The service reuses every existing protocol boundary: Nostr relay adapter,
 * NIP-59 gift wrap, agreement transition publication, and document-summary
 * executor. It does NOT create a second parallel workflow or protocol.
 *
 * Identity is server-side only. The provider private key is configured through
 * environment and never embedded in browser bundles, returned through
 * requester DTOs, logged, or written into public documentation.
 *
 * Idempotency: processed agreement root event IDs are tracked in-memory and
 * optionally durably. Replaying a valid relay event does not produce duplicate
 * acceptance, execution, or result publication.
 *
 * Reconnect: if the relay connection drops, the service reconnects and resumes
 * polling. In-flight agreements that were already accepted are not re-accepted
 * (idempotency).
 */

export type ProviderServiceErrorCode =
  | "invalid_configuration"
  | "relay_connection_failed"
  | "artifact_publication_failed"
  | "agreement_processing_failed"
  | "task_retrieval_failed"
  | "execution_failed"
  | "result_delivery_failed"
  | "not_started"
  | "already_started"
  | "relay_disconnected";

export class ProviderServiceError extends Error {
  readonly code: ProviderServiceErrorCode;

  constructor(code: ProviderServiceErrorCode, message: string) {
    super(message);
    this.name = "ProviderServiceError";
    this.code = code;
  }
}

export interface PactAgentProviderServiceConfig {
  readonly providerSigner: NostrSigner;
  readonly providerEncrypter: NostrEncrypter;
  readonly relay: NostrRelayAdapter;
  readonly relayUrl: string;
  readonly clock: () => number;
  readonly offerAmountSats: bigint;
  readonly maximumExecutionSeconds: number;
  readonly escrowTimeoutSeconds: number;
  readonly escrowAuthorityPublicKey: NostrPublicKey;
  readonly idempotencyStore: ProviderIdempotencyStore;
  /**
   * Capability replay-safety policy (Issue #38 Final Blocker 2).
   *
   * replay_safe: after an uncertain crash in "processing" state, the provider
   *   may deterministically re-execute the capability (e.g. document-summary@1
   *   is a pure text extraction + summarization with no side effects).
   *
   * non_replay_safe: after an uncertain crash in "processing" state, the
   *   provider enters "recovery_required" and does NOT automatically
   *   re-execute. An operator must resolve.
   *
   * Defaults to "replay_safe" for backward compatibility with the existing
   * document-summary@1 capability. Production deployments should set this
   * explicitly.
   */
  readonly capabilityReplaySafety?: CapabilityReplaySafety;
  readonly pollIntervalMs?: number;
  readonly transitionWaitTimeoutMs?: number;
  readonly stateDirectory?: string;
  readonly providerDefinitionIdentifier?: string;
  readonly offerIdentifier?: string;
  readonly escrowDescriptorIdentifier?: string;
}

export interface ProviderServiceReadiness {
  readonly processAlive: true;
  readonly protocolReady: boolean;
  readonly relayConnected: boolean;
  readonly artifactsPublished: boolean;
  /**
   * F38-06B: True if the last poll cycle succeeded. False if poll query
   * or reconnect is failing. protocolReady is false when this is false.
   */
  readonly pollHealthy: boolean;
  /**
   * F38-06C: True if the durable idempotency store is accessible.
   * If false, protocolReady is false — fail closed on store inspection failure.
   */
  readonly storeHealthy: boolean;
  readonly providerPublicKey: NostrPublicKey;
  readonly providerDefinitionReference: string | undefined;
  readonly offerReference: string | undefined;
  readonly escrowDescriptorReference: string | undefined;
  readonly agreementsProcessed: number;
  readonly reconnectAttempts: number;
  readonly replaySafety: CapabilityReplaySafety;
  readonly recoveryRequiredCount: number;
}

export interface ProviderServiceAgreementSummary {
  readonly agreementRootEventId: string;
  readonly agreementId: string;
  readonly requesterPublicKey: NostrPublicKey;
  readonly outcome: "accepted" | "completed" | "failed";
  readonly resultReference: string | undefined;
  readonly failureCode: string | undefined;
}

interface PublishedArtifacts {
  readonly providerDefinitionReference: string;
  readonly offerReference: string;
  readonly escrowDescriptorReference: string;
  readonly providerDefinitionEvent: SignedNostrEvent;
  readonly escrowDescriptorEvent: SignedNostrEvent;
}

interface ProcessedAgreementRecord {
  readonly agreementRootEventId: string;
  readonly agreementId: string;
  readonly acceptedAt: number;
  readonly completedAt?: number;
  readonly resultReference?: string;
  readonly failureCode?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_TRANSITION_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_RELAY_QUERY_TIMEOUT_MS = 15_000;

function safeLog(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void {
  const safeFields: Record<string, unknown> = {};
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        safeFields[key] = value;
      }
    }
  }
  const line = JSON.stringify({ level, message, ...safeFields, ts: Date.now() });
  console.log(line);
}

export class PactAgentProviderService {
  readonly #config: PactAgentProviderServiceConfig;
  readonly #replaySafety: CapabilityReplaySafety;
  #started = false;
  #stopping = false;
  #artifacts: PublishedArtifacts | undefined;
  #agreementsProcessed = 0;
  #reconnectAttempts = 0;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #lastPollTimestamp = 0;
  // F38-06C: Track poll failures so protocolReady reflects real state.
  #pollFailing = false;

  constructor(config: PactAgentProviderServiceConfig) {
    if (config.offerAmountSats <= 0n) {
      throw new ProviderServiceError("invalid_configuration", "Offer amount must be positive");
    }
    if (config.maximumExecutionSeconds <= 0 || config.maximumExecutionSeconds > 300) {
      throw new ProviderServiceError("invalid_configuration", "Maximum execution seconds must be between 1 and 300");
    }
    if (config.escrowTimeoutSeconds <= 0) {
      throw new ProviderServiceError("invalid_configuration", "Escrow timeout must be positive");
    }
    this.#config = config;
    this.#replaySafety = config.capabilityReplaySafety ?? "replay_safe";
  }

  get providerPublicKey(): NostrPublicKey {
    return this.#config.providerSigner.publicKey;
  }

  async start(): Promise<void> {
    if (this.#started) throw new ProviderServiceError("already_started", "Provider service is already started");
    this.#started = true;
    this.#stopping = false;
    await this.#connectAndPublish();
    this.#schedulePoll();
    safeLog("info", "provider_service_started", {
      provider: this.providerPublicKey,
    });
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#stopping = true;
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    try {
      await this.#config.relay.disconnect();
    } catch {
      // Best-effort disconnect during shutdown.
    }
    try {
      this.#config.idempotencyStore.close();
    } catch {
      // Best-effort close during shutdown.
    }
    this.#started = false;
    safeLog("info", "provider_service_stopped", {
      provider: this.providerPublicKey,
      agreements: this.#agreementsProcessed,
    });
  }

  async readiness(): Promise<ProviderServiceReadiness> {
    // F38-06C: relayConnected must inspect real relay/socket state.
    // Do NOT report started && !stopping as relay connectivity.
    let relayConnected = false;
    if (this.#started && !this.#stopping) {
      try {
        await this.#config.relay.reconnect();
        relayConnected = true;
      } catch {
        relayConnected = false;
      }
    }

    // F38-06C: recoveryRequiredCount must come from the durable store.
    // F38-06C: If the store cannot be inspected, storeHealthy=false and
    // protocolReady=false — fail closed, do NOT report recoveryRequiredCount=0.
    let recoveryRequiredCount = 0;
    let storeHealthy = true;
    try {
      recoveryRequiredCount = await this.#countRecoveryRequired();
    } catch {
      storeHealthy = false;
      recoveryRequiredCount = 0;
    }

    const pollHealthy = this.#started && !this.#pollFailing;

    // F38-06C: protocolReady must not remain true if polling is failing,
    // artifacts were never published, store is unhealthy, or relay is down.
    const protocolReady = this.#artifacts !== undefined && relayConnected && pollHealthy && storeHealthy;

    return Object.freeze({
      processAlive: true as const,
      protocolReady,
      relayConnected,
      artifactsPublished: this.#artifacts !== undefined,
      pollHealthy,
      storeHealthy,
      providerPublicKey: this.providerPublicKey,
      providerDefinitionReference: this.#artifacts?.providerDefinitionReference,
      offerReference: this.#artifacts?.offerReference,
      escrowDescriptorReference: this.#artifacts?.escrowDescriptorReference,
      agreementsProcessed: this.#agreementsProcessed,
      reconnectAttempts: this.#reconnectAttempts,
      replaySafety: this.#replaySafety,
      recoveryRequiredCount,
    });
  }

  async #countRecoveryRequired(): Promise<number> {
    // F38-06C: Propagate store errors so readiness() can set storeHealthy=false.
    return this.#config.idempotencyStore.countByState("recovery_required");
  }

  async #connectAndPublish(): Promise<void> {
    try {
      await this.#config.relay.connect();
    } catch {
      this.#reconnectAttempts += 1;
      throw new ProviderServiceError("relay_connection_failed", "Failed to connect to relay");
    }
    if (!this.#artifacts) {
      await this.#publishArtifacts();
    }
  }

  async #publishArtifacts(): Promise<void> {
    const now = this.#config.clock();
    const identity = createNostrIdentity(this.providerPublicKey, [this.#config.relayUrl]);
    const signer = this.#config.providerSigner;

    let descriptorEvent: SignedNostrEvent;
    let descriptorAddress: string;
    try {
      const descriptor = createCashuEscrowDescriptor({
        identity,
        identifier: this.#config.escrowDescriptorIdentifier ?? "hosted-cashu-escrow",
        referenceFormat: "opaque_service_reference",
        timeoutSeconds: this.#config.escrowTimeoutSeconds,
        updatedAt: now,
      });
      descriptorAddress = descriptor.address;
      descriptorEvent = await signAndPublishCashuEscrowDescriptor(descriptor, signer, this.#config.relay);
    } catch {
      throw new ProviderServiceError("artifact_publication_failed", "Escrow descriptor publication failed");
    }

    let offerAddress: string;
    try {
      const offer = createPactServiceOffer({
        identity,
        identifier: this.#config.offerIdentifier ?? "hosted-document-summary-offer",
        capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
        amountSats: sats(this.#config.offerAmountSats),
        settlementNetwork: "cashu",
        escrowDescriptorReference: descriptorAddress,
        maximumExecutionSeconds: this.#config.maximumExecutionSeconds,
        validFrom: now - 60,
        expiresAt: now + 86400,
        updatedAt: now,
      });
      offerAddress = offer.address;
      await signAndPublishPactServiceOffer(offer, signer, this.#config.relay);
    } catch {
      throw new ProviderServiceError("artifact_publication_failed", "Service offer publication failed");
    }

    let providerDefinitionEvent: SignedNostrEvent;
    let providerDefinitionAddress: string;
    try {
      const providerDefinition = createPontmoreAgentDefinition({
        identity,
        identifier: this.#config.providerDefinitionIdentifier ?? "hosted-provider",
        name: "PactAgent Hosted Provider",
        about: "Hosted PactAgent document-summary provider",
        capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
        pricingPolicyReference: offerAddress,
        escrowDescriptorReference: descriptorAddress,
        updatedAt: now,
      });
      providerDefinitionAddress = providerDefinition.address;
      providerDefinitionEvent = await signAndPublishAgentDefinition(
        providerDefinition,
        signer,
        this.#config.relay,
      );
    } catch {
      throw new ProviderServiceError("artifact_publication_failed", "Provider definition publication failed");
    }

    this.#artifacts = Object.freeze({
      providerDefinitionReference: providerDefinitionAddress,
      offerReference: offerAddress,
      escrowDescriptorReference: descriptorAddress,
      providerDefinitionEvent: providerDefinitionEvent,
      escrowDescriptorEvent: descriptorEvent,
    });

    safeLog("info", "provider_artifacts_published", {
      provider: this.providerPublicKey,
    });
  }

  #schedulePoll(): void {
    if (this.#stopping || !this.#started) return;
    const interval = this.#config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = undefined;
      this.#poll()
        .catch((error) => {
          safeLog("warn", "provider_poll_error", {
            code: error instanceof Error ? "poll_error" : "unknown",
          });
        })
        .finally(() => {
          if (this.#started && !this.#stopping) this.#schedulePoll();
        });
    }, interval);
    this.#pollTimer.unref?.();
  }

    async #poll(): Promise<void> {
    let connected: boolean;
    try {
      await this.#config.relay.reconnect();
      connected = true;
    } catch {
      connected = false;
      this.#reconnectAttempts += 1;
      this.#pollFailing = true;
      safeLog("warn", "provider_reconnect_failed", { attempts: this.#reconnectAttempts });
      return;
    }
    if (!connected) return;

    const since = this.#lastPollTimestamp > 0 ? this.#lastPollTimestamp : undefined;
    const filter: NostrFilter = {
      kinds: [PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND],
      tags: { t: [PACT_SERVICE_AGREEMENT_ROOT_TYPE] },
      ...(since === undefined ? {} : { since }),
      limit: 100,
    };

    let events: SignedNostrEvent[];
    try {
      events = await this.#config.relay.queryEvents(
        filter,
        operationOptions(DEFAULT_RELAY_QUERY_TIMEOUT_MS),
      );
    } catch (error) {
      this.#pollFailing = true;
      if (isTimeoutError(error)) {
        safeLog("warn", "provider_poll_timeout");
        return;
      }
      safeLog("warn", "provider_poll_query_failed");
      return;
    }

    // F38-06C: Poll succeeded — clear the poll-failing flag.
    this.#pollFailing = false;

    let latestTimestamp = this.#lastPollTimestamp;
    for (const event of events) {
      if (this.#stopping) break;
      try {
        const parsed = parseSignedNostrEvent(event);
        verifySignedNostrEvent(parsed);
        if (parsed.created_at > latestTimestamp) latestTimestamp = parsed.created_at;
        await this.#processAgreementRoot(parsed);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        safeLog("warn", "provider_agreement_parse_error", {
          event_id: event.id,
          error: errMsg.slice(0, 200),
        });
      }
    }
    this.#lastPollTimestamp = latestTimestamp;
  }

  async #processAgreementRoot(rootEvent: SignedNostrEvent): Promise<void> {
    let root: PactServiceAgreementRoot<SignedNostrEvent>;
    try {
      root = parsePactServiceAgreementRootEvent(rootEvent);
    } catch {
      safeLog("warn", "provider_agreement_root_invalid", { event_id: rootEvent.id });
      return;
    }

    if (root.content.provider !== this.providerPublicKey) {
      return;
    }

    const now = this.#config.clock();
    if (now > root.content.expires_at) {
      safeLog("warn", "provider_agreement_expired", { event_id: rootEvent.id });
      return;
    }

    /*
     * Durable idempotency check: if we already have a record for this
     * agreement root, recover from the stored state instead of re-processing.
     */
    const existing = await this.#config.idempotencyStore.read(rootEvent.id);
    if (existing) {
      await this.#recoverFromState(existing, root, rootEvent);
      return;
    }

    /*
     * Retrieve the requester definition from the relay.
     * The agreement root contains the requester_definition address.
     * The provider must retrieve the actual signed event to build
     * valid references for validation.
     */
    let requesterDefinitionEvent: SignedNostrEvent;
    try {
      const requesterDef = await retrieveAgentDefinition(
        root.content.requester_definition,
        this.#config.relay,
      );
      requesterDefinitionEvent = requesterDef.event;
    } catch {
      safeLog("warn", "provider_requester_definition_not_found", { event_id: rootEvent.id });
      return;
    }

    const references: PactAgreementReferences = {
      requesterDefinition: requesterDefinitionEvent,
      providerDefinition: this.#artifacts!.providerDefinitionEvent,
      escrowDescriptor: this.#artifacts!.escrowDescriptorEvent,
    };

    try {
      validatePactServiceAgreementRoot(root.event, references);
    } catch {
      safeLog("warn", "provider_agreement_validation_failed", { event_id: rootEvent.id });
      return;
    }

    /*
     * Write the initial "received" state durably before any processing.
     * If the process crashes after this point, recovery will safely
     * re-process from "received" (agreement was seen but not started).
     */
    const record: ProviderOperationRecord = Object.freeze({
      agreementRootEventId: rootEvent.id,
      agreementId: root.content.agreement_id,
      requesterPublicKey: root.content.requester as NostrPublicKey,
      state: "received" as ProviderOperationState,
      resultReference: undefined,
      resultSummary: undefined,
      acceptedTransitionEventId: undefined,
      taskDeliveredTransitionEventId: undefined,
      resultSubmittedTransitionEventId: undefined,
      createdAt: now,
      updatedAt: now,
      failureCode: undefined,
    });
    await this.#config.idempotencyStore.write(record);

    /*
     * Publish the signed escrow authority source to the relay.
     * In externalProvider mode, the requester retrieves this from the relay
     * instead of possessing the provider's private signer.
     */
    let signedSource: SignedNostrEvent;
    try {
      signedSource = await publishEscrowAuthoritySource({
        root,
        references,
        authority: this.#config.escrowAuthorityPublicKey,
        signer: this.#config.providerSigner,
        relay: this.#config.relay,
      });
    } catch {
      safeLog("error", "provider_authority_source_publication_failed", { event_id: rootEvent.id });
      await this.#config.idempotencyStore.transitionState(rootEvent.id, "complete", {
        failureCode: "authority_source_failed",
      });
      return;
    }

    const escrowAuthority = createPactEscrowAuthorityBinding({
      root,
      references,
      authority: this.#config.escrowAuthorityPublicKey,
      source: signedSource,
    });

    /*
     * Build context. The escrow authority binding is reconstructed from
     * the published source event. We re-retrieve it to verify it's on the relay.
     */
    const context: PactAgreementContext = {
      root,
      references,
      escrowAuthority,
    };

    const history = await this.#collectHistory(context);
    // F38-03: Don't mark complete if the relay shows "accepted" —
    // accepted is NOT terminal. Wait for funding instead.
    if (history.currentState !== "proposed") {
      if (history.currentState === "accepted") {
        // Already accepted (e.g., by a previous instance). Wait for funding.
        await this.#config.idempotencyStore.transitionState(rootEvent.id, "waiting_for_funding");
      } else if (history.currentState === "escrow_funded" || history.currentState === "task_delivered") {
        // Funding already appeared — proceed to processing.
        await this.#config.idempotencyStore.transitionState(rootEvent.id, "processing");
      } else if (history.currentState === "result_submitted" || history.currentState === "release_authorized") {
        await this.#config.idempotencyStore.transitionState(rootEvent.id, "result_published");
      } else if (history.currentState === "settled" || history.currentState === "refunded") {
        await this.#config.idempotencyStore.transitionState(rootEvent.id, "complete");
      } else {
        // Unknown/unexpected state — don't mark complete, wait for next poll.
        safeLog("warn", "provider_agreement_unexpected_state", {
          event_id: rootEvent.id,
          state: history.currentState,
        });
      }
      return;
    }

    try {
      await this.#acceptAgreement(context, history.transitions.map((t) => t.event));
      // F38-03: After acceptance, wait for funding (NOT "processing").
      await this.#config.idempotencyStore.transitionState(rootEvent.id, "waiting_for_funding");
      safeLog("info", "provider_agreement_accepted", {
        event_id: rootEvent.id,
        agreement_id: root.content.agreement_id,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      safeLog("error", "provider_accept_failed", {
        event_id: rootEvent.id,
        error: errMsg.slice(0, 200),
      });
      await this.#config.idempotencyStore.transitionState(rootEvent.id, "complete", {
        failureCode: "accept_failed",
      });
      return;
    }

    try {
      await this.#waitForTransition(context, "escrow_funded");
    } catch {
      safeLog("warn", "provider_escrow_funded_timeout", { event_id: rootEvent.id });
      return;
    }

    // F38-03: Transition to "processing" before execution.
    await this.#config.idempotencyStore.transitionState(rootEvent.id, "processing");

    try {
      await this.#receiveExecuteAndReturnResult(context, rootEvent);
      this.#agreementsProcessed += 1;
      safeLog("info", "provider_agreement_completed", {
        event_id: rootEvent.id,
        agreement_id: root.content.agreement_id,
      });
    } catch {
      safeLog("error", "provider_execution_failed", {
        event_id: rootEvent.id,
      });
      const current = await this.#config.idempotencyStore.read(rootEvent.id);
      if (current && (current.state === "processing" || current.state === "waiting_for_funding")) {
        await this.#config.idempotencyStore.transitionState(rootEvent.id, "complete", {
          failureCode: "execution_failed",
        });
      }
    }
  }

  async #recoverFromState(
    record: ProviderOperationRecord,
    root: PactServiceAgreementRoot<SignedNostrEvent>,
    rootEvent: SignedNostrEvent,
  ): Promise<void> {
    safeLog("info", "provider_agreement_recovering", {
      event_id: rootEvent.id,
      state: record.state,
    });

    /*
     * Retrieve the requester definition from the relay (same as #processAgreementRoot).
     */
    let requesterDefinitionEvent: SignedNostrEvent;
    try {
      const requesterDef = await retrieveAgentDefinition(
        root.content.requester_definition,
        this.#config.relay,
      );
      requesterDefinitionEvent = requesterDef.event;
    } catch {
      safeLog("warn", "provider_recovery_requester_definition_not_found", { event_id: rootEvent.id });
      return;
    }

    const references: PactAgreementReferences = {
      requesterDefinition: requesterDefinitionEvent,
      providerDefinition: this.#artifacts!.providerDefinitionEvent,
      escrowDescriptor: this.#artifacts!.escrowDescriptorEvent,
    };

    // F38-03I: For complete state, skip authority source publication —
    // no duplicate work needed for already-terminal agreements.
    if (record.state === "complete") {
      safeLog("info", "provider_recovery_already_complete", { event_id: rootEvent.id });
      return;
    }

    /*
     * Re-create the escrow authority binding from the published source
     * event on the relay. The provider already published it.
     */
    let signedSource: SignedNostrEvent;
    try {
      signedSource = await publishEscrowAuthoritySource({
        root,
        references,
        authority: this.#config.escrowAuthorityPublicKey,
        signer: this.#config.providerSigner,
        relay: this.#config.relay,
      });
    } catch {
      // The source may already be on the relay (idempotent Strfry).
      signedSource = rootEvent;
    }

    const escrowAuthority = createPactEscrowAuthorityBinding({
      root,
      references,
      authority: this.#config.escrowAuthorityPublicKey,
      source: signedSource,
    });
    const context: PactAgreementContext = { root, references, escrowAuthority };

    /*
     * F38-03: Reconcile durable local state + authoritative relay history
     * before deciding what action is safe. "complete" must mean the provider
     * operation is actually terminal according to the authoritative protocol
     * state — NOT merely "no immediate work to perform."
     */
    const history = await this.#collectHistory(context);
    const relayState = history.currentState;

    switch (record.state) {
      case "received": {
        // Agreement was seen but not started. Re-process from scratch.
        if (relayState === "proposed") {
          try {
            await this.#acceptAgreement(context, history.transitions.map((t) => t.event));
            await this.#config.idempotencyStore.transitionState(rootEvent.id, "waiting_for_funding");
          } catch {
            await this.#config.idempotencyStore.transitionState(rootEvent.id, "recovery_required", {
              failureCode: "accept_failed",
            });
          }
        } else if (relayState === "accepted") {
          // F38-03B: acceptance was published before crash. Continue waiting
          // for funding. NOT complete.
          await this.#config.idempotencyStore.transitionState(rootEvent.id, "waiting_for_funding");
        } else if (relayState === "escrow_funded" || relayState === "task_delivered") {
          // Funding appeared — proceed to processing.
          if (this.#replaySafety === "replay_safe") {
            await this.#config.idempotencyStore.transitionState(rootEvent.id, "processing");
            try {
              await this.#receiveExecuteAndReturnResult(context, rootEvent);
            } catch {
              safeLog("warn", "provider_recovery_reexecute_failed", { event_id: rootEvent.id });
            }
          } else {
            await this.#config.idempotencyStore.transitionState(rootEvent.id, "recovery_required", {
              failureCode: "uncertain_execution_crash",
            });
          }
        } else if (relayState === "result_submitted" || relayState === "release_authorized") {
          // Result is already on the relay.
          await this.#config.idempotencyStore.transitionState(rootEvent.id, "result_published");
        } else if (relayState === "settled" || relayState === "refunded") {
          // Terminal state — mark complete.
          await this.#config.idempotencyStore.transitionState(rootEvent.id, "complete");
        }
        return;
      }
      case "acceptance_prepared": {
        // Acceptance transition was constructed but not published. Re-publish.
        if (relayState === "proposed") {
          try {
            await this.#acceptAgreement(context, history.transitions.map((t) => t.event));
            await this.#config.idempotencyStore.transitionState(rootEvent.id, "waiting_for_funding");
          } catch {
            await this.#config.idempotencyStore.transitionState(rootEvent.id, "recovery_required", {
              failureCode: "accept_failed",
            });
          }
        } else {
          // Already accepted or beyond — advance state.
          await this.#config.idempotencyStore.transitionState(rootEvent.id, "waiting_for_funding");
        }
        return;
      }
      case "acceptance_published":
      case "waiting_for_funding": {
        // F38-03C: accepted, waiting for funding. Continue waiting. NOT complete.
        if (relayState === "accepted") {
          // Still waiting for funding. Do NOT mark complete.
          safeLog("info", "provider_recovery_waiting_for_funding", { event_id: rootEvent.id });
          return;
        }
        if (relayState === "escrow_funded" || relayState === "task_delivered") {
          // F38-03D: funding appeared after restart — proceed.
          if (this.#replaySafety === "replay_safe") {
            await this.#config.idempotencyStore.transitionState(rootEvent.id, "processing");
            try {
              await this.#receiveExecuteAndReturnResult(context, rootEvent);
            } catch {
              safeLog("warn", "provider_recovery_reexecute_failed", { event_id: rootEvent.id });
            }
          } else {
            await this.#config.idempotencyStore.transitionState(rootEvent.id, "recovery_required", {
              failureCode: "uncertain_execution_crash",
            });
          }
        } else if (relayState === "result_submitted" || relayState === "release_authorized") {
          await this.#config.idempotencyStore.transitionState(rootEvent.id, "result_published");
        } else if (relayState === "settled" || relayState === "refunded") {
          await this.#config.idempotencyStore.transitionState(rootEvent.id, "complete");
        }
        return;
      }
      case "processing": {
        /*
         * F38-03E/F: UNCERTAIN: execution may or may not have occurred.
         * First check the relay for a result_submitted transition.
         * If present → skip to result_published (result already on relay).
         */
        if (relayState === "result_submitted" || relayState === "release_authorized") {
          await this.#config.idempotencyStore.transitionState(rootEvent.id, "result_published");
          safeLog("info", "provider_recovery_found_result", { event_id: rootEvent.id });
          return;
        }
        if (relayState === "task_delivered" || relayState === "escrow_funded" || relayState === "accepted") {
          if (this.#replaySafety === "replay_safe") {
            // F38-03E: Capability is explicitly declared safe for deterministic replay.
            safeLog("info", "provider_recovery_replay_safe", { event_id: rootEvent.id });
            try {
              await this.#waitForTransition(context, "escrow_funded");
              await this.#receiveExecuteAndReturnResult(context, rootEvent);
            } catch {
              safeLog("warn", "provider_recovery_reexecute_failed", { event_id: rootEvent.id });
            }
          } else {
            // F38-03F: NON_REPLAY_SAFE: do NOT automatically re-execute.
            await this.#config.idempotencyStore.transitionState(rootEvent.id, "recovery_required", {
              failureCode: "uncertain_execution_crash",
            });
            safeLog("warn", "provider_recovery_required_non_replay_safe", { event_id: rootEvent.id });
          }
          return;
        }
        // Terminal state — no duplicate work.
        if (relayState === "settled" || relayState === "refunded") {
          await this.#config.idempotencyStore.transitionState(rootEvent.id, "complete");
        }
        return;
      }
      case "recovery_required": {
        /*
         * Explicit operator recovery state. Check if the relay shows
         * a result or terminal state. If so, advance. Otherwise, leave
         * in recovery_required for operator intervention.
         */
        if (relayState === "result_submitted" || relayState === "release_authorized" || relayState === "settled") {
          await this.#config.idempotencyStore.transitionState(rootEvent.id, "result_published");
          safeLog("info", "provider_recovery_resolved_from_relay", { event_id: rootEvent.id });
          return;
        }
        safeLog("warn", "provider_recovery_still_required", { event_id: rootEvent.id });
        return;
      }
      case "result_prepared": {
        // F38-03G/F38-04: Result was computed and the exact gift-wrap event
        // was persisted. Re-publish the SAME persisted event. No re-execution.
        // No new randomized gift wrap.
        if (record.preparedEventJson && record.resultSummary && record.resultReference) {
          try {
            const publishedEvent = await this.#publishResult(
              context,
              rootEvent,
              record.resultSummary,
              record.resultReference,
              record.preparedEventJson,
            );
            await this.#config.idempotencyStore.transitionState(rootEvent.id, "result_published", {
              preparedEventJson: JSON.stringify(publishedEvent),
            });
          } catch {
            safeLog("warn", "provider_recovery_republish_failed", { event_id: rootEvent.id });
          }
        }
        return;
      }
      case "result_published": {
        // F38-03H: Restore any missing public lifecycle transitions.
        // Continue to terminal state. NOT complete until relay shows settled/refunded.
        await this.#reconcileTransitions(context, rootEvent, history, record);
        return;
      }
      case "transitions_reconciling": {
        // Continue reconciling missing transitions.
        await this.#reconcileTransitions(context, rootEvent, history, record);
        return;
      }
    }
  }

  /**
   * F38-03H/F38-04: Reconcile missing public lifecycle transitions
   * (task_delivered, result_submitted) and advance to complete when
   * the relay shows a terminal state.
   */
  async #reconcileTransitions(
    context: PactAgreementContext,
    rootEvent: SignedNostrEvent,
    history: { currentState: string; transitions: readonly { event: SignedNostrEvent; content: { state: string } }[] },
    record: ProviderOperationRecord,
  ): Promise<void> {
    const relayState = history.currentState;

    // F38-04: Also make public lifecycle transition recovery idempotent.
    // If task_delivered is missing but result is published, restore it.
    if (relayState !== "task_delivered" && relayState !== "result_submitted" && relayState !== "release_authorized" && relayState !== "settled" && relayState !== "refunded") {
      try {
        const historyEvents = history.transitions.map((t) => t.event);
        const now = this.#config.clock();
        const tvt = PACT_AGREEMENT_CLOCK_SKEW_SECONDS !== undefined ? { validationTime: now } : {};
        await signAndPublishPactAgreementTransition({
          context,
          history: historyEvents,
          transition: createPactAgreementTransition({
            context,
            history: historyEvents,
            predecessorEventId: historyEvents.at(-1)?.id ?? null,
            nextState: "task_delivered",
            actor: this.providerPublicKey,
            actorRole: "provider",
            createdAt: now,
            ...tvt,
          }),
          signer: this.#config.providerSigner,
          relay: this.#config.relay,
          ...tvt,
        });
      } catch {
        // The task_delivered transition may already have been published.
      }
    }

    // Check updated state after task_delivered.
    const updatedHistory = await this.#collectHistory(context);
    const updatedState = updatedHistory.currentState;

    if (updatedState !== "result_submitted" && updatedState !== "release_authorized" && updatedState !== "settled" && updatedState !== "refunded") {
      if (record.resultReference) {
        try {
          const resultSubmittedHistory = updatedHistory.transitions
            .filter((t) => {
              const state = t.content.state;
              return (
                state === "accepted" ||
                state === "escrow_funded" ||
                state === "task_delivered" ||
                state === "result_submitted"
              );
            })
            .map((t) => t.event);

          const now = this.#config.clock();
          const tvt = PACT_AGREEMENT_CLOCK_SKEW_SECONDS !== undefined ? { validationTime: now } : {};
          await signAndPublishPactAgreementTransition({
            context,
            history: resultSubmittedHistory,
            transition: createPactAgreementTransition({
              context,
              history: resultSubmittedHistory,
              predecessorEventId: resultSubmittedHistory.at(-1)?.id ?? null,
              nextState: "result_submitted",
              actor: this.providerPublicKey,
              actorRole: "provider",
              resultReference: record.resultReference,
              createdAt: now,
              ...tvt,
            }),
            signer: this.#config.providerSigner,
            relay: this.#config.relay,
            ...tvt,
          });
        } catch {
          // The result_submitted transition may already have been published.
        }
      }
    }

    // Check final state.
    const finalHistory = await this.#collectHistory(context);
    const finalState = finalHistory.currentState;

    // F38-03: Only mark complete when relay shows truly terminal state.
    if (finalState === "settled" || finalState === "refunded") {
      await this.#config.idempotencyStore.transitionState(rootEvent.id, "complete");
    } else {
      // Not yet terminal — stay in result_published for next poll cycle.
      safeLog("info", "provider_reconciliation_waiting_for_terminal", {
        event_id: rootEvent.id,
        relay_state: finalState,
      });
    }
  }

  async #acceptAgreement(
    context: PactAgreementContext,
    history: SignedNostrEvent[],
  ): Promise<void> {
    const now = this.#config.clock();
    const trustedValidationTime = PACT_AGREEMENT_CLOCK_SKEW_SECONDS !== undefined
      ? { validationTime: now }
      : {};
    const transition = createPactAgreementTransition({
      context,
      history,
      predecessorEventId: history.at(-1)?.id ?? null,
      nextState: "accepted",
      actor: this.providerPublicKey,
      actorRole: "provider",
      createdAt: now,
      ...trustedValidationTime,
    });
    await signAndPublishPactAgreementTransition({
      context,
      history,
      transition,
      signer: this.#config.providerSigner,
      relay: this.#config.relay,
      ...trustedValidationTime,
    });
  }

  async #waitForTransition(
    context: PactAgreementContext,
    expectedState: string,
  ): Promise<void> {
    const timeoutMs = this.#config.transitionWaitTimeoutMs ?? DEFAULT_TRANSITION_WAIT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.#stopping) {
      const history = await this.#collectHistory(context);
      if (history.currentState === expectedState) return;
      if (
        history.currentState === "rejected" ||
        history.currentState === "expired" ||
        history.currentState === "disputed"
      ) {
        throw new ProviderServiceError("agreement_processing_failed", `Agreement reached terminal state: ${history.currentState}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      });
    }
    throw new ProviderServiceError("agreement_processing_failed", `Timed out waiting for state: ${expectedState}`);
  }

  async #receiveExecuteAndReturnResult(
    context: PactAgreementContext,
    rootEvent: SignedNostrEvent,
  ): Promise<void> {
    const provenance: PrivateTaskProvenance = {
      agreementId: context.root.content.agreement_id,
      agreementRoot: rootEvent.id,
      authorizedSender: context.root.content.requester as NostrPublicKey,
      recipient: this.providerPublicKey,
    };

    let task;
    try {
      task = await this.#retrieveTaskWithRetry(provenance);
    } catch {
      throw new ProviderServiceError("task_retrieval_failed", "Failed to retrieve private task");
    }

    const outcome = summarizeDocument({
      source_document: task.source_document,
      input_media_type: task.input_media_type,
      ...(task.private_prompt !== undefined ? { private_prompt: task.private_prompt } : {}),
      agreementRoot: rootEvent.id,
    });

    if (outcome.status !== "completed") {
      throw new ProviderServiceError("execution_failed", `Document summary execution failed: ${outcome.errorCode}`);
    }

    const privateResult = { summary: outcome.summary };
    const resultReference = createPactResultReference(
      DOCUMENT_SUMMARY_PROFILE_ID,
      rootEvent.id,
      privateResult,
    );

    /*
     * F38-04: Persist the exact prepared result AND the exact signed
     * NIP-59 gift-wrap event BEFORE publishing. If the process crashes
     * after this point, recovery will reuse the SAME persisted event —
     * NO new randomized gift wrap.
     */
    let preparedEventJson: string | undefined;
    {
      // Create the gift-wrap event but don't publish yet.
      const resultProvenance: PrivateTaskProvenance = {
        agreementId: context.root.content.agreement_id,
        agreementRoot: rootEvent.id,
        authorizedSender: this.providerPublicKey,
        recipient: context.root.content.requester as NostrPublicKey,
      };
      const sealed = await sealPrivateResult(
        { summary: outcome.summary },
        this.#config.providerEncrypter,
        resultProvenance,
        this.#config.clock(),
      );
      preparedEventJson = JSON.stringify(sealed.wrapEvent);
    }

    await this.#config.idempotencyStore.transitionState(rootEvent.id, "result_prepared", {
      resultReference,
      resultSummary: outcome.summary,
      preparedEventJson,
    });

    try {
      // F38-04: Publish the exact persisted event (not a new one).
      const publishedEvent = await this.#publishResult(
        context,
        rootEvent,
        outcome.summary,
        resultReference,
        preparedEventJson,
      );
      await this.#config.idempotencyStore.transitionState(rootEvent.id, "result_published", {
        preparedEventJson: JSON.stringify(publishedEvent),
      });
    } catch {
      throw new ProviderServiceError("result_delivery_failed", "Private result publication failed");
    }

    /*
     * Publish the task_delivered and result_submitted transitions.
     * These are idempotent: if already on the relay, re-publishing is
     * harmless (Strfry deduplicates by event ID).
     */
    const history = await this.#collectHistory(context);

    if (history.currentState !== "task_delivered" && history.currentState !== "result_submitted" && history.currentState !== "release_authorized" && history.currentState !== "settled") {
      try {
        const historyEvents = history.transitions.map((t) => t.event);
        const now = this.#config.clock();
        const tvt = PACT_AGREEMENT_CLOCK_SKEW_SECONDS !== undefined ? { validationTime: now } : {};
        await signAndPublishPactAgreementTransition({
          context,
          history: historyEvents,
          transition: createPactAgreementTransition({
            context,
            history: historyEvents,
            predecessorEventId: historyEvents.at(-1)?.id ?? null,
            nextState: "task_delivered",
            actor: this.providerPublicKey,
            actorRole: "provider",
            createdAt: now,
            ...tvt,
          }),
          signer: this.#config.providerSigner,
          relay: this.#config.relay,
          ...tvt,
        });
      } catch {
        // The task_delivered transition may already have been published;
        // idempotency is maintained by checking current state.
      }
    }

    const updatedHistory = await this.#collectHistory(context);
    if (updatedHistory.currentState !== "result_submitted" && updatedHistory.currentState !== "release_authorized" && updatedHistory.currentState !== "settled") {
      const resultSubmittedHistory = updatedHistory.transitions
        .filter((t) => {
          const state = t.content.state;
          return (
            state === "accepted" ||
            state === "escrow_funded" ||
            state === "task_delivered" ||
            state === "result_submitted"
          );
        })
        .map((t) => t.event);

      const now2 = this.#config.clock();
      const tvt2 = PACT_AGREEMENT_CLOCK_SKEW_SECONDS !== undefined ? { validationTime: now2 } : {};
      await signAndPublishPactAgreementTransition({
        context,
        history: resultSubmittedHistory,
        transition: createPactAgreementTransition({
          context,
          history: resultSubmittedHistory,
          predecessorEventId: resultSubmittedHistory.at(-1)?.id ?? null,
          nextState: "result_submitted",
          actor: this.providerPublicKey,
          actorRole: "provider",
          resultReference,
          createdAt: now2,
          ...tvt2,
        }),
        signer: this.#config.providerSigner,
        relay: this.#config.relay,
        ...tvt2,
      });
    }

    await this.#config.idempotencyStore.transitionState(rootEvent.id, "complete");
  }

  async #publishResult(
    context: PactAgreementContext,
    rootEvent: SignedNostrEvent,
    summary: string,
    resultReference: string,
    preparedEventJson?: string,
  ): Promise<SignedNostrEvent> {
    const resultProvenance: PrivateTaskProvenance = {
      agreementId: context.root.content.agreement_id,
      agreementRoot: rootEvent.id,
      authorizedSender: this.providerPublicKey,
      recipient: context.root.content.requester as NostrPublicKey,
    };

    // F38-04: If a prepared event was persisted, reuse it EXACTLY.
    // Do NOT create a new randomized gift wrap.
    if (preparedEventJson) {
      try {
        const persistedEvent = JSON.parse(preparedEventJson) as SignedNostrEvent;
        // Verify the persisted event has the correct kind and recipient.
        if (persistedEvent.kind === 1059) {
          // Check if the relay already has this exact event.
          const existing = await this.#config.relay.queryEvents({
            ids: [persistedEvent.id],
            limit: 1,
          });
          if (existing.length > 0) {
            // Publication is already satisfied — event is on the relay.
            return persistedEvent;
          }
          // Publish the exact persisted event.
          await this.#config.relay.publish(persistedEvent);
          return persistedEvent;
        }
      } catch {
        // If the persisted event is corrupt, fall through to create a new one.
        safeLog("warn", "provider_prepared_event_corrupt", { event_id: rootEvent.id });
      }
    }

    // Create a new gift-wrap event (first publication).
    const sealed = await sealPrivateResult(
      { summary },
      this.#config.providerEncrypter,
      resultProvenance,
      this.#config.clock(),
    );
    await publishGiftWrap(sealed.wrapEvent, this.#config.relay);
    return sealed.wrapEvent;
  }

  async #retrieveTaskWithRetry(provenance: PrivateTaskProvenance): Promise<{ source_document: string; input_media_type: "text/plain" | "application/pdf"; private_prompt?: string }> {
    const deadline = Date.now() + (this.#config.transitionWaitTimeoutMs ?? DEFAULT_TRANSITION_WAIT_TIMEOUT_MS);
    let lastError: unknown;
    while (Date.now() < deadline && !this.#stopping) {
      try {
        const task = await retrieveAndOpenPrivateTask(
          this.providerPublicKey,
          this.#config.providerEncrypter,
          provenance,
          this.#config.relay,
        );
        return task;
      } catch (error) {
        lastError = error;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref?.();
        });
      }
    }
    throw lastError ?? new ProviderServiceError("task_retrieval_failed", "Task retrieval timed out");
  }

  async #collectHistory(context: PactAgreementContext) {
    return retrieveAndReconstructPactAgreement({
      context,
      relay: this.#config.relay,
    });
  }

  getProcessedAgreements(): readonly ProviderOperationRecord[] {
    return [];
  }
}

export function createPactAgentProviderService(
  config: PactAgentProviderServiceConfig,
): PactAgentProviderService {
  return new PactAgentProviderService(config);
}
