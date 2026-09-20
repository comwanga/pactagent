import {
  NostrEventValidationError,
  parseSignedNostrEvent,
  verifySignedNostrEvent,
  type NostrSigner,
  type SignedNostrEvent,
} from "../domain/nostr";
import {
  parseCashuEscrowDescriptorEvent,
  parsePontmoreEscrowDescriptorReference,
  PIP01_ESCROW_DESCRIPTOR_KIND,
  PontmoreEscrowDescriptorError,
  type PontmoreEscrowDescriptor,
} from "../domain/pontmore-escrow";
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

export type Pip01PublicationErrorCode =
  | "signing_failure"
  | "publication_failure"
  | "retrieval_failure"
  | "timeout"
  | "descriptor_not_found"
  | "descriptor_agent_mismatch"
  | "invalid_nip01"
  | "invalid_signature"
  | "invalid_descriptor";

export class Pip01PublicationError extends Error {
  readonly code: Pip01PublicationErrorCode;

  constructor(code: Pip01PublicationErrorCode, message: string) {
    super(message);
    this.name = "Pip01PublicationError";
    this.code = code;
  }
}

export const PIP01_RELAY_TIMEOUT_MS = 10_000;

function validatedDescriptorDraft(
  descriptor: PontmoreEscrowDescriptor,
): PontmoreEscrowDescriptor {
  const parsed = parseCashuEscrowDescriptorEvent(descriptor.event);
  if (
    parsed.identifier !== descriptor.identifier ||
    parsed.address !== descriptor.address ||
    JSON.stringify(parsed.content) !== JSON.stringify(descriptor.content)
  ) {
    throw new PontmoreEscrowDescriptorError(
      "invalid_descriptor",
      "PIP-01 descriptor model does not match its event draft",
    );
  }
  return parsed;
}

export async function signCashuEscrowDescriptor(
  descriptor: PontmoreEscrowDescriptor,
  signer: NostrSigner,
): Promise<SignedNostrEvent> {
  const draft = validatedDescriptorDraft(descriptor).event;
  let signedValue: SignedNostrEvent;
  try {
    signedValue = await signer.sign(draft);
  } catch {
    throw new Pip01PublicationError("signing_failure", "PIP-01 descriptor signing failed");
  }

  const signed = parseSignedNostrEvent(signedValue);
  if (!sameUnsignedEvent(draft, signed)) {
    throw new NostrEventValidationError(
      "invalid_nostr_event",
      "Signer returned an event that does not match the PIP-01 draft",
    );
  }
  verifySignedNostrEvent(signed);
  return signed;
}

export async function publishSignedCashuEscrowDescriptor(
  event: SignedNostrEvent,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<void> {
  const signed = parseSignedNostrEvent(event);
  verifySignedNostrEvent(signed);
  parseCashuEscrowDescriptorEvent(signed);
  try {
    await relay.publish(signed, operationOptions(PIP01_RELAY_TIMEOUT_MS, options));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Pip01PublicationError("timeout", "PIP-01 descriptor publication timed out");
    }
    throw new Pip01PublicationError(
      "publication_failure",
      "PIP-01 descriptor publication failed",
    );
  }
}

