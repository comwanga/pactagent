import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": resolve(root, "src") },
  },
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    projects: [
      {
        resolve: { alias: { "@": resolve(root, "src") } },
        test: {
          name: "deterministic",
          environment: "node",
          include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
          exclude: [
            "src/**/*.live.test.ts",
            "src/**/*.blackbox.test.ts",
            "src/**/*.process.test.ts",
            "src/**/*.model-doctor.test.ts",
            "src/lib/cashu-escrow-settlement.test.ts",
            "src/lib/pactagent-runtime-api.test.ts",
            "src/lib/pactagent-runtime.test.ts",
            "src/lib/pactagent-workflow.test.ts",
          ],
          testTimeout: 20_000,
          pool: "forks",
        },
      },
      {
        resolve: { alias: { "@": resolve(root, "src") } },
        test: {
          name: "long-deterministic",
          environment: "node",
          include: [
            "src/lib/cashu-escrow-settlement.test.ts",
            "src/lib/pactagent-runtime-api.test.ts",
            "src/lib/pactagent-runtime.test.ts",
            "src/lib/pactagent-workflow.test.ts",
          ],
          testTimeout: 20_000,
          pool: "vmThreads",
          poolOptions: { vmThreads: { singleThread: true } },
        },
      },
    ],
  },
});
