// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { RequesterTransactionApi } from "@/lib/requester-api-client";
import { safeReportFixture, safeStatusFixture } from "@/lib/requester-api-test-fixtures";

import { RequesterTransactionApp } from "./requester-transaction-app";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function recoveringApi() {
  let currentId: string | null = safeStatusFixture().transactionId;
  const api: RequesterTransactionApi & {
    currentTransaction: ReturnType<typeof vi.fn>;
    closeCurrentTransaction: ReturnType<typeof vi.fn>;
    createSubmission: ReturnType<typeof vi.fn>;
    privateResult: ReturnType<typeof vi.fn>;
    report: ReturnType<typeof vi.fn>;
  } = {
    currentTransaction: vi.fn(async () => ({ transactionId: currentId })),
    closeCurrentTransaction: vi.fn(async () => {
      currentId = null;
      return { cleared: true as const };
    }),
    createSubmission: vi.fn(() => { throw new Error("reload must not create a transaction"); }),
    status: vi.fn(async () => safeStatusFixture()),
    privateResult: vi.fn(async () => ({ summary: "PHASE4-PRIVATE-RESULT-SENTINEL" })),
    report: vi.fn(async () => safeReportFixture()),
    resume: vi.fn(async () => safeReportFixture()),
    reconcile: vi.fn(async () => safeReportFixture()),
    refund: vi.fn(async () => safeReportFixture()),
    startDemo: vi.fn().mockResolvedValue({ economicMode: "demo", generation: 1, disclosure: "Demo sats — no monetary value" }),
    demoWallet: vi.fn().mockResolvedValue({ economicMode: "demo", started: true, generation: 1, balance: { availableSats: 1000 }, resetAvailable: true, disclosure: "Demo sats — no monetary value" }),
    resetDemo: vi.fn().mockResolvedValue({ economicMode: "demo", generation: 2, disclosure: "Demo sats — no monetary value" }),
  };
  return api;
}

describe("requester transaction UI Phase 4 recovery", () => {
  it("recovers the same transaction without creation or automatic private resource loading", async () => {
    const api = recoveringApi();
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const first = render(<RequesterTransactionApp api={api} pollIntervalMs={60_000} />);

    await waitFor(() => expect(api.status).toHaveBeenCalled(), { timeout: 5_000 });
    expect(await screen.findByRole("heading", { name: "Transaction status" }, { timeout: 5_000 })).toBeTruthy();
    expect(api.currentTransaction).toHaveBeenCalledOnce();
    expect(api.createSubmission).not.toHaveBeenCalled();
    expect(api.privateResult).not.toHaveBeenCalled();
    expect(api.report).not.toHaveBeenCalled();
    expect(screen.queryByText("PHASE4-PRIVATE-RESULT-SENTINEL")).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: "Load private result" }));
    expect(await screen.findByText("PHASE4-PRIVATE-RESULT-SENTINEL")).toBeTruthy();
    first.unmount();

    render(<RequesterTransactionApp api={api} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("heading", { name: "Transaction status" }, { timeout: 5_000 })).toBeTruthy();
    expect(screen.queryByText("PHASE4-PRIVATE-RESULT-SENTINEL")).toBeNull();
    expect(api.privateResult).toHaveBeenCalledOnce();
    expect(api.report).not.toHaveBeenCalled();
    expect(api.createSubmission).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it("Close clears recovery and browser state without a runtime transaction mutation", async () => {
    const api = recoveringApi();
    const first = render(<RequesterTransactionApp api={api} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("heading", { name: "Transaction status" })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Close transaction" }));
    expect(await screen.findByRole("button", { name: "New transaction" })).toBeTruthy();
    expect(api.closeCurrentTransaction).toHaveBeenCalledOnce();
    expect(api.resume).not.toHaveBeenCalled();
    expect(api.reconcile).not.toHaveBeenCalled();
    first.unmount();

    render(<RequesterTransactionApp api={api} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("button", { name: "New transaction" })).toBeTruthy();
    expect(screen.queryByText(safeStatusFixture().transactionId)).toBeNull();
    expect(api.createSubmission).not.toHaveBeenCalled();
  });

  it("fails safely to the landing surface when session discovery is unavailable", async () => {
    const api = recoveringApi();
    api.currentTransaction.mockRejectedValueOnce(new Error("private infrastructure detail"));
    render(<RequesterTransactionApp api={api} />);
    expect(await screen.findByRole("button", { name: "New transaction" })).toBeTruthy();
    expect(screen.getByText("The transaction service could not complete the request.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("private infrastructure detail");
    expect(api.createSubmission).not.toHaveBeenCalled();
  });

  it("does not clear local state when the server recovery pointer cannot be cleared", async () => {
    const api = recoveringApi();
    api.closeCurrentTransaction.mockRejectedValueOnce(new Error("secret database detail"));
    render(<RequesterTransactionApp api={api} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("heading", { name: "Transaction status" })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Close transaction" }));
    await waitFor(() => expect(screen.getByText(safeStatusFixture().transactionId)).toBeTruthy());
    expect(screen.getAllByText("The transaction service could not complete the request.")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("secret database detail");
  });
});
