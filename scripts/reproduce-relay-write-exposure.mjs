// Reproduce the pre-policy relay locally, with only new disposable project state.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import WebSocket from "ws";
import { runChecked } from "./local-process.mjs";
import { registerAcceptanceProject } from "./issue-62-ci.mjs";

const root = resolve(import.meta.dirname, "..");
const project = `${process.env.PACTAGENT_ACCEPTANCE_PROJECT_PREFIX || "pactagent-62"}-baseline-${randomBytes(6).toString("hex")}`;
const directory = resolve(root, ".local", project);
mkdirSync(directory, { recursive: true });
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const selected = server.address().port;
    server.close(() => resolvePort(selected));
  });
});
const file = resolve(directory, "compose.json");
writeFileSync(file, JSON.stringify({ services: { strfry: {
  image: "dockurr/strfry@sha256:599ab3500dbfbe6cb78c668e1892cd9802c192d066df4660e8e3175034a8344d",
  command: ["/app/strfry.sh"], ports: [`127.0.0.1:${port}:7777`],
  mem_limit: "256m",
  volumes: ["baseline:/app/strfry-db", `${resolve(root, "local/strfry.conf").replaceAll("\\", "/")}:/etc/strfry.conf:ro`],
  healthcheck: { test: ["CMD", "curl", "-fSs", "http://localhost:7777/"], interval: "2s", timeout: "2s", retries: 20 },
} }, volumes: { baseline: {} } }));
const compose = ["compose", "-f", file, "-p", project];
registerAcceptanceProject(project, [file], process.env);
async function publish(kind, contentLength = 32) {
  const event = finalizeEvent({ kind, content: "x".repeat(contentLength), tags: [],
    created_at: Math.floor(Date.now() / 1000) }, generateSecretKey());
  return new Promise((resolveResult, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => { socket.close(); reject(new Error("Baseline publication timeout")); }, 15000);
    socket.on("open", () => socket.send(JSON.stringify(["EVENT", event])));
    socket.on("error", reject);
    socket.on("message", data => {
      const response = JSON.parse(String(data));
      if (response[0] !== "OK" || response[1] !== event.id) return;
      clearTimeout(timer);
      socket.close();
      if (response[2] !== true) reject(new Error(`Baseline kind ${kind} unexpectedly rejected`));
      else resolveResult({ kind, normalizedBytes: Buffer.byteLength(JSON.stringify(event)), accepted: true });
    });
  });
}
try {
  await runChecked("docker", [...compose, "up", "-d", "--wait"]);
  for (const [kind, bytes] of [[1, 32], [3921, 32], [1059, 32], [1, 4 * 1024 * 1024 - 1000]]) {
    console.log("BASELINE_EXPOSURE", JSON.stringify(await publish(kind, bytes)));
  }
} catch (error) {
  // This relay contains only synthetic public baseline events. Preserve its
  // startup diagnostic before the disposable project is removed.
  await runChecked("docker", [...compose, "logs", "--no-color", "--tail", "80", "strfry"])
    .catch(() => undefined);
  throw error;
} finally {
  await runChecked("docker", [...compose, "down", "-v"]);
}
