import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Issue #39 Railway remediation", () => {
  it("turns intentional Strfry shutdown into a bounded Railway retry", async () => {
    const entrypoint = await source("deploy/strfry-entrypoint.sh");
    const dockerfile = await source("deploy/strfry.Dockerfile");
    const executableLines = entrypoint
      .split(/\r?\n/u)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    expect(executableLines).toContain("trap shutdown TERM INT");
    expect(executableLines).toContain('kill -TERM "$child_pid"');
    expect(executableLines).toContain('exit "$child_status"');
    expect(entrypoint).toContain("controlled retryable status");
    expect(executableLines.match(/exit 75/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(executableLines).not.toContain("kill -- -$$");
    expect(dockerfile).toContain("COPY deploy/strfry-entrypoint.sh /app/entrypoint.sh");
    expect(dockerfile).toContain('ENTRYPOINT ["/bin/bash", "/app/entrypoint.sh"]');
  });

  it("makes relay readiness depend on the Strfry upstream", async () => {
    const caddyfile = await source("local/Caddyfile-railway");
    const healthBlock = caddyfile.match(/handle \/health \{(?<body>[\s\S]*?)\n    \}/u)?.groups?.body;

    expect(healthBlock).toBeDefined();
    expect(healthBlock).toContain("reverse_proxy {$PACTAGENT_STRFRY_UPSTREAM}");
    expect(healthBlock).not.toMatch(/respond\s+"?ok"?\s+200/iu);
  });

  it("bounds Strfry restart attempts and pins safe mint logging thresholds", async () => {
    const railway = await source(".railway/railway.ts");

    expect(railway).toContain('restartPolicyType: "ON_FAILURE"');
    expect(railway).toContain("restartPolicyMaxRetries: 10");
    expect(railway).toContain('DEBUG: "FALSE"');
    expect(railway).toContain('LOG_LEVEL: "INFO"');
    expect(railway).not.toContain("LOGURU_LEVEL");
  });

  it("makes the production doctor consume upstream-aware relay readiness", async () => {
    const doctor = await source("scripts/railway-doctor.mjs");

    expect(doctor).toContain('`${relayProbeUrl}/health`');
    expect(doctor).toContain('record("relay /health upstream-aware readiness"');
  });
});
