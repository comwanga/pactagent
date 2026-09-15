import { createHash } from "node:crypto";
import { nip44 } from "nostr-tools";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { InvalidDomainInputError } from "../domain/errors";
import {
  nostrPublicKey,
  parseSignedNostrEvent,
  verifySignedNostrEvent,
  type NostrPublicKey,
  type NostrSigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "../domain/nostr";
import {
  bytesToHex,
  hexToBytes,
  parseNostrPrivateKey,
} from "./nostr-signer";
import {
  NIP59_GIFT_WRAP_KIND,
  NIP59_SEAL_KIND,
  validatePrivateResultPayload,
  validatePrivateTaskPayload,
  validateProvenance,
  type PrivateResultPayload,
  type PrivateTaskPayload,
  type PrivateTaskProvenance,
} from "../domain/private-task-transport";
import type { NostrFilter, NostrRelayAdapter, NostrRelayPublishOptions } from "./nostr-relay";
import { createPactResultReference, DOCUMENT_SUMMARY_PROFILE_ID } from "../domain/pact-service-agreement";
import { isTimeoutError, operationOptions } from "./pontmore-publication-helpers";

/*
 * NIP-59 Gift Wrap private task transport.
 *
 * The private task payload is sealed inside a three-layer structure:
 *
 *   1. The private payload JSON (document, prompt, or summary).
 *   2. A NIP-44 conversation key derived from the sender's private key and the
 *      recipient's public key. The payload is encrypted with this key.
 *   3. A kind 13 seal: a signed event whose content is the NIP-44 ciphertext,
 *      signed by the real sender. This establishes authentic provenance.
 *   4. A kind 1059 gift wrap: a signed event whose content is NIP-44-encrypted
 *      JSON of the seal event, signed by a one-time key. Only the recipient's
 *      public key appears in the p tag. The real sender, agreement ID, and
 *      timestamps are hidden inside the encrypted layers.
 *
 * Only the gift wrap (kind 1059) is published to relays. The seal is never
 * published directly — it is recovered by the recipient after unwrapping.
 *
 * The encrypter holds its private key only inside a closure, mirroring the
 * NostrSigner pattern. It is never attached as a property, returned from any
 * method, or placed onto any event output.
 */

export const PRIVATE_TASK_RELAY_TIMEOUT_MS = 10_000;

export type PrivateTaskPublicationErrorCode =
  | "signing_failure"
  | "publication_failure"
  | "retrieval_failure"
  | "timeout"
  | "task_not_found"
  | "decryption_failure"
  | "invalid_envelope"
  | "recipient_mismatch"
  | "hash_mismatch"
  | "sender_not_authorized"
  | "invalid_wrap";

export class PrivateTaskPublicationError extends Error {
  readonly code: PrivateTaskPublicationErrorCode;

  constructor(code: PrivateTaskPublicationErrorCode, message: string) {
    super(message);
    this.name = "PrivateTaskPublicationError";
    this.code = code;
  }
}

/*
 * Encryption/decryption interface. Mirrors NostrSigner: the private key is held
 * only inside a closure and never exposed. An encrypter can sign events
 * (as a NostrSigner) and encrypt/decrypt private task payloads via NIP-44.
 */
export interface NostrEncrypter extends NostrSigner {
  encryptNip44(recipientPublicKey: NostrPublicKey, plaintext: string): string;
  decryptNip44(senderPublicKey: NostrPublicKey, ciphertext: string): string;
}

export function generateNostrPrivateKeyForEncrypter(): string {
  return bytesToHex(generateSecretKey());
}

function copyTags(tags: readonly (readonly [string, ...string[]])[]): [string, ...string[]][] {
  return tags.map((tag) => [...tag] as [string, ...string[]]);
}

export function createLocalNostrEncrypter(privateKeyHex: string): NostrEncrypter {
  const privateKey = parseNostrPrivateKey(privateKeyHex);
  const publicKey = nostrPublicKey(getPublicKey(hexToBytes(privateKey)));
  const privateKeyBytes = hexToBytes(privateKey);

  return {
    publicKey,
    async sign(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
      if (event.pubkey !== publicKey) {
        throw new InvalidDomainInputError("Encrypter identity does not match the event");
      }
      const signed = finalizeEvent(
        {
          created_at: event.created_at,
          kind: event.kind,
          tags: copyTags(event.tags),
          content: event.content,
        },
        privateKeyBytes,
      );
      const result: SignedNostrEvent = {
        pubkey: nostrPublicKey(signed.pubkey),
        created_at: signed.created_at,
        kind: signed.kind,
        tags: copyTags(event.tags),
        content: signed.content,
        id: signed.id,
        sig: signed.sig,
      };
      verifySignedNostrEvent(result);
      return result;
    },
    encryptNip44(recipientPublicKey: NostrPublicKey, plaintext: string): string {
      const conversationKey = nip44.getConversationKey(privateKeyBytes, recipientPublicKey);
      return nip44.encrypt(plaintext, conversationKey);
    },
    decryptNip44(senderPublicKey: NostrPublicKey, ciphertext: string): string {
      const conversationKey = nip44.getConversationKey(privateKeyBytes, senderPublicKey);
      try {
        return nip44.decrypt(ciphertext, conversationKey);
      } catch {
        throw new PrivateTaskPublicationError("decryption_failure", "NIP-44 decryption failed");
      }
    },
  };
}

interface SealResult {
  readonly sealEvent: SignedNostrEvent;
  readonly wrapEvent: SignedNostrEvent;
}

/*
 * Build a NIP-59 Gift Wrap for a private payload. The seal (kind 13) is signed
 * by the real sender and its content is NIP-44-encrypted payload JSON. The
 * gift wrap (kind 1059) is signed by a one-time key and its content is
 * NIP-44-encrypted seal event JSON. Only the wrap is published.
 *
 * The wrap is signed by the one-time key inside this function — the one-time
 * private key is never exposed outside the closure and is discarded after
 * signing.
 */
async function buildGiftWrap(
  payloadJson: string,
  senderEncrypter: NostrEncrypter,
  recipient: NostrPublicKey,
  createdAt: number,
): Promise<SealResult> {
  const sealContent = senderEncrypter.encryptNip44(recipient, payloadJson);

  const sealUnsigned: UnsignedNostrEvent = {
    pubkey: senderEncrypter.publicKey,
    created_at: createdAt,
    kind: NIP59_SEAL_KIND,
    tags: [],
    content: sealContent,
  };
  const sealEvent = await senderEncrypter.sign(sealUnsigned);

  const oneTimeSk = generateSecretKey();
  const oneTimePk = nostrPublicKey(getPublicKey(oneTimeSk));
  const oneTimeConversationKey = nip44.getConversationKey(oneTimeSk, recipient);
  const wrapContent = nip44.encrypt(JSON.stringify(sealEvent), oneTimeConversationKey);

  const wrapUnsigned: UnsignedNostrEvent = {
    pubkey: oneTimePk,
    created_at: createdAt,
    kind: NIP59_GIFT_WRAP_KIND,
    tags: [["p", recipient]],
    content: wrapContent,
  };

  const wrapSigned = finalizeEvent(
    {
      created_at: wrapUnsigned.created_at,
      kind: wrapUnsigned.kind,
      tags: copyTags(wrapUnsigned.tags),
      content: wrapUnsigned.content,
    },
    oneTimeSk,
  );
  const wrapEvent: SignedNostrEvent = {
    pubkey: nostrPublicKey(wrapSigned.pubkey),
    created_at: wrapSigned.created_at,
    kind: wrapSigned.kind,
    tags: copyTags(wrapUnsigned.tags),
    content: wrapSigned.content,
    id: wrapSigned.id,
    sig: wrapSigned.sig,
  };

  return { sealEvent, wrapEvent };
}

export interface SealedTaskResult {
  readonly wrapEvent: SignedNostrEvent;
  readonly payloadHash: string;
}

export interface SealedResultResult {
  readonly wrapEvent: SignedNostrEvent;
  readonly resultReference: string;
}

/*
 * Seal a private task payload into a NIP-59 Gift Wrap.
 * The payload is validated against the document-summary@1 profile before
 * encryption. Returns the unsigned wrap event ready for publication.
 */
export async function sealPrivateTask(
  payload: PrivateTaskPayload,
  senderEncrypter: NostrEncrypter,
  recipient: NostrPublicKey,
  createdAt: number,
): Promise<SealedTaskResult> {
  const validated = validatePrivateTaskPayload(payload);
  const payloadJson = JSON.stringify(validated);
  const { wrapEvent } = await buildGiftWrap(payloadJson, senderEncrypter, recipient, createdAt);
  return { wrapEvent, payloadHash: computeHash(payloadJson) };
}

export async function sealPrivateResult(
  result: PrivateResultPayload,
  senderEncrypter: NostrEncrypter,
  recipient: NostrPublicKey,
  createdAt: number,
  agreementRoot: string,
): Promise<SealedResultResult> {
  const validated = validatePrivateResultPayload(result);
  const payloadJson = JSON.stringify(validated);
  const { wrapEvent } = await buildGiftWrap(payloadJson, senderEncrypter, recipient, createdAt);
  const resultReference = createPactResultReference(DOCUMENT_SUMMARY_PROFILE_ID, agreementRoot, validated);
  return { wrapEvent, resultReference };
}

function computeHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/*
 * Unwrap a NIP-59 Gift Wrap and recover the private payload. Verifies:
 *   1. The wrap event is a valid signed kind 1059 with exactly one p tag.
 *   2. The wrap signature is valid (proves the one-time key signed it).
 *   3. The seal event inside is a valid signed kind 13.
 *   4. The seal signature is valid (proves the real sender signed it).
 *   5. The seal's sender matches the authorized sender from provenance.
 *   6. The decrypted payload passes domain validation.
 */
function unwrapGiftWrap(
  wrapEvent: SignedNostrEvent,
  recipientEncrypter: NostrEncrypter,
  provenance: PrivateTaskProvenance,
): string {
  const wrap = parseSignedNostrEvent(wrapEvent);
  verifySignedNostrEvent(wrap);

  if (wrap.kind !== NIP59_GIFT_WRAP_KIND) {
    throw new PrivateTaskPublicationError("invalid_wrap", "Gift wrap must use kind 1059");
  }

  const pTags = wrap.tags.filter((tag) => tag[0] === "p");
  if (pTags.length !== 1 || pTags[0][1] !== recipientEncrypter.publicKey) {
    throw new PrivateTaskPublicationError("recipient_mismatch", "Gift wrap p tag must match the recipient");
  }

  let sealJson: string;
  try {
    sealJson = recipientEncrypter.decryptNip44(nostrPublicKey(wrap.pubkey), wrap.content);
  } catch (error) {
    if (error instanceof PrivateTaskPublicationError) throw error;
    throw new PrivateTaskPublicationError("decryption_failure", "Failed to decrypt gift wrap content");
  }

  let sealRaw: unknown;
  try {
    sealRaw = JSON.parse(sealJson);
  } catch {
    throw new PrivateTaskPublicationError("invalid_wrap", "Decrypted gift wrap content is not valid JSON");
  }

  let sealEvent: SignedNostrEvent;
  try {
    sealEvent = parseSignedNostrEvent(sealRaw);
  } catch (error) {
    if (error instanceof Error && error.name === "NostrEventValidationError") {
      throw new PrivateTaskPublicationError("invalid_envelope", "Seal event failed NIP-01 validation");
    }
    throw new PrivateTaskPublicationError("invalid_envelope", "Seal event is malformed");
  }

  if (sealEvent.kind !== NIP59_SEAL_KIND) {
    throw new PrivateTaskPublicationError("invalid_envelope", "Seal must use kind 13");
  }

  try {
    verifySignedNostrEvent(sealEvent);
  } catch {
    throw new PrivateTaskPublicationError("invalid_envelope", "Seal signature is invalid");
  }

  if (sealEvent.pubkey !== provenance.authorizedSender) {
    throw new PrivateTaskPublicationError(
      "sender_not_authorized",
      "Seal sender is not the authorized sender for this agreement",
    );
  }

  let payloadJson: string;
  try {
    payloadJson = recipientEncrypter.decryptNip44(sealEvent.pubkey, sealEvent.content);
  } catch (error) {
    if (error instanceof PrivateTaskPublicationError) throw error;
    throw new PrivateTaskPublicationError("decryption_failure", "Failed to decrypt seal content");
  }

  return payloadJson;
}

export function openPrivateTask(
  wrapEvent: SignedNostrEvent,
  recipientEncrypter: NostrEncrypter,
  provenance: PrivateTaskProvenance,
): PrivateTaskPayload {
  const validatedProvenance = validateProvenance(provenance);
  const payloadJson = unwrapGiftWrap(wrapEvent, recipientEncrypter, validatedProvenance);
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    throw new PrivateTaskPublicationError("decryption_failure", "Decrypted payload is not valid JSON");
  }
  return validatePrivateTaskPayload(raw);
}

