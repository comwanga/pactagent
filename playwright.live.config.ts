import { defineConfig, devices } from "@playwright/test";

const requesterOrigin = process.env.PACTAGENT_REQUESTER_UI_ORIGIN;

if (!requesterOrigin) {
  throw new Error("Live requester origin was not supplied by the opt-in runner");
}

export default defineConfig({
  testDir: "./e2e-live",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 8 * 60_000,
  expect: { timeout: 30_000 },
  outputDir: ".local/playwright-live-results",
  reporter: "list",
  use: {
    baseURL: requesterOrigin,
    actionTimeout: 30_000,
    navigationTimeout: 45_000,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium-live", use: { ...devices["Desktop Chrome"] } }],
});
