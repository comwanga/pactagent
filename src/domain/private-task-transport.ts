import { findForbiddenPublicMaterial } from "./forbidden-material";
import type { NostrPublicKey } from "./nostr";

/*
 * Private task companion transport (NIP-59 Gift Wrap).
 *
 * The public Nostr lifecycle (kind 3921 agreement/transition events) carries
 * only safe references and hashes. The actual document, prompt, summary, and
 * settlement secrets are sealed into a NIP-59 Gift Wrap — a kind 1059 wrapper
 * signed by a one-time key, wrapping a kind 13 seal signed by the real sender,
 * whose content is NIP-44-encrypted private data addressed to the recipient.
 *
 * The wrapper exposes only the recipient (via the p tag) and a one-time
 * identity. The real sender, agreement ID, and timestamps are hidden inside
 * encrypted layers. This module defines the domain shapes and pure validation
 * that align with the existing #10 document-summary@1 capability profile.
 *
 * Private terms and results reuse the exact shapes defined by the #10
 * capability profile: DocumentSummaryPrivateTerms and DocumentSummaryPrivateResult.
 * The result reference is computed via the #10 profile's createResultReference
 * so it is bit-identical to what the agreement completion validator expects.
 */

/*
 * NIP-59 Gift Wrap constants. Kind 13 is the seal; kind 1059 is the wrap.
 * Neither is a PactAgent-invented kind — both are Nostr standard kinds.
 */
export const NIP59_SEAL_KIND = 13;
export const NIP59_GIFT_WRAP_KIND = 1059;
export const NIP17_PRIVATE_DIRECT_MESSAGE_KIND = 14;
export const PRIVATE_TASK_MESSAGE_VERSION = 1;

export type PrivateTaskTransportErrorCode =
  | "invalid_payload"
  | "invalid_sealed_envelope"
  | "forbidden_material_in_cleartext"
  | "payload_too_large"
  | "recipient_mismatch"
  | "sender_not_authorized"
  | "agreement_mismatch"
  | "invalid_rumor";

import { InvalidDomainInputError } from "./errors";

export class PrivateTaskTransportError extends InvalidDomainInputError {
  readonly code: PrivateTaskTransportErrorCode;

  constructor(code: PrivateTaskTransportErrorCode, message: string) {
    super(message);
    this.name = "PrivateTaskTransportError";
    this.code = code;
  }
}

function transportError(code: PrivateTaskTransportErrorCode, message: string): never {
  throw new PrivateTaskTransportError(code, message);
}

/*
 * Private task payload — the sensitive data sealed inside the Gift Wrap.
 * This shape is compatible with DocumentSummaryPrivateTerms from #10:
 *   - source_document: the confidential document
 *   - input_media_type: restricted to text/plain or application/pdf
 *   - private_prompt: optional instruction
 *
 * The agreement_id and agreement_root are NOT inside the payload — they are
 * passed separately to the seal/open functions so the encrypted content does
 * not need to carry protocol metadata.
 */
export interface PrivateTaskPayload {
  readonly source_document: string;
  readonly input_media_type: "text/plain" | "application/pdf";
  readonly private_prompt?: string;
}

/*
 * Private result payload — compatible with DocumentSummaryPrivateResult from #10:
 *   - summary: the complete summary
 */
export interface PrivateResultPayload {
  readonly summary: string;
}

interface PrivateMessageBinding {
  readonly version: 1;
  readonly agreement_id: string;
  readonly agreement_root: string;
  readonly sender: NostrPublicKey;
  readonly recipient: NostrPublicKey;
}

export interface PrivateTaskMessage extends PrivateMessageBinding {
  readonly message_type: "task";
  readonly payload: PrivateTaskPayload;
}

export interface PrivateResultMessage extends PrivateMessageBinding {
  readonly message_type: "result";
  readonly payload: PrivateResultPayload;
}

const ALLOWED_MEDIA_TYPES = ["text/plain", "application/pdf"] as const;
const MAX_DOCUMENT_BYTES = 1_000_000;
export const PRIVATE_TASK_MAX_PROMPT_BYTES = 64 * 1024;
export const PRIVATE_RESULT_MAX_SUMMARY_BYTES = 1_000_000;
export const PRIVATE_MESSAGE_MAX_AGREEMENT_ID_BYTES = 128;

function exceedsUtf8Bytes(value: string, maximumBytes: number): boolean {
  return Buffer.byteLength(value, "utf8") > maximumBytes;
}

