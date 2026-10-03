import { expect, test, type Page } from "@playwright/test";

const DOCUMENT_MARKER = "LIVE-ACCEPTANCE-ALPHA";
const PROMPT_MARKER = "LIVE-PROMPT-ALPHA";
const SYNTHETIC_DOCUMENT = [
  "PactAgent live acceptance synthetic document.",
  `Verification marker: ${DOCUMENT_MARKER}.`,
  "No personal, customer, or production data.",
].join(" ");
const SYNTHETIC_PROMPT =
  `Synthetic requester instruction ${PROMPT_MARKER}: summarize the supplied synthetic document.`;
const LIVE_TERMINAL_TIMEOUT_MS = 6 * 60_000;

interface SafeStatusSnapshot {
  readonly phase?: string;
  readonly operationalState?: string;
  readonly failureCode?: string;
  readonly reconciliationState?: string;
  readonly resultAvailable?: boolean;
  readonly reportAvailable?: boolean;
}

interface LiveStatusProjection {
  readonly transactionId: string;
  readonly phase: string;
  readonly operationalState: string;
  readonly agreementId: string;
  readonly resultAvailable: boolean;
  readonly reportAvailable: boolean;
  readonly finalOutcome?: string;
  readonly resultReference?: string;
  readonly escrowReference?: string;
  readonly settlementReference?: string;
  readonly selectedOffer: {
    readonly providerPublicKey: string;
    readonly providerDefinitionReference: string;
    readonly offerReference: string;
    readonly escrowDescriptorReference: string;
    readonly amountSats: string;
    readonly unit: string;
  };
  readonly requesterDecision?: {
    readonly source: string;
    readonly recommendation: {
      readonly providerPublicKey: string;
      readonly offerReference: string;
      readonly amountSats: string;
    };
    readonly policy: Readonly<Record<string, boolean>>;
    readonly authorized: boolean;
  };
}

interface LiveReportProjection {
  readonly agreementId: string;
  readonly providerPublicKey: string;
  readonly amountSats: string;
  readonly unit: string;
  readonly selectedReferences: {
    readonly providerPublicKey: string;
    readonly providerDefinitionReference: string;
    readonly offerReference: string;
    readonly escrowDescriptorReference: string;
  };
  readonly lifecycle: ReadonlyArray<{ readonly state: string; readonly eventId: string }>;
  readonly resultReference?: string;
  readonly escrowReference: string;
  readonly settlementReference?: string;
  readonly finalOutcome: string;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Live requester endpoint returned an unexpected response shape");
  }
  return value as Record<string, unknown>;
}

function safeStatus(value: unknown): SafeStatusSnapshot {
  const status = asObject(value);
  return {
    ...(typeof status.phase === "string" ? { phase: status.phase } : {}),
    ...(typeof status.operationalState === "string"
      ? { operationalState: status.operationalState }
      : {}),
    ...(typeof status.failureCode === "string" ? { failureCode: status.failureCode } : {}),
    ...(typeof status.reconciliationState === "string"
      ? { reconciliationState: status.reconciliationState }
      : {}),
    ...(typeof status.resultAvailable === "boolean"
      ? { resultAvailable: status.resultAvailable }
      : {}),
    ...(typeof status.reportAvailable === "boolean"
      ? { reportAvailable: status.reportAvailable }
      : {}),
  };
}

async function requesterOperation(
  page: Page,
  path: string,
  method: "GET" | "POST" = "GET",
): Promise<{ readonly status: number; readonly body: unknown }> {
  return page.evaluate(async ({ path, method }) => {
    const response = await fetch(path, { method, cache: "no-store" });
    return { status: response.status, body: await response.json() as unknown };
  }, { path, method });
}

async function availabilityProbe(page: Page, path: string): Promise<{ status: number; code?: string }> {
  return page.evaluate(async (resourcePath) => {
    const response = await fetch(resourcePath, { method: "GET", cache: "no-store" });
    if (response.ok) return { status: response.status };
    const body = await response.json() as { code?: unknown };
    return {
      status: response.status,
      ...(typeof body.code === "string" ? { code: body.code } : {}),
    };
  }, path);
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
      metadata: [
        document.title,
        ...Array.from(document.head.querySelectorAll("meta")).flatMap((meta) => [
          meta.getAttribute("name") ?? "",
          meta.getAttribute("property") ?? "",
          meta.getAttribute("content") ?? "",
        ]),
      ].join("\n"),
      serviceWorkerCount: "serviceWorker" in navigator
        ? (await navigator.serviceWorker.getRegistrations()).length
        : 0,
    };
  });
}

