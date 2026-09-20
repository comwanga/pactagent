import { createHash } from "node:crypto";
import { nip44 } from "nostr-tools";
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from "nostr-tools/pure";

import { InvalidDomainInputError } from "../domain/errors";
import {
  nostrPublicKey,
  parseSignedNostrEvent,
  parseUnsignedNostrEvent,
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
  createPrivateResultMessage,
  createPrivateTaskMessage,
  NIP17_PRIVATE_DIRECT_MESSAGE_KIND,
  NIP59_GIFT_WRAP_KIND,
  NIP59_SEAL_KIND,
  parsePrivateResultMessage,
  parsePrivateTaskMessage,
  validatePrivateResultPayload,
  validatePrivateTaskPayload,
  validateProvenance,
  type PrivateResultPayload,
  type PrivateTaskPayload,
  type PrivateTaskProvenance,
} from "../domain/private-task-transport";
export type { PrivateTaskPayload } from "../domain/private-task-transport";
import type { NostrFilter, NostrRelayAdapter, NostrRelayPublishOptions } from "./nostr-relay";
import { createPactResultReference, DOCUMENT_SUMMARY_PROFILE_ID } from "../domain/pact-service-agreement";
import { isTimeoutError, operationOptions } from "./pontmore-publication-helpers";

/*
 * NIP-59 Gift Wrap private task transport.
 *
 * The private task payload is sealed inside a four-layer structure:
 *
 *   1. A versioned private message binds the payload to its exact agreement.
 *   2. An unsigned kind-14 rumor carries that message and recipient privately.
 *   3. A kind 13 seal: a signed event whose content is the NIP-44 rumor ciphertext,
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
export const PRIVATE_TASK_GIFT_WRAP_PAGE_SIZE = 50;
export const PRIVATE_TASK_GIFT_WRAP_MAX_PAGES = 20;

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
  readonly rumorEvent: NostrRumorEvent;
  readonly sealEvent: SignedNostrEvent;
  readonly wrapEvent: SignedNostrEvent;
}

interface NostrRumorEvent extends UnsignedNostrEvent {
  readonly id: string;
}

/*
 * Build a NIP-59 Gift Wrap for a private message. The message is placed in an
 * unsigned kind-14 rumor. The seal (kind 13) is signed by the real sender and
 * contains the NIP-44-encrypted rumor. The gift wrap (kind 1059) is signed by
 * a one-time key and contains the NIP-44-encrypted seal. Only the wrap is
 * published.
 *
 * The wrap is signed by the one-time key inside this function — the one-time
 * private key is never exposed outside the closure and is discarded after
 * signing.
 */
