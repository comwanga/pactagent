import { createHash, randomBytes, randomUUID } from "node:crypto";

import { InvalidDomainInputError } from "./errors";
import {
  nostrPublicKey,
  parseSignedNostrEvent,
  serializeUnsignedNostrEvent,
  verifySignedNostrEvent,
  type NostrPublicKey,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "./nostr";
import {
  parsePontmoreAgentDefinitionEvent,
  type PontmoreAgentDefinition,
} from "./pontmore-agent";
import {
  isCashuEscrowCompatible,
  parseCashuEscrowDescriptorEvent,
  type PontmoreEscrowDescriptor,
} from "./pontmore-escrow";
import { findForbiddenPublicMaterial } from "./forbidden-material";

/** PactAgent-owned provisional/unregistered regular kind; not a Pontmore PIP or Nostr standard. */
export const PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND = 3921;
export const PACT_SERVICE_AGREEMENT_ROOT_TYPE = "pactagent/service-agreement-root@1";
export const PACT_AGREEMENT_TRANSITION_TYPE = "pactagent/service-agreement-transition@1";
export const PACT_ESCROW_AUTHORITY_SOURCE_TYPE = "pactagent/escrow-authority@1";
export const DOCUMENT_SUMMARY_PROFILE_ID = "document-summary@1";
export const PACT_TERMS_COMMITMENT_SCHEME = "sha256-salted-canonical-json-v1";
export const DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES = 1_000_000;
export const DOCUMENT_SUMMARY_MAXIMUM_EXECUTION_SECONDS = 5 * 60;
export const DOCUMENT_SUMMARY_INPUT_MEDIA_TYPES = ["text/plain", "application/pdf"] as const;

export type PactCapabilityProfileId = typeof DOCUMENT_SUMMARY_PROFILE_ID;
export type PactTermsCommitmentScheme = typeof PACT_TERMS_COMMITMENT_SCHEME;

export type PactAgreementState =
  | "proposed"
  | "accepted"
  | "escrow_funded"
  | "task_delivered"
  | "result_submitted"
  | "result_verified"
  | "release_authorized"
  | "settled"
  | "expired"
  | "refund_authorized"
  | "refunded"
  | "rejected"
  | "disputed";

export type PactAgreementActorRole = "requester" | "provider" | "escrow";

export type PactServiceAgreementErrorCode =
  | "malformed_agreement"
  | "unsupported_profile_version"
  | "invalid_reference"
  | "signer_not_authorized"
  | "invalid_transition"
  | "stale_predecessor"
  | "forked_history"
  | "terminal_state_transition"
  | "timeout_not_reached"
  | "malformed_event"
  | "tag_content_mismatch"
  | "privacy_boundary_violation";

export class PactServiceAgreementError extends InvalidDomainInputError {
  readonly code: PactServiceAgreementErrorCode;

  constructor(code: PactServiceAgreementErrorCode, message: string) {
    super(message);
    this.name = "PactServiceAgreementError";
    this.code = code;
  }
}

function agreementError(code: PactServiceAgreementErrorCode, message: string): never {
  throw new PactServiceAgreementError(code, message);
}

export interface PactServiceAgreementContent {
  readonly version: 1;
  readonly agreement_id: string;
  readonly capability_profile: "document-summary@1";
  readonly requester: string;
  readonly provider: string;
  readonly requester_definition: string;
  readonly provider_definition: string;
  readonly escrow_descriptor: string;
  readonly amount_sats: string;
  readonly settlement_network: "cashu";
  readonly maximum_execution_seconds: number;
  readonly expires_at: number;
  readonly terms_commitment: string;
  readonly terms_commitment_scheme: "sha256-salted-canonical-json-v1";
}

export interface PactServiceAgreementRoot<
  TEvent extends UnsignedNostrEvent = UnsignedNostrEvent,
> {
  readonly event: TEvent;
  readonly content: PactServiceAgreementContent;
}

export interface PactAgreementTransitionContent {
  readonly version: 1;
  readonly agreement_id: string;
  readonly agreement_root: string;
  readonly predecessor: string | null;
  readonly state: PactAgreementState;
  readonly prev_state: PactAgreementState;
  readonly actor: string;
  readonly actor_role: PactAgreementActorRole;
  readonly reason_code?: string;
  readonly result_reference?: string;
}

export interface PactAgreementTransition<
  TEvent extends UnsignedNostrEvent = UnsignedNostrEvent,
> {
  readonly event: TEvent;
  readonly content: PactAgreementTransitionContent;
}

export interface PactAgreementReferences {
  readonly requesterDefinition: SignedNostrEvent;
  readonly providerDefinition: SignedNostrEvent;
  readonly escrowDescriptor: SignedNostrEvent;
}

type SignedPontmoreAgentDefinition = PontmoreAgentDefinition<SignedNostrEvent>;

const escrowAuthorityBindingBrand: unique symbol = Symbol("PactEscrowAuthorityBinding");
const completionDecisionBrand: unique symbol = Symbol("PactCompletionDecision");
const validatedEscrowAuthorityBindings = new WeakSet<object>();
const validatedCompletionDecisions = new WeakSet<object>();

/**
 * A trusted application record binding one agreement and descriptor to the
 * authority allowed to attest Cashu settlement facts. It is never inferred from
 * the PIP-01 descriptor author.
 */
export interface PactEscrowAuthorityBinding {
  readonly agreementId: string;
  readonly agreementRoot: string;
  readonly escrowDescriptor: string;
  readonly authority: NostrPublicKey;
  readonly sourceReference: string;
  readonly [escrowAuthorityBindingBrand]: true;
}

export interface PactEscrowAuthoritySourceContent {
  readonly version: 1;
  readonly agreement_id: string;
  readonly agreement_root: string;
  readonly escrow_descriptor: string;
  readonly settlement_network: "cashu";
  readonly authority: string;
}

export interface PactEscrowAuthoritySource<
  TEvent extends UnsignedNostrEvent = UnsignedNostrEvent,
> {
  readonly event: TEvent;
  readonly content: PactEscrowAuthoritySourceContent;
}

/** A secret-free proof that the bound profile validated one exact submitted result. */
export interface PactCompletionDecision {
  readonly capabilityProfile: PactCapabilityProfileId;
  readonly agreementRoot: string;
  readonly submittedTransition: string;
  readonly resultReference: string;
  readonly [completionDecisionBrand]: true;
}

export interface PactAgreementContext {
  readonly root: PactServiceAgreementRoot<SignedNostrEvent>;
  readonly references: PactAgreementReferences;
  readonly escrowAuthority?: PactEscrowAuthorityBinding;
  readonly completionDecisions?: readonly PactCompletionDecision[];
}

export interface DocumentSummaryPrivateTerms {
  readonly source_document: string;
  readonly input_media_type: (typeof DOCUMENT_SUMMARY_INPUT_MEDIA_TYPES)[number];
  readonly private_prompt?: string;
}

export interface DocumentSummaryPrivateResult {
  readonly summary: string;
}

export interface PactCapabilityProfile<TPrivateTerms, TPrivateResult> {
  readonly id: PactCapabilityProfileId;
  validatePrivateTerms(value: unknown): TPrivateTerms;
  validatePrivateResult(value: unknown): TPrivateResult;
  validateAgreement(content: PactServiceAgreementContent): void;
  createResultReference(agreementRoot: string, privateResult: unknown): string;
  validateCompletion(input: {
    readonly agreement: PactServiceAgreementContent;
    readonly agreementRoot: string;
    readonly privateTerms: unknown;
    readonly privateResult: unknown;
  }): string;
  validatePublicResultReference(value: unknown): string;
  allowsTransition(previous: PactAgreementState, next: PactAgreementState): boolean;
}

const DOCUMENT_SUMMARY_TRANSITIONS: Readonly<
  Record<PactAgreementState, readonly PactAgreementState[]>
> = {
  proposed: ["accepted", "expired"],
  accepted: ["escrow_funded", "expired", "refund_authorized"],
  escrow_funded: ["task_delivered", "refund_authorized"],
  task_delivered: ["result_submitted"],
  result_submitted: ["result_verified", "rejected"],
  result_verified: ["release_authorized"],
  release_authorized: ["settled"],
  rejected: ["refund_authorized"],
  refund_authorized: ["refunded"],
  settled: [],
  expired: [],
  refunded: [],
  disputed: [],
};

const TERMINAL_STATES = new Set<PactAgreementState>([
  "settled",
  "expired",
  "refunded",
  "disputed",
]);

const RECOVERY_STATES_REQUIRING_REASON = new Set<PactAgreementState>([
  "expired",
  "refund_authorized",
  "rejected",
  "disputed",
]);

const DOCUMENT_SUMMARY_PROFILE: PactCapabilityProfile<
  DocumentSummaryPrivateTerms,
  DocumentSummaryPrivateResult
> = {
  id: DOCUMENT_SUMMARY_PROFILE_ID,
  validatePrivateTerms(value) {
    if (!isRecord(value)) {
      agreementError("privacy_boundary_violation", "Private document-summary terms are invalid");
    }
    assertExactKeys(
      value,
      ["source_document", "input_media_type", "private_prompt"],
      "privacy_boundary_violation",
    );
    if (
      typeof value.source_document !== "string" ||
      value.source_document.length === 0 ||
      new TextEncoder().encode(value.source_document).length >
        DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES ||
      !DOCUMENT_SUMMARY_INPUT_MEDIA_TYPES.includes(
        value.input_media_type as (typeof DOCUMENT_SUMMARY_INPUT_MEDIA_TYPES)[number],
      ) ||
      (value.private_prompt !== undefined && typeof value.private_prompt !== "string")
    ) {
      agreementError("privacy_boundary_violation", "Private document-summary terms are invalid");
    }
    return value as unknown as DocumentSummaryPrivateTerms;
  },
  validatePrivateResult(value) {
    if (!isRecord(value)) {
      agreementError("privacy_boundary_violation", "Private document-summary result is invalid");
    }
    assertExactKeys(value, ["summary"], "privacy_boundary_violation");
    if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
      agreementError("privacy_boundary_violation", "Private document-summary result is invalid");
    }
    return value as unknown as DocumentSummaryPrivateResult;
  },
  validateAgreement(content) {
    if (content.maximum_execution_seconds > DOCUMENT_SUMMARY_MAXIMUM_EXECUTION_SECONDS) {
      agreementError(
        "malformed_agreement",
        "document-summary@1 execution limit exceeds the supported profile maximum",
      );
    }
  },
  createResultReference(agreementRoot, privateResult) {
    const result = this.validatePrivateResult(privateResult);
    return `sha256:${createHash("sha256")
      .update(
        canonicalizePactJson({
          agreement_root: agreementRoot,
          capability_profile: this.id,
          result: result as unknown as CanonicalJson,
        }),
      )
      .digest("hex")}`;
  },
  validateCompletion(input) {
    this.validatePrivateTerms(input.privateTerms);
    this.validateAgreement(input.agreement);
    return this.createResultReference(input.agreementRoot, input.privateResult);
  },
  validatePublicResultReference(value) {
    if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
      agreementError(
        "invalid_transition",
        "document-summary@1 result reference must be a SHA-256 commitment",
      );
    }
    return value;
  },
  allowsTransition(previous, next) {
    return DOCUMENT_SUMMARY_TRANSITIONS[previous]?.includes(next) ?? false;
  },
};

