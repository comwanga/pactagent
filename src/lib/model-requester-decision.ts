import type {
  RequesterDecisionModel,
  RequesterDecisionModelContext,
  SafeRequesterDecisionCandidate,
  SafeRequesterDecisionInput,
} from "./requester-decision";

/** The complete, provider-neutral payload that may cross the requester-model boundary. */
export interface RequesterRecommendationRequest {
  readonly instruction: string;
  readonly capabilityProfile: SafeRequesterDecisionInput["capabilityProfile"];
  readonly maximumBudgetSats: string;
  readonly candidates: readonly SafeRequesterDecisionCandidate[];
}

export interface RequesterRecommendationTransport {
  complete(
    request: RequesterRecommendationRequest,
    context: RequesterDecisionModelContext,
  ): Promise<unknown>;
}

function copyCandidate(candidate: SafeRequesterDecisionCandidate): SafeRequesterDecisionCandidate {
  return Object.freeze({
    providerPublicKey: candidate.providerPublicKey,
    providerDefinitionReference: candidate.providerDefinitionReference,
    offerReference: candidate.offerReference,
    escrowDescriptorReference: candidate.escrowDescriptorReference,
    amountSats: candidate.amountSats,
    settlementNetwork: candidate.settlementNetwork,
    maximumExecutionSeconds: candidate.maximumExecutionSeconds,
  });
}

/**
 * Adapts a provider transport to PactAgent's existing recommendation-only boundary.
 * Parsing and economic authorization deliberately remain in runRequesterDecision().
 */
export function createModelBackedRequesterDecisionModel(
  transport: RequesterRecommendationTransport,
): RequesterDecisionModel {
  return Object.freeze({
    async recommend(
      input: SafeRequesterDecisionInput,
      context: RequesterDecisionModelContext,
    ): Promise<unknown> {
      const request: RequesterRecommendationRequest = Object.freeze({
        instruction: input.instruction,
        capabilityProfile: input.capabilityProfile,
        maximumBudgetSats: input.maximumBudgetSats,
        candidates: Object.freeze(input.candidates.map(copyCandidate)),
      });
      return transport.complete(request, context);
    },
  });
}
