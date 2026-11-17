import { describe, expect, it } from "vitest";
import { privateRetentionEligible } from "./private-retention";

const terminal = {
  phase: "settled", escrowReference: "escrow-1", settlementReference: "settlement-1",
  agreementRootEventId: "root-1", retentionStartedAt: 100,
};
const escrow = {
  state: "settled", revision: 7, economicClaim: "release", agreementRoot: "root-1", reference: "escrow-1",
  settlementReference: "settlement-1", lastPublishedTransitionId: "terminal-1",
  operations: { fund: { type: "fund", status: "succeeded" }, release: { type: "release", status: "succeeded" } },
};

describe("Issue #66 conservative terminal eligibility", () => {
  it.each(["initialized", "proposed", "accepted", "escrow_funded", "task_delivered", "result_submitted", "result_verified", "release_authorized", "refund_authorized"])("never purges %s", phase => {
    expect(privateRetentionEligible({ ...terminal, phase }, escrow, true, 1000, 10)).toBe(false);
  });
  it("requires matching completed accounting, no ambiguity/publication, and the exact expiry boundary", () => {
    expect(privateRetentionEligible(terminal, escrow, true, 109, 10)).toBe(false);
    expect(privateRetentionEligible(terminal, escrow, true, 110, 10)).toBe(true);
    expect(privateRetentionEligible(terminal, escrow, false, 1000, 10)).toBe(false);
    for (const state of ["funding_reconciliation_required", "release_pending", "refund_pending", "release_reconciliation_required", "refund_reconciliation_required"])
      expect(privateRetentionEligible(terminal, { ...escrow, state }, true, 1000, 10)).toBe(false);
    expect(privateRetentionEligible(terminal, { ...escrow, pendingTransition: {} }, true, 1000, 10)).toBe(false);
    for (const status of ["pending", "reconciliation_required", "publication_pending", "unknown"])
      expect(privateRetentionEligible(terminal, { ...escrow, operations: { ...escrow.operations, extra: { status } } }, true, 1000, 10)).toBe(false);
    expect(privateRetentionEligible(terminal, { ...escrow, settlementReference: "other" }, true, 1000, 10)).toBe(false);
  });
  it("rejects unknown operations and contradictory successful outcomes", () => {
    expect(privateRetentionEligible(terminal, { ...escrow, operations: { ...escrow.operations, unknown: { type: "unknown", status: "succeeded" } } }, true, 110, 10)).toBe(false);
    expect(privateRetentionEligible(terminal, { ...escrow, operations: { ...escrow.operations, refund: { type: "refund", status: "succeeded" } } }, true, 110, 10)).toBe(false);
    expect(privateRetentionEligible(terminal, { ...escrow, refundReference: "contradictory" }, true, 110, 10)).toBe(false);
    const refunded = { ...terminal, phase: "refunded", settlementReference: undefined, refundReference: "refund-1" };
    const proof = { ...escrow, state: "refunded", economicClaim: "refund", settlementReference: undefined, refundReference: "refund-1", operations: { fund: escrow.operations.fund, refund: { type: "refund", status: "succeeded" } } };
    expect(privateRetentionEligible(refunded, proof, true, 110, 10)).toBe(true);
    expect(privateRetentionEligible(refunded, { ...proof, operations: { ...proof.operations, release: escrow.operations.release } }, true, 110, 10)).toBe(false);
  });
  it("allows a completed timeout refund after prior release authorization and definitive release failure", () => {
    const refunded = { ...terminal, phase: "refunded", settlementReference: undefined, refundReference: "refund-1" };
    const proof = { ...escrow, state: "refunded", economicClaim: "refund", settlementReference: undefined, refundReference: "refund-1",
      operations: { fund: escrow.operations.fund, refund: { type: "refund", status: "succeeded" },
        authorization: { type: "authorize_release", status: "succeeded" }, failedRelease: { type: "release", status: "failed" } } };
    expect(privateRetentionEligible(refunded, proof, true, 110, 10)).toBe(true);
  });
});
