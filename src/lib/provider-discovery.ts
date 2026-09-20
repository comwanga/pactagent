import {
  NostrEventValidationError,
  type NostrPublicKey,
  type SignedNostrEvent,
} from "../domain/nostr";
import { parseSignedNostrEvent, verifySignedNostrEvent } from "../domain/nostr";
import type { ServiceCapability, RequesterPolicy } from "../domain/pact-agents";
import type { Sats } from "../domain/money";
import {
  parsePontmoreAgentDefinitionEvent,
  PontmoreAgentDefinitionError,
  type PontmoreAgentDefinition,
} from "../domain/pontmore-agent";
import {
  isCashuEscrowCompatible,
  parsePontmoreEscrowDescriptorReference,
  PontmoreEscrowDescriptorError,
  type PontmoreEscrowDescriptor,
} from "../domain/pontmore-escrow";
import {
  PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
  resolveOfferAddressFromPricingPolicy,
  type PactServiceOffer,
} from "../domain/pact-service-offer";
import type { NostrFilter, NostrRelayAdapter, NostrRelayPublishOptions } from "./nostr-relay";
import { isTimeoutError, operationOptions } from "./pontmore-publication-helpers";
import {
  PactServiceOfferPublicationError,
  retrievePactServiceOffer,
} from "./pact-service-offer-publication";
import {
  Pip01PublicationError,
  retrieveCashuEscrowDescriptor,
} from "./pontmore-escrow-publication";

/*
 * Relay-backed provider discovery.
 *
 * Discovery answers "who is compatible and should be selected" from live
 * Pontmore PIP-00 data plus PactAgent's application-owned signed service offer.
 * It does not create a service agreement, imply bilateral consent, advance
 * lifecycle state, authorize settlement, or let AI output perform an economic
 * action. The selected provider must still separately accept the later
 * PactAgent service-agreement root (#10).
 *
 * The pipeline keeps three decisions distinct:
 *   1. Is this a valid signed Pontmore agent definition? (NIP-01 + PIP-00)
 *   2. Does it describe a provider compatible with the requested capability?
 *   3. Does the requester's deterministic economic policy authorize the
 *      provider's current signed offer?
 */

export const PIP00_PROFILE_DISCOVERY_TIMEOUT_MS = 10_000;
export const DEFAULT_DISCOVERY_MAX_PROFILES = 100;
export const DEFAULT_DISCOVERY_MAX_RESOLUTIONS = 200;
/** Cheaply inspected relay events are separately bounded from authenticated profiles. */
export const DEFAULT_DISCOVERY_MAX_RAW_PROFILE_EVENTS = 1_000;
export const DEFAULT_DISCOVERY_PROFILE_PAGE_SIZE = 100;

export interface DiscoveryBounds {
  readonly maxProfiles: number;
  readonly maxResolutions: number;
}

/*
 * Optional per-provider application constraints evaluated after the offer is
 * resolved. These mirror the provider-side checks in evaluateServiceOffer so
 * discovery's authorization is not weaker than the local fixture path.
 */
export interface ProviderConstraints {
  readonly minimumPriceSats: Sats;
  readonly maximumExecutionDurationSeconds: number;
}

export type DiscoveryRejectionCategory =
  | "invalid_nostr_event"
  | "invalid_pip00_profile"
  | "capability_mismatch"
  | "settlement_network_not_allowed"
  | "missing_offer"
  | "invalid_offer"
  | "offer_identity_mismatch"
  | "offer_capability_mismatch"
  | "offer_escrow_mismatch"
  | "offer_not_active"
  | "offer_expired"
  | "missing_descriptor"
  | "invalid_descriptor"
  | "descriptor_identity_mismatch"
  | "escrow_incompatible"
  | "budget_exceeded"
  | "provider_price_limit_exceeded"
  | "below_provider_minimum"
  | "provider_execution_limit_exceeded"
  | "duration_rejected"
  | "discovery_truncated";

export interface DiscoveryRejection {
  readonly providerPublicKey: string | undefined;
  readonly category: DiscoveryRejectionCategory;
  readonly reason: string;
}

export interface AuthorizedProviderCandidate {
  readonly providerPublicKey: NostrPublicKey;
  readonly definition: PontmoreAgentDefinition<SignedNostrEvent>;
  readonly offer: PactServiceOffer<SignedNostrEvent>;
  readonly escrowDescriptor: PontmoreEscrowDescriptor<SignedNostrEvent>;
}

