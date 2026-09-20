import {
  NostrEventValidationError,
  nostrPublicKey,
  parseSignedNostrEvent,
  verifySignedNostrEvent,
  type NostrPublicKey,
  type NostrSigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "../domain/nostr";
import {
  PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND,
  PACT_AGREEMENT_TRANSITION_TYPE,
  PACT_SERVICE_AGREEMENT_ROOT_TYPE,
  PactServiceAgreementError,
  createPactServiceAgreementRoot,
  parsePactAgreementTransitionEvent,
  parsePactServiceAgreementRootEvent,
  reconstructPactAgreementHistory,
  validatePactAgreementTransitionCandidate,
  validatePactServiceAgreementRoot,
  validatePactServiceAgreementRootDraft,
  type PactAgreementContext,
  type PactAgreementHistory,
  type PactAgreementReferences,
  type PactAgreementTransition,
  type PactServiceAgreementRoot,
  type PactTermsCommitment,
} from "../domain/pact-service-agreement";
import {
  parsePactServiceOfferEvent,
  type PactServiceOffer,
} from "../domain/pact-service-offer";
import type {
  NostrFilter,
  NostrRelayAdapter,
  NostrRelayPublishOptions,
} from "./nostr-relay";
import {
  isTimeoutError,
  operationOptions,
  sameUnsignedEvent,
} from "./pontmore-publication-helpers";
import type { DiscoverySelection } from "./provider-discovery";

export type PactAgreementPublicationErrorCode =
  | "signing_failure"
  | "publication_failure"
  | "retrieval_failure"
  | "timeout"
  | "agreement_not_found"
  | "conflicting_roots";

export class PactAgreementPublicationError extends Error {
  readonly code: PactAgreementPublicationErrorCode;

  constructor(code: PactAgreementPublicationErrorCode, message: string) {
    super(message);
    this.name = "PactAgreementPublicationError";
    this.code = code;
  }
}

export const PACT_AGREEMENT_RELAY_TIMEOUT_MS = 10_000;
export const PACT_AGREEMENT_DEFAULT_QUERY_LIMIT = 256;
export const PACT_AGREEMENT_MAX_QUERY_LIMIT = 1_000;

export interface PactAgreementDraftFromDiscovery {
  readonly root: PactServiceAgreementRoot;
  readonly references: PactAgreementReferences;
}

/**
 * Converts #9's validated provider selection into the exact signed Pontmore
 * references and provider-offer terms consumed by the #10 agreement root.
 * Discovery remains non-economic: this constructs an unsigned requester
 * proposal and performs no signing, publication, acceptance, or settlement.
 */
export function createPactServiceAgreementRootFromDiscovery(input: {
  readonly requesterDefinition: SignedNostrEvent;
  readonly selection: DiscoverySelection;
  readonly agreementId?: string;
  readonly expiresAt: number;
  readonly termsCommitment: Pick<PactTermsCommitment, "value" | "scheme">;
  readonly createdAt: number;
}): PactAgreementDraftFromDiscovery {
  const { selected, candidate } = input.selection;
  let offer: PactServiceOffer<SignedNostrEvent>;
  try {
    const offerEvent = parseSignedNostrEvent(candidate.offer.event);
    verifySignedNostrEvent(offerEvent);
    offer = parsePactServiceOfferEvent(offerEvent);
  } catch {
    throw new PactServiceAgreementError(
      "invalid_reference",
      "Provider discovery selection contains an invalid signed offer",
    );
  }

  if (
    selected.providerPublicKey !== candidate.providerPublicKey ||
    selected.providerPublicKey !== candidate.definition.event.pubkey ||
    selected.providerDefinitionReference !== candidate.definition.address ||
    selected.escrowDescriptorReference !== candidate.escrowDescriptor.address ||
    selected.offerReference !== offer.address ||
    candidate.definition.content.pricing_policy !== offer.address ||
    offer.content.provider !== selected.providerPublicKey ||
    offer.content.escrow_descriptor !== selected.escrowDescriptorReference
  ) {
    throw new PactServiceAgreementError(
      "invalid_reference",
      "Provider discovery selection does not match its validated candidate",
    );
  }
  if (input.createdAt < offer.content.valid_from || input.createdAt > offer.content.expires_at) {
    throw new PactServiceAgreementError(
      "invalid_reference",
      "Selected provider offer is not active at agreement creation",
    );
  }

  const references: PactAgreementReferences = {
    requesterDefinition: input.requesterDefinition,
    providerDefinition: candidate.definition.event,
    escrowDescriptor: candidate.escrowDescriptor.event,
  };
  const root = createPactServiceAgreementRoot({
    agreementId: input.agreementId,
    references,
    amountSats: offer.content.amount_sats,
    maximumExecutionSeconds: offer.content.maximum_execution_seconds,
    expiresAt: input.expiresAt,
    termsCommitment: input.termsCommitment,
    createdAt: input.createdAt,
  });
  return { root, references };
}

function queryLimit(value?: number): number {
  const limit = value ?? PACT_AGREEMENT_DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > PACT_AGREEMENT_MAX_QUERY_LIMIT) {
    throw new PactServiceAgreementError(
      "malformed_event",
      `PactAgent query limit must be between 1 and ${PACT_AGREEMENT_MAX_QUERY_LIMIT}`,
    );
  }
  return limit;
}

