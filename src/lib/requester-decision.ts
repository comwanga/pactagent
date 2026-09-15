import { DOCUMENT_SUMMARY_PROFILE_ID } from "../domain/pact-service-agreement";
import { findForbiddenPublicMaterial } from "../domain/forbidden-material";
import {
  evaluateRequesterOfferPolicy,
  validateRequesterPolicy,
  type RequesterPolicy,
} from "../domain/pact-agents";
import { sats, type Sats } from "../domain/money";
import type { NostrPublicKey } from "../domain/nostr";
import { isCashuEscrowCompatible } from "../domain/pontmore-escrow";
import {
  PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
  PACTAGENT_SERVICE_OFFER_PROFILE_VERSION,
} from "../domain/pact-service-offer";
import type {
  AuthorizedProviderCandidate,
  DiscoveryResult,
  SelectedProviderReferences,
} from "./provider-discovery";

export interface SafeRequesterDecisionCandidate {
  readonly providerPublicKey: NostrPublicKey;
  readonly providerDefinitionReference: string;
  readonly offerReference: string;
  readonly escrowDescriptorReference: string;
  readonly amountSats: string;
  readonly settlementNetwork: "cashu";
  readonly maximumExecutionSeconds: number;
}

export interface SafeRequesterDecisionInput {
  /** Private model input. It is deliberately non-enumerable and omitted by JSON serialization. */
  readonly instruction: string;
  readonly capabilityProfile: typeof DOCUMENT_SUMMARY_PROFILE_ID;
  readonly maximumBudgetSats: string;
  readonly candidates: readonly SafeRequesterDecisionCandidate[];
}

export interface RequesterDecisionModelContext {
  readonly signal: AbortSignal;
}

export interface RequesterDecisionModel {
  recommend(
    input: SafeRequesterDecisionInput,
    context: RequesterDecisionModelContext,
  ): Promise<unknown>;
}

export type RequesterDecisionModelFailureCode = "timeout" | "unavailable";

/** A redacted failure signal for an injected model adapter. */
export class RequesterDecisionModelFailure extends Error {
  readonly code: RequesterDecisionModelFailureCode;

  constructor(code: RequesterDecisionModelFailureCode) {
    super(code === "timeout" ? "Requester decision model timed out" : "Requester decision model is unavailable");
    this.name = "RequesterDecisionModelFailure";
    this.code = code;
  }

  toJSON(): Readonly<{ name: string; code: RequesterDecisionModelFailureCode; message: string }> {
    return Object.freeze({ name: this.name, code: this.code, message: this.message });
  }
}

export interface RequesterDecisionIntent {
  readonly capabilityProfile: string;
  readonly maximumBudgetSats: Sats;
  readonly instruction: string;
}

export interface RequesterDecisionBounds {
  readonly maximumInstructionCharacters: number;
  readonly maximumRationaleCharacters: number;
  readonly modelTimeoutMilliseconds: number;
}

export interface RunRequesterDecisionInput {
  readonly intent: RequesterDecisionIntent;
  readonly requesterPolicy: RequesterPolicy;
  readonly discovery: DiscoveryResult;
  readonly model: RequesterDecisionModel;
  readonly bounds: RequesterDecisionBounds;
}

export type RequesterDecisionReasonCode =
  | "approved"
  | "invalid_request"
  | "unsupported_capability_profile"
  | "no_selected_provider"
  | "invalid_discovery_result"
  | "model_timeout"
  | "model_unavailable"
  | "model_failure"
  | "malformed_model_output"
  | "model_declined"
  | "unknown_provider"
  | "selected_provider_mismatch"
  | "provider_definition_reference_mismatch"
  | "offer_reference_mismatch"
  | "escrow_reference_mismatch"
  | "amount_mismatch"
  | "human_budget_exceeded"
  | "capability_not_allowed"
  | "budget_exceeded"
  | "provider_price_limit_exceeded"
  | "settlement_network_not_allowed"
  | "invalid_execution_duration"
  | "duration_rejected"
  | "cashu_incompatible";

export interface ApprovedRequesterDecision {
  readonly status: "approved";
  readonly reason: "approved";
  readonly capabilityProfile: typeof DOCUMENT_SUMMARY_PROFILE_ID;
  readonly selection: SelectedProviderReferences;
  readonly amountSats: string;
}

export interface RejectedRequesterDecision {
  readonly status: "rejected";
  readonly reason: Exclude<RequesterDecisionReasonCode, "approved">;
}

export type RequesterDecision = ApprovedRequesterDecision | RejectedRequesterDecision;

interface ParsedRecommendation {
  readonly action: "recommend";
  readonly providerPublicKey: string;
  readonly providerDefinitionReference: string;
  readonly offerReference: string;
  readonly escrowDescriptorReference: string;
  readonly proposedAmountSats: Sats;
}