export interface SelectedProviderReferences {
  readonly providerPublicKey: NostrPublicKey;
  readonly providerDefinitionReference: string;
  readonly escrowDescriptorReference: string;
  readonly offerReference: string;
}

export interface DiscoverySelection {
  readonly selected: SelectedProviderReferences;
  readonly candidate: AuthorizedProviderCandidate;
}

export interface DiscoveryResult {
  readonly candidates: readonly AuthorizedProviderCandidate[];
  readonly selected: DiscoverySelection | undefined;
  readonly rejections: readonly DiscoveryRejection[];
}

export type DiscoveryErrorCode = "profile_query_failed" | "profile_query_timeout" | "invalid_input";

export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;

  constructor(code: DiscoveryErrorCode, message: string) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
  }
}

export interface DiscoverProvidersInput {
  readonly requesterPolicy: RequesterPolicy;
  readonly capability: ServiceCapability;
  readonly relay: NostrRelayAdapter;
  readonly now: number;
  readonly bounds?: Partial<DiscoveryBounds>;
  readonly options?: NostrRelayPublishOptions;
  readonly providerConstraints?: ReadonlyMap<string, ProviderConstraints>;
}

const CAPABILITY_PROFILE_BY_CAPABILITY: Readonly<Record<ServiceCapability, string>> = {
  "document-summary": PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
};

function rejection(
  providerPublicKey: string | undefined,
  category: DiscoveryRejectionCategory,
  reason: string,
): DiscoveryRejection {
  return { providerPublicKey, category, reason };
}

function profileDiscoveryFilter(maxProfiles: number, until?: number): NostrFilter {
  return {
    kinds: [30360],
    tags: { t: ["agent"] },
    limit: maxProfiles,
    ...(until === undefined ? {} : { until }),
  };
}

async function withinDiscoveryDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<T | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(undefined), remaining);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/*
 * Group raw profile events by their stable replaceable address
 * (<kind>:<pubkey>:<d-tag>) so only events for the same definition compete
 * for replacement. This prevents two different PIP-00 definitions for the same
 * pubkey (e.g. different d tags) from collapsing into one, and prevents
 * duplicate/multi-version events from crowding other providers out of the
 * bounded profile window. Returns groups in insertion order; each group is
 * sorted newest-first (created_at desc, then id asc) so the current valid
 * profile can be selected by replacement ordering.
 */
function groupProfilesByAddress(
  events: readonly SignedNostrEvent[],
): readonly { readonly address: string; readonly events: readonly SignedNostrEvent[] }[] {
  const groups = new Map<string, SignedNostrEvent[]>();
  for (const event of events) {
    if (typeof event.pubkey !== "string") continue;
    const dTag = event.tags.find((tag) => tag[0] === "d" && typeof tag[1] === "string");
    if (!dTag) continue;
    const address = `${event.kind}:${event.pubkey}:${dTag[1]}`;
    const list = groups.get(address);
    if (list) list.push(event);
    else groups.set(address, [event]);
  }
  return [...groups.entries()].map(([address, groupEvents]) => ({
    address,
    events: [...groupEvents].sort((left, right) => {
      const timestampOrder = right.created_at - left.created_at;
      return timestampOrder === 0 ? left.id.localeCompare(right.id) : timestampOrder;
    }),
  }));
}

function mapOfferRetrievalError(error: unknown): DiscoveryRejectionCategory {
  if (error instanceof PactServiceOfferPublicationError) {
    switch (error.code) {
      case "offer_not_found":
      case "retrieval_failure":
      case "timeout":
        return "missing_offer";
      case "address_mismatch":
        return "offer_identity_mismatch";
      case "invalid_signature":
      case "invalid_nip01":
      case "invalid_offer":
      case "signing_failure":
      case "publication_failure":
        return "invalid_offer";
    }
  }
  return "invalid_offer";
}

function mapDescriptorRetrievalError(error: unknown): DiscoveryRejectionCategory {
  if (error instanceof Pip01PublicationError) {
    switch (error.code) {
      case "descriptor_not_found":
      case "retrieval_failure":
      case "timeout":
        return "missing_descriptor";
      case "descriptor_agent_mismatch":
        return "descriptor_identity_mismatch";
      case "invalid_signature":
      case "invalid_nip01":
      case "invalid_descriptor":
      case "signing_failure":
      case "publication_failure":
        return "invalid_descriptor";
    }
  }
  return "invalid_descriptor";
}