const CAPABILITY_PROFILES: ReadonlyMap<string, PactCapabilityProfile<unknown, unknown>> = new Map([
  [DOCUMENT_SUMMARY_PROFILE.id, DOCUMENT_SUMMARY_PROFILE],
]);

export function getPactCapabilityProfile(
  value: unknown,
): PactCapabilityProfile<unknown, unknown> {
  if (typeof value !== "string" || !CAPABILITY_PROFILES.has(value)) {
    agreementError(
      "unsupported_profile_version",
      "PactAgent capability profile version is unsupported",
    );
  }
  return CAPABILITY_PROFILES.get(value)!;
}

export function createPactResultReference(
  profileId: PactCapabilityProfileId,
  agreementRoot: string,
  privateResult: unknown,
): string {
  validateEventId(agreementRoot, "Result agreement root");
  return getPactCapabilityProfile(profileId).createResultReference(agreementRoot, privateResult);
}

type CanonicalJson = null | boolean | number | string | readonly CanonicalJson[] | {
  readonly [key: string]: CanonicalJson;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      agreementError("privacy_boundary_violation", "Commitment terms contain invalid JSON data");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const member = value[key];
        if (member === undefined || typeof member === "bigint" || typeof member === "function") {
          agreementError("privacy_boundary_violation", "Commitment terms contain invalid JSON data");
        }
        return `${JSON.stringify(key)}:${canonicalJson(member)}`;
      });
    return `{${entries.join(",")}}`;
  }
  agreementError("privacy_boundary_violation", "Commitment terms contain invalid JSON data");
}

/** Deterministic recursive key ordering over the JSON subset used by PactAgent commitments. */
export function canonicalizePactJson(value: CanonicalJson): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export class PactPrivateCommitmentSalt {
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array = randomBytes(32)) {
    if (bytes.length !== 32) {
      agreementError("privacy_boundary_violation", "Commitment salt must contain 32 random bytes");
    }
    this.#bytes = Uint8Array.from(bytes);
  }

  commitmentInput(profile: PactCapabilityProfile<unknown, unknown>, terms: unknown): Uint8Array {
    profile.validatePrivateTerms(terms);
    return canonicalizePactJson({
      capability_profile: profile.id,
      scheme: PACT_TERMS_COMMITMENT_SCHEME,
      salt: Buffer.from(this.#bytes).toString("hex"),
      terms: terms as CanonicalJson,
    });
  }

  toJSON(): never {
    agreementError(
      "privacy_boundary_violation",
      "Private commitment salt cannot be serialized into public data",
    );
  }

  toString(): string {
    return "[private PactAgent commitment salt]";
  }
}

