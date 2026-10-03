import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = [
  resolve(sourceRoot, "lib/requester-api-client.ts"),
  resolve(sourceRoot, "app/requester-transaction-app.tsx"),
];
const forbidden = [
  "pactagent-runtime",
  "pactagent-workflow",
  "provider-discovery",
  "requester-decision",
  "nostr-relay",
  "nostr-signer",
  "private-task-transport",
  "cashu",
  "settlement",
  "economic-environment",
];

function clientImports(path: string): string[] {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']((?:\.|@\/)[^"']+)["']/g)]
    .map((match) => match[1]);
}

describe("requester client dependency boundary", () => {
  it("does not include workflow, runtime, Nostr, Cashu, or settlement implementations", () => {
    const visited = new Set<string>();
    const pending = [...entries];
    while (pending.length > 0) {
      const path = pending.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      expect(forbidden.some((name) => path.replaceAll("\\", "/").includes(name))).toBe(false);
      for (const specifier of clientImports(path)) {
        const base = specifier.startsWith("@/")
          ? resolve(sourceRoot, specifier.slice(2))
          : resolve(dirname(path), specifier);
        const target = path.endsWith(".tsx") && specifier === "./pactagent-logo"
          ? `${base}.tsx`
          : `${base}.ts`;
        pending.push(target);
      }
    }
    const normalized = [...visited].map((path) => path.replaceAll("\\", "/"));
    expect(normalized).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/app\/requester-transaction-app\.tsx$/),
      expect.stringMatching(/\/lib\/requester-api-client\.ts$/),
      expect.stringMatching(/\/lib\/requester-api-contracts\.ts$/),
      expect.stringMatching(/\/lib\/requester-ui-model\.ts$/),
    ]));
  });

  it("keeps requester Demo routes on the authenticated server transport", () => {
    for (const path of [
      resolve(sourceRoot, "app/api/requester/demo/route.ts"),
      resolve(sourceRoot, "app/api/requester/demo/start/route.ts"),
      resolve(sourceRoot, "app/api/requester/demo/reset/route.ts"),
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("runtimeTransport");
      expect(source).not.toContain("pactagent-runtime-singleton");
      expect(source).not.toContain("getPactAgentRuntime");
    }
  });
});
