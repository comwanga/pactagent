import { describe, expect, it } from "vitest";

import {
  parseRequesterApiError,
  parseRequesterDemoWallet,
  parseRequesterSafeReport,
  parseRequesterTransactionStatus,
  RequesterContractError,
} from "./requester-api-contracts";
import { safeReportFixture, safeStatusFixture } from "./requester-api-test-fixtures";

describe("requester API contracts", () => {
  it("accepts the current allowlisted Issue #33 status DTO", () => {
    expect(parseRequesterTransactionStatus(safeStatusFixture())).toEqual(safeStatusFixture());
  });

  it("accepts the current allowlisted Issue #33 safe report DTO", () => {
    expect(parseRequesterSafeReport(safeReportFixture())).toEqual(safeReportFixture());
    expect(parseRequesterSafeReport({
      ...safeReportFixture(),
      lifecycle: [
        { state: "proposed", eventId: "event-proposed" },
        { state: "expired", eventId: "event-expired" },
        { state: "refund_authorized", eventId: "event-refund-authorized" },
        { state: "refunded", eventId: "event-refunded" },
      ],
      finalOutcome: "refunded",
      refundReference: "refund-safe-reference",
    })).toMatchObject({ finalOutcome: "refunded" });
  });

  it("accepts only a boolean accounting-pending wallet projection", () => {
    const wallet = {
      economicMode: "demo" as const,
      started: true,
      generation: 1,
      balance: { availableSats: 650 },
      resetAvailable: true,
      accountingPending: false,
      disclosure: "Demo sats — no monetary value" as const,
    };
    expect(parseRequesterDemoWallet(wallet)).toEqual(wallet);
    expect(() => parseRequesterDemoWallet({ ...wallet, accountingPending: "false" }))
      .toThrow(RequesterContractError);
  });

  it("fails closed on malformed and unexpected status fields", () => {
    expect(() => parseRequesterTransactionStatus({
      ...safeStatusFixture(),
      privateDocument: "must-not-pass",
    })).toThrow(RequesterContractError);
    expect(() => parseRequesterTransactionStatus({
      ...safeStatusFixture(),
      selectedOffer: { ...safeStatusFixture().selectedOffer, unit: "btc" },
    })).toThrow(RequesterContractError);
    expect(() => parseRequesterTransactionStatus({
      ...safeStatusFixture(),
      failureCode: "transaction_failed",
      failureReason: "raw database exception with secret material",
    })).toThrow(RequesterContractError);
  });

  it("fails closed on unknown error codes and report fields", () => {
    expect(() => parseRequesterApiError({ error: "raw", code: "new_internal_detail" }))
      .toThrow(RequesterContractError);
    expect(() => parseRequesterSafeReport({ ...safeReportFixture(), summary: "private" }))
      .toThrow(RequesterContractError);
  });
});