interface ParsedDecline {
  readonly action: "decline";
}

type ParsedModelOutput = ParsedRecommendation | ParsedDecline;

interface AuthoritativeSelectedCandidate {
  readonly references: SelectedProviderReferences;
  readonly amountSats: Sats;
  readonly capabilityProfileId: string;
  readonly capabilityProfileVersion: number;
  readonly settlementNetwork: "cashu";
  readonly maximumExecutionSeconds: number;
  readonly cashuCompatible: boolean;
}

interface AuthoritativeRequesterDecisionSnapshot {
  readonly instruction: string;
  readonly capabilityProfile: typeof DOCUMENT_SUMMARY_PROFILE_ID;
  readonly maximumBudgetSats: Sats;
  readonly requesterPolicy: RequesterPolicy;
  readonly candidates: readonly SafeRequesterDecisionCandidate[];
  readonly selected: AuthoritativeSelectedCandidate;
  readonly bounds: RequesterDecisionBounds;
  readonly recommend: RequesterDecisionModel["recommend"];
}

const RUN_INPUT_KEYS = ["intent", "requesterPolicy", "discovery", "model", "bounds"] as const;
const INTENT_KEYS = ["capabilityProfile", "maximumBudgetSats", "instruction"] as const;
const BOUNDS_KEYS = [
  "maximumInstructionCharacters",
  "maximumRationaleCharacters",
  "modelTimeoutMilliseconds",
] as const;
const RECOMMEND_KEYS = [
  "action",
  "providerPublicKey",
  "providerDefinitionReference",
  "offerReference",
  "escrowDescriptorReference",
  "proposedAmountSats",
  "rationale",
] as const;
const DECLINE_KEYS = ["action", "rationale"] as const;

function rejected(reason: RejectedRequesterDecision["reason"]): RejectedRequesterDecision {
  return Object.freeze({ status: "rejected", reason });
}

function hasExactKeys(value: object, allowed: readonly string[], required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isBoundedText(value: unknown, maximumCharacters: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumCharacters;
}

function projectCandidate(candidate: AuthorizedProviderCandidate): SafeRequesterDecisionCandidate {
  return Object.freeze({
    providerPublicKey: candidate.providerPublicKey,
    providerDefinitionReference: candidate.definition.address,
    offerReference: candidate.offer.address,
    escrowDescriptorReference: candidate.escrowDescriptor.address,
    amountSats: candidate.offer.amountSats.toString(),
    settlementNetwork: candidate.offer.content.settlement_network,
    maximumExecutionSeconds: candidate.offer.content.maximum_execution_seconds,
  });
}

function createAuthoritativeSnapshot(
  input: RunRequesterDecisionInput,
): AuthoritativeRequesterDecisionSnapshot | RejectedRequesterDecision {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      !hasExactKeys(input, RUN_INPUT_KEYS, RUN_INPUT_KEYS) ||
      typeof input.intent !== "object" ||
      input.intent === null ||
      !hasExactKeys(input.intent, INTENT_KEYS, INTENT_KEYS) ||
      typeof input.bounds !== "object" ||
      input.bounds === null ||
      !hasExactKeys(input.bounds, BOUNDS_KEYS, BOUNDS_KEYS) ||
      !isPositiveInteger(input.bounds.maximumInstructionCharacters) ||
      !isPositiveInteger(input.bounds.maximumRationaleCharacters) ||
      !isPositiveInteger(input.bounds.modelTimeoutMilliseconds) ||
      !isBoundedText(input.intent.instruction, input.bounds.maximumInstructionCharacters) ||
      typeof input.intent.maximumBudgetSats !== "bigint" ||
      findForbiddenPublicMaterial(input.intent) !== undefined ||
      !input.model ||
      typeof input.model.recommend !== "function"
    ) {
      return rejected("invalid_request");
    }
    if (input.intent.capabilityProfile !== DOCUMENT_SUMMARY_PROFILE_ID) {
      return rejected("unsupported_capability_profile");
    }
    const maximumBudgetSats = sats(input.intent.maximumBudgetSats);
    if (maximumBudgetSats === 0n) return rejected("invalid_request");

    const requesterPolicy: RequesterPolicy = Object.freeze({
      maxBudgetSats: input.requesterPolicy.maxBudgetSats,
      allowedCapabilities: Object.freeze([...input.requesterPolicy.allowedCapabilities]),
      maximumEscrowDurationSeconds: input.requesterPolicy.maximumEscrowDurationSeconds,
      maximumProviderPriceSats: input.requesterPolicy.maximumProviderPriceSats,
      allowedSettlementNetworks: Object.freeze([
        ...input.requesterPolicy.allowedSettlementNetworks,
      ]) as unknown as readonly ["cashu"],
      autoRelease: input.requesterPolicy.autoRelease,
    });
    validateRequesterPolicy(requesterPolicy);

    const selected = input.discovery.selected;
    if (!selected) return rejected("no_selected_provider");
    const selectedIndex = input.discovery.candidates.findIndex((candidate) => candidate === selected.candidate);
    if (selectedIndex < 0) return rejected("invalid_discovery_result");

    const candidates = Object.freeze(input.discovery.candidates.map(projectCandidate));
    const selectedProjection = candidates[selectedIndex];
    const references = Object.freeze({ ...selected.selected });
    if (
      references.providerPublicKey !== selected.candidate.providerPublicKey ||
      references.providerDefinitionReference !== selected.candidate.definition.address ||
      references.offerReference !== selected.candidate.offer.address ||
      references.escrowDescriptorReference !== selected.candidate.escrowDescriptor.address ||
      selectedProjection.providerPublicKey !== references.providerPublicKey ||
      selectedProjection.providerDefinitionReference !== references.providerDefinitionReference ||
      selectedProjection.offerReference !== references.offerReference ||
      selectedProjection.escrowDescriptorReference !== references.escrowDescriptorReference ||
      typeof selected.candidate.offer.amountSats !== "bigint"
    ) {
      return rejected("invalid_discovery_result");
    }

    const selectedSnapshot: AuthoritativeSelectedCandidate = Object.freeze({
      references,
      amountSats: sats(selected.candidate.offer.amountSats),
      capabilityProfileId: selected.candidate.offer.content.capability_profile.id,
      capabilityProfileVersion: selected.candidate.offer.content.capability_profile.version,
      settlementNetwork: selected.candidate.offer.content.settlement_network,
      maximumExecutionSeconds: selected.candidate.offer.content.maximum_execution_seconds,
      cashuCompatible: isCashuEscrowCompatible(selected.candidate.escrowDescriptor),
    });
    const bounds = Object.freeze({ ...input.bounds });
    const recommend = input.model.recommend.bind(input.model);
    return Object.freeze({
      instruction: input.intent.instruction,
      capabilityProfile: DOCUMENT_SUMMARY_PROFILE_ID,
      maximumBudgetSats,
      requesterPolicy,
      candidates,
      selected: selectedSnapshot,
      bounds,
      recommend,
    });
  } catch {
    return rejected("invalid_request");
  }
}

