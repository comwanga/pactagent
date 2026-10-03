import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(root, "src"),
      "server-only": resolve(root, "src/test/server-only.ts"),
    },
  },
  test: {
    include: ["src/lib/demo-wallet.live.test.ts"],
    exclude: [],
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    environment: "node",
  },
});
