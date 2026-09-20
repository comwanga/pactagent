import { InvalidDomainInputError } from "./errors";
import { findForbiddenPublicMaterial, isForbiddenFieldName } from "./forbidden-material";
import type { NostrIdentity, NostrPublicKey, UnsignedNostrEvent } from "./nostr";
import { nostrPublicKey, parseUnsignedNostrEvent } from "./nostr";
import type { Sats } from "./money";
import { sats } from "./money";

export const PIP01_ESCROW_DESCRIPTOR_KIND = 30361;
export const PACTAGENT_CASHU_REFERENCE_FORMAT = "opaque_service_reference";

export type PontmoreEscrowDescriptorErrorCode =
  | "invalid_descriptor"
  | "forbidden_public_field"
  | "unsupported_escrow_type"
  | "unsupported_network"
  | "missing_required_metadata"
  | "malformed_descriptor_reference";

export class PontmoreEscrowDescriptorError extends InvalidDomainInputError {
  readonly code: PontmoreEscrowDescriptorErrorCode;

  constructor(code: PontmoreEscrowDescriptorErrorCode, message: string) {
    super(message);
    this.name = "PontmoreEscrowDescriptorError";
    this.code = code;
  }
}

export interface PontmoreEscrowTimeoutPolicy {
  readonly class: "refund-trigger timeout";
  readonly duration_seconds: number;
  readonly fallback_resolution: "cancelling and refunding";
}

export interface PontmoreEscrowDescriptorContent {
  readonly version: 1;
  readonly escrow_type: "cashu_escrow";
  readonly networks: readonly ["cashu"];
  readonly funding_rules: Readonly<{
    funding_threshold: number;
    participant_count: number;
  }>;
  readonly dispute_rules: Readonly<{
    policy: "pip03";
    timeout: PontmoreEscrowTimeoutPolicy;
  }>;
  readonly reference_format: typeof PACTAGENT_CASHU_REFERENCE_FORMAT;
  readonly updated_at: number;
}

export interface PontmoreEscrowDescriptor<TEvent extends UnsignedNostrEvent = UnsignedNostrEvent> {
  readonly identifier: string;
  readonly address: string;
  readonly event: TEvent;
  readonly content: PontmoreEscrowDescriptorContent;
}

export type Pip03TimeoutClass =
  | "request expiry"
  | "funding timeout"
  | "payment proof timeout"
  | "payout timeout"
  | "resolution timeout"
  | "refund-trigger timeout";

export type Pip03FallbackResolution =
  | "confirming the customer claim"
  | "confirming the agent claim"
  | "splitting outcome"
  | "cancelling and refunding"
  | "escalating to manual review";

export type CashuSettlementState =
  | "planned"
  | "funding_intended"
  | "secured"
  | "release_intended"
  | "refund_intended"
  | "disputed"
  | "released"
  | "refunded";

/** Application escrow intent; only its timeout semantics are mirrored into public PIP-01 metadata. */
export interface CashuEscrowPlan {
  readonly descriptorReference: string;
  readonly amountSats: Sats;
  readonly settlementState: CashuSettlementState;
  readonly fundingIntent: Readonly<{ action: "commit"; network: "cashu" }>;
  readonly releaseIntent: Readonly<{
    action: "release";
    condition: "deterministic_completion_checks_pass";
  }>;
  readonly refundIntent: Readonly<{
    action: "refund";
    condition: "timeout_or_pip03_resolution";
  }>;
  readonly timeout: Readonly<{
    class: Pip03TimeoutClass;
    durationSeconds: number;
    fallbackResolution: Pip03FallbackResolution;
  }>;
}

export interface CreateCashuDescriptorInput {
  readonly identity: NostrIdentity;
  readonly identifier: string;
  readonly updatedAt: number;
  readonly referenceFormat: string;
  readonly fundingThreshold?: number;
  readonly participantCount?: number;
  readonly timeoutSeconds?: number;
}