export function openPrivateResult(
  wrapEvent: SignedNostrEvent,
  recipientEncrypter: NostrEncrypter,
  provenance: PrivateTaskProvenance,
): PrivateResultPayload {
  const validatedProvenance = validateProvenance(provenance);
  const payloadJson = unwrapGiftWrap(wrapEvent, recipientEncrypter, validatedProvenance);
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    throw new PrivateTaskPublicationError("decryption_failure", "Decrypted result is not valid JSON");
  }
  return validatePrivateResultPayload(raw);
}

/*
 * Publish a signed gift wrap event. The wrap must already be signed by the
 * one-time key that built it (buildGiftWrap signs internally). This function
 * verifies the signature and structure before relay publication.
 */
export async function publishGiftWrap(
  wrapEvent: SignedNostrEvent,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<SignedNostrEvent> {
  let parsed: SignedNostrEvent;
  try {
    parsed = parseSignedNostrEvent(wrapEvent);
    verifySignedNostrEvent(parsed);
  } catch {
    throw new PrivateTaskPublicationError("invalid_wrap", "Gift wrap event is invalid or signature verification failed");
  }
  if (parsed.kind !== NIP59_GIFT_WRAP_KIND) {
    throw new PrivateTaskPublicationError("invalid_wrap", "Event must be a kind 1059 gift wrap");
  }
  const pTags = parsed.tags.filter((tag) => tag[0] === "p");
  if (pTags.length !== 1) {
    throw new PrivateTaskPublicationError("invalid_wrap", "Gift wrap must have exactly one p tag");
  }

  try {
    await relay.publish(parsed, operationOptions(PRIVATE_TASK_RELAY_TIMEOUT_MS, options));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new PrivateTaskPublicationError("timeout", "Gift wrap publication timed out");
    }
    throw new PrivateTaskPublicationError("publication_failure", "Gift wrap publication failed");
  }
  return parsed;
}

