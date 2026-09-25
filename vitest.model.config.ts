import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": resolve(root, "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.model-doctor.test.ts"],
    testTimeout: 60_000,
    pool: "forks",
    maxWorkers: 1,
  },
});