export interface PontmoreEscrowDescriptorReference {
  readonly kind: typeof PIP01_ESCROW_DESCRIPTOR_KIND;
  readonly publicKey: NostrPublicKey;
  readonly identifier: string;
}

const CREATE_INPUT_KEYS = [
  "identity",
  "identifier",
  "updatedAt",
  "referenceFormat",
  "fundingThreshold",
  "participantCount",
  "timeoutSeconds",
] as const;
function assertNoForbiddenPublicMaterial(value: unknown): void {
  const reason = findForbiddenPublicMaterial(value);
  if (reason === undefined) return;
  descriptorError(
    "forbidden_public_field",
    reason.kind === "field"
      ? "PIP-01 public descriptor contains a forbidden private field"
      : "PIP-01 public descriptor contains forbidden secret or token material",
  );
}

function descriptorError(code: PontmoreEscrowDescriptorErrorCode, message: string): never {
  throw new PontmoreEscrowDescriptorError(code, message);
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    descriptorError("invalid_descriptor", `${field} must be a positive safe integer`);
  }
}

function requireIdentifier(value: string): string {
  const identifier = value.trim();
  if (/^[0-9a-f]{64}$/i.test(identifier)) {
    descriptorError(
      "forbidden_public_field",
      "PIP-01 public identifier must not contain secret-key-shaped material",
    );
  }
  if (!identifier || identifier !== value || /[\u0000-\u001f\u007f]/.test(identifier)) {
    descriptorError("missing_required_metadata", "PIP-01 d tag must be a stable non-empty identifier");
  }
  assertNoForbiddenPublicMaterial(identifier);
  return identifier;
}

export function createCashuEscrowDescriptor(
  input: CreateCashuDescriptorInput,
): PontmoreEscrowDescriptor {
  assertNoForbiddenPublicMaterial(input);
  if (Object.keys(input).some((key) => !CREATE_INPUT_KEYS.includes(key as (typeof CREATE_INPUT_KEYS)[number]))) {
    descriptorError("invalid_descriptor", "Cashu descriptor input contains unsupported fields");
  }
  const identifier = requireIdentifier(input.identifier);
  const referenceFormat = input.referenceFormat.trim();
  const fundingThreshold = input.fundingThreshold ?? 1;
  const participantCount = input.participantCount ?? 1;
  const timeoutSeconds = input.timeoutSeconds ?? 15 * 60;
  if (referenceFormat !== PACTAGENT_CASHU_REFERENCE_FORMAT) {
    descriptorError("invalid_descriptor", "Cashu descriptor reference format is unsupported");
  }
  if (!Number.isInteger(input.updatedAt) || input.updatedAt < 0) {
    descriptorError("invalid_descriptor", "PIP-01 updated_at must be a non-negative integer");
  }
  requirePositiveInteger(fundingThreshold, "Funding threshold");
  requirePositiveInteger(participantCount, "Participant count");
  requirePositiveInteger(timeoutSeconds, "Timeout duration");
  if (participantCount < fundingThreshold) {
    descriptorError("invalid_descriptor", "Participant count must be at least the funding threshold");
  }

  const content: PontmoreEscrowDescriptorContent = {
    version: 1,
    escrow_type: "cashu_escrow",
    networks: ["cashu"],
    funding_rules: { funding_threshold: fundingThreshold, participant_count: participantCount },
    dispute_rules: {
      policy: "pip03",
      timeout: {
        class: "refund-trigger timeout",
        duration_seconds: timeoutSeconds,
        fallback_resolution: "cancelling and refunding",
      },
    },
    reference_format: PACTAGENT_CASHU_REFERENCE_FORMAT,
    updated_at: input.updatedAt,
  };
  const event: UnsignedNostrEvent = {
    pubkey: input.identity.publicKey,
    created_at: input.updatedAt,
    kind: PIP01_ESCROW_DESCRIPTOR_KIND,
    tags: [["d", identifier], ["network", "cashu"]],
    content: JSON.stringify(content),
  };
  return {
    identifier,
    address: `${PIP01_ESCROW_DESCRIPTOR_KIND}:${input.identity.publicKey}:${identifier}`,
    event,
    content,
  };
}