function giftWrapFilter(recipient: NostrPublicKey): NostrFilter {
  return {
    kinds: [NIP59_GIFT_WRAP_KIND],
    tags: { p: [recipient] },
    limit: 50,
  };
}

/*
 * Retrieve gift wrap events addressed to the recipient. Returns all signed
 * wrap events so the caller can iterate and try to unwrap each one. This
 * avoids a single malformed or hostile wrap from blocking legitimate tasks.
 * The caller filters by provenance (agreement ID, authorized sender) when
 * unwrapping.
 */
export async function retrieveGiftWraps(
  recipient: NostrPublicKey,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<SignedNostrEvent[]> {
  const filter = giftWrapFilter(recipient);
  let events: readonly SignedNostrEvent[];
  try {
    events = await relay.queryEvents(filter, operationOptions(PRIVATE_TASK_RELAY_TIMEOUT_MS, options));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new PrivateTaskPublicationError("timeout", "Gift wrap retrieval timed out");
    }
    throw new PrivateTaskPublicationError("retrieval_failure", "Gift wrap retrieval failed");
  }

  const verified: SignedNostrEvent[] = [];
  for (const raw of events) {
    try {
      const parsed = parseSignedNostrEvent(raw);
      verifySignedNostrEvent(parsed);
      if (parsed.kind === NIP59_GIFT_WRAP_KIND) {
        verified.push(parsed);
      }
    } catch {
      continue;
    }
  }

  if (verified.length === 0) {
    throw new PrivateTaskPublicationError("task_not_found", "No valid gift wraps were found");
  }

  return verified.sort((left, right) => right.created_at - left.created_at);
}