async function buildGiftWrap(
  messageJson: string,
  senderEncrypter: NostrEncrypter,
  provenance: PrivateTaskProvenance,
  createdAt: number,
): Promise<SealResult> {
  if (senderEncrypter.publicKey !== provenance.authorizedSender) {
    throw new PrivateTaskPublicationError(
      "sender_not_authorized",
      "Private message signer is not authorized for the agreement",
    );
  }

  const rumorUnsigned: UnsignedNostrEvent = {
    pubkey: senderEncrypter.publicKey,
    created_at: createdAt,
    kind: NIP17_PRIVATE_DIRECT_MESSAGE_KIND,
    tags: [["p", provenance.recipient]],
    content: messageJson,
  };
  const rumorEvent: NostrRumorEvent = {
    ...rumorUnsigned,
    tags: copyTags(rumorUnsigned.tags),
    id: getEventHash({
      ...rumorUnsigned,
      tags: copyTags(rumorUnsigned.tags),
    }),
  };

  const sealContent = senderEncrypter.encryptNip44(
    provenance.recipient,
    JSON.stringify(rumorEvent),
  );

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
  const oneTimeConversationKey = nip44.getConversationKey(oneTimeSk, provenance.recipient);
  const wrapContent = nip44.encrypt(JSON.stringify(sealEvent), oneTimeConversationKey);

  const wrapUnsigned: UnsignedNostrEvent = {
    pubkey: oneTimePk,
    created_at: createdAt,
    kind: NIP59_GIFT_WRAP_KIND,
    tags: [["p", provenance.recipient]],
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

  return { rumorEvent, sealEvent, wrapEvent };
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
  provenance: PrivateTaskProvenance,
  createdAt: number,
): Promise<SealedTaskResult> {
  const validatedProvenance = validateProvenance(provenance);
  const message = createPrivateTaskMessage(
    validatePrivateTaskPayload(payload),
    validatedProvenance,
  );
  const messageJson = JSON.stringify(message);
  const { wrapEvent } = await buildGiftWrap(
    messageJson,
    senderEncrypter,
    validatedProvenance,
    createdAt,
  );
  return { wrapEvent, payloadHash: computeHash(messageJson) };
}

export async function sealPrivateResult(
  result: PrivateResultPayload,
  senderEncrypter: NostrEncrypter,
  provenance: PrivateTaskProvenance,
  createdAt: number,
): Promise<SealedResultResult> {
  const validatedProvenance = validateProvenance(provenance);
  const validated = validatePrivateResultPayload(result);
  const message = createPrivateResultMessage(validated, validatedProvenance);
  const { wrapEvent } = await buildGiftWrap(
    JSON.stringify(message),
    senderEncrypter,
    validatedProvenance,
    createdAt,
  );
  const resultReference = createPactResultReference(
    DOCUMENT_SUMMARY_PROFILE_ID,
    validatedProvenance.agreementRoot,
    validated,
  );
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
 *   5. The encrypted rumor id, kind, author, and recipient are valid.
 *   6. The rumor author matches both the seal and the agreement authority.
 *   7. The encrypted message binds the exact agreement and participants.
 */
function unwrapGiftWrap(
  wrapEvent: SignedNostrEvent,
  recipientEncrypter: NostrEncrypter,
  provenance: PrivateTaskProvenance,
): string {
  if (recipientEncrypter.publicKey !== provenance.recipient) {
    throw new PrivateTaskPublicationError(
      "recipient_mismatch",
      "Private message is not addressed to the agreement recipient",
    );
  }
  const wrap = parseSignedNostrEvent(wrapEvent);
  verifySignedNostrEvent(wrap);

  if (wrap.kind !== NIP59_GIFT_WRAP_KIND) {
    throw new PrivateTaskPublicationError("invalid_wrap", "Gift wrap must use kind 1059");
  }

  const pTags = wrap.tags.filter((tag) => tag[0] === "p");
  if (pTags.length !== 1 || pTags[0][1] !== provenance.recipient) {
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

  if (sealEvent.tags.length !== 0) {
    throw new PrivateTaskPublicationError("invalid_envelope", "Seal tags must be empty");
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

  let rumorJson: string;
  try {
    rumorJson = recipientEncrypter.decryptNip44(sealEvent.pubkey, sealEvent.content);
  } catch (error) {
    if (error instanceof PrivateTaskPublicationError) throw error;
    throw new PrivateTaskPublicationError("decryption_failure", "Failed to decrypt seal content");
  }

  return parseRumor(rumorJson, sealEvent.pubkey, provenance).content;
}

function parseRumor(
  rumorJson: string,
  sealAuthor: NostrPublicKey,
  provenance: PrivateTaskProvenance,
): NostrRumorEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(rumorJson);
  } catch {
    throw new PrivateTaskPublicationError("invalid_envelope", "Seal does not contain a valid rumor");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new PrivateTaskPublicationError("invalid_envelope", "Rumor must be an object");
  }
  const candidate = raw as Record<string, unknown>;
  const keys = ["id", "pubkey", "created_at", "kind", "tags", "content"];
  if (
    Object.keys(candidate).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in candidate))
  ) {
    throw new PrivateTaskPublicationError("invalid_envelope", "Rumor fields are invalid");
  }

  let unsigned: UnsignedNostrEvent;
  try {
    unsigned = parseUnsignedNostrEvent(
      JSON.stringify({
        pubkey: candidate.pubkey,
        created_at: candidate.created_at,
        kind: candidate.kind,
        tags: candidate.tags,
        content: candidate.content,
      }),
    );
  } catch {
    throw new PrivateTaskPublicationError("invalid_envelope", "Rumor event is malformed");
  }
  if (
    typeof candidate.id !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.id) ||
    candidate.id !== getEventHash({ ...unsigned, tags: copyTags(unsigned.tags) })
  ) {
    throw new PrivateTaskPublicationError("invalid_envelope", "Rumor id is invalid");
  }
  if (unsigned.kind !== NIP17_PRIVATE_DIRECT_MESSAGE_KIND) {
    throw new PrivateTaskPublicationError("invalid_envelope", "Rumor must use kind 14");
  }
  if (unsigned.pubkey !== sealAuthor || unsigned.pubkey !== provenance.authorizedSender) {
    throw new PrivateTaskPublicationError(
      "sender_not_authorized",
      "Rumor author does not match the seal and agreement authority",
    );
  }
  if (
    unsigned.tags.length !== 1 ||
    unsigned.tags[0][0] !== "p" ||
    unsigned.tags[0].length !== 2 ||
    unsigned.tags[0][1] !== provenance.recipient
  ) {
    throw new PrivateTaskPublicationError(
      "recipient_mismatch",
      "Rumor recipient does not match the agreement recipient",
    );
  }
  return { ...unsigned, tags: copyTags(unsigned.tags), id: candidate.id };
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
  return parsePrivateTaskMessage(raw, validatedProvenance).payload;
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
  return parsePrivateResultMessage(raw, validatedProvenance).payload;
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

