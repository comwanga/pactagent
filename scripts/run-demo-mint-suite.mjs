import { spawn } from "node:child_process";
import { resolve } from "node:path";

const configuration = process.argv[2];
if (configuration !== "vitest.demo-economic.config.ts" && configuration !== "vitest.demo-wallet.config.ts") {
  throw new Error("A supported demo-mint Vitest configuration is required");
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolveRun()
      : reject(new Error(`${command} exited with status ${code ?? "unknown"}`)));
  });
}

async function waitForMint(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:3338/v1/info", {
        cache: "no-store",
        redirect: "error",
      });
      if (response.ok) return;
    } catch {
      // Bounded readiness polling; no fallback mint is ever started.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error("The local FakeWallet-backed demo mint did not become ready");
}

await run("docker", ["compose", "-f", "compose.local.yml", "up", "-d", "demo-mint"]);
await waitForMint();
await run(process.execPath, [
  resolve("node_modules", "vitest", "vitest.mjs"),
  "run",
  "--config",
  configuration,
]);