export interface PactTermsCommitment {
  readonly value: string;
  readonly scheme: PactTermsCommitmentScheme;
  readonly privateSalt: PactPrivateCommitmentSalt;
}

export function createPactTermsCommitment(
  profileId: PactCapabilityProfileId,
  privateTerms: unknown,
  privateSalt = new PactPrivateCommitmentSalt(),
): PactTermsCommitment {
  const profile = getPactCapabilityProfile(profileId);
  const bytes = privateSalt.commitmentInput(profile, privateTerms);
  return {
    value: createHash("sha256").update(bytes).digest("hex"),
    scheme: PACT_TERMS_COMMITMENT_SCHEME,
    privateSalt,
  };
}

export function verifyPactTermsCommitment(
  commitment: Pick<PactTermsCommitment, "value" | "scheme">,
  profileId: PactCapabilityProfileId,
  privateTerms: unknown,
  privateSalt: PactPrivateCommitmentSalt,
): boolean {
  if (commitment.scheme !== PACT_TERMS_COMMITMENT_SCHEME) return false;
  return createPactTermsCommitment(profileId, privateTerms, privateSalt).value === commitment.value;
}

const AGREEMENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/;
const EVENT_ID_PATTERN = /^[0-9a-f]{64}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_REFERENCE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:._/@-]{0,255}$/;

export function createPactAgreementId(): string {
  return randomUUID();
}

function validateAgreementId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !AGREEMENT_ID_PATTERN.test(value) ||
    EVENT_ID_PATTERN.test(value) ||
    value.startsWith("nsec1") ||
    value.startsWith("cashu")
  ) {
    agreementError("malformed_agreement", "PactAgent agreement_id must be a safe opaque identifier");
  }
  return value;
}

function validateEventId(value: unknown, field: string): string {
  if (typeof value !== "string" || !EVENT_ID_PATTERN.test(value)) {
    agreementError("invalid_reference", `${field} must be a Nostr event id`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: PactServiceAgreementErrorCode,
): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) {
    agreementError(code, "PactAgent public model contains unsupported fields");
  }
}

function unsignedPart(event: UnsignedNostrEvent): UnsignedNostrEvent {
  return {
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
  };
}

function validateSignedAgentDefinition(
  value: SignedNostrEvent,
): SignedPontmoreAgentDefinition {
  const signed = parseSignedNostrEvent(value);
  verifySignedNostrEvent(signed);
  return parsePontmoreAgentDefinitionEvent(signed);
}

function definitionAddress(definition: SignedPontmoreAgentDefinition): string {
  return definition.address;
}

function validateAgreementReferences(references: PactAgreementReferences): {
  readonly requester: SignedPontmoreAgentDefinition;
  readonly provider: SignedPontmoreAgentDefinition;
  readonly escrow: PontmoreEscrowDescriptor<SignedNostrEvent>;
} {
  let requester: SignedPontmoreAgentDefinition;
  let provider: SignedPontmoreAgentDefinition;
  let escrow: PontmoreEscrowDescriptor<SignedNostrEvent>;
  try {
    requester = validateSignedAgentDefinition(references.requesterDefinition);
    provider = validateSignedAgentDefinition(references.providerDefinition);
    const descriptorEvent = parseSignedNostrEvent(references.escrowDescriptor);
    verifySignedNostrEvent(descriptorEvent);
    escrow = parseCashuEscrowDescriptorEvent(descriptorEvent);
  } catch (error) {
    if (error instanceof PactServiceAgreementError) throw error;
    agreementError("invalid_reference", "PactAgent agreement has an invalid Pontmore reference");
  }

  if (requester.event.pubkey === provider.event.pubkey) {
    agreementError("invalid_reference", "Requester and provider must use independent identities");
  }
  if (!isCashuEscrowCompatible(escrow)) {
    agreementError("invalid_reference", "PIP-01 descriptor is not Cashu compatible");
  }
  if (
    provider.content.escrow !== escrow.address ||
    !provider.content.capabilities.names.includes("document-summary") ||
    !provider.content.capabilities.settlement_networks.includes("cashu")
  ) {
    agreementError("invalid_reference", "Pontmore references do not satisfy the agreement profile");
  }
  return { requester, provider, escrow };
}

const ESCROW_AUTHORITY_SOURCE_KEYS = [
  "version",
  "agreement_id",
  "agreement_root",
  "escrow_descriptor",
  "settlement_network",
  "authority",
] as const;

function parseEscrowAuthoritySourceContent(
  value: Record<string, unknown>,
): PactEscrowAuthoritySourceContent {
  assertExactKeys(value, ESCROW_AUTHORITY_SOURCE_KEYS, "privacy_boundary_violation");
  if (ESCROW_AUTHORITY_SOURCE_KEYS.some((key) => !(key in value))) {
    agreementError("invalid_reference", "Escrow authority source is missing required content");
  }
  let authority: NostrPublicKey;
  try {
    authority = nostrPublicKey(String(value.authority));
  } catch {
    agreementError("invalid_reference", "Escrow authority source identity is invalid");
  }
  if (
    value.version !== 1 ||
    value.settlement_network !== "cashu" ||
    typeof value.escrow_descriptor !== "string" ||
    !SAFE_REFERENCE_PATTERN.test(value.escrow_descriptor)
  ) {
    agreementError("invalid_reference", "Escrow authority source content is invalid");
  }
  return {
    version: 1,
    agreement_id: validateAgreementId(value.agreement_id),
    agreement_root: validateEventId(value.agreement_root, "Escrow authority agreement root"),
    escrow_descriptor: value.escrow_descriptor,
    settlement_network: "cashu",
    authority,
  };
}

function validateEscrowAuthoritySourceTags(
  event: UnsignedNostrEvent,
  content: PactEscrowAuthoritySourceContent,
): void {
  if (event.tags.some((tag) => !["d", "t", "e", "a", "p"].includes(tag[0]) || tag.length !== 2)) {
    agreementError("tag_content_mismatch", "Escrow authority source contains invalid tags");
  }
  if (
    !valuesEqual(tagsNamed(event, "d").map((tag) => tag[1]), [content.agreement_id]) ||
    !valuesEqual(tagsNamed(event, "t").map((tag) => tag[1]), [PACT_ESCROW_AUTHORITY_SOURCE_TYPE]) ||
    !valuesEqual(tagsNamed(event, "e").map((tag) => tag[1]), [content.agreement_root]) ||
    !valuesEqual(tagsNamed(event, "a").map((tag) => tag[1]), [content.escrow_descriptor]) ||
    !valuesEqual(tagsNamed(event, "p").map((tag) => tag[1]), [content.authority])
  ) {
    agreementError("tag_content_mismatch", "Escrow authority source tags and content disagree");
  }
}

