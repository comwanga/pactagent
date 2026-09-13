import { describe, expect, it } from "vitest";

import { sats } from "../domain/money";
import {
  createCashuTestMintAdapter,
  createInMemoryCashuPrivateStore,
} from "./cashu-test-mint";

const configuredTestMint = process.env.PACTAGENT_CASHU_TEST_MINT_URL;
const liveIt = configuredTestMint ? it : it.skip;

describe("Cashu test-mint opt-in integration", () => {
  liveIt(
    "inspects the explicitly configured test mint without moving value",
    async () => {
      if (!configuredTestMint) return;
      const adapter = createCashuTestMintAdapter({
        configuration: {
          testMintUrl: configuredTestMint,
          unit: "sat",
          maximumExposureSats: sats(1n),
          requestTimeoutMs: 5_000,
          maximumResponseBytes: 500_000,
        },
        privateStore: createInMemoryCashuPrivateStore(),
      });

      await expect(adapter.inspectCapabilities()).resolves.toMatchObject({
        mintUrl: configuredTestMint.replace(/\/+$/, ""),
        unit: "sat",
        nuts: {
          nut07ProofState: true,
          nut09Restore: true,
          nut10SpendingConditions: true,
          nut11P2pk: true,
        },
      });
    },
    15_000,
  );
});
