// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  RequesterApiClientError,
  type RequesterTransactionSubmission,
} from "@/lib/requester-api-client";
import type {
  RequesterSafeReport,
  RequesterTransactionStatus,
} from "@/lib/requester-api-contracts";
import { safeReportFixture, safeStatusFixture } from "@/lib/requester-api-test-fixtures";

import { RequesterTransactionApp } from "./requester-transaction-app";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function settledStatus(
  overrides: Partial<RequesterTransactionStatus> = {},
): RequesterTransactionStatus {
  return { ...safeStatusFixture(), ...overrides };
}

function resumableStatus(): RequesterTransactionStatus {
  return settledStatus({
    phase: "accepted",
    operationalState: "failed",
    availableActions: { resume: true, reconcile: false, refund: false },
    resultAvailable: false,
    reportAvailable: false,
    finalOutcome: undefined,
    failureCode: "transaction_failed",
    settlementReference: undefined,
  });
}

function reconciliationStatus(): RequesterTransactionStatus {
  return settledStatus({
    phase: "release_authorized",
    operationalState: "reconciliation_required",
    availableActions: { resume: false, reconcile: true, refund: false },
    resultAvailable: true,
    reportAvailable: false,
    finalOutcome: undefined,
    settlementReference: undefined,
    reconciliationRequired: true,
    reconciliationState: "release_reconciliation_required",
  });
}

function submission(): RequesterTransactionSubmission {
  return {
    idempotencyKey: "phase3-stable-key",
    submit: vi.fn(async () => ({ transactionId: safeStatusFixture().transactionId })),
  };
}

function phase3Api(options: {
  readonly status?: () => Promise<RequesterTransactionStatus>;
  readonly privateResult?: () => Promise<{ summary: string }>;
  readonly report?: () => Promise<RequesterSafeReport>;
  readonly resume?: () => Promise<RequesterSafeReport>;
  readonly reconcile?: () => Promise<RequesterSafeReport | RequesterTransactionStatus>;
  readonly refund?: () => Promise<RequesterSafeReport>;
} = {}) {
  return {
    currentTransaction: vi.fn(async () => ({ transactionId: null })),
    closeCurrentTransaction: vi.fn(async () => ({ cleared: true as const })),
    createSubmission: vi.fn(() => submission()),
    status: vi.fn(options.status ?? (async () => settledStatus())),
    privateResult: vi.fn(options.privateResult ?? (async () => ({ summary: "PRIVATE-RESULT-MARKER" }))),
    report: vi.fn(options.report ?? (async () => safeReportFixture())),
    resume: vi.fn(options.resume ?? (async () => safeReportFixture())),
    reconcile: vi.fn(options.reconcile ?? (async () => safeReportFixture())),
    refund: vi.fn(options.refund ?? (async () => safeReportFixture())),
    startDemo: vi.fn().mockResolvedValue({ economicMode: "demo", generation: 1, disclosure: "Demo sats — no monetary value" }),
    demoWallet: vi.fn().mockResolvedValue({ economicMode: "demo", started: true, generation: 1, balance: { availableSats: 1000 }, resetAvailable: true, disclosure: "Demo sats — no monetary value" }),
    resetDemo: vi.fn().mockResolvedValue({ economicMode: "demo", generation: 2, disclosure: "Demo sats — no monetary value" }),
  };
}

async function reachStatus(
  user: ReturnType<typeof userEvent.setup>,
  api: ReturnType<typeof phase3Api>,
  pollIntervalMs = 10_000,
): Promise<void> {
  render(<RequesterTransactionApp api={api} pollIntervalMs={pollIntervalMs} />);
  await user.click(await screen.findByRole("button", { name: "New transaction" }, { timeout: 5_000 }));
  await user.upload(
    screen.getByLabelText("Choose document"),
    new File(["PRIVATE-PHASE3-DOCUMENT"], "request.txt", { type: "text/plain" }),
  );
  await screen.findByText("request.txt");
  await user.click(screen.getByRole("button", { name: "Review request" }));
  await user.click(await screen.findByRole("button", { name: "Submit transaction" }));
  await screen.findByRole("heading", { name: "Transaction status" });
}