export function parseCashuEscrowDescriptor(serialized: string): PontmoreEscrowDescriptor {
  const event = parseUnsignedNostrEvent(serialized);
  return parseCashuEscrowDescriptorEvent(event);
}

export function parseCashuEscrowDescriptorEvent<TEvent extends UnsignedNostrEvent>(
  event: TEvent,
): PontmoreEscrowDescriptor<TEvent> {
  if (event.kind !== PIP01_ESCROW_DESCRIPTOR_KIND) {
    descriptorError("invalid_descriptor", "PIP-01 escrow descriptor must use kind 30361");
  }
  assertNoForbiddenPublicMaterial(event.tags);
  for (const tag of event.tags) {
    if (isForbiddenFieldName(tag[0])) {
      descriptorError(
        "forbidden_public_field",
        "PIP-01 public descriptor contains a forbidden private tag",
      );
    }
    if (!["d", "network"].includes(tag[0]) || tag.length !== 2) {
      descriptorError("invalid_descriptor", "PIP-01 descriptor contains unsupported tags");
    }
  }
  const identifierTags = event.tags.filter((tag) => tag[0] === "d");
  if (identifierTags.length !== 1 || !identifierTags[0][1]) {
    descriptorError("missing_required_metadata", "PIP-01 escrow descriptor requires exactly one d tag");
  }
  const identifier = requireIdentifier(identifierTags[0][1]);

  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    descriptorError("invalid_descriptor", "PIP-01 content must be valid JSON");
  }
  if (typeof content !== "object" || content === null) {
    descriptorError("invalid_descriptor", "PIP-01 content must be an object");
  }
  assertNoForbiddenPublicMaterial(content);
  const candidate = content as Record<string, unknown>;
  const keys = Object.keys(candidate);
  const allowedKeys = [
    "version",
    "escrow_type",
    "networks",
    "funding_rules",
    "dispute_rules",
    "reference_format",
    "updated_at",
  ];
  if (keys.some((key) => !allowedKeys.includes(key))) {
    descriptorError("invalid_descriptor", "PIP-01 descriptor contains unsupported fields");
  }
  if (allowedKeys.some((key) => !(key in candidate))) {
    descriptorError("missing_required_metadata", "PIP-01 descriptor is missing required metadata");
  }
  const funding = candidate.funding_rules as Record<string, unknown> | undefined;
  const dispute = candidate.dispute_rules as Record<string, unknown> | undefined;
  const timeout = dispute?.timeout as Record<string, unknown> | undefined;
  const networkTags = event.tags.filter((tag) => tag[0] === "network").map((tag) => tag[1]);
  if (candidate.escrow_type !== "cashu_escrow") {
    descriptorError("unsupported_escrow_type", "PIP-01 escrow type is unsupported");
  }
  if (
    !Array.isArray(candidate.networks) ||
    candidate.networks.length !== 1 ||
    candidate.networks[0] !== "cashu" ||
    networkTags.length !== 1 ||
    networkTags[0] !== "cashu"
  ) {
    descriptorError("unsupported_network", "PIP-01 Cashu descriptor requires the cashu network");
  }
  if (
    candidate.version !== 1 ||
    candidate.reference_format !== PACTAGENT_CASHU_REFERENCE_FORMAT ||
    !Number.isInteger(candidate.updated_at) ||
    candidate.updated_at !== event.created_at ||
    typeof funding !== "object" ||
    funding === null ||
    Object.keys(funding).some((key) => !["funding_threshold", "participant_count"].includes(key)) ||
    !Number.isInteger(funding.funding_threshold) ||
    !Number.isInteger(funding.participant_count) ||
    (funding.funding_threshold as number) < 1 ||
    (funding.participant_count as number) < (funding.funding_threshold as number) ||
    typeof dispute !== "object" ||
    dispute === null ||
    Object.keys(dispute).some((key) => !["policy", "timeout"].includes(key)) ||
    dispute.policy !== "pip03" ||
    typeof timeout !== "object" ||
    timeout === null ||
    Object.keys(timeout).some((key) => !["class", "duration_seconds", "fallback_resolution"].includes(key)) ||
    timeout.class !== "refund-trigger timeout" ||
    !Number.isSafeInteger(timeout.duration_seconds) ||
    (timeout.duration_seconds as number) < 1 ||
    timeout.fallback_resolution !== "cancelling and refunding"
  ) {
    descriptorError("missing_required_metadata", "PIP-01 Cashu descriptor metadata is missing or invalid");
  }

  const typedContent: PontmoreEscrowDescriptorContent = {
    version: 1,
    escrow_type: "cashu_escrow",
    networks: ["cashu"],
    funding_rules: {
      funding_threshold: funding.funding_threshold as number,
      participant_count: funding.participant_count as number,
    },
    dispute_rules: {
      policy: "pip03",
      timeout: {
        class: "refund-trigger timeout",
        duration_seconds: timeout.duration_seconds as number,
        fallback_resolution: "cancelling and refunding",
      },
    },
    reference_format: PACTAGENT_CASHU_REFERENCE_FORMAT,
    updated_at: candidate.updated_at as number,
  };
  return {
    identifier,
    address: `${PIP01_ESCROW_DESCRIPTOR_KIND}:${event.pubkey}:${identifier}`,
    event,
    content: typedContent,
  };
}