function verifyProfileEvent(
  raw: SignedNostrEvent,
): SignedNostrEvent | { rejection: DiscoveryRejection } {
  let parsed: SignedNostrEvent;
  try {
    parsed = parseSignedNostrEvent(raw);
  } catch (error) {
    if (error instanceof NostrEventValidationError) {
      return { rejection: rejection(undefined, "invalid_nostr_event", error.message) };
    }
    return { rejection: rejection(undefined, "invalid_nostr_event", "PIP-00 profile is not a valid NIP-01 event") };
  }
  try {
    verifySignedNostrEvent(parsed);
  } catch (error) {
    if (error instanceof NostrEventValidationError) {
      return {
        rejection: rejection(
          parsed.pubkey,
          "invalid_nostr_event",
          "PIP-00 profile signature is invalid",
        ),
      };
    }
    return { rejection: rejection(parsed.pubkey, "invalid_nostr_event", "PIP-00 profile signature verification failed") };
  }
  return parsed;
}

function parseProfileDefinition(
  event: SignedNostrEvent,
): PontmoreAgentDefinition<SignedNostrEvent> | { rejection: DiscoveryRejection } {
  try {
    return parsePontmoreAgentDefinitionEvent(event);
  } catch (error) {
    if (error instanceof PontmoreAgentDefinitionError) {
      return { rejection: rejection(event.pubkey, "invalid_pip00_profile", error.message) };
    }
    return { rejection: rejection(event.pubkey, "invalid_pip00_profile", "PIP-00 profile is invalid") };
  }
}

function evaluateCapabilityCompatibility(
  definition: PontmoreAgentDefinition<SignedNostrEvent>,
  capability: ServiceCapability,
  requesterPolicy: RequesterPolicy,
): DiscoveryRejection | undefined {
  if (!definition.content.capabilities.names.includes(capability)) {
    return rejection(
      definition.event.pubkey,
      "capability_mismatch",
      "Provider does not advertise the requested capability",
    );
  }
  const supportsAllowedSettlement = definition.content.capabilities.settlement_networks.some((network) =>
    requesterPolicy.allowedSettlementNetworks.includes(network as "cashu"),
  );
  if (!supportsAllowedSettlement) {
    return rejection(
      definition.event.pubkey,
      "settlement_network_not_allowed",
      "Provider does not advertise a requester-allowed settlement network",
    );
  }
  return undefined;
}

async function resolveOffer(
  definition: PontmoreAgentDefinition<SignedNostrEvent>,
  relay: NostrRelayAdapter,
  options: NostrRelayPublishOptions | undefined,
): Promise<PactServiceOffer<SignedNostrEvent> | { rejection: DiscoveryRejection }> {
  /*
   * resolveOfferAddressFromPricingPolicy validates that pricing_policy is a
   * canonical service-offer address owned by the provider. The pricing_policy
   * string itself is the canonical address, so it can be passed directly to
   * retrieval without reconstruction.
   */
  try {
    resolveOfferAddressFromPricingPolicy(
      definition.content.pricing_policy,
      definition.event.pubkey,
    );
  } catch {
    return {
      rejection: rejection(
        definition.event.pubkey,
        "missing_offer",
        "PIP-00 pricing_policy does not resolve to a provider-owned service offer",
      ),
    };
  }

  try {
    const offer = await retrievePactServiceOffer(definition.content.pricing_policy, relay, options);
    return offer;
  } catch (error) {
    return {
      rejection: rejection(definition.event.pubkey, mapOfferRetrievalError(error), "Service offer could not be resolved"),
    };
  }
}

