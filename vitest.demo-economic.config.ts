import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/*
 * Dedicated configuration for the Issue #36 container-backed demo economic
 * integration lane (`npm run test:demo-economic:live`).
 *
 * This lane executes against the REAL pinned Nutshell 0.21.0/FakeWallet
 * container defined in compose.local.yml (demo-mint on 127.0.0.1:3338). It
 * does NOT mock the Cashu port. It exercises the real demo economic factory,
 * real P2PK lock/spend, durable funding restart, mint restart, replay
 * rejection, and the real coordinator settlement. Demo sats only — no Testnut,
 * no real Lightning, no real Bitcoin, no fabricated proofs, no direct mint DB
 * mutation.
 *
 * The npm wrapper starts the demo-mint container and waits for bounded
 * readiness. A skipped test is NOT PASS: if the mint is unreachable the suite
 * fails explicitly.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(root, "src"),
      "server-only": resolve(root, "src/test/server-only.ts"),
    },
  },
  test: {
    include: ["src/lib/demo-economic.live.test.ts"],
    exclude: [],
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    environment: "node",
  },
});