function containsPrivateMarker(value: unknown): boolean {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized.includes(DOCUMENT_MARKER) || serialized.includes(PROMPT_MARKER);
}

test("real requester boundary completes one live BOSS-stack transaction", async ({
  browser,
  context,
  page,
}, testInfo) => {
  const consoleText: string[] = [];
  const requestUrls: string[] = [];
  const statusHistory: SafeStatusSnapshot[] = [];
  const requesterCacheHeaders: string[] = [];
  let browserAuthorizationHeaderSeen = false;
  let browserFundingFieldSeen = false;
  let createRequestCount = 0;
  let capturedReport: LiveReportProjection | undefined;

  page.on("console", (message) => consoleText.push(message.text()));
  page.on("request", (request) => {
    requestUrls.push(request.url());
    if (request.headers().authorization) browserAuthorizationHeaderSeen = true;
    const url = new URL(request.url());
    if (url.pathname === "/api/requester/transactions" && request.method() === "POST") {
      createRequestCount += 1;
      try {
        const body = asObject(JSON.parse(request.postData() ?? "null") as unknown);
        browserFundingFieldSeen = browserFundingFieldSeen || Object.hasOwn(body, "fundingReference");
      } catch {
        browserFundingFieldSeen = true;
      }
    }
  });
  page.on("response", async (response) => {
    try {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/requester/")) {
        requesterCacheHeaders.push((await response.allHeaders())["cache-control"] ?? "");
      }
      if (
        response.status() === 200 &&
        response.request().method() === "GET" &&
        /^\/api\/requester\/transactions\/[^/]+$/u.test(url.pathname)
      ) {
        statusHistory.push(safeStatus(await response.json()));
      }
      if (
        response.status() === 200 &&
        response.request().method() === "GET" &&
        /^\/api\/requester\/transactions\/[^/]+\/report$/u.test(url.pathname)
      ) {
        capturedReport = await response.json() as LiveReportProjection;
      }
    } catch {
      // Assertions below fail closed if a required projection was not captured.
    }
  });

  await page.goto("/");
  const newTransaction = page.getByRole("button", { name: "New transaction" });
  await expect(newTransaction).toBeVisible();
  const initialCookie = (await context.cookies()).find(
    (cookie) => cookie.name === "pactagent_requester_session",
  );
  expect(initialCookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api/requester" });
  expect(initialCookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(containsPrivateMarker(initialCookie?.value ?? ""), "session cookie contains no private marker").toBe(false);

  await newTransaction.click();
  await expect(page.getByRole("heading", { name: "New transaction" })).toBeFocused();
  await expect(page.getByLabel("Maximum budget")).toHaveValue("500");
  await page.getByLabel("Choose document").setInputFiles({
    name: "pactagent-live-acceptance.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(SYNTHETIC_DOCUMENT),
  });
  await page.getByLabel(/Private prompt/u).fill(SYNTHETIC_PROMPT);
  await page.getByRole("button", { name: "Review request" }).click();
  await expect(page.getByRole("heading", { name: "Review transaction" })).toBeVisible();
  const reviewText = await page.locator("body").textContent() ?? "";
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
  expect(transactionId.length).toBeGreaterThan(1);
  await expect(page.getByText(transactionId, { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(createRequestCount).toBe(1);

  await expect.poll(() => statusHistory.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const firstStatus = statusHistory[0];
  if (firstStatus.resultAvailable === false) {
    const resultProbe = await availabilityProbe(
      page,
      `/api/requester/transactions/${encodeURIComponent(transactionId)}/result`,
    );
    if (resultProbe.status === 409) expect(resultProbe.code).toBe("result_not_available");
    testInfo.annotations.push({
      type: "live-result-before-availability",
      description: resultProbe.status === 409 ? "observed" : "advanced before probe completed",
    });
  } else {
    testInfo.annotations.push({
      type: "live-result-before-availability",
      description: "not directly observed; transaction advanced before first browser projection",
    });
  }
  if (firstStatus.reportAvailable === false) {
    const reportProbe = await availabilityProbe(
      page,
      `/api/requester/transactions/${encodeURIComponent(transactionId)}/report`,
    );
    if (reportProbe.status === 409) expect(reportProbe.code).toBe("report_not_available");
    testInfo.annotations.push({
      type: "live-report-before-availability",
      description: reportProbe.status === 409 ? "observed" : "advanced before probe completed",
    });
  } else {
    testInfo.annotations.push({
      type: "live-report-before-availability",
      description: "not directly observed; transaction advanced before first browser projection",
    });
  }

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
    }, undefined, { timeout: LIVE_TERMINAL_TIMEOUT_MS });
  } catch {
    throw new Error(`Live transaction timed out: ${JSON.stringify(statusHistory.at(-1) ?? {})}`);
  }
  const operationalState = await page.locator("[data-operational-state]").getAttribute("data-operational-state");
  if (operationalState !== "settled") {
    throw new Error(
      `Live success path ended without settlement: ${JSON.stringify(statusHistory.at(-1) ?? {})}`,
    );
  }

  const statusResponse = await requesterOperation(
    page,
    `/api/requester/transactions/${encodeURIComponent(transactionId)}`,
  );
  expect(statusResponse.status).toBe(200);
  const status = statusResponse.body as LiveStatusProjection;
  expect(status.transactionId).toBe(transactionId);
  expect(status.phase).toBe("settled");
  expect(status.operationalState).toBe("settled");
  expect(status.finalOutcome).toBe("settled");
  expect(status.resultAvailable).toBe(true);
  expect(status.reportAvailable).toBe(true);
  expect(status.selectedOffer.providerPublicKey).toMatch(/^[0-9a-f]{64}$/u);
  expect(status.selectedOffer.providerDefinitionReference).toContain("live-provider");
  expect(status.selectedOffer.offerReference).toContain("live-document-summary-offer");
  expect(status.selectedOffer.escrowDescriptorReference).toContain("live-cashu-escrow");
  expect(status.selectedOffer.amountSats).toBe("350");
  expect(status.selectedOffer.unit).toBe("sat");
  expect(status.escrowReference).toBeTruthy();
  expect(status.resultReference).toBeTruthy();
  expect(status.settlementReference).toBeTruthy();

  const decision = status.requesterDecision;
  expect(decision?.source === "deterministic" || decision?.source === "model").toBe(true);
  expect(decision?.recommendation.providerPublicKey).toBe(status.selectedOffer.providerPublicKey);
  expect(decision?.recommendation.offerReference).toBe(status.selectedOffer.offerReference);
  expect(decision?.recommendation.amountSats).toBe("350");
  expect(Object.values(decision?.policy ?? {})).toHaveLength(6);
  expect(Object.values(decision?.policy ?? {}).every((value) => value === true)).toBe(true);
  expect(decision?.authorized).toBe(true);
  await expect(page.getByText("350 sats", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Recommendation is advisory\. Policy authorizes\./u)).toBeVisible();
  await expect(page.getByText("passed", { exact: true })).toHaveCount(6);

  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  try {
    await otherPage.goto("/");
    await expect(otherPage.getByRole("button", { name: "New transaction" })).toBeVisible();
    for (const [suffix, method] of [
      ["", "GET"],
      ["/result", "GET"],
      ["/report", "GET"],
      ["/resume", "POST"],
      ["/reconcile", "POST"],
    ] as const) {
      const denied = await requesterOperation(
        otherPage,
        `/api/requester/transactions/${encodeURIComponent(transactionId)}${suffix}`,
        method,
      );
      expect(denied).toEqual({
        status: 404,
        body: { error: "Transaction not found", code: "transaction_not_found" },
      });
    }
    const otherBody = await otherPage.locator("body").textContent() ?? "";
    expect(otherBody.includes(transactionId), "unowned transaction ID is absent from the page").toBe(false);
    expect(containsPrivateMarker(otherBody), "unowned private material is absent from the page").toBe(false);
    const otherCookie = (await otherContext.cookies()).find(
      (cookie) => cookie.name === "pactagent_requester_session",
    );
    expect(otherCookie?.httpOnly).toBe(true);
    expect(otherCookie?.value === initialCookie?.value, "isolated sessions use different opaque values").toBe(false);
  } finally {
    await otherContext.close();
  }

  await page.getByRole("button", { name: "Load private result" }).click();
  const privateResultPanel = page.locator("[data-private-result='loaded']");
  await expect(privateResultPanel).toBeVisible({ timeout: 30_000 });
  const privateResultText = await privateResultPanel.textContent() ?? "";
  expect(
    privateResultText.includes(DOCUMENT_MARKER),
    "private summary corresponds to the synthetic transaction document",
  ).toBe(true);

  await page.getByRole("button", { name: "Load safe transaction report" }).click();
  const reportPanel = page.locator("[data-safe-report='loaded']");
  await expect(reportPanel).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => capturedReport, { timeout: 30_000 }).toBeTruthy();
  const report = capturedReport!;
  expect(report.agreementId).toBe(status.agreementId);
  expect(report.providerPublicKey).toBe(status.selectedOffer.providerPublicKey);
  expect(report.selectedReferences.providerPublicKey).toBe(status.selectedOffer.providerPublicKey);
  expect(report.selectedReferences.providerDefinitionReference)
    .toBe(status.selectedOffer.providerDefinitionReference);
  expect(report.selectedReferences.offerReference).toBe(status.selectedOffer.offerReference);
  expect(report.selectedReferences.escrowDescriptorReference)
    .toBe(status.selectedOffer.escrowDescriptorReference);
  expect(report.amountSats).toBe("350");
  expect(report.unit).toBe("sat");
  expect(report.finalOutcome).toBe("settled");
  expect(report.escrowReference).toBe(status.escrowReference);
  expect(report.resultReference).toBe(status.resultReference);
  expect(report.settlementReference).toBe(status.settlementReference);
  expect(report.lifecycle.map(({ state }) => state)).toEqual(expect.arrayContaining([
    "task_delivered",
    "result_submitted",
    "result_verified",
    "settled",
  ]));
  expect(Object.hasOwn(report as unknown as Record<string, unknown>, "summary")).toBe(false);
  const reportText = await reportPanel.textContent() ?? "";
  expect(containsPrivateMarker(reportText), "safe report remains separate from private result").toBe(false);

  const beforeReloadStorage = await storageSnapshot(page);
  expect(beforeReloadStorage.local).toEqual({});
  expect(beforeReloadStorage.session).toEqual({});
  expect(beforeReloadStorage.cookiesVisibleToJavaScript).toBe("");
  expect(beforeReloadStorage.indexedDatabases.filter((name) => name !== "__next_debug_channel")).toEqual([]);
  expect(containsPrivateMarker(beforeReloadStorage.indexedValues), "IndexedDB has no private marker").toBe(false);
  expect(containsPrivateMarker(beforeReloadStorage.metadata), "page metadata has no private marker").toBe(false);
  expect(beforeReloadStorage.serviceWorkerCount).toBe(0);
  expect(requestUrls.some((url) => containsPrivateMarker(url)), "request URLs have no private marker").toBe(false);
  expect(consoleText.some((line) => containsPrivateMarker(line)), "console has no private marker").toBe(false);
  expect(browserAuthorizationHeaderSeen).toBe(false);
  expect(browserFundingFieldSeen).toBe(false);
  expect(requesterCacheHeaders.length).toBeGreaterThan(0);
  expect(requesterCacheHeaders.every((value) => value === "no-store")).toBe(true);

  await page.reload();
  await expect(page.getByText(transactionId, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-operational-state='settled']")).toBeVisible();
  await expect(page.locator("[data-private-result='loaded']")).toHaveCount(0);
  await expect(page.locator("[data-safe-report='loaded']")).toHaveCount(0);
  expect(createRequestCount).toBe(1);
  const afterReloadBody = await page.locator("body").textContent() ?? "";
  expect(containsPrivateMarker(afterReloadBody), "reload does not restore private content").toBe(false);

  await page.getByRole("button", { name: "Load private result" }).click();
  await expect(page.locator("[data-private-result='loaded']")).toBeVisible({ timeout: 30_000 });
  const reloadedPrivateText = await page.locator("[data-private-result='loaded']").textContent() ?? "";
  expect(
    reloadedPrivateText.includes(DOCUMENT_MARKER),
    "explicit reload returns the same transaction summary",
  ).toBe(true);
  expect(createRequestCount).toBe(1);
  expect(new URL(page.url()).pathname).toBe("/");
  expect(new URL(page.url()).search).toBe("");

  await page.getByRole("button", { name: "Close transaction" }).click();
  await expect(page.getByRole("button", { name: "New transaction" })).toBeVisible();
});
