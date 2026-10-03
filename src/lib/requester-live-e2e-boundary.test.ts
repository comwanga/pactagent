import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Phase 5 live requester acceptance boundary", () => {
  it("keeps the live runner isolated from deterministic fixture startup", () => {
    const runner = read("scripts/run-requester-e2e-live.mjs");
    const config = read("playwright.live.config.ts");
    const specification = read("e2e-live/requester-live.spec.ts");
    const surface = `${runner}\n${config}\n${specification}`;

    expect(surface).not.toContain("requester-e2e-runtime-fixture");
    expect(surface).not.toContain("requester-phase4.spec");
    expect(config).not.toContain("webServer");
    expect(config).toContain('testDir: "./e2e-live"');
    expect(runner).not.toContain('next", "start"');
    expect(runner).not.toContain("__test/state");
  });

  it("keeps the live browser specification black-box", () => {
    const specification = read("e2e-live/requester-live.spec.ts");
    const forbidden = [
      "pactagent-runtime",
      "pactagent-workflow",
      "nostr-relay",
      "nostr-signer",
      "private-task-transport",
      "cashu-test-mint",
      "cashu-escrow-settlement",
      "requester-decision",
      "provider-discovery",
    ];

    for (const path of forbidden) expect(specification).not.toContain(`from \"${path}`);
    expect(specification.match(/^import .* from .*;$/gmu)).toEqual([
      'import { expect, test, type Page } from "@playwright/test";',
    ]);
    expect(specification).not.toContain("/api/transactions");
    expect(specification).toContain("/api/requester/transactions/");
  });

  it("does not make live acceptance part of deterministic commands", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.test).not.toContain("requester:live");
    expect(packageJson.scripts.build).not.toContain("requester:live");
    expect(packageJson.scripts["test:e2e:requester"]).not.toContain("live");
    expect(packageJson.scripts["test:e2e:requester:live"])
      .toBe("node scripts/run-requester-e2e-live.mjs");
  });

  it("strips server-only live material before Playwright starts", () => {
    const runner = read("scripts/run-requester-e2e-live.mjs");

    for (const name of [
      "PACTAGENT_RUNTIME_API_TOKEN",
      "PACTAGENT_LIVE_FUNDING_TOKEN",
      "PACTAGENT_LIVE_FUNDING_REFERENCE",
      "PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY",
      "PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY",
      "PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY",
      "PACTAGENT_LIVE_NORMAL_SPEND_KEY",
      "PACTAGENT_LIVE_REFUND_SPEND_KEY",
      "PACTAGENT_REQUESTER_MODEL_API_KEY",
    ]) {
      expect(runner).toContain(`\"${name}\"`);
    }
    expect(runner).toContain("delete childEnvironment[name]");
  });

  it("skips by safe category when live configuration is absent", () => {
    const absent = Object.fromEntries([
      "PACTAGENT_RUNTIME_API_TOKEN",
      "PACTAGENT_RUNTIME_API_BASE",
      "PACTAGENT_REQUESTER_UI_ORIGIN",
      "PACTAGENT_LIVE_RELAY_URL",
      "PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY",
      "PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY",
      "PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY",
      "PACTAGENT_CASHU_TEST_MINT_URL",
      "PACTAGENT_LIVE_NORMAL_SPEND_KEY",
      "PACTAGENT_LIVE_REFUND_SPEND_KEY",
      "PACTAGENT_LIVE_FUNDING_TOKEN",
      "PACTAGENT_LIVE_FUNDING_REFERENCE",
      "PACTAGENT_LIVE_STATE_DIRECTORY",
    ].map((name) => [name, ""]));
    const result = spawnSync(process.execPath, [resolve(root, "scripts/run-requester-e2e-live.mjs")], {
      cwd: root,
      env: { ...process.env, ...absent },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SKIP: requester runtime authorization unavailable.");
    expect(result.stdout).toContain("SKIP: live Nostr configuration unavailable.");
    expect(result.stdout).toContain("SKIP: Cashu test-mint configuration unavailable.");
    expect(result.stdout).toContain("SKIP: live requester browser acceptance was not run.");
    expect(result.stdout).not.toContain("PACTAGENT_RUNTIME_API_TOKEN");
    expect(result.stdout).not.toContain("PACTAGENT_LIVE_FUNDING_TOKEN");
  });
});
