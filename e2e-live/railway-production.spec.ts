import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/*
 * Issue #39 production acceptance — drives the PUBLIC Railway deployment
 * exactly the way a judge will: open the public URL, Start Demo, submit a
 * synthetic task, and follow the runtime-authoritative workflow through
 * settlement to the private result, safe report, and authoritative Demo
 * balance.
 *
 * This spec runs against a real deployed stack. The document and prompt are
 * synthetic and contain no real-world data. The marker is injected by the
 * acceptance runner so the relay privacy scan can prove the private material
 * never appears in public relay events.
 */

const MARKER = process.env.PACTAGENT_RAILWAY_MARKER ?? "RAILWAY-ACCEPTANCE-MARKER";
const RESULT_MARKER = `${MARKER}-RESULT`;
const SYNTHETIC_DOCUMENT = [
  "PactAgent Railway production acceptance synthetic document.",
  `Verification marker: ${MARKER}.`,
  "No personal, customer, or production data.",
].join(" ");
const SYNTHETIC_PROMPT =
  `Synthetic requester instruction ${MARKER}: summarize the supplied document and mention ${RESULT_MARKER}.`;
const TERMINAL_TIMEOUT_MS = 6 * 60_000;
const EXPECTED_INITIAL_BALANCE = 1000;
const EXPECTED_OFFER_SATS = 350;
const EXPECTED_FINAL_BALANCE = 648;

interface DemoStatus {
  readonly started: boolean;
  readonly generation?: number;
  readonly balance?: { readonly availableSats: number };
  readonly resetAvailable?: boolean;
  readonly accountingPending?: boolean;
}

interface TransactionStatus {
  readonly transactionId: string;
  readonly phase: string;
  readonly operationalState: string;
  readonly finalOutcome?: string;
  readonly resultAvailable: boolean;
  readonly reportAvailable: boolean;
  readonly selectedOffer?: {
    readonly amountSats: string;
    readonly providerPublicKey: string;
    readonly offerReference: string;
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Requester endpoint returned an unexpected response shape");
  }
  return value as Record<string, unknown>;
}

async function requesterFetch(
  page: Page,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, {
      method,
      cache: "no-store",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as unknown };
  }, { path, method, body });
}

function containsPrivateMarker(value: unknown): boolean {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized.includes(MARKER) || serialized.includes(RESULT_MARKER);
}

async function networkBodies(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const entries = performance.getEntriesByType("resource")
      .map((entry) => entry.name);
    const bodies: string[] = [];
    for (const url of entries) {
      try {
        if (url.startsWith("http") && !url.includes(".js")) {
          bodies.push(await (await fetch(url, { cache: "no-store" })).text());
        }
      } catch {
        // Ignore in-flight or opaque resources.
      }
    }
    return bodies;
  });
}