function createSafeModelInput(snapshot: AuthoritativeRequesterDecisionSnapshot): SafeRequesterDecisionInput {
  const safe = {
    capabilityProfile: DOCUMENT_SUMMARY_PROFILE_ID,
    maximumBudgetSats: snapshot.maximumBudgetSats.toString(),
    candidates: snapshot.candidates,
  } as Omit<SafeRequesterDecisionInput, "instruction"> & { instruction?: string };
  Object.defineProperty(safe, "instruction", {
    value: snapshot.instruction,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(safe) as SafeRequesterDecisionInput;
}

function parsePositiveSats(value: unknown): Sats | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
  try {
    return sats(BigInt(value));
  } catch {
    return undefined;
  }
}

function validRationale(value: unknown, maximumCharacters: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maximumCharacters);
}

function normalizePlainModelRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !("value" in descriptor)
    ) {
      return undefined;
    }
    if (
      (typeof descriptor.value === "object" && descriptor.value !== null) ||
      typeof descriptor.value === "function" ||
      typeof descriptor.value === "symbol"
    ) {
      return undefined;
    }
    normalized[key] = descriptor.value;
  }
  return normalized;
}

function parseModelOutput(value: unknown, maximumRationaleCharacters: number): ParsedModelOutput | undefined {
  try {
    const candidate = normalizePlainModelRecord(value);
    if (!candidate || findForbiddenPublicMaterial(candidate) !== undefined) return undefined;
    if (candidate.action === "decline") {
      if (
        !hasExactKeys(candidate, DECLINE_KEYS, ["action"]) ||
        !validRationale(candidate.rationale, maximumRationaleCharacters)
      ) {
        return undefined;
      }
      return Object.freeze({ action: "decline" });
    }
    if (candidate.action !== "recommend") return undefined;
    if (
      !hasExactKeys(candidate, RECOMMEND_KEYS, [
        "action",
        "providerPublicKey",
        "providerDefinitionReference",
        "offerReference",
        "escrowDescriptorReference",
        "proposedAmountSats",
      ]) ||
      !validRationale(candidate.rationale, maximumRationaleCharacters) ||
      typeof candidate.providerPublicKey !== "string" ||
      typeof candidate.providerDefinitionReference !== "string" ||
      typeof candidate.offerReference !== "string" ||
      typeof candidate.escrowDescriptorReference !== "string"
    ) {
      return undefined;
    }
    const proposedAmountSats = parsePositiveSats(candidate.proposedAmountSats);
    if (!proposedAmountSats) return undefined;
    return Object.freeze({
      action: "recommend",
      providerPublicKey: candidate.providerPublicKey,
      providerDefinitionReference: candidate.providerDefinitionReference,
      offerReference: candidate.offerReference,
      escrowDescriptorReference: candidate.escrowDescriptorReference,
      proposedAmountSats,
    });
  } catch {
    return undefined;
  }
}

