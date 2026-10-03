import { defineConfig, devices } from "@playwright/test";

const appOrigin = "http://localhost:3410";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  outputDir: ".local/playwright-results",
  reporter: "list",
  use: {
    baseURL: appOrigin,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