export function parsePactEscrowAuthoritySourceEvent<TEvent extends UnsignedNostrEvent>(
  event: TEvent,
): PactEscrowAuthoritySource<TEvent> {
  if (event.kind !== PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND) {
    agreementError(
      "malformed_event",
      `Escrow authority source must use PactAgent service-agreement kind ${PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND}`,
    );
  }
  const content = parseEscrowAuthoritySourceContent(
    parseJsonObject(event.content, "Escrow authority source"),
  );
  validateEscrowAuthoritySourceTags(event, content);
  return { event, content };
}

/**
 * Creates the explicit application record by which the selected descriptor
 * owner designates one settlement authority for this exact agreement.
 */
export function createPactEscrowAuthoritySource(input: {
  readonly root: PactServiceAgreementRoot<SignedNostrEvent>;
  readonly references: PactAgreementReferences;
  readonly authority: string;
  readonly createdAt: number;
}): PactEscrowAuthoritySource {
  assertExactKeys(
    input as unknown as Record<string, unknown>,
    ["root", "references", "authority", "createdAt"],
    "privacy_boundary_violation",
  );
  const root = validatePactServiceAgreementRoot(input.root.event, input.references);
  const resolved = validateAgreementReferences(input.references);
  const authority = nostrPublicKey(input.authority);
  if (!Number.isInteger(input.createdAt) || input.createdAt < root.event.created_at) {
    agreementError("malformed_event", "Escrow authority source creation time is invalid");
  }
  const content: PactEscrowAuthoritySourceContent = {
    version: 1,
    agreement_id: root.content.agreement_id,
    agreement_root: root.event.id,
    escrow_descriptor: resolved.escrow.address,
    settlement_network: "cashu",
    authority,
  };
  return parsePactEscrowAuthoritySourceEvent({
    pubkey: resolved.escrow.event.pubkey,
    created_at: input.createdAt,
    kind: PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND,
    tags: [
      ["d", content.agreement_id],
      ["t", PACT_ESCROW_AUTHORITY_SOURCE_TYPE],
      ["e", content.agreement_root],
      ["a", content.escrow_descriptor],
      ["p", content.authority],
    ],
    content: JSON.stringify(content),
  });
}

export function createPactEscrowAuthorityBinding(input: {
  readonly root: PactServiceAgreementRoot<SignedNostrEvent>;
  readonly references: PactAgreementReferences;
  readonly authority: string;
  readonly source: SignedNostrEvent;
}): PactEscrowAuthorityBinding {
  assertExactKeys(
    input as unknown as Record<string, unknown>,
    ["root", "references", "authority", "source"],
    "privacy_boundary_violation",
  );
  const root = validatePactServiceAgreementRoot(input.root.event, input.references);
  const resolved = validateAgreementReferences(input.references);
  let signed: SignedNostrEvent;
  let source: PactEscrowAuthoritySource<SignedNostrEvent>;
  try {
    signed = parseSignedNostrEvent(input.source);
    verifySignedNostrEvent(signed);
    source = parsePactEscrowAuthoritySourceEvent(signed);
  } catch (error) {
    if (error instanceof PactServiceAgreementError) throw error;
    agreementError("invalid_reference", "Escrow authority source signature is invalid");
  }
  const authority = nostrPublicKey(input.authority);
  if (
    source.event.pubkey !== resolved.escrow.event.pubkey ||
    source.content.agreement_id !== root.content.agreement_id ||
    source.content.agreement_root !== root.event.id ||
    source.content.escrow_descriptor !== root.content.escrow_descriptor ||
    source.content.settlement_network !== root.content.settlement_network ||
    source.content.authority !== authority
  ) {
    agreementError("invalid_reference", "Escrow authority source is unrelated to this agreement");
  }
  const binding: PactEscrowAuthorityBinding = {
    agreementId: root.content.agreement_id,
    agreementRoot: root.event.id,
    escrowDescriptor: root.content.escrow_descriptor,
    authority,
    sourceReference: source.event.id,
    [escrowAuthorityBindingBrand]: true,
  };
  validatedEscrowAuthorityBindings.add(binding);
  return Object.freeze(binding);
}

const ROOT_CONTENT_KEYS = [
  "version",
  "agreement_id",
  "capability_profile",
  "requester",
  "provider",
  "requester_definition",
  "provider_definition",
  "escrow_descriptor",
  "amount_sats",
  "settlement_network",
  "maximum_execution_seconds",
  "expires_at",
  "terms_commitment",
  "terms_commitment_scheme",
] as const;

function parseJsonObject(content: string, model: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    agreementError("malformed_event", `${model} content must be valid JSON`);
  }
  if (!isRecord(parsed)) {
    agreementError("malformed_event", `${model} content must be an object`);
  }
  return parsed;
}

function parseRootContent(value: Record<string, unknown>): PactServiceAgreementContent {
  assertExactKeys(value, ROOT_CONTENT_KEYS, "privacy_boundary_violation");
  if (findForbiddenPublicMaterial(value) !== undefined) {
    agreementError("privacy_boundary_violation", "PactAgent agreement root contains forbidden private material");
  }
  if (ROOT_CONTENT_KEYS.some((key) => !(key in value))) {
    agreementError("malformed_agreement", "PactAgent agreement root is missing required content");
  }
  const agreementId = validateAgreementId(value.agreement_id);
  const profile = getPactCapabilityProfile(value.capability_profile);
  let requester: NostrPublicKey;
  let provider: NostrPublicKey;
  try {
    requester = nostrPublicKey(String(value.requester));
    provider = nostrPublicKey(String(value.provider));
  } catch {
    agreementError("malformed_agreement", "PactAgent agreement participants are invalid");
  }
  if (requester === provider) {
    agreementError("malformed_agreement", "PactAgent agreement participants must be independent");
  }
  if (
    value.version !== 1 ||
    typeof value.requester_definition !== "string" ||
    typeof value.provider_definition !== "string" ||
    typeof value.escrow_descriptor !== "string" ||
    typeof value.amount_sats !== "string" ||
    !/^[1-9][0-9]*$/.test(value.amount_sats) ||
    value.settlement_network !== "cashu" ||
    !Number.isInteger(value.maximum_execution_seconds) ||
    (value.maximum_execution_seconds as number) < 1 ||
    !Number.isInteger(value.expires_at) ||
    (value.expires_at as number) < 1 ||
    typeof value.terms_commitment !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.terms_commitment) ||
    value.terms_commitment_scheme !== PACT_TERMS_COMMITMENT_SCHEME
  ) {
    agreementError("malformed_agreement", "PactAgent agreement root content is invalid");
  }
  const content: PactServiceAgreementContent = {
    version: 1,
    agreement_id: agreementId,
    capability_profile: DOCUMENT_SUMMARY_PROFILE_ID,
    requester,
    provider,
    requester_definition: value.requester_definition,
    provider_definition: value.provider_definition,
    escrow_descriptor: value.escrow_descriptor,
    amount_sats: value.amount_sats,
    settlement_network: "cashu",
    maximum_execution_seconds: value.maximum_execution_seconds as number,
    expires_at: value.expires_at as number,
    terms_commitment: value.terms_commitment,
    terms_commitment_scheme: PACT_TERMS_COMMITMENT_SCHEME,
  };
  profile.validateAgreement(content);
  return content;
}

