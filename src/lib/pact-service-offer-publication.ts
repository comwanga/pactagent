import {
  NostrEventValidationError,
  parseSignedNostrEvent,
  verifySignedNostrEvent,
  type NostrSigner,
  type SignedNostrEvent,
} from "../domain/nostr";
import {
  parsePactServiceOfferEvent,
  parsePactServiceOfferReference,
  PACTAGENT_SERVICE_OFFER_KIND,
  PactServiceOfferError,
  type PactServiceOffer,
  type PactServiceOfferReference,
} from "../domain/pact-service-offer";
import type { NostrFilter, NostrRelayAdapter, NostrRelayPublishOptions } from "./nostr-relay";
import { isTimeoutError, operationOptions, sameUnsignedEvent } from "./pontmore-publication-helpers";

export type PactServiceOfferPublicationErrorCode =
  | "signing_failure"
  | "publication_failure"
  | "retrieval_failure"
  | "timeout"
  | "offer_not_found"
  | "address_mismatch"
  | "invalid_nip01"
  | "invalid_signature"
  | "invalid_offer";

export class PactServiceOfferPublicationError extends Error {
  readonly code: PactServiceOfferPublicationErrorCode;

  constructor(code: PactServiceOfferPublicationErrorCode, message: string) {
    super(message);
    this.name = "PactServiceOfferPublicationError";
    this.code = code;
  }
}

export const PACT_SERVICE_OFFER_RELAY_TIMEOUT_MS = 10_000;

export async function signPactServiceOffer(
  offer: PactServiceOffer,
  signer: NostrSigner,
): Promise<SignedNostrEvent> {
  if (offer.event.pubkey !== signer.publicKey) {
    throw new PactServiceOfferPublicationError(
      "signing_failure",
      "Signer identity does not match the PactAgent service offer",
    );
  }

  let signedValue: SignedNostrEvent;
  try {
    signedValue = await signer.sign(offer.event);
  } catch {
    throw new PactServiceOfferPublicationError("signing_failure", "PactAgent service-offer signing failed");
  }

  const signed = parseSignedNostrEvent(signedValue);
  if (!sameUnsignedEvent(offer.event, signed)) {
    throw new NostrEventValidationError(
      "invalid_nostr_event",
      "Signer returned an event that does not match the PactAgent service-offer draft",
    );
  }
  verifySignedNostrEvent(signed);
  return signed;
}

export async function publishSignedPactServiceOffer(
  event: SignedNostrEvent,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<void> {
  const signed = parseSignedNostrEvent(event);
  verifySignedNostrEvent(signed);
  parsePactServiceOfferEvent(signed);
  try {
    await relay.publish(signed, operationOptions(PACT_SERVICE_OFFER_RELAY_TIMEOUT_MS, options));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new PactServiceOfferPublicationError("timeout", "PactAgent service-offer publication timed out");
    }
    throw new PactServiceOfferPublicationError("publication_failure", "PactAgent service-offer publication failed");
  }
}

export async function signAndPublishPactServiceOffer(
  offer: PactServiceOffer,
  signer: NostrSigner,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<SignedNostrEvent> {
  const signed = await signPactServiceOffer(offer, signer);
  await publishSignedPactServiceOffer(signed, relay, options);
  return signed;
}

export function pactServiceOfferFilter(reference: string): NostrFilter {
  const parsed = parsePactServiceOfferReference(reference);
  return {
    kinds: [PACTAGENT_SERVICE_OFFER_KIND],
    authors: [parsed.publicKey],
    tags: { d: [parsed.identifier] },
    limit: 10,
  };
}

function hasOfferAddress(event: SignedNostrEvent, reference: string): boolean {
  const parsed = parsePactServiceOfferReference(reference);
  const dTags = event.tags.filter((tag) => tag[0] === "d");
  return (
    event.kind === parsed.kind &&
    event.pubkey === parsed.publicKey &&
    dTags.length === 1 &&
    dTags[0][1] === parsed.identifier
  );
}

function matchesRawOfferAddress(raw: unknown, ref: PactServiceOfferReference): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const candidate = raw as Record<string, unknown>;
  if (
    candidate.kind !== ref.kind ||
    candidate.pubkey !== ref.publicKey ||
    !Array.isArray(candidate.tags)
  ) {
    return false;
  }
  const dTags = candidate.tags.filter(
    (tag: unknown) => Array.isArray(tag) && tag[0] === "d",
  );
  return dTags.length === 1 && dTags[0][1] === ref.identifier;
}

