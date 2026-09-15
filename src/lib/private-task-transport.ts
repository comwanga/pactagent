import { nip04 } from "nostr-tools";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { InvalidDomainInputError } from "../domain/errors";
import {
  type NostrPublicKey,
  type NostrSigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
  nostrPublicKey,
} from "../domain/nostr";
import {
  bytesToHex,
  hexToBytes,
  parseNostrPrivateKey,
} from "./nostr-signer";
import {
  createPrivateTaskReference,
  createPrivateResultReference,
  PACTAGENT_PRIVATE_TASK_KIND,
  parsePrivateTaskEvent,
  validatePrivateTaskPayload,
  validatePrivateResultPayload,
  validateSealedPrivateTask,
  PrivateTaskTransportError,
  type PrivateResultPayload,
  type PrivateTaskPayload,
  type PrivateTaskReference,
  type SealedPrivateTask,
} from "../domain/private-task-transport";
import type { NostrFilter, NostrRelayAdapter, NostrRelayPublishOptions } from "./nostr-relay";
import { isTimeoutError, operationOptions, sameUnsignedEvent } from "./pontmore-publication-helpers";

/*
 * NIP-04-based private task transport.
 *
 * The public Nostr lifecycle (kind 3921 agreement/transition events) carries
 * only safe references and hashes. The actual document, prompt, summary, and
 * evidence are sealed into an encrypted envelope addressed to the intended
 * recipient's Nostr public key and transported via a separate kind-30401
 * companion event. Encryption uses NIP-04 (ECDH + AES-256-CBC) so only the
 * holder of the recipient's private key can recover the private data.
 *
 * The encrypter holds its private key only inside a closure, mirroring the
 * NostrSigner pattern. It is never attached as a property, returned from any
 * method, or placed onto any event output.
 */

export const PACTAGENT_PRIVATE_TASK_RELAY_TIMEOUT_MS = 10_000;

export type PrivateTaskTransportPublicationErrorCode =
  | "signing_failure"
  | "publication_failure"
  | "retrieval_failure"
  | "timeout"
  | "task_not_found"
  | "decryption_failure"
  | "invalid_envelope"
  | "recipient_mismatch"
  | "hash_mismatch";

export class PrivateTaskTransportPublicationError extends Error {
  readonly code: PrivateTaskTransportPublicationErrorCode;

  constructor(code: PrivateTaskTransportPublicationErrorCode, message: string) {
    super(message);
    this.name = "PrivateTaskTransportPublicationError";
    this.code = code;
  }
}

/*
 * Encryption/decryption interface. Mirrors NostrSigner: the private key is held
 * only inside a closure and never exposed. An encrypter can both sign events
 * (as a NostrSigner) and encrypt/decrypt private task payloads.
 */
export interface NostrEncrypter extends NostrSigner {
  encrypt(recipientPublicKey: NostrPublicKey, plaintext: string): string;
  decrypt(senderPublicKey: NostrPublicKey, ciphertext: string): string;
}

export function generateNostrPrivateKeyForEncrypter(): string {
  return bytesToHex(generateSecretKey());
}

export function createLocalNostrEncrypter(privateKeyHex: string): NostrEncrypter {
  const privateKey = parseNostrPrivateKey(privateKeyHex);
  const publicKey = nostrPublicKey(getPublicKey(hexToBytes(privateKey)));
  const privateKeyBytes = hexToBytes(privateKey);

  return {
    publicKey,
    sign(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
      if (event.pubkey !== publicKey) {
        return Promise.reject(new InvalidDomainInputError("Encrypter identity does not match the event"));
      }
      const signed = finalizeEvent(
        {
          created_at: event.created_at,
          kind: event.kind,
          tags: event.tags.map((tag) => [...tag]) as unknown as Parameters<typeof finalizeEvent>[0]["tags"],
          content: event.content,
        },
        privateKeyBytes,
      );
      return Promise.resolve({
        ...signed,
        pubkey: nostrPublicKey(signed.pubkey),
        tags: event.tags,
      });
    },
    encrypt(recipientPublicKey: NostrPublicKey, plaintext: string): string {
      return nip04.encrypt(privateKeyBytes, recipientPublicKey, plaintext);
    },
    decrypt(senderPublicKey: NostrPublicKey, ciphertext: string): string {
      try {
        return nip04.decrypt(privateKeyBytes, senderPublicKey, ciphertext);
      } catch {
        throw new PrivateTaskTransportPublicationError("decryption_failure", "NIP-04 decryption failed");
      }
    },
  };
}

