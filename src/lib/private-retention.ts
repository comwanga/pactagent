export interface RetentionRecord {
  readonly phase: string;
  readonly agreementRootEventId?: string;
  readonly escrowReference?: string;
  readonly settlementReference?: string;
  readonly refundReference?: string;
  readonly retentionStartedAt?: number;
}

/** Read-only predicate. Unknown, ambiguous, pending and contradictory state always retains inputs. */
export function privateRetentionEligible(record: RetentionRecord, raw: unknown, accountingComplete: boolean, now: number, retentionSeconds: number): boolean {
  if (!Number.isSafeInteger(now) ||
      !Number.isSafeInteger(retentionSeconds) || retentionSeconds < 1 ||
      !Number.isSafeInteger(record.retentionStartedAt) || record.retentionStartedAt! < 0 ||
      now - record.retentionStartedAt! < retentionSeconds) return false;
  return privateTransactionFinality(record, raw, accountingComplete);
}

export function privateTransactionFinality(record: RetentionRecord, raw: unknown, accountingComplete: boolean): boolean {
  if (!accountingComplete || (record.phase !== "settled" && record.phase !== "refunded") ||
      !record.escrowReference || !record.agreementRootEventId || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const escrow = raw as Record<string, unknown>;
  const operationType = record.phase === "settled" ? "release" : "refund";
  const reference = record.phase === "settled" ? "settlementReference" : "refundReference";
  const oppositeReference = record.phase === "settled" ? "refundReference" : "settlementReference";
  if (escrow.state !== record.phase || escrow.economicClaim !== operationType || escrow.agreementRoot !== record.agreementRootEventId ||
      escrow.reference !== record.escrowReference || !Number.isSafeInteger(escrow.revision) || (escrow.revision as number) < 0 ||
      record[oppositeReference] !== undefined || escrow[oppositeReference] !== undefined ||
      typeof record[reference] !== "string" || escrow[reference] !== record[reference] ||
      typeof escrow.lastPublishedTransitionId !== "string" || escrow.lastPublishedTransitionId.length === 0 ||
      escrow.pendingTransition !== undefined || !escrow.operations || typeof escrow.operations !== "object" || Array.isArray(escrow.operations)) return false;
  const operations = Object.values(escrow.operations);
  const knownTypes = ["prepare", "fund", "authorize_release", "release", "authorize_refund", "refund", "deliver_provider_payout", "deliver_requester_refund"];
  const complete = (value: unknown): value is { type: string; status: string } => !!value && typeof value === "object" &&
    "type" in value && typeof value.type === "string" && knownTypes.includes(value.type) && "status" in value && (value.status === "succeeded" || value.status === "failed");
  // Authorization is not a spend: a failed release after authorization can
  // legitimately be followed by a timeout refund. Reject opposite effects.
  const oppositeTypes = record.phase === "settled" ? ["refund", "deliver_requester_refund"] : ["release", "deliver_provider_payout"];
  return operations.length > 0 && operations.every(complete) &&
    !operations.some(value => complete(value) && oppositeTypes.includes(value.type) && value.status === "succeeded") &&
    operations.some(value => complete(value) && value.type === "fund" && value.status === "succeeded") &&
    operations.some(value => complete(value) && value.type === operationType && value.status === "succeeded");
}