function mapOfferValidationError(error: unknown): PactServiceOfferPublicationError {
  if (error instanceof NostrEventValidationError) {
    return error.code === "invalid_signature"
      ? new PactServiceOfferPublicationError("invalid_signature", "PactAgent service-offer signature is invalid")
      : new PactServiceOfferPublicationError("invalid_nip01", "PactAgent service-offer failed NIP-01 validation");
  }
  if (error instanceof PactServiceOfferError) {
    return new PactServiceOfferPublicationError("invalid_offer", error.message);
  }
  return new PactServiceOfferPublicationError("invalid_offer", "PactAgent service-offer is invalid");
}

export async function retrievePactServiceOffer(
  reference: string,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<PactServiceOffer<SignedNostrEvent>> {
  const ref = parsePactServiceOfferReference(reference);
  const filter = pactServiceOfferFilter(reference);
  let events: readonly SignedNostrEvent[];
  try {
    events = await relay.queryEvents(filter, operationOptions(PACT_SERVICE_OFFER_RELAY_TIMEOUT_MS, options));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new PactServiceOfferPublicationError("timeout", "PactAgent service-offer retrieval timed out");
    }
    throw new PactServiceOfferPublicationError("retrieval_failure", "PactAgent service-offer retrieval failed");
  }

  if (events.length === 0) {
    throw new PactServiceOfferPublicationError("offer_not_found", "PactAgent service-offer was not found");
  }

  const authenticMatches: SignedNostrEvent[] = [];
  let anyAddressMatch = false;
  let firstError: PactServiceOfferPublicationError | undefined;

  for (const raw of events) {
    let parsedEvent: SignedNostrEvent;
    try {
      parsedEvent = parseSignedNostrEvent(raw);
    } catch (error) {
      if (matchesRawOfferAddress(raw, ref)) {
        anyAddressMatch = true;
        if (!firstError) firstError = mapOfferValidationError(error);
      }
      continue;
    }

    if (!hasOfferAddress(parsedEvent, reference)) continue;
    anyAddressMatch = true;
    try {
      verifySignedNostrEvent(parsedEvent);
      authenticMatches.push(parsedEvent);
    } catch (error) {
      if (!firstError) firstError = mapOfferValidationError(error);
    }
  }

  if (authenticMatches.length === 0) {
    if (anyAddressMatch && firstError) throw firstError;
    throw new PactServiceOfferPublicationError(
      "address_mismatch",
      "Relay result does not match the requested PactAgent service-offer reference",
    );
  }

  authenticMatches.sort((left, right) => {
    const timestampOrder = right.created_at - left.created_at;
    return timestampOrder === 0 ? left.id.localeCompare(right.id) : timestampOrder;
  });
  let newestParseError: PactServiceOfferPublicationError | undefined;
  for (const current of authenticMatches) {
    try {
      const offer = parsePactServiceOfferEvent(current);
      if (offer.address !== reference) {
        throw new PactServiceOfferPublicationError("address_mismatch", "Retrieved PactAgent service-offer does not match its reference");
      }
      return offer;
    } catch (error) {
      const mapped =
        error instanceof PactServiceOfferPublicationError
          ? error
          : mapOfferValidationError(error);
      newestParseError ??= mapped;
    }
  }
  throw newestParseError ?? new PactServiceOfferPublicationError("invalid_offer", "PactAgent service-offer is invalid");
}