/*
 * Retrieve and unwrap the most recent valid gift wrap for a given provenance.
 * Iterates wraps in newest-first order, skipping ones that fail to unwrap or
 * don't match the provenance. Returns the first successfully unwrapped payload.
 */
export async function retrieveAndOpenPrivateTask(
  recipient: NostrPublicKey,
  recipientEncrypter: NostrEncrypter,
  provenance: PrivateTaskProvenance,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<PrivateTaskPayload> {
  const wraps = await retrieveGiftWraps(recipient, relay, options);
  for (const wrap of wraps) {
    try {
      return openPrivateTask(wrap, recipientEncrypter, provenance);
    } catch {
      continue;
    }
  }
  throw new PrivateTaskPublicationError("task_not_found", "No gift wrap matched the provenance and decrypted successfully");
}

export async function retrieveAndOpenPrivateResult(
  recipient: NostrPublicKey,
  recipientEncrypter: NostrEncrypter,
  provenance: PrivateTaskProvenance,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<PrivateResultPayload> {
  const wraps = await retrieveGiftWraps(recipient, relay, options);
  for (const wrap of wraps) {
    try {
      return openPrivateResult(wrap, recipientEncrypter, provenance);
    } catch {
      continue;
    }
  }
  throw new PrivateTaskPublicationError("task_not_found", "No gift wrap matched the provenance and decrypted successfully");
}