function tagsNamed(event: UnsignedNostrEvent, name: string): readonly (readonly string[])[] {
  return event.tags.filter((tag) => tag[0] === name);
}

function valuesEqual(actual: readonly string[], expected: readonly string[]): boolean {
  return [...actual].sort().join("\u0000") === [...expected].sort().join("\u0000");
}

function validateRootTags(event: UnsignedNostrEvent, content: PactServiceAgreementContent): void {
  if (event.tags.some((tag) => !["d", "t", "p", "a"].includes(tag[0]) || tag.length !== 2)) {
    agreementError("tag_content_mismatch", "PactAgent agreement root contains invalid tags");
  }
  const dValues = tagsNamed(event, "d").map((tag) => tag[1]);
  const tValues = tagsNamed(event, "t").map((tag) => tag[1]);
  const pValues = tagsNamed(event, "p").map((tag) => tag[1]);
  const aValues = tagsNamed(event, "a").map((tag) => tag[1]);
  if (
    !valuesEqual(dValues, [content.agreement_id]) ||
    !valuesEqual(tValues, [PACT_SERVICE_AGREEMENT_ROOT_TYPE, content.capability_profile]) ||
    !valuesEqual(pValues, [content.requester, content.provider]) ||
    !valuesEqual(aValues, [
      content.requester_definition,
      content.provider_definition,
      content.escrow_descriptor,
    ])
  ) {
    agreementError("tag_content_mismatch", "PactAgent agreement root tags and content disagree");
  }
}

export function parsePactServiceAgreementRootEvent<TEvent extends UnsignedNostrEvent>(
  event: TEvent,
): PactServiceAgreementRoot<TEvent> {
  if (event.kind !== PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND) {
    agreementError(
      "malformed_event",
      `PactAgent agreement root must use service-agreement kind ${PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND}`,
    );
  }
  const content = parseRootContent(parseJsonObject(event.content, "PactAgent agreement root"));
  if (event.pubkey !== content.requester || event.created_at >= content.expires_at) {
    agreementError("malformed_agreement", "PactAgent agreement root author or expiry is invalid");
  }
  validateRootTags(event, content);
  return { event, content };
}

export function validatePactServiceAgreementRoot(
  event: SignedNostrEvent,
  references: PactAgreementReferences,
): PactServiceAgreementRoot<SignedNostrEvent> {
  const signed = parseSignedNostrEvent(event);
  verifySignedNostrEvent(signed);
  return validatePactServiceAgreementRootDraft(parsePactServiceAgreementRootEvent(signed), references);
}

export function validatePactServiceAgreementRootDraft<TEvent extends UnsignedNostrEvent>(
  value: PactServiceAgreementRoot<TEvent>,
  references: PactAgreementReferences,
): PactServiceAgreementRoot<TEvent> {
  const root = parsePactServiceAgreementRootEvent(value.event);
  if (JSON.stringify(root.content) !== JSON.stringify(value.content)) {
    agreementError("malformed_agreement", "Agreement root model does not match its event");
  }
  const resolved = validateAgreementReferences(references);
  if (
    root.content.requester !== resolved.requester.event.pubkey ||
    root.content.provider !== resolved.provider.event.pubkey ||
    root.content.requester_definition !== definitionAddress(resolved.requester) ||
    root.content.provider_definition !== definitionAddress(resolved.provider) ||
    root.content.escrow_descriptor !== resolved.escrow.address
  ) {
    agreementError("invalid_reference", "Agreement root does not match its Pontmore references");
  }
  return root;
}

export function createPactServiceAgreementRoot(input: {
  readonly agreementId?: string;
  readonly references: PactAgreementReferences;
  readonly amountSats: string;
  readonly maximumExecutionSeconds: number;
  readonly expiresAt: number;
  readonly termsCommitment: Pick<PactTermsCommitment, "value" | "scheme">;
  readonly createdAt: number;
  readonly capabilityProfile?: PactCapabilityProfileId;
}): PactServiceAgreementRoot {
  assertExactKeys(
    input as unknown as Record<string, unknown>,
    [
      "agreementId",
      "references",
      "amountSats",
      "maximumExecutionSeconds",
      "expiresAt",
      "termsCommitment",
      "createdAt",
      "capabilityProfile",
    ],
    "privacy_boundary_violation",
  );
  const profile = getPactCapabilityProfile(
    input.capabilityProfile ?? DOCUMENT_SUMMARY_PROFILE_ID,
  );
  if (!Number.isInteger(input.createdAt) || input.createdAt < 0) {
    agreementError("malformed_agreement", "PactAgent agreement creation time is invalid");
  }
  const agreementId = validateAgreementId(input.agreementId ?? createPactAgreementId());
  const resolved = validateAgreementReferences(input.references);
  const content: PactServiceAgreementContent = {
    version: 1,
    agreement_id: agreementId,
    capability_profile: profile.id,
    requester: resolved.requester.event.pubkey,
    provider: resolved.provider.event.pubkey,
    requester_definition: definitionAddress(resolved.requester),
    provider_definition: definitionAddress(resolved.provider),
    escrow_descriptor: resolved.escrow.address,
    amount_sats: input.amountSats,
    settlement_network: "cashu",
    maximum_execution_seconds: input.maximumExecutionSeconds,
    expires_at: input.expiresAt,
    terms_commitment: input.termsCommitment.value,
    terms_commitment_scheme: input.termsCommitment.scheme,
  };
  const event: UnsignedNostrEvent = {
    pubkey: resolved.requester.event.pubkey,
    created_at: input.createdAt,
    kind: PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND,
    tags: [
      ["d", agreementId],
      ["t", PACT_SERVICE_AGREEMENT_ROOT_TYPE],
      ["t", profile.id],
      ["p", content.requester],
      ["p", content.provider],
      ["a", content.requester_definition],
      ["a", content.provider_definition],
      ["a", content.escrow_descriptor],
    ],
    content: JSON.stringify(content),
  };
  return parsePactServiceAgreementRootEvent(event);
}

