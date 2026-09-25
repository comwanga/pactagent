import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { PROJECT_ROOT } from "./local-env.mjs";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

export function runSync(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

export async function runChecked(command, args, options = {}) {
  const result = await runCommand(command, args, { stdio: "inherit", ...options });
  if (result.signal || result.code !== 0) {
    throw new Error(`${command} exited unsuccessfully`);
  }
}

export function installSignalForwarding(child) {
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (!child.killed) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}

export async function runForeground(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  const removeHandlers = installSignalForwarding(child);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (result.signal) process.kill(process.pid, result.signal);
    return result.code ?? 1;
  } finally {
    removeHandlers();
  }
}

export function spawnNext(args, environment, stdio = "inherit") {
  return spawn(process.execPath, [nextBin, ...args], {
    cwd: PROJECT_ROOT,
    env: environment,
    stdio,
    windowsHide: true,
  });
}

export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for readiness");
}

export const nextBinary = nextBin;