function crossValidateOffer(
  definition: PontmoreAgentDefinition<SignedNostrEvent>,
  offer: PactServiceOffer<SignedNostrEvent>,
  capability: ServiceCapability,
  requesterPolicy: RequesterPolicy,
  now: number,
): DiscoveryRejection | undefined {
  if (offer.event.pubkey !== definition.event.pubkey || offer.content.provider !== definition.event.pubkey) {
    return rejection(definition.event.pubkey, "offer_identity_mismatch", "Service offer is not signed by the provider");
  }
  const expectedProfileId = CAPABILITY_PROFILE_BY_CAPABILITY[capability];
  if (offer.content.capability_profile.id !== expectedProfileId) {
    return rejection(definition.event.pubkey, "offer_capability_mismatch", "Service offer targets a different capability profile");
  }
  if (offer.content.escrow_descriptor !== definition.content.escrow) {
    return rejection(definition.event.pubkey, "offer_escrow_mismatch", "Service offer escrow reference does not match the provider definition");
  }
  if (!requesterPolicy.allowedSettlementNetworks.includes(offer.content.settlement_network)) {
    return rejection(definition.event.pubkey, "settlement_network_not_allowed", "Service offer settlement network is not allowed");
  }
  if (now < offer.content.valid_from) {
    return rejection(definition.event.pubkey, "offer_not_active", "Service offer is not yet valid");
  }
  if (now > offer.content.expires_at) {
    return rejection(definition.event.pubkey, "offer_expired", "Service offer has expired");
  }
  return undefined;
}

async function resolveDescriptor(
  definition: PontmoreAgentDefinition<SignedNostrEvent>,
  relay: NostrRelayAdapter,
  options: NostrRelayPublishOptions | undefined,
): Promise<PontmoreEscrowDescriptor<SignedNostrEvent> | { rejection: DiscoveryRejection }> {
  let escrowReference;
  try {
    escrowReference = parsePontmoreEscrowDescriptorReference(definition.content.escrow);
  } catch (error) {
    if (error instanceof PontmoreEscrowDescriptorError) {
      return {
        rejection: rejection(definition.event.pubkey, "invalid_descriptor", "PIP-00 escrow reference is malformed"),
      };
    }
    return { rejection: rejection(definition.event.pubkey, "invalid_descriptor", "PIP-00 escrow reference is invalid") };
  }
  if (escrowReference.publicKey !== definition.event.pubkey) {
    return {
      rejection: rejection(definition.event.pubkey, "descriptor_identity_mismatch", "PIP-01 escrow descriptor is not owned by the provider"),
    };
  }

  try {
    const descriptor = await retrieveCashuEscrowDescriptor(definition.content.escrow, relay, options);
    return descriptor;
  } catch (error) {
    return {
      rejection: rejection(definition.event.pubkey, mapDescriptorRetrievalError(error), "PIP-01 escrow descriptor could not be resolved"),
    };
  }
}

function crossValidateDescriptor(
  descriptor: PontmoreEscrowDescriptor<SignedNostrEvent>,
  requesterPolicy: RequesterPolicy,
): DiscoveryRejection | undefined {
  if (!isCashuEscrowCompatible(descriptor)) {
    return { providerPublicKey: descriptor.event.pubkey, category: "escrow_incompatible", reason: "PIP-01 descriptor is not Cashu-compatible" };
  }
  if (
    descriptor.content.dispute_rules.timeout.duration_seconds >
    requesterPolicy.maximumEscrowDurationSeconds
  ) {
    return rejection(
      descriptor.event.pubkey,
      "duration_rejected",
      "PIP-01 descriptor timeout exceeds the requester escrow duration",
    );
  }
  return undefined;
}

function evaluateEconomicPolicy(
  offer: PactServiceOffer<SignedNostrEvent>,
  requesterPolicy: RequesterPolicy,
  providerConstraints: ProviderConstraints | undefined,
): DiscoveryRejection | undefined {
  if (offer.amountSats > requesterPolicy.maxBudgetSats) {
    return rejection(offer.content.provider, "budget_exceeded", "Service offer exceeds the requester budget");
  }
  if (offer.amountSats > requesterPolicy.maximumProviderPriceSats) {
    return rejection(offer.content.provider, "provider_price_limit_exceeded", "Service offer exceeds the requester provider-price ceiling");
  }
  if (providerConstraints && offer.amountSats < providerConstraints.minimumPriceSats) {
    return rejection(offer.content.provider, "below_provider_minimum", "Service offer is below the provider minimum price");
  }
  if (offer.content.maximum_execution_seconds > requesterPolicy.maximumEscrowDurationSeconds) {
    return rejection(offer.content.provider, "duration_rejected", "Service offer execution duration exceeds the requester escrow duration");
  }
  if (
    providerConstraints &&
    offer.content.maximum_execution_seconds > providerConstraints.maximumExecutionDurationSeconds
  ) {
    return rejection(offer.content.provider, "provider_execution_limit_exceeded", "Service offer execution duration exceeds the provider execution limit");
  }
  return undefined;
}

