import { expect, test, type Locator, type Page } from "@playwright/test";

interface ContrastEvidence {
  readonly name: string;
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  readonly minimum: number;
}

async function measureContrast(
  page: Page,
  options: {
    readonly name: string;
    readonly foreground: Locator;
    readonly background: Locator;
    readonly property?: "color" | "borderTopColor" | "borderLeftColor" | "outlineColor";
    readonly minimum: number;
  },
): Promise<ContrastEvidence> {
  const [foregroundSelector, backgroundSelector] = await Promise.all([
    options.foreground.evaluate((element) => {
      element.setAttribute("data-contrast-foreground", "true");
      return "[data-contrast-foreground='true']";
    }),
    options.background.evaluate((element) => {
      element.setAttribute("data-contrast-background", "true");
      return "[data-contrast-background='true']";
    }),
  ]);
  const result = await page.evaluate(({ foregroundSelector, backgroundSelector, property }) => {
    function rgb(value: string): [number, number, number, number] {
      const components = value.match(/[\d.]+/gu)?.map(Number) ?? [];
      if (components.length < 3) throw new Error(`Unsupported rendered color: ${value}`);
      return [components[0], components[1], components[2], components[3] ?? 1];
    }
    function blend(
      foreground: [number, number, number, number],
      background: [number, number, number, number],
    ): [number, number, number] {
      return [0, 1, 2].map((index) =>
        foreground[index] * foreground[3] + background[index] * (1 - foreground[3]),
      ) as [number, number, number];
    }
    function luminance(value: [number, number, number]): number {
      const channels = value.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    }
    const foregroundElement = document.querySelector(foregroundSelector);
    const backgroundElement = document.querySelector(backgroundSelector);
    if (!(foregroundElement instanceof HTMLElement) || !(backgroundElement instanceof HTMLElement)) {
      throw new Error("Contrast target is unavailable");
    }
    const foregroundCss = getComputedStyle(foregroundElement)[property];
    const backgroundCss = getComputedStyle(backgroundElement).backgroundColor;
    const background = rgb(backgroundCss);
    const foreground = blend(rgb(foregroundCss), background);
    const backgroundRgb = blend(background, [255, 255, 255, 1]);
    const lighter = Math.max(luminance(foreground), luminance(backgroundRgb));
    const darker = Math.min(luminance(foreground), luminance(backgroundRgb));
    return {
      foreground: foregroundCss,
      background: backgroundCss,
      ratio: Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100,
    };
  }, {
    foregroundSelector,
    backgroundSelector,
    property: options.property ?? "color",
  });
  await options.foreground.evaluate((element) => element.removeAttribute("data-contrast-foreground"));
  await options.background.evaluate((element) => element.removeAttribute("data-contrast-background"));
  return { name: options.name, ...result, minimum: options.minimum };
}

test("rendered requester text, controls, focus, and status meet the contrast baseline", async ({ page }) => {
  const evidence: ContrastEvidence[] = [];
  await page.goto("/");
  const startDemo = page.getByRole("button", { name: "Start Demo" });
  const newTransaction = page.getByRole("button", { name: "New transaction" });
  await expect(startDemo.or(newTransaction)).toBeVisible();
  if (await startDemo.isVisible()) {
    await startDemo.evaluate((element: HTMLButtonElement) => element.click()).catch(() => undefined);
  }
  await expect(newTransaction).toBeVisible();
  evidence.push(await measureContrast(page, {
    name: "header environment label",
    foreground: page.locator(".environmentFlag"),
    background: page.locator(".appHeader"),
    minimum: 4.5,
  }));
  evidence.push(await measureContrast(page, {
    name: "primary action text",
    foreground: page.locator(".requesterHero .primaryAction"),
    background: page.locator(".requesterHero .primaryAction"),
    minimum: 4.5,
  }));

  await page.getByRole("button", { name: "New transaction" }).click();
  evidence.push(await measureContrast(page, {
    name: "form heading",
    foreground: page.getByRole("heading", { name: "New transaction" }),
    background: page.locator("html"),
    minimum: 4.5,
  }));
  evidence.push(await measureContrast(page, {
    name: "form help text",
    foreground: page.locator(".fieldHelp").first(),
    background: page.locator(".transactionForm"),
    minimum: 4.5,
  }));
  const budget = page.getByLabel("Maximum budget");
  evidence.push(await measureContrast(page, {
    name: "input control border",
    foreground: budget,
    background: budget,
    property: "borderTopColor",
    minimum: 3,
  }));
  await budget.focus();
  evidence.push(await measureContrast(page, {
    name: "keyboard focus outline",
    foreground: budget,
    background: budget,
    property: "outlineColor",
    minimum: 3,
  }));

  await page.getByLabel("Choose document").setInputFiles({
    name: "contrast-success.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Contrast verification content. SCENARIO:success"),
  });
  await page.getByRole("button", { name: "Review request" }).click();
  await page.getByRole("button", { name: "Submit transaction" }).click();
  await expect(page.locator("[data-operational-state='settled']")).toBeVisible({ timeout: 10_000 });

  evidence.push(await measureContrast(page, {
    name: "status card text",
    foreground: page.locator(".stateCard strong"),
    background: page.locator(".stateCard"),
    minimum: 4.5,
  }));
  evidence.push(await measureContrast(page, {
    name: "status indicator border",
    foreground: page.locator(".stateCard"),
    background: page.locator(".stateCard"),
    property: "borderLeftColor",
    minimum: 3,
  }));
  evidence.push(await measureContrast(page, {
    name: "status section label",
    foreground: page.locator(".dataPanel .sectionKicker"),
    background: page.locator(".dataPanel"),
    minimum: 4.5,
  }));
  evidence.push(await measureContrast(page, {
    name: "policy explanatory text",
    foreground: page.locator(".policyCard .decisionType"),
    background: page.locator(".policyCard"),
    minimum: 4.5,
  }));
  evidence.push(await measureContrast(page, {
    name: "policy pass status",
    foreground: page.locator(".policyChecks strong").first(),
    background: page.locator(".policyCard"),
    minimum: 4.5,
  }));
  evidence.push(await measureContrast(page, {
    name: "private panel explanatory text",
    foreground: page.locator(".privateResultPanel .resourceExplanation"),
    background: page.locator(".privateResultPanel"),
    minimum: 4.5,
  }));

  for (const measurement of evidence) {
    expect(measurement.ratio, measurement.name).toBeGreaterThanOrEqual(measurement.minimum);
  }
  console.log(`CONTRAST_EVIDENCE ${JSON.stringify(evidence)}`);
});
