import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": resolve(root, "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.live.test.ts", "src/**/*.blackbox.test.ts"],
    testTimeout: 300_000,
    pool: "forks",
  },
});