function giftWrapFilter(recipient: NostrPublicKey, until?: number): NostrFilter {
  return {
    kinds: [NIP59_GIFT_WRAP_KIND],
    tags: { p: [recipient] },
    ...(until === undefined ? {} : { until }),
    limit: PRIVATE_TASK_GIFT_WRAP_PAGE_SIZE,
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
  const scan = await scanGiftWrapPages(recipient, relay, options, () => undefined);
  if (scan.verified.length === 0) {
    throw new PrivateTaskPublicationError("task_not_found", "No valid gift wraps were found");
  }
  return [...scan.verified].sort((left, right) => right.created_at - left.created_at);
}

async function scanGiftWrapPages<T>(
  recipient: NostrPublicKey,
  relay: NostrRelayAdapter,
  options: NostrRelayPublishOptions | undefined,
  visit: (event: SignedNostrEvent) => { readonly value: T } | undefined,
): Promise<{
  readonly verified: readonly SignedNostrEvent[];
  readonly match?: { readonly value: T };
}> {
  const timeoutMs = options?.timeoutMs ?? PRIVATE_TASK_RELAY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const verified: SignedNostrEvent[] = [];
  const seen = new Set<string>();
  let until: number | undefined;
  try {
    for (let page = 0; page < PRIVATE_TASK_GIFT_WRAP_MAX_PAGES; page += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new PrivateTaskPublicationError("timeout", "Gift wrap retrieval timed out");
      }
      const pageEvents = await relay.queryEvents(
        giftWrapFilter(recipient, until),
        operationOptions(remaining, { ...options, timeoutMs: remaining }),
      );
      const ordered = [...pageEvents].sort((left, right) => {
        const timestampOrder = right.created_at - left.created_at;
        return timestampOrder === 0 ? left.id.localeCompare(right.id) : timestampOrder;
      });
      for (const raw of ordered) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        try {
          const parsed = parseSignedNostrEvent(raw);
          verifySignedNostrEvent(parsed);
          if (parsed.kind !== NIP59_GIFT_WRAP_KIND) continue;
          verified.push(parsed);
          const match = visit(parsed);
          if (match !== undefined) {
            return { verified, match };
          }
        } catch {
          continue;
        }
      }
      if (pageEvents.length < PRIVATE_TASK_GIFT_WRAP_PAGE_SIZE) break;
      const oldestTimestamp = ordered.at(-1)?.created_at;
      if (oldestTimestamp === undefined || oldestTimestamp < 1) break;
      until = oldestTimestamp - 1;
    }
  } catch (error) {
    if (error instanceof PrivateTaskPublicationError) throw error;
    if (isTimeoutError(error)) {
      throw new PrivateTaskPublicationError("timeout", "Gift wrap retrieval timed out");
    }
    throw new PrivateTaskPublicationError("retrieval_failure", "Gift wrap retrieval failed");
  }
  return { verified };
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
  const scan = await scanGiftWrapPages(recipient, relay, options, (wrap) => {
    try {
      return { value: openPrivateTask(wrap, recipientEncrypter, provenance) };
    } catch {
      return undefined;
    }
  });
  if (scan.match) return scan.match.value;
  throw new PrivateTaskPublicationError("task_not_found", "No gift wrap matched the provenance and decrypted successfully");
}

export async function retrieveAndOpenPrivateResult(
  recipient: NostrPublicKey,
  recipientEncrypter: NostrEncrypter,
  provenance: PrivateTaskProvenance,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<PrivateResultPayload> {
  const scan = await scanGiftWrapPages(recipient, relay, options, (wrap) => {
    try {
      return { value: openPrivateResult(wrap, recipientEncrypter, provenance) };
    } catch {
      return undefined;
    }
  });
  if (scan.match) return scan.match.value;
  throw new PrivateTaskPublicationError("task_not_found", "No gift wrap matched the provenance and decrypted successfully");
}