function assertNoForbiddenMaterial(value: unknown, label: string): void {
  const reason = findForbiddenPublicMaterial(value);
  if (reason === undefined) return;
  transportError(
    "forbidden_material_in_cleartext",
    `Private task ${label} contains forbidden Cashu token, nsec, or secret material`,
  );
}

export function validatePrivateTaskPayload(input: unknown): PrivateTaskPayload {
  if (typeof input !== "object" || input === null) {
    transportError("invalid_payload", "Private task payload must be an object");
  }
  const candidate = input as Record<string, unknown>;
  const allowedKeys = ["source_document", "input_media_type", "private_prompt"];
  if (Object.keys(candidate).some((key) => !allowedKeys.includes(key))) {
    transportError("invalid_payload", "Private task payload contains unsupported fields");
  }
  if (typeof candidate.source_document !== "string" || candidate.source_document.length === 0) {
    transportError("invalid_payload", "Private task source_document must be a non-empty string");
  }
  if (Buffer.byteLength(candidate.source_document as string, "utf8") > MAX_DOCUMENT_BYTES) {
    transportError("payload_too_large", "Private task source_document exceeds the maximum document size");
  }
  if (!ALLOWED_MEDIA_TYPES.includes(candidate.input_media_type as (typeof ALLOWED_MEDIA_TYPES)[number])) {
    transportError("invalid_payload", "Private task input_media_type must be text/plain or application/pdf");
  }
  if (candidate.private_prompt !== undefined && (typeof candidate.private_prompt !== "string" || candidate.private_prompt.length === 0)) {
    transportError("invalid_payload", "Private task private_prompt must be a non-empty string if present");
  }
  if (
    typeof candidate.private_prompt === "string" &&
    exceedsUtf8Bytes(candidate.private_prompt, PRIVATE_TASK_MAX_PROMPT_BYTES)
  ) {
    transportError("payload_too_large", "Private task private_prompt exceeds the maximum prompt size");
  }

  const payload: PrivateTaskPayload = {
    source_document: candidate.source_document as string,
    input_media_type: candidate.input_media_type as "text/plain" | "application/pdf",
    ...(candidate.private_prompt !== undefined ? { private_prompt: candidate.private_prompt as string } : {}),
  };

  assertNoForbiddenMaterial(payload, "payload");
  return payload;
}

export function validatePrivateResultPayload(input: unknown): PrivateResultPayload {
  if (typeof input !== "object" || input === null) {
    transportError("invalid_payload", "Private result payload must be an object");
  }
  const candidate = input as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== "summary")) {
    transportError("invalid_payload", "Private result payload contains unsupported fields");
  }
  if (typeof candidate.summary !== "string" || (candidate.summary as string).trim().length === 0) {
    transportError("invalid_payload", "Private result summary must be a non-empty string");
  }
  if (
    typeof candidate.summary === "string" &&
    exceedsUtf8Bytes(candidate.summary, PRIVATE_RESULT_MAX_SUMMARY_BYTES)
  ) {
    transportError("payload_too_large", "Private result summary exceeds the maximum result size");
  }

  const result: PrivateResultPayload = { summary: candidate.summary as string };
  assertNoForbiddenMaterial(result, "result");
  return result;
}

/*
 * Provenance binding — the set of Nostr public keys authorized to send a
 * private task for a given agreement. For a document-summary agreement, the
 * authorized sender of a task is the requester; the authorized sender of a
 * result is the provider. This binding is checked after unwrapping so an
 * unrelated signer cannot inject or replace tasks.
 */
export interface PrivateTaskProvenance {
  readonly agreementId: string;
  readonly agreementRoot: string;
  readonly authorizedSender: NostrPublicKey;
  readonly recipient: NostrPublicKey;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    transportError("invalid_payload", `Private task ${field} must be a non-empty string`);
  }
  return value;
}

