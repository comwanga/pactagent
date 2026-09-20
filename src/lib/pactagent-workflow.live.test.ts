import { describe, expect, it } from "vitest";

import { sats } from "../domain/money";
import {
  readLiveDemoConfigFromEnv,
  assertLiveDemoConfig,
  importLiveDemoFunding,
  runLiveDemoTransaction,
  type PactAgentLiveDemoConfig,
} from "./pactagent-workflow.live";
import { PactAgentWorkflowError } from "./pactagent-workflow";
import type { CashuTestMintPort } from "./cashu-test-mint";

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

  it("redacts a malformed live funding token from the reported error", async () => {
    const tokenMarker = "cashuA-PRIVATE-TOKEN-MARKER";
    const config: PactAgentLiveDemoConfig = {
      relayUrl: "wss://relay.example",
      testMintUrl: "https://testmint.example/cashu",
      requesterPrivateKeyHex: "01".repeat(32),
      providerPrivateKeyHex: "02".repeat(32),
      escrowAuthorityPrivateKeyHex: "03".repeat(32),
      normalSpendKeyHex: "04".repeat(32),
      refundSpendKeyHex: "05".repeat(32),
      fundingToken: tokenMarker,
      stateDirectory: ".test-live-state",
    };
    const cashu = {
      async inspectCapabilities() {
        return {
          mintUrl: config.testMintUrl,
          unit: "sat" as const,
          nuts: {
            nut07ProofState: true,
            nut09Restore: true,
            nut10SpendingConditions: true,
            nut11P2pk: true,
          },
          activeKeyset: { id: "00aabb", inputFeePpk: 0 },
          acceptedKeysetIds: ["00aabb"],
        };
      },
    } as unknown as CashuTestMintPort;

    let caught: unknown;
    try {
      await importLiveDemoFunding(config, cashu);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PactAgentWorkflowError);
    expect(JSON.stringify(caught)).not.toContain(tokenMarker);
    expect(caught).toMatchObject({ code: "invalid_configuration" });
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
