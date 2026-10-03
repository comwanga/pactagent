// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  RequesterApiClientError,
  type RequesterTransactionApi,
  type RequesterTransactionSubmission,
} from "@/lib/requester-api-client";
import type { RequesterTransactionCreateInput, RequesterTransactionStatus } from "@/lib/requester-api-contracts";
import { safeReportFixture, safeStatusFixture } from "@/lib/requester-api-test-fixtures";
import { REQUESTER_PROMPT_MAXIMUM_BYTES } from "@/lib/requester-ui-model";

import { RequesterTransactionApp, TransactionStatusView } from "./requester-transaction-app";

afterEach(() => cleanup());

function activeStatus(
  overrides: Partial<RequesterTransactionStatus> = {},
): RequesterTransactionStatus {
  const base = safeStatusFixture();
  return {
    ...base,
    phase: "initialized",
    operationalState: "active",
    availableActions: { resume: false, reconcile: false, refund: false },
    resultAvailable: false,
    reportAvailable: false,
    finalOutcome: undefined,
    settlementReference: undefined,
    ...overrides,
  };
}

function resolvedSubmission(
  submit = vi.fn(async () => ({ transactionId: safeStatusFixture().transactionId })),
): RequesterTransactionSubmission {
  return { idempotencyKey: "stable-ui-key-0001", submit };
}

function fakeApi(options: {
  readonly submission?: RequesterTransactionSubmission;
  readonly status?: (transactionId: string) => Promise<RequesterTransactionStatus>;
} = {}): RequesterTransactionApi & {
  createSubmission: ReturnType<typeof vi.fn<(input: RequesterTransactionCreateInput) => RequesterTransactionSubmission>>;
  status: ReturnType<typeof vi.fn<(transactionId: string) => Promise<RequesterTransactionStatus>>>;
} {
  return {
    currentTransaction: vi.fn(async () => ({ transactionId: null })),
    closeCurrentTransaction: vi.fn(async () => ({ cleared: true as const })),
    createSubmission: vi.fn((input: RequesterTransactionCreateInput) => {
      void input;
      return options.submission ?? resolvedSubmission();
    }),
    status: vi.fn(options.status ?? (async () => activeStatus())),
    privateResult: vi.fn(async () => ({ summary: "private result" })),
    report: vi.fn(async () => safeReportFixture()),
    resume: vi.fn(async () => safeReportFixture()),
    reconcile: vi.fn(async () => safeReportFixture()),
    refund: vi.fn(async () => safeReportFixture()),
    startDemo: vi.fn().mockResolvedValue({ economicMode: "demo", generation: 1, disclosure: "Demo sats — no monetary value" }),
    demoWallet: vi.fn().mockResolvedValue({ economicMode: "demo", started: true, generation: 1, balance: { availableSats: 1000 }, resetAvailable: true, disclosure: "Demo sats — no monetary value" }),
    resetDemo: vi.fn().mockResolvedValue({ economicMode: "demo", generation: 2, disclosure: "Demo sats — no monetary value" }),
  };
}

async function openForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "New transaction" }));
}

async function reachReview(
  user: ReturnType<typeof userEvent.setup>,
  input: { readonly document?: string; readonly prompt?: string } = {},
): Promise<void> {
  const documentText = input.document ?? "PRIVATE-COMPLETE-DOCUMENT-MARKER";
  const prompt = input.prompt ?? "PRIVATE-COMPLETE-PROMPT-MARKER";
  await openForm(user);
  await user.upload(
    screen.getByLabelText("Choose document"),
    new File([documentText], "request.txt", { type: "text/plain" }),
  );
  await screen.findByText("request.txt");
  if (prompt.length > 0) await user.type(screen.getByLabelText(/Private prompt/), prompt);
  await user.click(screen.getByRole("button", { name: "Review request" }));
  await screen.findByRole("heading", { name: "Review transaction" });
}

