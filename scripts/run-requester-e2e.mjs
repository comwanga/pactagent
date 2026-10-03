import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const runtimeToken = "E2E-RUNTIME-TOKEN-SERVER-ONLY";
const commonEnvironment = {
  ...process.env,
  PACTAGENT_RUNTIME_API_BASE: "http://127.0.0.1:3411",
  PACTAGENT_RUNTIME_API_TOKEN: runtimeToken,
  PACTAGENT_LIVE_FUNDING_REFERENCE: "E2E-FUNDING-SERVER-ONLY",
  PACTAGENT_LIVE_STATE_DIRECTORY: ".local/requester-e2e-state",
  PACTAGENT_REQUESTER_SESSION_DATABASE: ".local/requester-e2e-state/requester-sessions.sqlite",
  PACTAGENT_REQUESTER_UI_ORIGIN: "http://localhost:3410",
};
const runtime = spawn(process.execPath, [resolve(root, "scripts", "requester-e2e-runtime-fixture.mjs")], {
  cwd: root,
  env: { ...commonEnvironment, PACTAGENT_E2E_RUNTIME_PORT: "3411" },
  stdio: "inherit",
});
const app = spawn(process.execPath, [
  resolve(root, "node_modules", "next", "dist", "bin", "next"),
  "start",
  "--hostname",
  "127.0.0.1",
  "--port",
  "3410",
], { cwd: root, env: commonEnvironment, stdio: "inherit" });

function terminate(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

function cleanup() {
  terminate(app);
  terminate(runtime);
}

async function waitFor(url) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (runtime.exitCode !== null || app.exitCode !== null) throw new Error("E2E server exited before readiness");
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(1);
  });
}

let exitCode = 1;
try {
  await Promise.all([
    waitFor("http://127.0.0.1:3411/__test/state"),
    waitFor("http://localhost:3410/"),
  ]);
  const playwright = spawn(process.execPath, [
    resolve(root, "node_modules", "@playwright", "test", "cli.js"),
    "test",
    ...process.argv.slice(2),
  ], { cwd: root, env: commonEnvironment, stdio: "inherit" });
  exitCode = await new Promise((resolveExit) => {
    playwright.on("exit", (code) => resolveExit(code ?? 1));
  });
} finally {
  cleanup();
}
process.exit(exitCode);