function mapRequesterPolicyReason(reason: string): RejectedRequesterDecision["reason"] {
  switch (reason) {
    case "capability_not_allowed":
    case "budget_exceeded":
    case "provider_price_limit_exceeded":
    case "settlement_network_not_allowed":
    case "invalid_execution_duration":
      return reason;
    case "requester_escrow_duration_exceeded":
      return "duration_rejected";
    default:
      return "invalid_request";
  }
}

function deterministicDecision(
  snapshot: AuthoritativeRequesterDecisionSnapshot,
  output: ParsedModelOutput,
): RequesterDecision {
  if (output.action === "decline") return rejected("model_declined");
  const recommendedCandidate = snapshot.candidates.find(
    (candidate) => candidate.providerPublicKey === output.providerPublicKey,
  );
  if (!recommendedCandidate) return rejected("unknown_provider");
  if (output.providerPublicKey !== snapshot.selected.references.providerPublicKey) {
    return rejected("selected_provider_mismatch");
  }
  if (output.providerDefinitionReference !== snapshot.selected.references.providerDefinitionReference) {
    return rejected("provider_definition_reference_mismatch");
  }
  if (output.offerReference !== snapshot.selected.references.offerReference) {
    return rejected("offer_reference_mismatch");
  }
  if (output.escrowDescriptorReference !== snapshot.selected.references.escrowDescriptorReference) {
    return rejected("escrow_reference_mismatch");
  }
  if (output.proposedAmountSats !== snapshot.selected.amountSats) {
    return rejected("amount_mismatch");
  }
  if (output.proposedAmountSats > snapshot.maximumBudgetSats) {
    return rejected("human_budget_exceeded");
  }
  if (
    snapshot.selected.capabilityProfileId !== PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID ||
    snapshot.selected.capabilityProfileVersion !== PACTAGENT_SERVICE_OFFER_PROFILE_VERSION
  ) {
    return rejected("unsupported_capability_profile");
  }
  if (!snapshot.selected.cashuCompatible) {
    return rejected("cashu_incompatible");
  }

  let requesterEvaluation;
  try {
    requesterEvaluation = evaluateRequesterOfferPolicy({
      policy: snapshot.requesterPolicy,
      capability: "document-summary",
      priceSats: snapshot.selected.amountSats,
      settlementNetwork: snapshot.selected.settlementNetwork,
      estimatedExecutionSeconds: snapshot.selected.maximumExecutionSeconds,
    });
  } catch {
    return rejected("invalid_request");
  }
  if (!requesterEvaluation.authorized) {
    return rejected(mapRequesterPolicyReason(requesterEvaluation.reasons[0]));
  }

  return Object.freeze({
    status: "approved",
    reason: "approved",
    capabilityProfile: DOCUMENT_SUMMARY_PROFILE_ID,
    selection: snapshot.selected.references,
    amountSats: snapshot.selected.amountSats.toString(),
  });
}

async function invokeModel(
  recommend: RequesterDecisionModel["recommend"],
  input: SafeRequesterDecisionInput,
  timeoutMilliseconds: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new RequesterDecisionModelFailure("timeout"));
    }, timeoutMilliseconds);
  });
  try {
    return await Promise.race([recommend(input, Object.freeze({ signal: controller.signal })), timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function runRequesterDecision(input: RunRequesterDecisionInput): Promise<RequesterDecision> {
  const snapshot = createAuthoritativeSnapshot(input);
  if ("status" in snapshot) return snapshot;

  let rawOutput: unknown;
  try {
    rawOutput = await invokeModel(
      snapshot.recommend,
      createSafeModelInput(snapshot),
      snapshot.bounds.modelTimeoutMilliseconds,
    );
  } catch (error) {
    if (error instanceof RequesterDecisionModelFailure) {
      return rejected(error.code === "timeout" ? "model_timeout" : "model_unavailable");
    }
    return rejected("model_failure");
  }

  const output = parseModelOutput(rawOutput, snapshot.bounds.maximumRationaleCharacters);
  if (!output) return rejected("malformed_model_output");
  return deterministicDecision(snapshot, output);
}
