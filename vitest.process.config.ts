import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": resolve(root, "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.process.test.ts"],
    testTimeout: 120_000,
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