function compareAuthorizedCandidates(
  left: AuthorizedProviderCandidate,
  right: AuthorizedProviderCandidate,
): number {
  if (left.offer.amountSats !== right.offer.amountSats) {
    return left.offer.amountSats < right.offer.amountSats ? -1 : 1;
  }
  const leftDuration = left.offer.content.maximum_execution_seconds;
  const rightDuration = right.offer.content.maximum_execution_seconds;
  if (leftDuration !== rightDuration) {
    return leftDuration < rightDuration ? -1 : 1;
  }
  const providerOrder = left.providerPublicKey.localeCompare(right.providerPublicKey);
  if (providerOrder !== 0) return providerOrder;
  return left.definition.address.localeCompare(right.definition.address);
}

export async function discoverProviders(input: DiscoverProvidersInput): Promise<DiscoveryResult> {
  if (!Number.isFinite(input.now) || !Number.isInteger(input.now) || input.now < 0) {
    throw new DiscoveryError("invalid_input", "Discovery now must be a finite non-negative integer");
  }
  const maxProfiles = input.bounds?.maxProfiles ?? DEFAULT_DISCOVERY_MAX_PROFILES;
  const maxResolutions = input.bounds?.maxResolutions ?? DEFAULT_DISCOVERY_MAX_RESOLUTIONS;
  if (!Number.isInteger(maxProfiles) || maxProfiles < 1) {
    throw new DiscoveryError("invalid_input", "Discovery bounds maxProfiles must be a positive integer");
  }
  if (!Number.isInteger(maxResolutions) || maxResolutions < 0) {
    throw new DiscoveryError("invalid_input", "Discovery bounds maxResolutions must be a non-negative integer");
  }
  if (!input.requesterPolicy.allowedCapabilities.includes(input.capability)) {
    return { candidates: [], selected: undefined, rejections: [] };
  }

  const discoveryTimeoutMs = input.options?.timeoutMs ?? PIP00_PROFILE_DISCOVERY_TIMEOUT_MS;
  const deadline = Date.now() + discoveryTimeoutMs;
  const rawProfiles: SignedNostrEvent[] = [];
  const seenProfiles = new Set<string>();
  let profileQueryTruncated = false;
  let until: number | undefined;
  while (rawProfiles.length < DEFAULT_DISCOVERY_MAX_RAW_PROFILE_EVENTS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      profileQueryTruncated = true;
      break;
    }
    let page: readonly SignedNostrEvent[] | undefined;
    try {
      page = await withinDiscoveryDeadline(
        input.relay.queryEvents(
          profileDiscoveryFilter(DEFAULT_DISCOVERY_PROFILE_PAGE_SIZE, until),
          operationOptions(remaining, input.options),
        ),
        deadline,
      );
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new DiscoveryError("profile_query_timeout", "PIP-00 profile discovery query timed out");
      }
      throw new DiscoveryError("profile_query_failed", "PIP-00 profile discovery query failed");
    }
    if (page === undefined) {
      if (rawProfiles.length === 0) {
        throw new DiscoveryError("profile_query_timeout", "PIP-00 profile discovery query timed out");
      }
      profileQueryTruncated = true;
      break;
    }
    let added = 0;
    for (const event of page) {
      const eventFingerprint = JSON.stringify(event);
      if (seenProfiles.has(eventFingerprint)) continue;
      seenProfiles.add(eventFingerprint);
      rawProfiles.push(event);
      added += 1;
      if (rawProfiles.length === DEFAULT_DISCOVERY_MAX_RAW_PROFILE_EVENTS) break;
    }
    if (page.length < DEFAULT_DISCOVERY_PROFILE_PAGE_SIZE) break;
    if (rawProfiles.length === DEFAULT_DISCOVERY_MAX_RAW_PROFILE_EVENTS) {
      profileQueryTruncated = true;
      break;
    }
    const oldestTimestamp = page.reduce<number | undefined>(
      (oldest, event) => oldest === undefined || event.created_at < oldest ? event.created_at : oldest,
      undefined,
    );
    if (added === 0 || oldestTimestamp === undefined || oldestTimestamp <= 0) {
      profileQueryTruncated = true;
      break;
    }
    until = oldestTimestamp - 1;
  }

  const groupedProfiles = groupProfilesByAddress(rawProfiles);
  const rejections: DiscoveryRejection[] = [];
  if (profileQueryTruncated) {
    rejections.push(
      rejection(undefined, "discovery_truncated", "Discovery raw-profile scan was bounded"),
    );
  }
  const candidates: AuthorizedProviderCandidate[] = [];
  let resolutionsRemaining = maxResolutions;
  let profilesRemaining = maxProfiles;

  for (const group of groupedProfiles) {
    let currentAuthentic: SignedNostrEvent | undefined;
    for (const raw of group.events) {
      const verified = verifyProfileEvent(raw);
      if ("rejection" in verified) {
        rejections.push(verified.rejection);
        continue;
      }
      currentAuthentic = verified;
      break;
    }
    if (!currentAuthentic) continue;

    /*
     * Replacement ordering is authoritative only among authentic NIP-01
     * events. Once selected, the current event must pass PIP-00 validation;
     * an application-invalid current definition never falls back to a stale
     * authentic version.
     */
    const profile = parseProfileDefinition(currentAuthentic);
    if ("rejection" in profile) {
      rejections.push(profile.rejection);
      continue;
    }
    const definition = profile;

    const capabilityRejection = evaluateCapabilityCompatibility(definition, input.capability, input.requesterPolicy);
    if (capabilityRejection) {
      rejections.push(capabilityRejection);
      continue;
    }

    if (profilesRemaining < 1) {
      rejections.push(rejection(definition.event.pubkey, "discovery_truncated", "Discovery authenticated-profile budget exhausted before this provider"));
      continue;
    }
    profilesRemaining -= 1;

    if (resolutionsRemaining < 1) {
      rejections.push(rejection(definition.event.pubkey, "discovery_truncated", "Discovery resolution budget exhausted before this provider"));
      continue;
    }
    resolutionsRemaining -= 1;

    const remainingForOffer = deadline - Date.now();
    const offerResult = await withinDiscoveryDeadline(
      resolveOffer(definition, input.relay, {
        ...input.options,
        timeoutMs: Math.max(1, remainingForOffer),
      }),
      deadline,
    );
    if (offerResult === undefined) {
      rejections.push(rejection(definition.event.pubkey, "discovery_truncated", "Discovery global deadline was exhausted"));
      break;
    }
    if ("rejection" in offerResult) {
      rejections.push(offerResult.rejection);
      continue;
    }
    const offer = offerResult;

    const offerRejection = crossValidateOffer(definition, offer, input.capability, input.requesterPolicy, input.now);
    if (offerRejection) {
      rejections.push(offerRejection);
      continue;
    }

    if (resolutionsRemaining < 1) {
      rejections.push(rejection(definition.event.pubkey, "discovery_truncated", "Discovery resolution budget exhausted before descriptor resolution"));
      continue;
    }
    resolutionsRemaining -= 1;

    const remainingForDescriptor = deadline - Date.now();
    const descriptorResult = await withinDiscoveryDeadline(
      resolveDescriptor(definition, input.relay, {
        ...input.options,
        timeoutMs: Math.max(1, remainingForDescriptor),
      }),
      deadline,
    );
    if (descriptorResult === undefined) {
      rejections.push(rejection(definition.event.pubkey, "discovery_truncated", "Discovery global deadline was exhausted"));
      break;
    }
    if ("rejection" in descriptorResult) {
      rejections.push(descriptorResult.rejection);
      continue;
    }
    const descriptor = descriptorResult;

    const descriptorRejection = crossValidateDescriptor(descriptor, input.requesterPolicy);
    if (descriptorRejection) {
      rejections.push(descriptorRejection);
      continue;
    }

    const economicRejection = evaluateEconomicPolicy(
      offer,
      input.requesterPolicy,
      input.providerConstraints?.get(definition.event.pubkey),
    );
    if (economicRejection) {
      rejections.push(economicRejection);
      continue;
    }

    candidates.push({
      providerPublicKey: definition.event.pubkey,
      definition,
      offer,
      escrowDescriptor: descriptor,
    });
  }

  const sorted = [...candidates].sort(compareAuthorizedCandidates);
  const winner = sorted[0];
  const selected = winner
    ? {
        selected: {
          providerPublicKey: winner.providerPublicKey,
          providerDefinitionReference: winner.definition.address,
          escrowDescriptorReference: winner.escrowDescriptor.address,
          offerReference: winner.offer.address,
        },
        candidate: winner,
      }
    : undefined;

  return { candidates: sorted, selected, rejections };
}