const TRANSITION_BASE_KEYS = [
  "version",
  "agreement_id",
  "agreement_root",
  "predecessor",
  "state",
  "prev_state",
  "actor",
  "actor_role",
  "reason_code",
  "result_reference",
] as const;

function isAgreementState(value: unknown): value is PactAgreementState {
  return typeof value === "string" && Object.hasOwn(DOCUMENT_SUMMARY_TRANSITIONS, value);
}

function parseTransitionContent(
  value: Record<string, unknown>,
  profile: PactCapabilityProfile<unknown, unknown>,
): PactAgreementTransitionContent {
  assertExactKeys(value, TRANSITION_BASE_KEYS, "privacy_boundary_violation");
  if (findForbiddenPublicMaterial(value) !== undefined) {
    agreementError("privacy_boundary_violation", "PactAgent transition contains forbidden private material");
  }
  for (const key of [
    "version",
    "agreement_id",
    "agreement_root",
    "predecessor",
    "state",
    "prev_state",
    "actor",
    "actor_role",
  ]) {
    if (!(key in value)) {
      agreementError("malformed_event", "PactAgent transition is missing required content");
    }
  }
  const agreementId = validateAgreementId(value.agreement_id);
  const agreementRoot = validateEventId(value.agreement_root, "agreement_root");
  const predecessor =
    value.predecessor === null ? null : validateEventId(value.predecessor, "predecessor");
  let actor: NostrPublicKey;
  try {
    actor = nostrPublicKey(String(value.actor));
  } catch {
    agreementError("malformed_event", "PactAgent transition actor is invalid");
  }
  if (
    value.version !== 1 ||
    !isAgreementState(value.state) ||
    !isAgreementState(value.prev_state) ||
    !["requester", "provider", "escrow"].includes(String(value.actor_role))
  ) {
    agreementError("malformed_event", "PactAgent transition content is invalid");
  }
  if (TERMINAL_STATES.has(value.prev_state)) {
    agreementError("terminal_state_transition", "Terminal PactAgent agreement state cannot advance");
  }
  if (!profile.allowsTransition(value.prev_state, value.state)) {
    agreementError("invalid_transition", "PactAgent agreement transition is invalid");
  }
  const reasonRequired = RECOVERY_STATES_REQUIRING_REASON.has(value.state);
  if (
    (reasonRequired &&
      (typeof value.reason_code !== "string" || !REASON_CODE_PATTERN.test(value.reason_code))) ||
    (!reasonRequired && value.reason_code !== undefined)
  ) {
    agreementError("invalid_transition", "PactAgent transition reason code is invalid");
  }
  if (value.state === "result_submitted" || value.state === "result_verified") {
    profile.validatePublicResultReference(value.result_reference);
  } else if (value.result_reference !== undefined) {
    agreementError("privacy_boundary_violation", "Public result reference is not valid in this transition");
  }
  return {
    version: 1,
    agreement_id: agreementId,
    agreement_root: agreementRoot,
    predecessor,
    state: value.state,
    prev_state: value.prev_state,
    actor,
    actor_role: value.actor_role as PactAgreementActorRole,
    ...(value.reason_code === undefined ? {} : { reason_code: value.reason_code as string }),
    ...(value.result_reference === undefined
      ? {}
      : { result_reference: value.result_reference as string }),
  };
}

function validateTransitionTags(
  event: UnsignedNostrEvent,
  content: PactAgreementTransitionContent,
): void {
  if (event.tags.some((tag) => !["d", "t", "e", "p"].includes(tag[0]) || tag.length !== 2)) {
    agreementError("tag_content_mismatch", "PactAgent transition contains invalid tags");
  }
  const expectedEvents = [content.agreement_root];
  if (content.predecessor !== null) expectedEvents.push(content.predecessor);
  if (
    !valuesEqual(tagsNamed(event, "d").map((tag) => tag[1]), [content.agreement_id]) ||
    !valuesEqual(tagsNamed(event, "t").map((tag) => tag[1]), [
      PACT_AGREEMENT_TRANSITION_TYPE,
      content.state,
    ]) ||
    !valuesEqual(tagsNamed(event, "e").map((tag) => tag[1]), expectedEvents) ||
    !valuesEqual(tagsNamed(event, "p").map((tag) => tag[1]), [content.actor])
  ) {
    agreementError("tag_content_mismatch", "PactAgent transition tags and content disagree");
  }
}

export function parsePactAgreementTransitionEvent<TEvent extends UnsignedNostrEvent>(
  event: TEvent,
  profileId: PactCapabilityProfileId = DOCUMENT_SUMMARY_PROFILE_ID,
): PactAgreementTransition<TEvent> {
  if (event.kind !== PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND) {
    agreementError(
      "malformed_event",
      `PactAgent transition must use service-agreement kind ${PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND}`,
    );
  }
  const profile = getPactCapabilityProfile(profileId);
  const content = parseTransitionContent(
    parseJsonObject(event.content, "PactAgent transition"),
    profile,
  );
  if (event.pubkey !== content.actor) {
    agreementError("signer_not_authorized", "PactAgent transition signer does not match its actor");
  }
  validateTransitionTags(event, content);
  return { event, content };
}

function roleForTransition(state: PactAgreementState): PactAgreementActorRole | "participant" {
  switch (state) {
    case "accepted":
    case "task_delivered":
    case "result_submitted":
      return "provider";
    case "result_verified":
    case "rejected":
    case "release_authorized":
    case "refund_authorized":
      return "requester";
    case "escrow_funded":
    case "settled":
    case "refunded":
      return "escrow";
    case "expired":
      return "participant";
    case "disputed":
      agreementError(
        "invalid_transition",
        "Disputed is unavailable without a validated dispute authority",
      );
    case "proposed":
      agreementError("invalid_transition", "Proposed is represented only by the immutable root");
  }
}

function validateCompletionDecision(
  transition: PactAgreementTransition,
  context: PactAgreementContext,
): void {
  if (transition.content.state !== "result_verified") return;
  const decision = context.completionDecisions?.find(
    (candidate) =>
      candidate[completionDecisionBrand] === true &&
      validatedCompletionDecisions.has(candidate) &&
      candidate.capabilityProfile === context.root.content.capability_profile &&
      candidate.agreementRoot === context.root.event.id &&
      candidate.submittedTransition === transition.content.predecessor &&
      candidate.resultReference === transition.content.result_reference,
  );
  if (!decision) {
    agreementError(
      "invalid_transition",
      "Result verification requires a valid profile completion decision",
    );
  }
}

function validateEscrowBinding(context: PactAgreementContext): NostrPublicKey {
  const binding = context.escrowAuthority;
  if (
    !binding ||
    binding[escrowAuthorityBindingBrand] !== true ||
    !validatedEscrowAuthorityBindings.has(binding) ||
    binding.agreementId !== context.root.content.agreement_id ||
    binding.agreementRoot !== context.root.event.id ||
    binding.escrowDescriptor !== context.root.content.escrow_descriptor
  ) {
    agreementError(
      "signer_not_authorized",
      "Settlement transition requires an explicitly bound escrow authority",
    );
  }
  return binding.authority;
}

