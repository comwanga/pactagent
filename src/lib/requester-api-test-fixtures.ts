import type {
  RequesterSafeReport,
  RequesterTransactionStatus,
} from "./requester-api-contracts";

export function safeStatusFixture(): RequesterTransactionStatus {
  return {
    transactionId: "txn_0123456789abcdef0123456789abcdef",
    kind: "successful",
    phase: "settled",
    operationalState: "settled",
    agreementId: "agreement-safe-reference",
    selectedOffer: {
      providerPublicKey: "22".repeat(32),
      providerDefinitionReference: "31990:provider:p002",
      offerReference: "offer-safe-reference",
      escrowDescriptorReference: "32121:provider:pip01",
      amountSats: "350",
      unit: "sat",
    },
    requesterDecision: {
      source: "model",
      recommendation: {
        action: "recommend",
        providerPublicKey: "22".repeat(32),
        offerReference: "offer-safe-reference",
        amountSats: "350",
      },
      policy: {
        selectedProviderMatchesDiscovery: true,
        stableReferencesMatch: true,
        withinRequesterBudget: true,
        cashuCompatible: true,
        priceAllowed: true,
        executionDurationAllowed: true,
      },
      authorized: true,
    },
    availableActions: { resume: false, reconcile: false, refund: false },
    resultAvailable: true,
    reportAvailable: true,
    agreementRootEventId: "root-safe-reference",
    finalOutcome: "settled",
    resultReference: "result-safe-reference",
    escrowReference: "escrow-safe-reference",
    settlementReference: "settlement-safe-reference",
  };
}

export function safeReportFixture(): RequesterSafeReport {
  return {
    workflowVersion: 1,
    agreementId: "agreement-safe-reference",
    agreementRootEventId: "root-safe-reference",
    requesterPublicKey: "11".repeat(32),
    providerPublicKey: "22".repeat(32),
    escrowAuthorityPublicKey: "33".repeat(32),
    selectedReferences: {
      providerPublicKey: "22".repeat(32),
      providerDefinitionReference: "31990:provider:p002",
      offerReference: "offer-safe-reference",
      escrowDescriptorReference: "32121:provider:pip01",
    },
    amountSats: "350",
    unit: "sat",
    lifecycle: [
      { state: "proposed", eventId: "event-proposed" },
      { state: "settled", eventId: "event-settled" },
    ],
    escrowReference: "escrow-safe-reference",
    resultReference: "result-safe-reference",
    settlementReference: "settlement-safe-reference",
    finalOutcome: "settled",
  };
}