function createPrivateTaskEvent(
  sealed: SealedPrivateTask,
  agreementRootAddress: string,
  updatedAt: number,
): UnsignedNostrEvent {
  const validated = validateSealedPrivateTask(sealed);
  const content = JSON.stringify({
    version: validated.version,
    recipient: validated.recipient,
    sender: validated.sender,
    ciphertext: validated.ciphertext,
    payload_hash: validated.payload_hash,
    agreement_id: validated.agreement_id,
  });
  return {
    pubkey: validated.sender,
    created_at: updatedAt,
    kind: PACTAGENT_PRIVATE_TASK_KIND,
    tags: [
      ["d", validated.agreement_id],
      ["p", validated.recipient],
      ["a", agreementRootAddress],
    ],
    content,
  };
}

export interface SealedTaskResult {
  readonly sealed: SealedPrivateTask;
  readonly reference: PrivateTaskReference;
  readonly event: UnsignedNostrEvent;
}

/*
 * Shared seal: encrypt a validated payload to the recipient and build the
 * companion event. Used by both sealPrivateTask and sealPrivateResult.
 */
function sealPayload<TPayload>(
  payload: TPayload,
  reference: PrivateTaskReference,
  recipientPublicKey: NostrPublicKey,
  senderEncrypter: NostrEncrypter,
  agreementRootAddress: string,
  updatedAt: number,
): SealedTaskResult {
  const plaintext = JSON.stringify(payload);
  const ciphertext = senderEncrypter.encrypt(recipientPublicKey, plaintext);

  const sealed: SealedPrivateTask = {
    version: 1,
    recipient: recipientPublicKey,
    sender: senderEncrypter.publicKey,
    ciphertext,
    payload_hash: reference.hash,
    agreement_id: reference.agreement_id,
  };

  const event = createPrivateTaskEvent(sealed, agreementRootAddress, updatedAt);
  return { sealed, reference, event };
}

/*
 * Seal a private task payload encrypted to the recipient. Returns the sealed
 * envelope, a safe public reference (sha256 hash), and the unsigned companion
 * event ready for signing and publication.
 */
export function sealPrivateTask(
  payload: PrivateTaskPayload,
  recipientPublicKey: NostrPublicKey,
  senderEncrypter: NostrEncrypter,
  agreementRootAddress: string,
  updatedAt: number,
): SealedTaskResult {
  const validatedPayload = validatePrivateTaskPayload(payload);
  const reference = createPrivateTaskReference(validatedPayload);
  return sealPayload(validatedPayload, reference, recipientPublicKey, senderEncrypter, agreementRootAddress, updatedAt);
}

export interface SealedResultResult {
  readonly sealed: SealedPrivateTask;
  readonly reference: PrivateTaskReference;
  readonly event: UnsignedNostrEvent;
}

export function sealPrivateResult(
  result: PrivateResultPayload,
  recipientPublicKey: NostrPublicKey,
  senderEncrypter: NostrEncrypter,
  agreementRootAddress: string,
  updatedAt: number,
): SealedResultResult {
  const validatedResult = validatePrivateResultPayload(result);
  const reference = createPrivateResultReference(validatedResult);
  return sealPayload(validatedResult, reference, recipientPublicKey, senderEncrypter, agreementRootAddress, updatedAt);
}

/*
 * Shared open: decrypt and validate a sealed envelope, verifying the payload
 * hash and agreement_id. Used by both openPrivateTask and openPrivateResult.
 */
function openSealed<TPayload extends { readonly agreement_id: string }>(
  sealed: SealedPrivateTask,
  recipientEncrypter: NostrEncrypter,
  validate: (input: unknown) => TPayload,
  computeReference: (payload: TPayload) => PrivateTaskReference,
  label: string,
): TPayload {
  const validated = validateSealedPrivateTask(sealed);
  if (validated.recipient !== recipientEncrypter.publicKey) {
    throw new PrivateTaskTransportPublicationError(
      "recipient_mismatch",
      `Sealed private ${label} is not addressed to this encrypter`,
    );
  }
  let plaintext: string;
  try {
    plaintext = recipientEncrypter.decrypt(validated.sender, validated.ciphertext);
  } catch (error) {
    if (error instanceof PrivateTaskTransportPublicationError) throw error;
    throw new PrivateTaskTransportPublicationError("decryption_failure", "NIP-04 decryption failed");
  }
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(plaintext);
  } catch {
    throw new PrivateTaskTransportPublicationError("decryption_failure", `Decrypted ${label} is not valid JSON`);
  }
  const payload = validate(rawPayload);
  const reference = computeReference(payload);
  if (reference.hash !== validated.payload_hash) {
    throw new PrivateTaskTransportPublicationError(
      "hash_mismatch",
      `Decrypted ${label} hash does not match the sealed payload_hash`,
    );
  }
  if (payload.agreement_id !== validated.agreement_id) {
    throw new PrivateTaskTransportPublicationError(
      "hash_mismatch",
      `Decrypted ${label} agreement_id does not match the sealed agreement_id`,
    );
  }
  return payload;
}

