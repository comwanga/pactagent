import { describe, expect, it } from "vitest";

import { sats } from "../domain/money";
import {
  readLiveDemoConfigFromEnv,
  assertLiveDemoConfig,
  runLiveDemoTransaction,
} from "./pactagent-workflow.live";

const liveConfig = readLiveDemoConfigFromEnv();
const liveIt = liveConfig ? it : it.skip;

describe("PactAgent live workflow demonstration", () => {
  it("skips cleanly when live configuration is missing", () => {
    if (liveConfig) {
      expect(assertLiveDemoConfig(liveConfig)).toBeDefined();
      return;
    }
    expect(() => assertLiveDemoConfig(undefined)).toThrow(
      /Live demonstration requires explicit configuration/,
    );
  });

  liveIt(
    "executes a live PactAgent transaction end to end when configured",
    async () => {
      if (!liveConfig) return;
      const report = await runLiveDemoTransaction(liveConfig, {
        privateDocument:
          "This is a live demonstration document about Bitcoin and Lightning Network protocols.",
        mediaType: "text/plain",
        maximumBudgetSats: sats(500n),
      });
      expect(report.finalOutcome).toBe("settled");
      expect(report.amountSats).toBe("350");
      expect(report.selectedReferences.providerDefinitionReference).toContain("live-provider");
      expect(report.selectedReferences.offerReference).toContain("live-document-summary-offer");
      expect(report.selectedReferences.escrowDescriptorReference).toContain("live-cashu-escrow");
    },
    120_000,
  );
});
