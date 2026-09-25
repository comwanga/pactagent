import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  COMPOSE_FILE,
  DEFAULT_STATE_PATH,
  LOCAL_ROOT,
  loadLocalEnvironment,
  resolveLocalCaPath,
} from "./local-env.mjs";
import { runChecked, waitFor } from "./local-process.mjs";

const environment = loadLocalEnvironment();
const caPath = resolveLocalCaPath(environment);
const caddyRoot = resolve(LOCAL_ROOT, "caddy-data", "caddy", "pki", "authorities", "local", "root.crt");

await Promise.all([
  mkdir(resolve(LOCAL_ROOT, "strfry-db"), { recursive: true }),
  mkdir(resolve(LOCAL_ROOT, "caddy-data"), { recursive: true }),
  mkdir(dirname(caPath), { recursive: true }),
  mkdir(DEFAULT_STATE_PATH, { recursive: true }),
]);

await runChecked("docker", [
  "compose",
  "-f",
  COMPOSE_FILE,
  "up",
  "-d",
  "--wait",
  "--wait-timeout",
  "60",
]);

await waitFor(async () => {
  try {
    return (await stat(caddyRoot)).isFile();
  } catch {
    return false;
  }
}, { timeoutMs: 30_000 });
await copyFile(caddyRoot, caPath);

console.log("PASS: PactAgent local Strfry is running on 127.0.0.1:7777");
console.log("PASS: PactAgent local Caddy WSS proxy is running on 127.0.0.1:8443");
console.log(`PASS: local Caddy root CA exported to ${caPath}`);