function validateTransitionAuthorization(
  transition: PactAgreementTransition,
  context: PactAgreementContext,
): void {
  const expectedRole = roleForTransition(transition.content.state);
  let authorized = false;
  if (expectedRole === "requester") {
    authorized =
      transition.content.actor_role === "requester" &&
      transition.event.pubkey === context.root.content.requester;
  } else if (expectedRole === "provider") {
    authorized =
      transition.content.actor_role === "provider" &&
      transition.event.pubkey === context.root.content.provider;
  } else if (expectedRole === "escrow") {
    authorized =
      transition.content.actor_role === "escrow" &&
      transition.event.pubkey === validateEscrowBinding(context);
  } else {
    authorized =
      (transition.content.actor_role === "requester" &&
        transition.event.pubkey === context.root.content.requester) ||
      (transition.content.actor_role === "provider" &&
        transition.event.pubkey === context.root.content.provider);
  }
  if (!authorized) {
    agreementError("signer_not_authorized", "PactAgent transition signer is not authorized");
  }
  validateCompletionDecision(transition, context);
  if (
    transition.content.state === "accepted" &&
    transition.event.created_at >= context.root.content.expires_at
  ) {
    agreementError("invalid_transition", "Expired PactAgent proposal cannot be accepted");
  }
  if (
    transition.content.state === "expired" &&
    transition.event.created_at < context.root.content.expires_at
  ) {
    agreementError("invalid_transition", "PactAgent proposal cannot expire before its deadline");
  }
}

function validatedContext(context: PactAgreementContext): PactAgreementContext {
  const root = validatePactServiceAgreementRoot(context.root.event, context.references);
  return { ...context, root };
}

function validatedSignedTransitions(
  events: readonly SignedNostrEvent[],
  context: PactAgreementContext,
): {
  readonly transitions: readonly PactAgreementTransition<SignedNostrEvent>[];
  readonly duplicateEventIds: readonly string[];
} {
  const unique = new Map<string, PactAgreementTransition<SignedNostrEvent>>();
  const serialized = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const value of events) {
    const signed = parseSignedNostrEvent(value);
    verifySignedNostrEvent(signed);
    const wire = JSON.stringify(signed);
    const prior = serialized.get(signed.id);
    if (prior !== undefined) {
      if (prior !== wire) {
        agreementError("malformed_event", "One Nostr event id has conflicting wire data");
      }
      duplicates.add(signed.id);
      continue;
    }
    const transition = parsePactAgreementTransitionEvent(
      signed,
      context.root.content.capability_profile,
    );
    if (
      transition.content.agreement_id !== context.root.content.agreement_id ||
      transition.content.agreement_root !== context.root.event.id
    ) {
      agreementError("invalid_reference", "PactAgent transition references another agreement");
    }
    validateTransitionAuthorization(transition, context);
    serialized.set(signed.id, wire);
    unique.set(signed.id, transition);
  }
  return {
    transitions: [...unique.values()],
    duplicateEventIds: [...duplicates].sort(),
  };
}

export interface PactAgreementHistoryOk {
  readonly status: "ok";
  readonly currentState: PactAgreementState;
  readonly mutuallyAccepted: boolean;
  readonly transitions: readonly PactAgreementTransition<SignedNostrEvent>[];
  readonly duplicateEventIds: readonly string[];
}

export interface PactAgreementHistoryForked {
  readonly status: "forked";
  readonly currentState: PactAgreementState;
  readonly mutuallyAccepted: boolean;
  readonly transitions: readonly PactAgreementTransition<SignedNostrEvent>[];
  readonly duplicateEventIds: readonly string[];
  readonly conflict: Readonly<{
    predecessorEventId: string | null;
    competingEventIds: readonly string[];
  }>;
}

export type PactAgreementHistory = PactAgreementHistoryOk | PactAgreementHistoryForked;

export function reconstructPactAgreementHistory(
  contextValue: PactAgreementContext,
  events: readonly SignedNostrEvent[],
): PactAgreementHistory {
  const context = validatedContext(contextValue);
  const { transitions, duplicateEventIds } = validatedSignedTransitions(events, context);
  const byId = new Map(transitions.map((transition) => [transition.event.id, transition]));
  const children = new Map<string, PactAgreementTransition<SignedNostrEvent>[]>();
  const rootKey = "<agreement-root>";

  for (const transition of transitions) {
    const predecessor = transition.content.predecessor;
    if (predecessor !== null && !byId.has(predecessor)) {
      agreementError("invalid_reference", "PactAgent transition predecessor is missing");
    }
    if (predecessor === transition.event.id || predecessor === context.root.event.id) {
      agreementError("invalid_reference", "PactAgent transition predecessor is malformed");
    }
    const key = predecessor ?? rootKey;
    const siblings = children.get(key) ?? [];
    siblings.push(transition);
    children.set(key, siblings);
  }

  const ordered: PactAgreementTransition<SignedNostrEvent>[] = [];
  const visited = new Set<string>();
  let predecessorKey = rootKey;
  let currentState: PactAgreementState = "proposed";

  while (true) {
    const next = children.get(predecessorKey) ?? [];
    if (next.length > 1) {
      return {
        status: "forked",
        currentState,
        mutuallyAccepted: ordered.some((transition) => transition.content.state === "accepted"),
        transitions: ordered,
        duplicateEventIds,
        conflict: {
          predecessorEventId: predecessorKey === rootKey ? null : predecessorKey,
          competingEventIds: next.map((transition) => transition.event.id).sort(),
        },
      };
    }
    if (next.length === 0) break;
    const selected = next[0];
    if (selected.content.prev_state !== currentState || visited.has(selected.event.id)) {
      agreementError("stale_predecessor", "PactAgent transition predecessor state is incoherent");
    }
    const predecessorCreatedAt =
      predecessorKey === rootKey
        ? context.root.event.created_at
        : byId.get(predecessorKey)!.event.created_at;
    if (selected.event.created_at < predecessorCreatedAt) {
      agreementError("stale_predecessor", "PactAgent transition predates its predecessor");
    }
    ordered.push(selected);
    visited.add(selected.event.id);
    currentState = selected.content.state;
    predecessorKey = selected.event.id;
  }

  if (visited.size !== transitions.length) {
    agreementError("invalid_reference", "PactAgent transition history is not root-connected");
  }
  return {
    status: "ok",
    currentState,
    mutuallyAccepted: ordered.some((transition) => transition.content.state === "accepted"),
    transitions: ordered,
    duplicateEventIds,
  };
}

/**
 * Runs the selected profile's deterministic completion checks over private
 * material and returns only a safe binding to the exact submitted transition.
 */