export async function signAndPublishCashuEscrowDescriptor(
  descriptor: PontmoreEscrowDescriptor,
  signer: NostrSigner,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<SignedNostrEvent> {
  const signed = await signCashuEscrowDescriptor(descriptor, signer);
  await publishSignedCashuEscrowDescriptor(signed, relay, options);
  return signed;
}

export function escrowDescriptorFilter(reference: string): NostrFilter {
  const parsed = parsePontmoreEscrowDescriptorReference(reference);
  return {
    kinds: [PIP01_ESCROW_DESCRIPTOR_KIND],
    authors: [parsed.publicKey],
    tags: { d: [parsed.identifier] },
    limit: 10,
  };
}

function hasDescriptorAddress(event: SignedNostrEvent, reference: string): boolean {
  const parsed = parsePontmoreEscrowDescriptorReference(reference);
  const identifierTags = event.tags.filter((tag) => tag[0] === "d");
  return (
    event.kind === parsed.kind &&
    event.pubkey === parsed.publicKey &&
    identifierTags.length === 1 &&
    identifierTags[0][1] === parsed.identifier
  );
}

function matchesRawDescriptorAddress(raw: unknown, reference: string): boolean {
  const parsed = parsePontmoreEscrowDescriptorReference(reference);
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (r.kind !== parsed.kind || typeof r.pubkey !== "string" || r.pubkey !== parsed.publicKey) return false;
  if (!Array.isArray(r.tags)) return false;
  const dTags = r.tags.filter((tag: unknown) => Array.isArray(tag) && tag[0] === "d");
  return dTags.length === 1 && dTags[0][1] === parsed.identifier;
}

function mapDescriptorValidationError(error: unknown): Pip01PublicationError {
  if (error instanceof NostrEventValidationError) {
    return error.code === "invalid_signature"
      ? new Pip01PublicationError("invalid_signature", "PIP-01 descriptor signature is invalid")
      : new Pip01PublicationError("invalid_nip01", "PIP-01 descriptor failed NIP-01 validation");
  }
  if (error instanceof PontmoreEscrowDescriptorError) {
    return new Pip01PublicationError("invalid_descriptor", error.message);
  }
  return new Pip01PublicationError("invalid_descriptor", "PIP-01 descriptor is invalid");
}

export async function retrieveCashuEscrowDescriptor(
  reference: string,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<PontmoreEscrowDescriptor<SignedNostrEvent>> {
  const filter = escrowDescriptorFilter(reference);
  let events: readonly SignedNostrEvent[];
  try {
    events = await relay.queryEvents(filter, operationOptions(PIP01_RELAY_TIMEOUT_MS, options));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Pip01PublicationError("timeout", "PIP-01 descriptor retrieval timed out");
    }
    throw new Pip01PublicationError("retrieval_failure", "PIP-01 descriptor retrieval failed");
  }

  if (events.length === 0) {
    throw new Pip01PublicationError("descriptor_not_found", "PIP-01 descriptor was not found");
  }

  const authenticMatches: SignedNostrEvent[] = [];
  let anyAddressMatch = false;
  let firstError: Pip01PublicationError | undefined;

  for (const raw of events) {
    let parsed: SignedNostrEvent;
    try {
      parsed = parseSignedNostrEvent(raw);
    } catch (error) {
      if (matchesRawDescriptorAddress(raw, reference)) {
        anyAddressMatch = true;
        if (!firstError) firstError = mapDescriptorValidationError(error);
      }
      continue;
    }

    if (!hasDescriptorAddress(parsed, reference)) continue;
    anyAddressMatch = true;

    try {
      verifySignedNostrEvent(parsed);
      authenticMatches.push(parsed);
    } catch (error) {
      if (!firstError) firstError = mapDescriptorValidationError(error);
    }
  }

  if (authenticMatches.length === 0) {
    if (anyAddressMatch && firstError) throw firstError;
    throw new Pip01PublicationError(
      "descriptor_agent_mismatch",
      "Relay result does not match the requested PIP-01 descriptor reference",
    );
  }

  authenticMatches.sort((left, right) => {
    const timestampOrder = right.created_at - left.created_at;
    return timestampOrder === 0 ? left.id.localeCompare(right.id) : timestampOrder;
  });
  let newestParseError: Pip01PublicationError | undefined;
  for (const current of authenticMatches) {
    try {
      const descriptor = parseCashuEscrowDescriptorEvent(current);
      if (descriptor.address !== reference) {
        throw new Pip01PublicationError(
          "descriptor_agent_mismatch",
          "Retrieved PIP-01 descriptor does not match its agent reference",
        );
      }
      return descriptor;
    } catch (error) {
      const mapped =
        error instanceof Pip01PublicationError
          ? error
          : mapDescriptorValidationError(error);
      newestParseError ??= mapped;
    }
  }
  throw newestParseError ?? new Pip01PublicationError("invalid_descriptor", "PIP-01 descriptor is invalid");
}