test("public Railway deployment completes the zero-setup judge flow", async ({
  browser,
  context,
  page,
}) => {
  const secretNameProbe = /PACTAGENT_(LIVE_|DEMO_|RUNTIME_API_TOKEN|REQUESTER_SESSION_DATABASE)/u;

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start a demo wallet" })).toBeVisible();

  // Session cookie contract (opaque, httpOnly, scoped to the requester path).
  const initialCookie = (await context.cookies()).find(
    (cookie) => cookie.name === "pactagent_requester_session",
  );
  expect(initialCookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api/requester" });

  // Zero-setup Demo wallet generation.
  const startDemo = page.getByRole("button", { name: "Start Demo" });
  await expect(startDemo).toBeVisible();
  await startDemo.click();
  await expect(page.getByText(`Demo balance: ${EXPECTED_INITIAL_BALANCE} demo sats`)).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(/Demo sats/u).first()).toBeVisible();

  const demoResponse = await requesterFetch(page, "/api/requester/demo");
  expect(demoResponse.status).toBe(200);
  const demo = demoResponse.body as DemoStatus;
  expect(demo.started).toBe(true);
  expect(demo.balance?.availableSats).toBe(EXPECTED_INITIAL_BALANCE);
  expect(demo.accountingPending).toBe(false);
  expect(demo.resetAvailable).toBe(true);

  // Enter a synthetic task.
  const newTransaction = page.getByRole("button", { name: "New transaction" });
  await expect(newTransaction).toBeVisible();
  await newTransaction.click();
  await expect(page.getByRole("heading", { name: "New transaction" })).toBeFocused();
  await expect(page.getByLabel("Maximum budget")).toHaveValue("500");
  await page.getByLabel("Choose document").setInputFiles({
    name: "railway-acceptance.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(SYNTHETIC_DOCUMENT),
  });
  await page.getByLabel(/Private prompt/u).fill(SYNTHETIC_PROMPT);
  await page.getByRole("button", { name: "Review request" }).click();

  // Review never displays private material.
  await expect(page.getByRole("heading", { name: "Review transaction" })).toBeVisible();
  const reviewText = (await page.locator("body").textContent()) ?? "";
  expect(containsPrivateMarker(reviewText), "review hides the private document and prompt").toBe(false);

  const createResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/requester/transactions") &&
    response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Submit transaction" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(202);
  const accepted = asObject(await createResponse.json());
  expect(typeof accepted.transactionId).toBe("string");
  const transactionId = accepted.transactionId as string;
  await expect(page.getByText(transactionId, { exact: true })).toBeVisible({ timeout: 30_000 });

  // Runtime-authoritative progression to settlement (fail fast on any terminal
  // outcome so failures surface the real state instead of waiting 6 minutes).
  try {
    await page.waitForFunction(() => {
      const terminal = [
        "settled",
        "refunded",
        "resolved_not_funded",
        "failed",
        "reconciliation_required",
      ];
      return terminal.some((state) =>
        document.querySelector(`[data-operational-state="${state}"]`),
      );
    }, undefined, { timeout: TERMINAL_TIMEOUT_MS });
  } catch {
    throw new Error("Transaction did not reach a terminal state within the acceptance window");
  }
  const operationalState = await page.locator("[data-operational-state]").getAttribute("data-operational-state");
  expect(operationalState, "production acceptance must reach settled").toBe("settled");

  const statusResponse = await requesterFetch(
    page,
    `/api/requester/transactions/${encodeURIComponent(transactionId)}`,
  );
  expect(statusResponse.status).toBe(200);
  const status = statusResponse.body as TransactionStatus;
  expect(status.transactionId).toBe(transactionId);
  expect(status.phase).toBe("settled");
  expect(status.operationalState).toBe("settled");
  expect(status.finalOutcome).toBe("settled");
  expect(status.resultAvailable).toBe(true);
  expect(status.reportAvailable).toBe(true);
  expect(status.selectedOffer?.amountSats).toBe(String(EXPECTED_OFFER_SATS));

  // The signed 350-sat offer is displayed.
  await expect(page.getByText(`${EXPECTED_OFFER_SATS} sats`, { exact: true }).first()).toBeVisible();

  // Authoritative Demo balance after settlement (Cashu fee behavior).
  const settledDemoResponse = await requesterFetch(page, "/api/requester/demo");
  expect(settledDemoResponse.status).toBe(200);
  const settledDemo = settledDemoResponse.body as DemoStatus;
  expect(settledDemo.balance?.availableSats).toBe(EXPECTED_FINAL_BALANCE);
  expect(settledDemo.accountingPending).toBe(false);

  // Private result is retrievable by the owning session.
  await page.getByRole("button", { name: "Load private result" }).click();
  await expect(page.locator("[data-private-result='loaded']")).toBeVisible({ timeout: 30_000 });
  const privateResultText = (await page.locator("[data-private-result='loaded']").textContent()) ?? "";
  expect(privateResultText.trim().length > 0, "private result contains provider output").toBe(true);

  // Safe report stays separate from the private result.
  await page.getByRole("button", { name: "Load safe transaction report" }).click();
  await expect(page.getByText(/Lifecycle|lifecycle/i).first()).toBeVisible({ timeout: 30_000 });

  // Reload recovers the same session transaction without repeating economics.
  await page.reload();
  await expect(page.getByText(transactionId, { exact: true })).toBeVisible({ timeout: 30_000 });
  const reloadedStatusResponse = await requesterFetch(
    page,
    `/api/requester/transactions/${encodeURIComponent(transactionId)}`,
  );
  expect(reloadedStatusResponse.status).toBe(200);
  const reloadedStatus = reloadedStatusResponse.body as TransactionStatus;
  expect(reloadedStatus.operationalState).toBe("settled");
  expect(reloadedStatus.transactionId).toBe(transactionId);

  // The judge closes the finished transaction to return to the landing,
  // which displays the authoritative remaining Demo balance.
  await page.getByRole("button", { name: "Close transaction" }).click();
  await expect(page.getByRole("heading", { name: "Private work. Protocol-visible truth." })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(`Demo balance: ${EXPECTED_FINAL_BALANCE} demo sats`)).toBeVisible({
    timeout: 60_000,
  });

  // Session isolation: an independent browser session cannot see or mutate
  // this session's transaction or Demo wallet.
  const otherContext: BrowserContext = await browser.newContext();
  const otherPage: Page = await otherContext.newPage();
  try {
    await otherPage.goto("/");
    await expect(otherPage.getByRole("button", { name: "Start Demo" })).toBeVisible();
    for (const path of [
      `/api/requester/transactions/${encodeURIComponent(transactionId)}`,
      `/api/requester/transactions/${encodeURIComponent(transactionId)}/result`,
      `/api/requester/transactions/${encodeURIComponent(transactionId)}/report`,
    ]) {
      const denied = await requesterFetch(otherPage, path);
      expect(denied.status, `cross-session ${path} is denied`).toBe(404);
    }
    // A foreign session resetting its own demo wallet cannot touch ours.
    const foreignReset = await requesterFetch(otherPage, "/api/requester/demo/reset", "POST", {
      idempotencyKey: `railway-isolation-${Date.now()}`,
    });
    expect([200, 400, 401, 404, 409]).toContain(foreignReset.status);
    const ourDemoAfterForeignReset = await requesterFetch(page, "/api/requester/demo");
    expect((ourDemoAfterForeignReset.body as DemoStatus).balance?.availableSats)
      .toBe(EXPECTED_FINAL_BALANCE);
  } finally {
    await otherContext.close();
  }

  // Privacy: no server-side secret material appears in browser-visible
  // artifacts or network bodies.
  const pageSource = await page.content();
  expect(secretNameProbe.test(pageSource), "page source leaks no server variable names").toBe(false);
  const bodies = await networkBodies(page);
  expect(
    bodies.every((body) => !secretNameProbe.test(body)),
    "network bodies leak no server variable names",
  ).toBe(true);
});