export function createPactCompletionDecision(input: {
  readonly context: PactAgreementContext;
  readonly history: readonly SignedNostrEvent[];
  readonly privateTerms: unknown;
  readonly privateSalt: PactPrivateCommitmentSalt;
  readonly privateResult: unknown;
}): PactCompletionDecision {
  const context = validatedContext(input.context);
  const history = reconstructPactAgreementHistory(context, input.history);
  if (history.status === "forked") {
    agreementError("forked_history", "Forked history cannot produce a completion decision");
  }
  const submitted = history.transitions.at(-1);
  if (!submitted || submitted.content.state !== "result_submitted") {
    agreementError(
      "invalid_transition",
      "Completion decision requires the current submitted result",
    );
  }
  if (
    !verifyPactTermsCommitment(
      {
        value: context.root.content.terms_commitment,
        scheme: context.root.content.terms_commitment_scheme,
      },
      context.root.content.capability_profile,
      input.privateTerms,
      input.privateSalt,
    )
  ) {
    agreementError("invalid_transition", "Completion terms do not match the agreement commitment");
  }
  const profile = getPactCapabilityProfile(context.root.content.capability_profile);
  const resultReference = profile.validateCompletion({
    agreement: context.root.content,
    agreementRoot: context.root.event.id,
    privateTerms: input.privateTerms,
    privateResult: input.privateResult,
  });
  if (resultReference !== submitted.content.result_reference) {
    agreementError("invalid_transition", "Completion result does not match the submitted result");
  }
  const decision: PactCompletionDecision = {
    capabilityProfile: context.root.content.capability_profile,
    agreementRoot: context.root.event.id,
    submittedTransition: submitted.event.id,
    resultReference,
    [completionDecisionBrand]: true,
  };
  validatedCompletionDecisions.add(decision);
  return Object.freeze(decision);
}

export interface CreatePactAgreementTransitionInput {
  readonly context: PactAgreementContext;
  readonly history: readonly SignedNostrEvent[];
  readonly predecessorEventId?: string | null;
  readonly nextState: PactAgreementState;
  readonly actor: string;
  readonly actorRole: PactAgreementActorRole;
  readonly reasonCode?: string;
  readonly resultReference?: string;
  readonly createdAt: number;
}

export function createPactAgreementTransition(
  input: CreatePactAgreementTransitionInput,
): PactAgreementTransition {
  assertExactKeys(
    input as unknown as Record<string, unknown>,
    [
      "context",
      "history",
      "predecessorEventId",
      "nextState",
      "actor",
      "actorRole",
      "reasonCode",
      "resultReference",
      "createdAt",
    ],
    "privacy_boundary_violation",
  );
  if (!Number.isInteger(input.createdAt) || input.createdAt < 0) {
    agreementError("malformed_event", "PactAgent transition creation time is invalid");
  }
  const context = validatedContext(input.context);
  const history = reconstructPactAgreementHistory(context, input.history);
  if (history.status === "forked") {
    agreementError("forked_history", "PactAgent history is forked and cannot be advanced");
  }
  if (TERMINAL_STATES.has(history.currentState)) {
    agreementError("terminal_state_transition", "Terminal PactAgent agreement state cannot advance");
  }
  const expectedPredecessor = history.transitions.at(-1)?.event.id ?? null;
  const predecessor = input.predecessorEventId ?? null;
  if (predecessor !== expectedPredecessor) {
    agreementError("stale_predecessor", "PactAgent transition does not reference the current tip");
  }
  const predecessorCreatedAt =
    history.transitions.at(-1)?.event.created_at ?? context.root.event.created_at;
  if (input.createdAt < predecessorCreatedAt) {
    agreementError("stale_predecessor", "PactAgent transition predates its predecessor");
  }
  if (input.nextState === "refund_authorized" && input.reasonCode === "timeout") {
    const descriptor = parseCashuEscrowDescriptorEvent(context.references.escrowDescriptor);
    const acceptedEvent = history.transitions.find((t) => t.content.state === "accepted")?.event;
    if (!acceptedEvent) {
      agreementError("invalid_transition", "Timeout refund authorization requires an accepted agreement");
    }
    const locktime = acceptedEvent.created_at + descriptor.content.dispute_rules.timeout.duration_seconds;
    if (input.createdAt < locktime) {
      agreementError("timeout_not_reached", "Timeout refund authorization cannot predate escrow locktime");
    }
  }
  const actor = nostrPublicKey(input.actor);
  const completionDecision =
    input.nextState === "result_verified"
      ? context.completionDecisions?.find(
          (candidate) =>
            candidate[completionDecisionBrand] === true &&
            validatedCompletionDecisions.has(candidate) &&
            candidate.agreementRoot === context.root.event.id &&
            candidate.submittedTransition === predecessor,
        )
      : undefined;
  const resultReference = input.resultReference ?? completionDecision?.resultReference;
  const content: PactAgreementTransitionContent = {
    version: 1,
    agreement_id: context.root.content.agreement_id,
    agreement_root: context.root.event.id,
    predecessor,
    state: input.nextState,
    prev_state: history.currentState,
    actor,
    actor_role: input.actorRole,
    ...(input.reasonCode === undefined ? {} : { reason_code: input.reasonCode }),
    ...(resultReference === undefined
      ? {}
      : { result_reference: resultReference }),
  };
  const event: UnsignedNostrEvent = {
    pubkey: actor,
    created_at: input.createdAt,
    kind: PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND,
    tags: [
      ["d", content.agreement_id],
      ["t", PACT_AGREEMENT_TRANSITION_TYPE],
      ["t", content.state],
      ["e", content.agreement_root],
      ...(content.predecessor === null
        ? []
        : [["e", content.predecessor] as const]),
      ["p", content.actor],
    ],
    content: JSON.stringify(content),
  };
  const transition = parsePactAgreementTransitionEvent(
    event,
    context.root.content.capability_profile,
  );
  validateTransitionAuthorization(transition, context);
  return transition;
}

export function validatePactAgreementTransitionCandidate(
  context: PactAgreementContext,
  historyEvents: readonly SignedNostrEvent[],
  candidate: PactAgreementTransition,
): PactAgreementTransition {
  const recreated = createPactAgreementTransition({
    context,
    history: historyEvents,
    predecessorEventId: candidate.content.predecessor,
    nextState: candidate.content.state,
    actor: candidate.content.actor,
    actorRole: candidate.content.actor_role,
    reasonCode: candidate.content.reason_code,
    resultReference: candidate.content.result_reference,
    createdAt: candidate.event.created_at,
  });
  if (
    serializeUnsignedNostrEvent(recreated.event) !==
      serializeUnsignedNostrEvent(unsignedPart(candidate.event)) ||
    JSON.stringify(recreated.content) !== JSON.stringify(candidate.content)
  ) {
    agreementError("malformed_event", "PactAgent transition draft is inconsistent");
  }
  return recreated;
}