describe("requester transaction UI Phase 3", () => {
  it("does not permit private-result retrieval before resultAvailable", async () => {
    const api = phase3Api({ status: async () => settledStatus({ resultAvailable: false }) });
    await reachStatus(userEvent.setup(), api);
    expect(screen.queryByRole("button", { name: /private result/i })).toBeNull();
    expect(api.privateResult).not.toHaveBeenCalled();
  });

  it("loads a private result only through the result capability", async () => {
    const api = phase3Api();
    const user = userEvent.setup();
    await reachStatus(user, api);
    await user.click(screen.getByRole("button", { name: "Load private result" }));
    expect(await screen.findByText("PRIVATE-RESULT-MARKER")).toBeTruthy();
    expect(api.privateResult).toHaveBeenCalledOnce();
    expect(api.privateResult).toHaveBeenCalledWith(safeStatusFixture().transactionId);
    expect(api.report).not.toHaveBeenCalled();
    expect(api.resume).not.toHaveBeenCalled();
    expect(api.reconcile).not.toHaveBeenCalled();
  });

  it("renders the complete private result as text rather than HTML", async () => {
    const privateMarkup = "<img src=x onerror=alert('private')>PRIVATE-TEXT";
    const api = phase3Api({ privateResult: async () => ({ summary: privateMarkup }) });
    const user = userEvent.setup();
    await reachStatus(user, api);
    await user.click(screen.getByRole("button", { name: "Load private result" }));
    expect(await screen.findByText(privateMarkup)).toBeTruthy();
    expect(document.querySelector(".privateSummary img")).toBeNull();
  });

  it("handles result_not_available using the redacted client error", async () => {
    const api = phase3Api({
      privateResult: async () => {
        throw new RequesterApiClientError(409, {
          error: "The private result is not available",
          code: "result_not_available",
        });
      },
    });
    const user = userEvent.setup();
    await reachStatus(user, api);
    await user.click(screen.getByRole("button", { name: "Load private result" }));
    expect(await screen.findByText("The private result is not available yet.")).toBeTruthy();
  });

  it("does not permit report retrieval before reportAvailable", async () => {
    const api = phase3Api({ status: async () => settledStatus({ reportAvailable: false }) });
    await reachStatus(userEvent.setup(), api);
    expect(screen.queryByRole("button", { name: /safe transaction report/i })).toBeNull();
    expect(api.report).not.toHaveBeenCalled();
  });

  it("loads a report only through the report capability and keeps it separate from the result", async () => {
    const api = phase3Api();
    const user = userEvent.setup();
    await reachStatus(user, api);
    await user.click(screen.getByRole("button", { name: "Load private result" }));
    await user.click(screen.getByRole("button", { name: "Load safe transaction report" }));
    const privateSection = screen.getByRole("heading", { name: "Private result" }).closest("section");
    const reportSection = screen.getByRole("heading", { name: "Safe transaction report" }).closest("section");
    expect(privateSection).not.toBeNull();
    expect(reportSection).not.toBeNull();
    expect(within(privateSection!).getByText("PRIVATE-RESULT-MARKER")).toBeTruthy();
    expect(within(reportSection!).queryByText("PRIVATE-RESULT-MARKER")).toBeNull();
    expect(api.report).toHaveBeenCalledOnce();
    expect(api.privateResult).toHaveBeenCalledOnce();
    expect(api.resume).not.toHaveBeenCalled();
    expect(api.reconcile).not.toHaveBeenCalled();
  });

  it("represents expired, rejected, and disputed report lifecycle states exactly", async () => {
    const report: RequesterSafeReport = {
      ...safeReportFixture(),
      lifecycle: [
        { state: "expired", eventId: "event-expired" },
        { state: "rejected", eventId: "event-rejected" },
        { state: "disputed", eventId: "event-disputed" },
      ],
      finalOutcome: "refunded",
      settlementReference: undefined,
      refundReference: "refund-safe-reference",
    };
    const api = phase3Api({ report: async () => report });
    const user = userEvent.setup();
    await reachStatus(user, api);
    await user.click(screen.getByRole("button", { name: "Load safe transaction report" }));
    expect(await screen.findByText("expired")).toBeTruthy();
    expect(screen.getByText("rejected")).toBeTruthy();
    expect(screen.getByText("disputed")).toBeTruthy();
  });

  it("shows Resume only when the authoritative action flag permits it", async () => {
    const api = phase3Api({ status: async () => resumableStatus() });
    await reachStatus(userEvent.setup(), api);
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconcile" })).toBeNull();
  });

  it("calls only Resume and refetches status without optimistic phase mutation", async () => {
    let finishResume!: (report: RequesterSafeReport) => void;
    let finishStatus!: (status: RequesterTransactionStatus) => void;
    const resume = new Promise<RequesterSafeReport>((resolve) => { finishResume = resolve; });
    const refreshed = new Promise<RequesterTransactionStatus>((resolve) => { finishStatus = resolve; });
    const api = phase3Api({
      status: vi.fn()
        .mockResolvedValueOnce(resumableStatus())
        .mockImplementationOnce(() => refreshed),
      resume: () => resume,
    });
    const user = userEvent.setup();
    await reachStatus(user, api);
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(screen.getAllByText("accepted").length).toBeGreaterThan(0);
    expect(api.status).toHaveBeenCalledOnce();
    finishResume(safeReportFixture());
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("accepted").length).toBeGreaterThan(0);
    finishStatus(settledStatus());
    await waitFor(() => expect(screen.getAllByText("settled").length).toBeGreaterThan(0));
    expect(api.resume).toHaveBeenCalledOnce();
    expect(api.report).not.toHaveBeenCalled();
    expect(api.reconcile).not.toHaveBeenCalled();
  });

  it("shows Reconcile only when the authoritative action flag permits it", async () => {
    const api = phase3Api({ status: async () => reconciliationStatus() });
    await reachStatus(userEvent.setup(), api);
    expect(screen.getByRole("button", { name: "Reconcile" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("requires confirmation, manages focus, calls only Reconcile, and refetches status", async () => {
    const api = phase3Api({
      status: vi.fn()
        .mockResolvedValueOnce(reconciliationStatus())
        .mockResolvedValueOnce(settledStatus()),
    });
    const user = userEvent.setup();
    await reachStatus(user, api);
    const trigger = screen.getByRole("button", { name: "Reconcile" });
    await user.click(trigger);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/inspect existing runtime and economic state/i)).toBeTruthy();
    expect(api.reconcile).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Confirm reconciliation" }));
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));
    expect(api.reconcile).toHaveBeenCalledOnce();
    expect(api.resume).not.toHaveBeenCalled();
    expect(api.report).not.toHaveBeenCalled();
    expect(api.privateResult).not.toHaveBeenCalled();
  });

  it("does not automatically retry a failed reconciliation request", async () => {
    const api = phase3Api({
      status: async () => reconciliationStatus(),
      reconcile: async () => {
        throw new RequesterApiClientError(503, {
          error: "The transaction service is unavailable",
          code: "runtime_unavailable",
        });
      },
    });
    const user = userEvent.setup();
    await reachStatus(user, api);
    await user.click(screen.getByRole("button", { name: "Reconcile" }));
    await user.click(screen.getByRole("button", { name: "Confirm reconciliation" }));
    expect((await screen.findAllByText("The transaction service is temporarily unavailable.")).length)
      .toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.reconcile).toHaveBeenCalledOnce();
    expect(api.status).toHaveBeenCalledOnce();
  });

  it("keeps reconciliation_required distinct from terminal and failure states", async () => {
    const api = phase3Api({ status: async () => reconciliationStatus() });
    await reachStatus(userEvent.setup(), api);
    const stateCard = document.querySelector(".stateCard");
    expect(stateCard?.textContent).toContain("reconciliation_required");
    expect(stateCard?.textContent).not.toContain("failed");
    expect(stateCard?.textContent).not.toContain("refunded");
    expect(stateCard?.textContent).not.toContain("settled");
  });

  it.each(["settled", "refunded", "failed", "resolved_not_funded"] as const)(
    "stops status polling for terminal operational state %s",
    async (operationalState) => {
      const status = settledStatus({
        operationalState,
        phase: operationalState === "refunded" ? "refunded" : operationalState === "settled" ? "settled" : "accepted",
        kind: operationalState === "refunded" ? "refund" : "successful",
        finalOutcome: operationalState === "settled" ? "settled" : operationalState === "refunded" ? "refunded" : undefined,
        failureCode: operationalState === "failed" ? "transaction_failed" : undefined,
      });
      const api = phase3Api({ status: async () => status });
      await reachStatus(userEvent.setup(), api, 5);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(api.status).toHaveBeenCalledOnce();
    },
  );

  it("closes the transaction and clears status, report, and private-result memory", async () => {
    const api = phase3Api();
    const user = userEvent.setup();
    await reachStatus(user, api);
    await user.click(screen.getByRole("button", { name: "Load private result" }));
    await user.click(screen.getByRole("button", { name: "Load safe transaction report" }));
    await screen.findByText("PRIVATE-RESULT-MARKER");
    await user.click(screen.getByRole("button", { name: "Close transaction" }));
    expect(await screen.findByRole("button", { name: "New transaction" })).toBeTruthy();
    expect(api.closeCurrentTransaction).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("PRIVATE-RESULT-MARKER");
    expect(document.body.textContent).not.toContain(safeStatusFixture().transactionId);
    expect(screen.queryByRole("heading", { name: "Safe transaction report" })).toBeNull();
  });

  it("never writes a loaded private result to URLs, storage, metadata, or logs", async () => {
    const marker = "PRIVATE-RESULT-NO-PERSISTENCE-MARKER";
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api = phase3Api({ privateResult: async () => ({ summary: marker }) });
    const user = userEvent.setup();
    await reachStatus(user, api);
    await user.click(screen.getByRole("button", { name: "Load private result" }));
    expect(await screen.findByText(marker)).toBeTruthy();
    expect(location.href).not.toContain(marker);
    expect(document.head.textContent).not.toContain(marker);
    expect(storage).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
