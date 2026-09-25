import { spawnNext, waitFor } from "./local-process.mjs";

const MAX_CAPTURE_BYTES = 1_000_000;

function appendBounded(current, chunk) {
  const next = current + String(chunk);
  return next.length <= MAX_CAPTURE_BYTES ? next : next.slice(next.length - MAX_CAPTURE_BYTES);
}

export async function startCapturedRuntime(environment, baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("Local runtime base must use localhost HTTP");
  }
  const port = url.port || "3000";
  const child = spawnNext(["start", "-p", port], environment, ["ignore", "pipe", "pipe"]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error("Local runtime exited before readiness");
    const response = await fetch(`${baseUrl}/api/status`);
    return response.ok;
  }, { timeoutMs: 30_000 });
  return Object.freeze({
    child,
    exited,
    logs: () => `${stdout}\n${stderr}`,
  });
}

export async function stopCapturedRuntime(runtime) {
  if (runtime.child.exitCode !== null) return runtime.exited;
  runtime.child.kill("SIGTERM");
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (runtime.child.exitCode === null) runtime.child.kill("SIGKILL");
      resolve(undefined);
    }, 10_000);
    timer.unref();
  });
  await Promise.race([runtime.exited, timeout]);
  return runtime.exited;
}
