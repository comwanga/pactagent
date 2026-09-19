import { describe, expect, it } from "vitest";

import { sats } from "../domain/money";
import { createPrivateCashuFunding } from "./cashu-test-mint";
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
      const funding = createPrivateCashuFunding({
        mintUrl: liveConfig.testMintUrl,
        unit: "sat",
        proofs: [],
      });
      const report = await runLiveDemoTransaction(
        liveConfig,
        {
          async recommend() {
            return {
              action: "recommend",
              providerPublicKey:
                "0000000000000000000000000000000000000000000000000000000000000001",
              providerDefinitionReference: "30360:0000000000000000000000000000000000000000000000000000000000000001:live-provider",
              offerReference: "30400:0000000000000000000000000000000000000000000000000000000000000001:live-offer",
              escrowDescriptorReference: "30361:0000000000000000000000000000000000000000000000000000000000000001:live-escrow",
              proposedAmountSats: "350",
            };
          },
        },
        {
          requesterDefinition: {
            id: "0000000000000000000000000000000000000000000000000000000000000000",
            pubkey: "0000000000000000000000000000000000000000000000000000000000000002",
            created_at: 1_900_000_000,
            kind: 0,
            tags: [],
            content: JSON.stringify({
              name: "Live Requester",
              about: "Live demonstration requester",
              nip05: "requester@example.com",
            }),
            sig: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
          } as never,
          privateDocument: "This is a live demonstration document about Bitcoin and Lightning Network protocols.",
          mediaType: "text/plain",
          maximumBudgetSats: sats(500n),
          funding,
        },
      );
      expect(report.finalOutcome).toBe("settled");
      expect(report.amountSats).toBe("350");
    },
    120_000,
  );
});