function assertSignedEventMatchesDraft(
  draft: UnsignedNostrEvent,
  signed: SignedNostrEvent,
): void {
  if (!sameUnsignedEvent(draft, signed)) {
    throw new NostrEventValidationError(
      "invalid_nostr_event",
      "Signer returned an event that does not match the requested draft",
    );
  }
}

function assertSignerIdentity(signer: NostrSigner, expected: NostrPublicKey): void {
  if (signer.publicKey !== expected) {
    throw new PactServiceAgreementError(
      "signer_not_authorized",
      "PactAgent signer is not authorized for the requested event",
    );
  }
}

async function publish(
  event: SignedNostrEvent,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<void> {
  try {
    await relay.publish(
      event,
      operationOptions(PACT_AGREEMENT_RELAY_TIMEOUT_MS, options),
    );
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new PactAgreementPublicationError("timeout", "PactAgent event publication timed out");
    }
    throw new PactAgreementPublicationError(
      "publication_failure",
      "PactAgent event publication failed",
    );
  }
}

export async function signPactServiceAgreementRoot(input: {
  readonly root: PactServiceAgreementRoot;
  readonly references: PactAgreementReferences;
  readonly signer: NostrSigner;
}): Promise<PactServiceAgreementRoot<SignedNostrEvent>> {
  const root = validatePactServiceAgreementRootDraft(input.root, input.references);
  assertSignerIdentity(input.signer, root.event.pubkey);
  let signerResult: SignedNostrEvent;
  try {
    signerResult = await input.signer.sign(root.event);
  } catch {
    throw new PactAgreementPublicationError(
      "signing_failure",
      "PactAgent agreement root signing failed",
    );
  }
  const signed = parseSignedNostrEvent(signerResult);
  assertSignedEventMatchesDraft(root.event, signed);
  return validatePactServiceAgreementRoot(signed, input.references);
}

export async function publishSignedPactServiceAgreementRoot(input: {
  readonly root: PactServiceAgreementRoot<SignedNostrEvent>;
  readonly references: PactAgreementReferences;
  readonly relay: NostrRelayAdapter;
  readonly options?: NostrRelayPublishOptions;
}): Promise<void> {
  const root = validatePactServiceAgreementRoot(input.root.event, input.references);
  await publish(root.event, input.relay, input.options);
}

