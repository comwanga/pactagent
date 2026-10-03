import { expect, test, type Page } from "@playwright/test";

const DOCUMENT_SENTINEL = "PRIVATE-DOCUMENT-E2E-SENTINEL";
const PROMPT_SENTINEL = "PRIVATE-PROMPT-E2E-SENTINEL";
const FUNDING_SENTINEL = "E2E-FUNDING-SERVER-ONLY";
const RUNTIME_TOKEN_SENTINEL = "E2E-RUNTIME-TOKEN-SERVER-ONLY";

async function fixtureState(page: Page) {
  return page.request.get("http://127.0.0.1:3411/__test/state").then((response) => response.json());
}

async function requesterDemoStatus(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/requester/demo", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
}

async function ensureDemoStarted(page: Page): Promise<void> {
  const startDemo = page.getByRole("button", { name: "Start Demo" });
  const newTransaction = page.getByRole("button", { name: "New transaction" });
  await expect(startDemo.or(newTransaction)).toBeVisible();
  if (await startDemo.isVisible()) {
    await startDemo.evaluate((element: HTMLButtonElement) => element.click()).catch(() => undefined);
    // Wait for the demo wallet to be provisioned by polling the status API.
    // The "New transaction" button only appears after the wallet is active.
    await expect.poll(async () => {
      const status = await requesterDemoStatus(page);
      return status.body?.started === true;
    }, { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(true);
  }
  await expect(newTransaction).toBeVisible({ timeout: 15_000 });
}

async function openNewTransaction(page: Page, scenario: string, prompt = PROMPT_SENTINEL): Promise<void> {
  await page.goto("/");
  await ensureDemoStarted(page);
  const newTransaction = page.getByRole("button", { name: "New transaction" });
  await expect(newTransaction).toBeVisible();
  await newTransaction.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "New transaction" })).toBeFocused();
  await expect(page.getByLabel("Maximum budget")).toHaveValue("500");
  await page.getByLabel("Choose document").setInputFiles({
    name: `${scenario}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(`${DOCUMENT_SENTINEL} SCENARIO:${scenario}`),
  });
  if (prompt) await page.getByLabel(/Private prompt/).fill(prompt);
  await page.getByRole("button", { name: "Review request" }).click();
  await expect(page.getByRole("heading", { name: "Review transaction" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(DOCUMENT_SENTINEL);
  await expect(page.locator("body")).not.toContainText(PROMPT_SENTINEL);
}

async function submit(page: Page, duplicate = false): Promise<string> {
  const button = page.getByRole("button", { name: "Submit transaction" });
  const createResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/requester/transactions") && response.request().method() === "POST",
  );
  if (duplicate) {
    await button.evaluate((element: HTMLButtonElement) => {
      element.click();
      element.click();
    });
  } else {
    await button.click();
  }
  const response = await createResponse;
  if (response.status() !== 202) {
    const headers = await response.request().allHeaders();
    throw new Error(JSON.stringify({
      status: response.status(),
      origin: headers.origin,
      fetchSite: headers["sec-fetch-site"],
      url: response.url(),
    }));
  }
  await expect(page.getByRole("heading", { name: /Transaction (accepted|status)/ })).toBeFocused();
  const id = page.locator("code").filter({ hasText: /^txn_e2e_/ }).first();
  await expect(id).toBeVisible();
  return (await id.textContent()) ?? "";
}

async function createScenario(page: Page, scenario: string): Promise<string> {
  await openNewTransaction(page, scenario);
  return submit(page);
}

async function storageSnapshot(page: Page) {
  return page.evaluate(async () => {
    const databaseNames = typeof indexedDB.databases === "function"
      ? (await indexedDB.databases()).flatMap((database) => database.name ? [database.name] : [])
      : [];
    const indexedValues: unknown[] = [];
    for (const name of databaseNames) {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      for (const storeName of database.objectStoreNames) {
        const values = await new Promise<unknown[]>((resolve, reject) => {
          const transaction = database.transaction(storeName, "readonly");
          const read = transaction.objectStore(storeName).getAll();
          read.onsuccess = () => resolve(read.result);
          read.onerror = () => reject(read.error);
        });
        indexedValues.push(...values);
      }
      database.close();
    }
    return {
      url: location.href,
      local: Object.fromEntries(Object.entries(localStorage)),
      session: Object.fromEntries(Object.entries(sessionStorage)),
      cookiesVisibleToJavaScript: document.cookie,
      indexedDatabases: databaseNames,
      indexedValues: JSON.stringify(indexedValues),
      metadata: document.head.textContent ?? "",
    };
  });
}

async function bffOperation(
  page: Page,
  transactionId: string,
  suffix: string,
  method: "GET" | "POST",
) {
  return page.evaluate(async ({ transactionId, suffix, method }) => {
    const response = await fetch(`/api/requester/transactions/${encodeURIComponent(transactionId)}${suffix}`, {
      method,
      cache: "no-store",
    });
    return { status: response.status, body: await response.json() };
  }, { transactionId, suffix, method });
}

test("Demo Wallet starts with the authoritative balance and Reset creates a new generation", async ({ page }) => {
  const before = await fixtureState(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Start Demo" })).toBeVisible();
  await expect(page.getByText("Demo sats — no monetary value", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start Demo" }).click();
  await expect(page.getByText("Demo balance: 1000 demo sats", { exact: true })).toBeVisible();

  const first = await requesterDemoStatus(page);
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ started: true, generation: 1, balance: { availableSats: 1000 } });

  await page.getByRole("button", { name: "Reset Demo" }).click();
  await expect(page.getByText("Demo balance: 1000 demo sats", { exact: true })).toBeVisible();
  const second = await requesterDemoStatus(page);
  expect(second.status).toBe(200);
  expect(second.body).toMatchObject({ started: true, generation: 2, balance: { availableSats: 1000 } });

  const after = await fixtureState(page);
  expect(after.counts.demoStart - before.counts.demoStart).toBe(1);
  expect(after.counts.demoReset - before.counts.demoReset).toBe(1);
});

test("LIVE-mode requester projection does not render Demo Wallet controls", async ({ page }) => {
  await page.route("**/api/requester/demo", async (route) => {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({ error: "Demo wallet is unavailable", code: "invalid_request" }),
    });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "New transaction" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Demo" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset Demo" })).toHaveCount(0);
});

test("settled requester flow survives reload without persisting private resources", async ({ page, context }) => {
  const consoleText: string[] = [];
  const requestUrls: string[] = [];
  const requesterCacheHeaders: string[] = [];
  page.on("console", (message) => consoleText.push(message.text()));
  page.on("request", (request) => requestUrls.push(request.url()));
  page.on("response", async (response) => {
    if (response.url().includes("/api/requester/")) {
      requesterCacheHeaders.push((await response.allHeaders())["cache-control"] ?? "");
    }
  });
  const before = await fixtureState(page);

  await openNewTransaction(page, "success");
  const transactionId = await submit(page, true);
  await expect(page.locator("[data-operational-state='settled']")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("350 sats", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Recommendation is advisory\. Policy authorizes\./)).toBeVisible();
  await expect(page.getByText("Authorized:").locator("..")).toContainText("yes");
  await expect(page.getByText("passed", { exact: true })).toHaveCount(6);

  const afterSubmit = await fixtureState(page);
  expect(afterSubmit.counts.create - before.counts.create).toBe(1);
  expect(afterSubmit.transactionIds).toContain(transactionId);

  await page.getByRole("button", { name: "Load private result" }).click();
  const privateSummary = `PRIVATE-SUMMARY-FOR-${transactionId}`;
  await expect(page.locator("[data-private-result='loaded']")).toContainText(privateSummary, { timeout: 15_000 });
  await page.getByRole("button", { name: "Load safe transaction report" }).click();
  await expect(page.locator("[data-safe-report='loaded']")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-safe-report='loaded']")).not.toContainText(privateSummary);

  const storage = await storageSnapshot(page);
  expect(storage.url).not.toContain(DOCUMENT_SENTINEL);
  expect(storage.url).not.toContain(PROMPT_SENTINEL);
  expect(storage.url).not.toContain(privateSummary);
  expect(storage.local).toEqual({});
  expect(storage.session).toEqual({});
  expect(storage.cookiesVisibleToJavaScript).toBe("");
  // Next dev owns this debug database; PactAgent creates no browser database.
  expect(storage.indexedDatabases.filter((name) => name !== "__next_debug_channel")).toEqual([]);
  expect(storage.indexedValues).not.toContain(DOCUMENT_SENTINEL);
  expect(storage.indexedValues).not.toContain(PROMPT_SENTINEL);
  expect(storage.indexedValues).not.toContain(privateSummary);
  expect(storage.metadata).not.toContain(DOCUMENT_SENTINEL);
  expect(storage.metadata).not.toContain(PROMPT_SENTINEL);
  expect(storage.metadata).not.toContain(privateSummary);
  expect(requestUrls.join("\n")).not.toContain(DOCUMENT_SENTINEL);
  expect(requestUrls.join("\n")).not.toContain(PROMPT_SENTINEL);
  expect(requestUrls.join("\n")).not.toContain(privateSummary);
  expect(consoleText.join("\n")).not.toContain(DOCUMENT_SENTINEL);
  expect(consoleText.join("\n")).not.toContain(PROMPT_SENTINEL);
  expect(consoleText.join("\n")).not.toContain(privateSummary);
  expect(consoleText.join("\n")).not.toContain(FUNDING_SENTINEL);
  expect(consoleText.join("\n")).not.toContain(RUNTIME_TOKEN_SENTINEL);
  expect(requesterCacheHeaders.length).toBeGreaterThan(0);
  expect(requesterCacheHeaders.every((value) => value === "no-store")).toBe(true);

  const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === "pactagent_requester_session");
  expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api/requester" });
  expect(sessionCookie?.value).not.toContain(DOCUMENT_SENTINEL);
  expect(sessionCookie?.value).not.toContain(PROMPT_SENTINEL);
  expect(sessionCookie?.value).not.toContain(RUNTIME_TOKEN_SENTINEL);

  await page.reload();
  await expect(page.getByText(transactionId, { exact: true })).toBeVisible();
  await expect(page.locator("[data-operational-state='settled']")).toBeVisible();
  await expect(page.locator("[data-private-result='loaded']")).toHaveCount(0);
  await expect(page.locator("[data-safe-report='loaded']")).toHaveCount(0);
  expect((await fixtureState(page)).counts.create).toBe(afterSubmit.counts.create);
  await page.getByRole("button", { name: "Load private result" }).click();
  await expect(page.locator("[data-private-result='loaded']")).toContainText(privateSummary, { timeout: 15_000 });

  await page.getByRole("button", { name: "Close transaction" }).click();
  await expect(page.getByRole("button", { name: "New transaction" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "New transaction" })).toBeVisible();
  await expect(page.getByText(transactionId, { exact: true })).toHaveCount(0);
  expect((await fixtureState(page)).counts.create).toBe(afterSubmit.counts.create);
});

test("isolated requester session cannot access another session transaction", async ({ browser, page }) => {
  const transactionId = await createScenario(page, "success");
  await expect(page.locator("[data-operational-state='settled']")).toBeVisible({ timeout: 10_000 });
  const before = await fixtureState(page);
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await otherPage.goto("/");
  await expect(otherPage.getByRole("button", { name: "Start Demo" })).toBeVisible();

  for (const [suffix, method] of [
    ["", "GET"],
    ["/result", "GET"],
    ["/report", "GET"],
    ["/resume", "POST"],
    ["/reconcile", "POST"],
  ] as const) {
    const result = await bffOperation(otherPage, transactionId, suffix, method);
    expect(result).toEqual({
      status: 404,
      body: { error: "Transaction not found", code: "transaction_not_found" },
    });
  }
  await expect(otherPage.locator("body")).not.toContainText(transactionId);
  await expect(otherPage.locator("body")).not.toContainText("PRIVATE-SUMMARY");
  const after = await fixtureState(page);
  for (const operation of ["create", "status", "result", "report", "resume", "reconcile"] as const) {
    expect(after.counts[operation]).toBe(before.counts[operation]);
  }
  await otherContext.close();
});

test("reconciliation and resume remain explicit runtime-controlled actions", async ({ page }) => {
  test.setTimeout(90_000);
  await createScenario(page, "reconciliation");
  await expect(page.locator("[data-operational-state='reconciliation_required']")).toBeVisible();
  const beforeReconcile = await fixtureState(page);
  const reconcile = page.getByRole("button", { name: "Reconcile" });
  await reconcile.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(reconcile).toBeFocused();
  expect((await fixtureState(page)).counts.reconcile).toBe(beforeReconcile.counts.reconcile);
  await reconcile.click();
  await dialog.getByRole("button", { name: "Confirm reconciliation" }).click();
  await expect(page.locator("[data-operational-state='reconciliation_required']")).toBeVisible();
  await expect(page.locator("[data-operational-state='settled']")).toBeVisible({ timeout: 10_000 });
  expect((await fixtureState(page)).counts.reconcile - beforeReconcile.counts.reconcile).toBe(1);

  await page.getByRole("button", { name: "Close transaction" }).click();
  await createScenario(page, "resume");
  await expect(page.locator("[data-operational-state='failed']")).toBeVisible();
  const beforeResume = await fixtureState(page);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.locator("[data-operational-state='failed']")).toBeVisible();
  await expect(page.locator("[data-operational-state='settled']")).toBeVisible({ timeout: 10_000 });
  expect((await fixtureState(page)).counts.resume - beforeResume.counts.resume).toBe(1);
});

test("refund, failure, and unavailable resources stay distinct", async ({ page }) => {
  test.setTimeout(90_000);
  await createScenario(page, "refund");
  await expect(page.locator("[data-operational-state='refunded']")).toBeVisible();
  await expect(page.locator("[data-operational-state='settled']")).toHaveCount(0);
  await page.getByRole("button", { name: "Close transaction" }).click();

  await createScenario(page, "failure");
  await expect(page.locator("[data-operational-state='failed']")).toBeVisible();
  await expect(page.getByText("transaction_failed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Load private result|Load safe transaction report/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Close transaction" }).click();

  await createScenario(page, "result-unavailable");
  await expect(page.locator("[data-operational-state='settled']")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load private result" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load safe transaction report" })).toBeVisible();
  await page.getByRole("button", { name: "Close transaction" }).click();

  await createScenario(page, "report-unavailable");
  await expect(page.locator("[data-operational-state='settled']")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load private result" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load safe transaction report" })).toHaveCount(0);
});