export function parsePontmoreEscrowDescriptorReference(
  reference: string,
): PontmoreEscrowDescriptorReference {
  const match = /^30361:([0-9a-f]{64}):(.+)$/.exec(reference);
  if (!match) {
    descriptorError("malformed_descriptor_reference", "PIP-01 descriptor reference is malformed");
  }
  return {
    kind: PIP01_ESCROW_DESCRIPTOR_KIND,
    publicKey: nostrPublicKey(match[1]),
    identifier: requireIdentifier(match[2]),
  };
}

export function isCashuEscrowCompatible(descriptor: PontmoreEscrowDescriptor): boolean {
  return (
    descriptor.content.escrow_type === "cashu_escrow" &&
    descriptor.content.networks.includes("cashu") &&
    descriptor.content.dispute_rules.policy === "pip03" &&
    descriptor.content.dispute_rules.timeout.class === "refund-trigger timeout" &&
    descriptor.content.dispute_rules.timeout.duration_seconds >= 1 &&
    descriptor.content.dispute_rules.timeout.fallback_resolution === "cancelling and refunding" &&
    descriptor.content.funding_rules.funding_threshold >= 1 &&
    descriptor.content.funding_rules.participant_count >=
      descriptor.content.funding_rules.funding_threshold
  );
}

export function createCashuEscrowPlan(input: {
  descriptor: PontmoreEscrowDescriptor;
  amountSats: Sats;
  timeoutSeconds: number;
}): CashuEscrowPlan {
  if (!isCashuEscrowCompatible(input.descriptor)) {
    throw new InvalidDomainInputError("Escrow descriptor is not Cashu/PIP-03 compatible");
  }
  sats(input.amountSats);
  if (input.amountSats === 0n) throw new InvalidDomainInputError("Escrow amount must be positive");
  if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1) {
    throw new InvalidDomainInputError("Escrow timeout must be a positive integer");
  }
  if (input.timeoutSeconds !== input.descriptor.content.dispute_rules.timeout.duration_seconds) {
    throw new InvalidDomainInputError("Escrow plan timeout must match its public descriptor");
  }
  return {
    descriptorReference: input.descriptor.address,
    amountSats: input.amountSats,
    settlementState: "planned",
    fundingIntent: { action: "commit", network: "cashu" },
    releaseIntent: { action: "release", condition: "deterministic_completion_checks_pass" },
    refundIntent: { action: "refund", condition: "timeout_or_pip03_resolution" },
    timeout: {
      class: "refund-trigger timeout",
      durationSeconds: input.timeoutSeconds,
      fallbackResolution: "cancelling and refunding",
    },
  };
}