export async function signAndPublishPactServiceAgreementRoot(input: {
  readonly root: PactServiceAgreementRoot;
  readonly references: PactAgreementReferences;
  readonly signer: NostrSigner;
  readonly relay: NostrRelayAdapter;
  readonly options?: NostrRelayPublishOptions;
}): Promise<PactServiceAgreementRoot<SignedNostrEvent>> {
  const signed = await signPactServiceAgreementRoot(input);
  await publishSignedPactServiceAgreementRoot({
    root: signed,
    references: input.references,
    relay: input.relay,
    options: input.options,
  });
  return signed;
}

export function pactServiceAgreementRootFilter(input: {
  readonly agreementId: string;
  readonly requester: NostrPublicKey;
  readonly limit?: number;
}): NostrFilter {
  return {
    kinds: [PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND],
    authors: [input.requester],
    tags: {
      d: [input.agreementId],
      t: [PACT_SERVICE_AGREEMENT_ROOT_TYPE],
    },
    limit: queryLimit(input.limit),
  };
}

export async function retrievePactServiceAgreementRoot(input: {
  readonly agreementId: string;
  readonly references: PactAgreementReferences;
  readonly relay: NostrRelayAdapter;
  readonly limit?: number;
  readonly options?: NostrRelayPublishOptions;
}): Promise<PactServiceAgreementRoot<SignedNostrEvent>> {
  const requester = parseSignedNostrEvent(input.references.requesterDefinition).pubkey;
  let events: SignedNostrEvent[];
  try {
    events = await input.relay.queryEvents(
      pactServiceAgreementRootFilter({
        agreementId: input.agreementId,
        requester,
        limit: input.limit,
      }),
      operationOptions(PACT_AGREEMENT_RELAY_TIMEOUT_MS, input.options),
    );
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new PactAgreementPublicationError("timeout", "PactAgent agreement retrieval timed out");
    }
    throw new PactAgreementPublicationError(
      "retrieval_failure",
      "PactAgent agreement retrieval failed",
    );
  }

  const roots = new Map<string, PactServiceAgreementRoot<SignedNostrEvent>>();
  for (const value of events) {
    const signed = parseSignedNostrEvent(value);
    verifySignedNostrEvent(signed);
    const parsed = parsePactServiceAgreementRootEvent(signed);
    if (
      parsed.content.agreement_id === input.agreementId &&
      parsed.event.pubkey === requester
    ) {
      roots.set(parsed.event.id, validatePactServiceAgreementRoot(signed, input.references));
    }
  }
  if (roots.size === 0) {
    throw new PactAgreementPublicationError(
      "agreement_not_found",
      "PactAgent agreement root was not found",
    );
  }
  if (roots.size > 1) {
    throw new PactAgreementPublicationError(
      "conflicting_roots",
      "PactAgent agreement identifier has conflicting immutable roots",
    );
  }
  return [...roots.values()][0];
}

export async function signPactAgreementTransition(input: {
  readonly context: PactAgreementContext;
  readonly history: readonly SignedNostrEvent[];
  readonly transition: PactAgreementTransition;
  readonly signer: NostrSigner;
  readonly validationTime?: number;
}): Promise<PactAgreementTransition<SignedNostrEvent>> {
  const transition = validatePactAgreementTransitionCandidate(
    input.context,
    input.history,
    input.transition,
    input.validationTime,
  );
  assertSignerIdentity(input.signer, transition.event.pubkey);
  let signerResult: SignedNostrEvent;
  try {
    signerResult = await input.signer.sign(transition.event);
  } catch {
    throw new PactAgreementPublicationError(
      "signing_failure",
      "PactAgent transition signing failed",
    );
  }
  const signed = parseSignedNostrEvent(signerResult);
  assertSignedEventMatchesDraft(transition.event, signed);
  verifySignedNostrEvent(signed);
  return parsePactAgreementTransitionEvent(
    signed,
    input.context.root.content.capability_profile,
  );
}

