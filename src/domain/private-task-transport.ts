import { createHash } from "node:crypto";

import { InvalidDomainInputError } from "./errors";
import { findForbiddenPublicMaterial } from "./forbidden-material";
import type { NostrPublicKey, UnsignedNostrEvent } from "./nostr";

/*
 * Private task companion transport.
 *
 * The public Nostr lifecycle (kind 3921 agreement/transition events) carries
 * only safe references and hashes — agreement metadata, state, terms
 * commitments, and result references. The actual document, prompt, complete
 * summary, sensitive evidence, and settlement secrets never appear in public
 * events. Instead they are sealed into an encrypted private task envelope
 * addressed to the intended recipient's Nostr public key and transmitted via a
 * separate private companion channel.
 *
 * This module defines the domain shapes and pure validation. The encryption
 * boundary (NIP-04 ECDH + AES) lives in the lib layer.
 */

export const PACTAGENT_PRIVATE_TASK_KIND = 30401;
export const PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION = 1;

export type PrivateTaskTransportErrorCode =
  | "invalid_payload"
  | "invalid_sealed_envelope"
  | "forbidden_material_in_cleartext"
  | "payload_too_large";

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
 * Private task payload — the sensitive data that must never appear in public
 * events. This includes the source document, the private prompt, the complete
 * summary, sensitive evidence, and settlement secrets.
 */
export interface PrivateTaskPayload {
  readonly version: 1;
  readonly agreement_id: string;
  readonly source_document: string;
  readonly input_media_type: string;
  readonly private_prompt: string;
}

/*
 * Private result payload — the complete summary and sensitive evidence produced
 * by the provider. Sealed back to the requester.
 */
export interface PrivateResultPayload {
  readonly version: 1;
  readonly agreement_id: string;
  readonly summary: string;
  readonly evidence: string;
}

const PAYLOAD_KEYS = ["version", "agreement_id", "source_document", "input_media_type", "private_prompt"] as const;
const RESULT_KEYS = ["version", "agreement_id", "summary", "evidence"] as const;

export const PRIVATE_TASK_MAXIMUM_DOCUMENT_BYTES = 1_000_000;

/*
 * Sealed envelope — the encrypted private payload plus metadata that is safe
 * to publish in the companion event. The ciphertext is the only private data;
 * all envelope fields are safe for public transport.
 */
export interface SealedPrivateTask {
  readonly version: 1;
  readonly recipient: NostrPublicKey;
  readonly sender: NostrPublicKey;
  readonly ciphertext: string;
  readonly payload_hash: string;
  readonly agreement_id: string;
}

export interface PrivateTaskReference {
  readonly hash: string;
  readonly scheme: "sha256-hex-canonical-json-v1";
  readonly kind: "task" | "result";
  readonly agreement_id: string;
}

function assertNoForbiddenMaterialInPayload(value: unknown, label: string): void {
  const reason = findForbiddenPublicMaterial(value);
  if (reason === undefined) return;
  if (reason.kind === "secret_or_token") {
    transportError(
      "forbidden_material_in_cleartext",
      `Private task ${label} contains a Cashu token, nsec, or secret material that must not appear in any event`,
    );
  }
  transportError(
    "forbidden_material_in_cleartext",
    `Private task ${label} contains a forbidden private field`,
  );
}

function requireAgreementId(value: unknown): string {
  if (typeof value !== "string") {
    transportError("invalid_payload", "Private task agreement_id must be a string");
  }
  const id = value.trim();
  if (!id || id !== value || /[\u0000-\u001f\u007f]/.test(id)) {
    transportError("invalid_payload", "Private task agreement_id must be a stable non-empty identifier");
  }
  if (findForbiddenPublicMaterial(id) !== undefined) {
    transportError("forbidden_material_in_cleartext", "Private task agreement_id contains forbidden material");
  }
  return id;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    transportError("invalid_payload", `Private task ${field} must be a non-empty string`);
  }
  return value;
}

function computePayloadHash(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

export function validatePrivateTaskPayload(input: unknown): PrivateTaskPayload {
  if (typeof input !== "object" || input === null) {
    transportError("invalid_payload", "Private task payload must be an object");
  }
  const candidate = input as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !PAYLOAD_KEYS.includes(key as (typeof PAYLOAD_KEYS)[number]))) {
    transportError("invalid_payload", "Private task payload contains unsupported fields");
  }
  if (PAYLOAD_KEYS.some((key) => !(key in candidate))) {
    transportError("invalid_payload", "Private task payload is missing required fields");
  }
  if (candidate.version !== PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION) {
    transportError("invalid_payload", "Private task payload version is not supported");
  }
  const agreementId = requireAgreementId(candidate.agreement_id);
  const sourceDocument = requireNonEmptyString(candidate.source_document, "source_document");
  if (Buffer.byteLength(sourceDocument, "utf8") > PRIVATE_TASK_MAXIMUM_DOCUMENT_BYTES) {
    transportError("payload_too_large", "Private task source_document exceeds the maximum document size");
  }
  const inputMediaType = requireNonEmptyString(candidate.input_media_type, "input_media_type");
  const privatePrompt = requireNonEmptyString(candidate.private_prompt, "private_prompt");

  const payload: PrivateTaskPayload = {
    version: PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION,
    agreement_id: agreementId,
    source_document: sourceDocument,
    input_media_type: inputMediaType,
    private_prompt: privatePrompt,
  };

  assertNoForbiddenMaterialInPayload(payload, "payload");
  return payload;
}