/*
 * Open a sealed private task by decrypting the ciphertext with the recipient's
 * private key. Verifies that the decrypted payload matches the sealed
 * payload_hash. Returns the recovered private task payload.
 */
export function openPrivateTask(
  sealed: SealedPrivateTask,
  recipientEncrypter: NostrEncrypter,
): PrivateTaskPayload {
  return openSealed(sealed, recipientEncrypter, validatePrivateTaskPayload, createPrivateTaskReference, "task");
}

export function openPrivateResult(
  sealed: SealedPrivateTask,
  recipientEncrypter: NostrEncrypter,
): PrivateResultPayload {
  return openSealed(sealed, recipientEncrypter, validatePrivateResultPayload, createPrivateResultReference, "result");
}

/*
 * Sign and publish a sealed private task companion event.
 */
export async function signAndPublishPrivateTaskEvent(
  event: UnsignedNostrEvent,
  signer: NostrSigner,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<SignedNostrEvent> {
  if (event.pubkey !== signer.publicKey) {
    throw new PrivateTaskTransportPublicationError("signing_failure", "Signer identity does not match the private task event");
  }
  let signed: SignedNostrEvent;
  try {
    signed = await signer.sign(event);
  } catch {
    throw new PrivateTaskTransportPublicationError("signing_failure", "Private task event signing failed");
  }
  if (!sameUnsignedEvent(event, signed)) {
    throw new PrivateTaskTransportPublicationError("signing_failure", "Signer returned a mismatched event");
  }
  try {
    await relay.publish(signed, operationOptions(PACTAGENT_PRIVATE_TASK_RELAY_TIMEOUT_MS, options));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new PrivateTaskTransportPublicationError("timeout", "Private task publication timed out");
    }
    throw new PrivateTaskTransportPublicationError("publication_failure", "Private task publication failed");
  }
  return signed;
}

function privateTaskEventFilter(agreementId: string, recipient: NostrPublicKey): NostrFilter {
  return {
    kinds: [PACTAGENT_PRIVATE_TASK_KIND],
    tags: { d: [agreementId], p: [recipient] },
    limit: 10,
  };
}

/*
 * Retrieve the newest sealed private task companion event for a given
 * agreement and recipient. Only the newest event per address is selected
 * (replacement ordering), mirroring the offer/descriptor retrieval patterns.
 */
export async function retrievePrivateTaskEvent(
  agreementId: string,
  recipient: NostrPublicKey,
  relay: NostrRelayAdapter,
  options?: NostrRelayPublishOptions,
): Promise<SealedPrivateTask> {
  const filter = privateTaskEventFilter(agreementId, recipient);
  let events: readonly SignedNostrEvent[];
  try {
    events = await relay.queryEvents(filter, operationOptions(PACTAGENT_PRIVATE_TASK_RELAY_TIMEOUT_MS, options));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new PrivateTaskTransportPublicationError("timeout", "Private task retrieval timed out");
    }
    throw new PrivateTaskTransportPublicationError("retrieval_failure", "Private task retrieval failed");
  }

  if (events.length === 0) {
    throw new PrivateTaskTransportPublicationError("task_not_found", "Private task was not found");
  }

  const sorted = [...events].sort((left, right) => {
    const order = right.created_at - left.created_at;
    return order === 0 ? left.id.localeCompare(right.id) : order;
  });

  const newest = sorted[0];
  try {
    return parsePrivateTaskEvent(newest);
  } catch (error) {
    if (error instanceof PrivateTaskTransportError) {
      throw new PrivateTaskTransportPublicationError("invalid_envelope", error.message);
    }
    throw new PrivateTaskTransportPublicationError("invalid_envelope", "Private task event is malformed");
  }
}