export async function publishSignedPactAgreementTransition(input: {
  readonly context: PactAgreementContext;
  readonly history: readonly SignedNostrEvent[];
  readonly transition: PactAgreementTransition<SignedNostrEvent>;
  readonly relay: NostrRelayAdapter;
  readonly options?: NostrRelayPublishOptions;
  readonly validationTime?: number;
}): Promise<void> {
  const signed = parseSignedNostrEvent(input.transition.event);
  verifySignedNostrEvent(signed);
  const parsed = parsePactAgreementTransitionEvent(
    signed,
    input.context.root.content.capability_profile,
  );
  validatePactAgreementTransitionCandidate(
    input.context,
    input.history,
    parsed,
    input.validationTime,
  );
  await publish(signed, input.relay, input.options);
}

export async function signAndPublishPactAgreementTransition(input: {
  readonly context: PactAgreementContext;
  readonly history: readonly SignedNostrEvent[];
  readonly transition: PactAgreementTransition;
  readonly signer: NostrSigner;
  readonly relay: NostrRelayAdapter;
  readonly options?: NostrRelayPublishOptions;
  readonly validationTime?: number;
}): Promise<PactAgreementTransition<SignedNostrEvent>> {
  const signed = await signPactAgreementTransition(input);
  await publishSignedPactAgreementTransition({
    context: input.context,
    history: input.history,
    transition: signed,
    relay: input.relay,
    options: input.options,
    validationTime: input.validationTime,
  });
  return signed;
}

export function pactAgreementTransitionFilter(input: {
  readonly agreementId: string;
  readonly authors: readonly NostrPublicKey[];
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
}): NostrFilter {
  if (input.authors.length === 0) {
    throw new PactServiceAgreementError(
      "invalid_reference",
      "PactAgent transition retrieval requires known authorized authors",
    );
  }
  if (input.since !== undefined && (!Number.isInteger(input.since) || input.since < 0)) {
    throw new PactServiceAgreementError("malformed_event", "PactAgent query since is invalid");
  }
  if (
    input.until !== undefined &&
    (!Number.isInteger(input.until) || input.until < (input.since ?? 0))
  ) {
    throw new PactServiceAgreementError("malformed_event", "PactAgent query until is invalid");
  }
  return {
    kinds: [PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND],
    authors: [...new Set(input.authors)],
    tags: {
      d: [input.agreementId],
      t: [PACT_AGREEMENT_TRANSITION_TYPE],
    },
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.until === undefined ? {} : { until: input.until }),
    limit: queryLimit(input.limit),
  };
}

export async function retrievePactAgreementTransitions(input: {
  readonly context: PactAgreementContext;
  readonly relay: NostrRelayAdapter;
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  readonly options?: NostrRelayPublishOptions;
}): Promise<readonly SignedNostrEvent[]> {
  const authors: NostrPublicKey[] = [
    nostrPublicKey(input.context.root.content.requester),
    nostrPublicKey(input.context.root.content.provider),
  ];
  if (input.context.escrowAuthority) authors.push(input.context.escrowAuthority.authority);
  let events: SignedNostrEvent[];
  try {
    events = await input.relay.queryEvents(
      pactAgreementTransitionFilter({
        agreementId: input.context.root.content.agreement_id,
        authors,
        since: input.since,
        until: input.until,
        limit: input.limit,
      }),
      operationOptions(PACT_AGREEMENT_RELAY_TIMEOUT_MS, input.options),
    );
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new PactAgreementPublicationError("timeout", "PactAgent transition retrieval timed out");
    }
    throw new PactAgreementPublicationError(
      "retrieval_failure",
      "PactAgent transition retrieval failed",
    );
  }
  for (const event of events) {
    const signed = parseSignedNostrEvent(event);
    verifySignedNostrEvent(signed);
    parsePactAgreementTransitionEvent(
      signed,
      input.context.root.content.capability_profile,
    );
  }
  return events;
}

export async function retrieveAndReconstructPactAgreement(input: {
  readonly context: PactAgreementContext;
  readonly relay: NostrRelayAdapter;
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  readonly options?: NostrRelayPublishOptions;
}): Promise<PactAgreementHistory> {
  const events = await retrievePactAgreementTransitions(input);
  return reconstructPactAgreementHistory(input.context, events);
}