export function validatePrivateResultPayload(input: unknown): PrivateResultPayload {
  if (typeof input !== "object" || input === null) {
    transportError("invalid_payload", "Private result payload must be an object");
  }
  const candidate = input as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !RESULT_KEYS.includes(key as (typeof RESULT_KEYS)[number]))) {
    transportError("invalid_payload", "Private result payload contains unsupported fields");
  }
  if (RESULT_KEYS.some((key) => !(key in candidate))) {
    transportError("invalid_payload", "Private result payload is missing required fields");
  }
  if (candidate.version !== PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION) {
    transportError("invalid_payload", "Private result payload version is not supported");
  }
  const agreementId = requireAgreementId(candidate.agreement_id);
  const summary = requireNonEmptyString(candidate.summary, "summary");
  const evidence = requireNonEmptyString(candidate.evidence, "evidence");

  const result: PrivateResultPayload = {
    version: PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION,
    agreement_id: agreementId,
    summary,
    evidence,
  };

  assertNoForbiddenMaterialInPayload(result, "result");
  return result;
}

/*
 * Compute a safe public reference (sha256 hash) for a private task payload.
 * This reference can appear in public lifecycle events without revealing the
 * private data. The hash is computed over canonical JSON so it is deterministic.
 */
export function createPrivateTaskReference(payload: PrivateTaskPayload): PrivateTaskReference {
  const canonical = canonicalizePayload(payload);
  return {
    hash: computePayloadHash(canonical),
    scheme: "sha256-hex-canonical-json-v1",
    kind: "task",
    agreement_id: payload.agreement_id,
  };
}

export function createPrivateResultReference(result: PrivateResultPayload): PrivateTaskReference {
  const canonical = canonicalizeResult(result);
  return {
    hash: computePayloadHash(canonical),
    scheme: "sha256-hex-canonical-json-v1",
    kind: "result",
    agreement_id: result.agreement_id,
  };
}

function canonicalizePayload(payload: PrivateTaskPayload): string {
  return JSON.stringify({
    agreement_id: payload.agreement_id,
    input_media_type: payload.input_media_type,
    private_prompt: payload.private_prompt,
    source_document: payload.source_document,
    version: payload.version,
  });
}

function canonicalizeResult(result: PrivateResultPayload): string {
  return JSON.stringify({
    agreement_id: result.agreement_id,
    evidence: result.evidence,
    summary: result.summary,
    version: result.version,
  });
}

const SEALED_KEYS = ["version", "recipient", "sender", "ciphertext", "payload_hash", "agreement_id"] as const;

export function validateSealedPrivateTask(input: unknown): SealedPrivateTask {
  if (typeof input !== "object" || input === null) {
    transportError("invalid_sealed_envelope", "Sealed private task must be an object");
  }
  const candidate = input as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !SEALED_KEYS.includes(key as (typeof SEALED_KEYS)[number]))) {
    transportError("invalid_sealed_envelope", "Sealed private task contains unsupported fields");
  }
  if (SEALED_KEYS.some((key) => !(key in candidate))) {
    transportError("invalid_sealed_envelope", "Sealed private task is missing required fields");
  }
  if (candidate.version !== PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION) {
    transportError("invalid_sealed_envelope", "Sealed private task version is not supported");
  }
  if (typeof candidate.recipient !== "string" || !/^[0-9a-f]{64}$/.test(candidate.recipient)) {
    transportError("invalid_sealed_envelope", "Sealed private task recipient must be a valid Nostr public key");
  }
  if (typeof candidate.sender !== "string" || !/^[0-9a-f]{64}$/.test(candidate.sender)) {
    transportError("invalid_sealed_envelope", "Sealed private task sender must be a valid Nostr public key");
  }
  if (typeof candidate.ciphertext !== "string" || candidate.ciphertext.length === 0) {
    transportError("invalid_sealed_envelope", "Sealed private task ciphertext must be a non-empty string");
  }
  if (typeof candidate.payload_hash !== "string" || !/^[0-9a-f]{64}$/.test(candidate.payload_hash)) {
    transportError("invalid_sealed_envelope", "Sealed private task payload_hash must be a sha256 hex digest");
  }
  const agreementId = requireAgreementId(candidate.agreement_id);

  return {
    version: PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION,
    recipient: candidate.recipient as NostrPublicKey,
    sender: candidate.sender as NostrPublicKey,
    ciphertext: candidate.ciphertext,
    payload_hash: candidate.payload_hash,
    agreement_id: agreementId,
  };
}

export function parsePrivateTaskEvent(event: UnsignedNostrEvent): SealedPrivateTask {
  if (event.kind !== PACTAGENT_PRIVATE_TASK_KIND) {
    transportError("invalid_sealed_envelope", "Private task event must use the PactAgent private task kind");
  }
  for (const tag of event.tags) {
    if (!["d", "p", "a"].includes(tag[0]) || tag.length !== 2) {
      transportError("invalid_sealed_envelope", "Private task event contains unsupported tags");
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(event.content);
  } catch {
    transportError("invalid_sealed_envelope", "Private task event content must be valid JSON");
  }
  const sealed = validateSealedPrivateTask(raw);
  if (sealed.sender !== event.pubkey) {
    transportError("invalid_sealed_envelope", "Sealed private task sender must match the event author");
  }
  const dTags = event.tags.filter((tag) => tag[0] === "d");
  if (dTags.length !== 1 || dTags[0][1] !== sealed.agreement_id) {
    transportError("invalid_sealed_envelope", "Private task event d tag must match the agreement_id");
  }
  return sealed;
}
