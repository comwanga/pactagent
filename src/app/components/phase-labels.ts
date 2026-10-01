import type { RuntimePhase } from "@/lib/pactagent-api-client";

export const PHASE_LABELS: Record<RuntimePhase, string> = {
  initialized: "Initialized",
  proposed: "Proposed",
  accepted: "Accepted",
  escrow_funded: "Escrow funded",
  task_delivered: "Task delivered",
  result_submitted: "Result submitted",
  result_verified: "Result verified",
  release_authorized: "Release authorized",
  settled: "Settled",
  refund_authorized: "Refund authorized",
  refunded: "Refunded",
};

export const PHASE_VERBS_PRESENT: Record<RuntimePhase, string> = {
  initialized: "Preparing private terms",
  proposed: "Discovering provider (P002) over Nostr",
  accepted: "Provider accepted the pact",
  escrow_funded: "Funding Cashu escrow (PIP-01)",
  task_delivered: "Delivering private task (NIP-59)",
  result_submitted: "Provider submitted the result",
  result_verified: "Verifying result against commitment",
  release_authorized: "Authorizing escrow release",
  settled: "Settled — pact complete",
  refund_authorized: "Authorizing refund",
  refunded: "Refunded — pact cancelled",
};

export const PHASE_VERBS_PAST: Record<RuntimePhase, string> = {
  initialized: "Prepared private terms",
  proposed: "Discovered provider (P002) over Nostr",
  accepted: "Provider accepted the pact",
  escrow_funded: "Funded Cashu escrow (PIP-01)",
  task_delivered: "Delivered private task (NIP-59)",
  result_submitted: "Provider submitted the result",
  result_verified: "Verified result against commitment",
  release_authorized: "Authorized escrow release",
  settled: "Settled — pact complete",
  refund_authorized: "Authorized refund",
  refunded: "Refunded — pact cancelled",
};