describe("requester transaction UI", () => {
  it("offers Start Demo before a wallet exists and then displays its authoritative balance", async () => {
    let started = false;
    const api = fakeApi();
    vi.mocked(api.demoWallet).mockImplementation(async () => started
      ? { economicMode: "demo", started: true, generation: 1, balance: { availableSats: 1000 }, resetAvailable: true, disclosure: "Demo sats — no monetary value" }
      : { economicMode: "demo", started: false });
    vi.mocked(api.startDemo).mockImplementation(async () => {
      started = true;
      return { economicMode: "demo", generation: 1, disclosure: "Demo sats — no monetary value" };
    });
    render(<RequesterTransactionApp api={api} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start Demo" }));
    expect(await screen.findByRole("heading", { name: /demo balance: 1000 demo sats/i })).toBeTruthy();
    expect(screen.getByText(/no monetary value/i)).toBeTruthy();
  });

  it("uses one reset identity for retries", async () => {
    const api = fakeApi();
    vi.mocked(api.resetDemo)
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue({ economicMode: "demo", generation: 2, disclosure: "Demo sats — no monetary value" });
    render(<RequesterTransactionApp api={api} />);
    const user = userEvent.setup();
    const reset = await screen.findByRole("button", { name: "Reset Demo" });
    await user.click(reset);
    await waitFor(() => expect(api.resetDemo).toHaveBeenCalledTimes(1));
    await user.click(reset);
    await waitFor(() => expect(api.resetDemo).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.resetDemo).mock.calls[0][0]).toBe(vi.mocked(api.resetDemo).mock.calls[1][0]);
  });

  it("hides Reset Demo when authoritative accounting says reset is unavailable", async () => {
    const api = fakeApi();
    vi.mocked(api.demoWallet).mockResolvedValue({
      economicMode: "demo",
      started: true,
      generation: 1,
      balance: { availableSats: 650 },
      resetAvailable: false,
      disclosure: "Demo sats — no monetary value",
    });
    render(<RequesterTransactionApp api={api} />);
    expect(await screen.findByText(/finish or recover/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset Demo" })).toBeNull();
  });

  it("defaults the whole-sat budget to 500", async () => {
    render(<RequesterTransactionApp api={fakeApi()} />);
    const user = userEvent.setup();
    await openForm(user);
    expect((screen.getByLabelText("Maximum budget") as HTMLInputElement).value).toBe("500");
  });

  it.each(["", "0", "-2", "1.5"])("rejects invalid budget %j", async (value) => {
    render(<RequesterTransactionApp api={fakeApi()} />);
    const user = userEvent.setup();
    await openForm(user);
    fireEvent.change(screen.getByLabelText("Maximum budget"), { target: { value } });
    await user.click(screen.getByRole("button", { name: "Review request" }));
    expect(await screen.findByText("Enter a positive whole-sat budget.")).toBeTruthy();
  });

  it("rejects unsupported document types", async () => {
    render(<RequesterTransactionApp api={fakeApi()} />);
    const user = userEvent.setup({ applyAccept: false });
    await openForm(user);
    await user.upload(
      screen.getByLabelText("Choose document"),
      new File(["private"], "request.png", { type: "image/png" }),
    );
    expect(await screen.findByText("Choose a text/plain or application/pdf document.")).toBeTruthy();
  });

  it("enforces the private prompt byte limit before review", async () => {
    render(<RequesterTransactionApp api={fakeApi()} />);
    const user = userEvent.setup();
    await openForm(user);
    fireEvent.change(screen.getByLabelText(/Private prompt/), {
      target: { value: "x".repeat(REQUESTER_PROMPT_MAXIMUM_BYTES + 1) },
    });
    await user.click(screen.getByRole("button", { name: "Review request" }));
    expect(await screen.findByText(/private prompt must not exceed/i)).toBeTruthy();
  });

  it("shows only safe metadata during review", async () => {
    render(<RequesterTransactionApp api={fakeApi()} />);
    const user = userEvent.setup();
    await reachReview(user);
    expect(screen.getByText("request.txt")).toBeTruthy();
    expect(screen.getByText("Present")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("PRIVATE-COMPLETE-DOCUMENT-MARKER");
    expect(document.body.innerHTML).not.toContain("PRIVATE-COMPLETE-PROMPT-MARKER");
  });

  it("preserves one logical submission across review back-navigation", async () => {
    const api = fakeApi();
    render(<RequesterTransactionApp api={api} />);
    const user = userEvent.setup();
    await reachReview(user);
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByRole("heading", { name: "Review transaction" });
    expect(api.createSubmission).toHaveBeenCalledTimes(1);
  });

  it("coalesces duplicate submit clicks into one logical submission", async () => {
    let accept!: (value: { transactionId: string }) => void;
    const accepted = new Promise<{ transactionId: string }>((resolve) => { accept = resolve; });
    const submit = vi.fn(() => accepted);
    const api = fakeApi({ submission: resolvedSubmission(submit) });
    render(<RequesterTransactionApp api={api} />);
    const user = userEvent.setup();
    await reachReview(user);
    const button = screen.getByRole("button", { name: "Submit transaction" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.createSubmission).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    accept({ transactionId: safeStatusFixture().transactionId });
    await screen.findByText("Transaction status");
  });

  it("retries with the same logical submission after an HTTP failure", async () => {
    const submit = vi.fn()
      .mockRejectedValueOnce(new RequesterApiClientError(503, {
        error: "The transaction service is unavailable",
        code: "runtime_unavailable",
      }))
      .mockResolvedValueOnce({ transactionId: safeStatusFixture().transactionId });
    const api = fakeApi({ submission: resolvedSubmission(submit) });
    render(<RequesterTransactionApp api={api} />);
    const user = userEvent.setup();
    await reachReview(user);
    await user.click(screen.getByRole("button", { name: "Submit transaction" }));
    await user.click(await screen.findByRole("button", { name: "Retry transaction" }));
    await screen.findByText("Transaction status");
    expect(api.createSubmission).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("drops private form presentation after successful acceptance", async () => {
    const api = fakeApi({ status: async () => activeStatus({ phase: "accepted" }) });
    render(<RequesterTransactionApp api={api} />);
    const user = userEvent.setup();
    await reachReview(user);
    await user.click(screen.getByRole("button", { name: "Submit transaction" }));
    await screen.findByText("Transaction status");
    expect(screen.queryByLabelText("Choose document")).toBeNull();
    expect(screen.queryByLabelText(/Private prompt/)).toBeNull();
    expect(document.body.innerHTML).not.toContain("PRIVATE-COMPLETE-DOCUMENT-MARKER");
    expect(document.body.innerHTML).not.toContain("PRIVATE-COMPLETE-PROMPT-MARKER");
  });

  it("renders only the authoritative returned phase", async () => {
    const api = fakeApi({ status: async () => activeStatus({ phase: "result_submitted" }) });
    render(<RequesterTransactionApp api={api} />);
    const user = userEvent.setup();
    await reachReview(user, { prompt: "" });
    await user.click(screen.getByRole("button", { name: "Submit transaction" }));
    expect(await screen.findByText("Current phase:")).toBeTruthy();
    expect(screen.getAllByText("result_submitted").length).toBeGreaterThan(0);
  });

  it("does not let a polling timer fabricate a lifecycle transition", async () => {
    let resolveSecond!: (status: RequesterTransactionStatus) => void;
    const second = new Promise<RequesterTransactionStatus>((resolve) => { resolveSecond = resolve; });
    const status = vi.fn()
      .mockResolvedValueOnce(activeStatus({ phase: "initialized" }))
      .mockImplementationOnce(() => second);
    const api = fakeApi({ status });
    render(<RequesterTransactionApp api={api} pollIntervalMs={5} />);
    const user = userEvent.setup();
    await reachReview(user, { prompt: "" });
    await user.click(screen.getByRole("button", { name: "Submit transaction" }));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("initialized").length).toBeGreaterThan(0);
    expect(screen.queryByText("Current phase: accepted")).toBeNull();
    resolveSecond(activeStatus({ phase: "accepted" }));
    await waitFor(() => expect(screen.getAllByText("accepted").length).toBeGreaterThan(0));
  });

  it("takes the selected amount from the status DTO", () => {
    render(<TransactionStatusView status={activeStatus({
      requesterDecision: undefined,
      selectedOffer: { ...safeStatusFixture().selectedOffer, amountSats: "777" },
    })} />);
    expect(screen.getByText("777 sats")).toBeTruthy();
    expect(document.body.textContent).not.toContain("350 sats");
  });

  it("renders policy booleans as supplied without recalculating price or budget", () => {
    render(<TransactionStatusView status={activeStatus({
      selectedOffer: { ...safeStatusFixture().selectedOffer, amountSats: "999999" },
    })} />);
    expect(screen.getAllByText("passed")).toHaveLength(6);
    expect(screen.getByText(/Authorized:/).textContent).toContain("yes");
    expect(screen.getByText("999999 sats")).toBeTruthy();
  });

  it.each([
    ["failed", "The runtime reported a redacted transaction failure."],
    ["refunded", "The runtime reports that the transaction was refunded."],
    ["reconciliation_required", "The runtime requires reconciliation."],
    ["settled", "The runtime reports that the transaction settled."],
  ] as const)("keeps %s distinct", (operationalState, copy) => {
    render(<TransactionStatusView status={{
      ...activeStatus(),
      operationalState,
      phase: operationalState === "refunded" ? "refunded" : operationalState === "settled" ? "settled" : "accepted",
      kind: operationalState === "refunded" ? "refund" : "successful",
      ...(operationalState === "reconciliation_required"
        ? { reconciliationRequired: true as const, reconciliationState: "release_reconciliation_required" as const }
        : {}),
    }} />);
    expect(screen.getAllByText(operationalState).length).toBeGreaterThan(0);
    expect(screen.getByText(copy, { exact: false })).toBeTruthy();
  });

  it("does not write private values to URLs, metadata, or browser persistence", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    render(<RequesterTransactionApp api={fakeApi()} />);
    const user = userEvent.setup();
    await reachReview(user);
    expect(location.pathname).toBe("/");
    expect(location.search).toBe("");
    expect(document.head.textContent).not.toContain("PRIVATE-COMPLETE");
    expect(storage).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    storage.mockRestore();
    push.mockRestore();
    replace.mockRestore();
  });

  it("clears an explicitly cancelled private draft", async () => {
    render(<RequesterTransactionApp api={fakeApi()} />);
    const user = userEvent.setup();
    await openForm(user);
    await user.upload(
      screen.getByLabelText("Choose document"),
      new File(["PRIVATE-CANCELLED-DOCUMENT"], "cancel.txt", { type: "text/plain" }),
    );
    await screen.findByText("cancel.txt");
    await user.type(screen.getByLabelText(/Private prompt/), "PRIVATE-CANCELLED-PROMPT");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "New transaction" }));
    expect(screen.queryByText("cancel.txt")).toBeNull();
    expect((screen.getByLabelText(/Private prompt/) as HTMLTextAreaElement).value).toBe("");
  });
});
