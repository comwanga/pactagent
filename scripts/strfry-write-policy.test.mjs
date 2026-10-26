import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("passes the independently executable Python relay policy suite", () => {
  const result = spawnSync(process.execPath,
    [fileURLToPath(new URL("./test-relay-policy.mjs", import.meta.url))], { encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 30000);
