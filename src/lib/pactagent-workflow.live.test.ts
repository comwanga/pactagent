import { describe, expect, it } from "vitest";

import {
  readLiveDemoConfigFromEnv,
  assertLiveDemoConfig,
} from "./pactagent-workflow.live";

const liveConfig = readLiveDemoConfigFromEnv();
const liveIt = liveConfig ? it : it.skip;

describe("PactAgent live workflow demonstration", () => {
  liveIt(
    "skips cleanly when live configuration is missing",
    () => {
      if (!liveConfig) return;
      expect(assertLiveDemoConfig(liveConfig)).toBeDefined();
    },
    15_000,
  );
});