export function validateProvenance(input: unknown): PrivateTaskProvenance {
  if (typeof input !== "object" || input === null) {
    transportError("invalid_payload", "Private task provenance must be an object");
  }
  const candidate = input as Record<string, unknown>;
  const allowedKeys = ["agreementId", "agreementRoot", "authorizedSender", "recipient"];
  if (Object.keys(candidate).some((key) => !allowedKeys.includes(key))) {
    transportError("invalid_payload", "Private task provenance contains unsupported fields");
  }
  if (allowedKeys.some((key) => !(key in candidate))) {
    transportError("invalid_payload", "Private task provenance is missing required fields");
  }
  const agreementId = requireNonEmptyString(candidate.agreementId, "agreementId");
  if (exceedsUtf8Bytes(agreementId, PRIVATE_MESSAGE_MAX_AGREEMENT_ID_BYTES)) {
    transportError("payload_too_large", "Private task agreementId exceeds the maximum identifier size");
  }
  const agreementRoot = requireNonEmptyString(candidate.agreementRoot, "agreementRoot");
  if (!/^[0-9a-f]{64}$/.test(agreementRoot)) {
    transportError("invalid_payload", "Private task agreementRoot must be a Nostr event id");
  }
  if (typeof candidate.authorizedSender !== "string" || !/^[0-9a-f]{64}$/.test(candidate.authorizedSender)) {
    transportError("invalid_payload", "Private task authorizedSender must be a valid Nostr public key");
  }
  if (typeof candidate.recipient !== "string" || !/^[0-9a-f]{64}$/.test(candidate.recipient)) {
    transportError("invalid_payload", "Private task recipient must be a valid Nostr public key");
  }
  if (candidate.authorizedSender === candidate.recipient) {
    transportError("invalid_payload", "Private task sender and recipient must be independent identities");
  }
  assertNoForbiddenMaterial(agreementId, "agreementId");
  assertNoForbiddenMaterial(agreementRoot, "agreementRoot");
  return {
    agreementId,
    agreementRoot,
    authorizedSender: candidate.authorizedSender as NostrPublicKey,
    recipient: candidate.recipient as NostrPublicKey,
  };
}

const PRIVATE_MESSAGE_KEYS = [
  "version",
  "message_type",
  "agreement_id",
  "agreement_root",
  "sender",
  "recipient",
  "payload",
] as const;

function parsePrivateMessageBinding(
  input: unknown,
  expectedType: "task" | "result",
  provenance: PrivateTaskProvenance,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null) {
    transportError("invalid_rumor", "Private message must be an object");
  }
  const candidate = input as Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) => !PRIVATE_MESSAGE_KEYS.includes(key as (typeof PRIVATE_MESSAGE_KEYS)[number]),
    ) ||
    PRIVATE_MESSAGE_KEYS.some((key) => !(key in candidate))
  ) {
    transportError("invalid_rumor", "Private message fields are invalid");
  }
  if (
    candidate.version !== PRIVATE_TASK_MESSAGE_VERSION ||
    candidate.message_type !== expectedType
  ) {
    transportError("invalid_rumor", "Private message type or version is invalid");
  }
  if (
    candidate.agreement_id !== provenance.agreementId ||
    candidate.agreement_root !== provenance.agreementRoot
  ) {
    transportError("agreement_mismatch", "Private message does not match the agreement");
  }
  if (candidate.sender !== provenance.authorizedSender) {
    transportError("sender_not_authorized", "Private message sender is not authorized");
  }
  if (candidate.recipient !== provenance.recipient) {
    transportError("recipient_mismatch", "Private message recipient does not match the agreement");
  }
  return candidate;
}

function privateMessageBinding(provenance: PrivateTaskProvenance): PrivateMessageBinding {
  return {
    version: PRIVATE_TASK_MESSAGE_VERSION,
    agreement_id: provenance.agreementId,
    agreement_root: provenance.agreementRoot,
    sender: provenance.authorizedSender,
    recipient: provenance.recipient,
  };
}

export function createPrivateTaskMessage(
  payload: PrivateTaskPayload,
  provenance: PrivateTaskProvenance,
): PrivateTaskMessage {
  const binding = validateProvenance(provenance);
  return {
    ...privateMessageBinding(binding),
    message_type: "task",
    payload: validatePrivateTaskPayload(payload),
  };
}

export function createPrivateResultMessage(
  payload: PrivateResultPayload,
  provenance: PrivateTaskProvenance,
): PrivateResultMessage {
  const binding = validateProvenance(provenance);
  return {
    ...privateMessageBinding(binding),
    message_type: "result",
    payload: validatePrivateResultPayload(payload),
  };
}

export function parsePrivateTaskMessage(
  input: unknown,
  provenance: PrivateTaskProvenance,
): PrivateTaskMessage {
  const binding = validateProvenance(provenance);
  const candidate = parsePrivateMessageBinding(input, "task", binding);
  return {
    ...privateMessageBinding(binding),
    message_type: "task",
    payload: validatePrivateTaskPayload(candidate.payload),
  };
}

export function parsePrivateResultMessage(
  input: unknown,
  provenance: PrivateTaskProvenance,
): PrivateResultMessage {
  const binding = validateProvenance(provenance);
  const candidate = parsePrivateMessageBinding(input, "result", binding);
  return {
    ...privateMessageBinding(binding),
    message_type: "result",
    payload: validatePrivateResultPayload(candidate.payload),
  };
}
