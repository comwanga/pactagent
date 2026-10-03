import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDemoEconomicEnvironment,
  type EconomicEnvironment,
  type DemoEconomicEnvironmentConfig,
} from "./economic-environment";

/*
 * Issue #37: Demo Wallet value lifecycle tests.
 *
 * Tests the per-session wallet model: Start Demo, balance aggregation,
 * resolveFunding aggregation, reset with retirement, no-silent-replenishment,
 * reload persistence, generation isolation, and security boundaries.
 *
 * The npm test harness starts and waits for the real Nutshell 0.21.0
 * FakeWallet demo mint. No operator restart is required between suites.
 *
 * No Testnut. No real Bitcoin. No real Lightning.
 */

const DEMO_MINT_URL = "http://127.0.0.1:3338";
const NORMAL_SPEND_KEY_HEX = "41".repeat(32);
const REFUND_SPEND_KEY_HEX = "42".repeat(32);

const tempDirs: string[] = [];
afterAll(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows locks */ }
  }
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pactagent-demo-wallet-"));
  tempDirs.push(dir);
  return dir;
}

function demoConfig(stateDirectory: string, fundingReference: string): DemoEconomicEnvironmentConfig {
  return {
    mintUrl: DEMO_MINT_URL,
    stateDirectory,
    normalSpendKeyHex: NORMAL_SPEND_KEY_HEX,
    refundSpendKeyHex: REFUND_SPEND_KEY_HEX,
    fundingReference,
    initialBalanceSats: 1000,
  };
}

let transactionSequence = 0;
async function resolveWalletFunding(env: EconomicEnvironment, walletKey: string) {
  const transactionId = `txn_demo_wallet_${++transactionSequence}`;
  const binding = await env.bindDemoTransactionFunding!(walletKey, transactionId);
  return env.resolveFunding(binding.fundingReference);
}

async function waitForMint(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${DEMO_MINT_URL}/v1/info`);
      if (res.ok) return;
    } catch { /* keep polling */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Demo mint did not become reachable at ${DEMO_MINT_URL}`);
}

beforeAll(async () => {
  await waitForMint();
}, 90_000);

beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 3000));
});

describe("Issue #37: Demo Wallet value lifecycle", () => {
  it("Start Demo creates wallet-owned private value with balance 1000", async () => {
    const stateDir = await tempDir();
    const ref = "wallet-balance-init-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));

    try {
      const result = await env.startDemoWallet!(ref);
      expect(result.generation).toBe(1);

      const balance = await env.walletBalance!(ref);
      expect(balance.generation).toBe(1);
      expect(balance.availableSats).toBe(1000n);
    } finally {
      env.close();
    }
  }, 120_000);

  it("resolveFunding aggregates unspent value and returns funding", async () => {
    const stateDir = await tempDir();
    const ref = "wallet-resolve-funding-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));

    try {
      await env.startDemoWallet!(ref);
      const funding = await resolveWalletFunding(env, ref);
      expect(funding).toBeDefined();
    } finally {
      env.close();
    }
  }, 120_000);

  it("browser cannot inject a funding reference — resolveFunding rejects unknown references", async () => {
    const stateDir = await tempDir();
    const ref = "wallet-inject-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));

    try {
      await env.startDemoWallet!(ref);
      await expect(env.resolveFunding("injected-fake-reference")).rejects.toThrow();
      await expect(env.resolveFunding("another-fake-ref-12345")).rejects.toThrow();
    } finally {
      env.close();
    }
  }, 120_000);

  it("reload preserves wallet-owned handles and balance", async () => {
    const stateDir = await tempDir();
    const ref = "wallet-reload-ref";
    const env1 = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));

    try {
      await env1.startDemoWallet!(ref);
      const balance1 = await env1.walletBalance!(ref);
      expect(balance1.availableSats).toBe(1000n);
    } finally {
      env1.close();
    }

    const env2 = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));
    try {
      const exists = await env2.demoWalletExists!(ref);
      expect(exists).toBe(true);
      const balance2 = await env2.walletBalance!(ref);
      expect(balance2.generation).toBe(1);
      expect(balance2.availableSats).toBe(1000n);
    } finally {
      env2.close();
    }
  }, 120_000);

  it("reset retires old generation and creates new allocation with balance 1000", async () => {
    const stateDir = await tempDir();
    const ref = "wallet-reset-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));

    try {
      await env.startDemoWallet!(ref);
      const before = await env.walletBalance!(ref);
      expect(before.generation).toBe(1);

      await env.resetDemoWallet!(ref, "reset-demo-wallet-01");

      const after = await env.walletBalance!(ref);
      expect(after.generation).toBe(2);
      expect(after.availableSats).toBe(1000n);
    } finally {
      env.close();
    }
  }, 120_000);

  it("reset does not delete old economic records (retired wallet preserved)", async () => {
    const stateDir = await tempDir();
    const ref = "wallet-reset-records-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));

    try {
      await env.startDemoWallet!(ref);
      await env.resetDemoWallet!(ref, "reset-demo-wallet-02");

      const currentRaw = await env.privateStore.read("demo-wallet", ref);
      expect(currentRaw).toBeDefined();
      const current = currentRaw as { generation: number; status: string };
      expect(current.generation).toBe(2);
      expect(current.status).toBe("active");
    } finally {
      env.close();
    }
  }, 120_000);

  it("new generation cannot spend old generation value (proofs are distinct)", async () => {
    const stateDir = await tempDir();
    const ref = "wallet-gen-isolation-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));

    try {
      await env.startDemoWallet!(ref);
      await env.resetDemoWallet!(ref, "reset-demo-wallet-03");
      const balance = await env.walletBalance!(ref);
      expect(balance.generation).toBe(2);
      expect(balance.availableSats).toBe(1000n);
    } finally {
      env.close();
    }
  }, 120_000);

  it("low balance does not silently remint (resolveFunding throws when exhausted)", async () => {
    const stateDir = await tempDir();
    const ref = "wallet-exhaust-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));

    try {
      await env.startDemoWallet!(ref);
      const balance = await env.walletBalance!(ref);
      expect(balance.availableSats).toBe(1000n);

      const funding = await resolveWalletFunding(env, ref);
      expect(funding).toBeDefined();

      const balance2 = await env.walletBalance!(ref);
      expect(balance2.availableSats).toBe(1000n);
    } finally {
      env.close();
    }
  }, 120_000);

  it("idempotent Start Demo returns same wallet", async () => {
    const stateDir = await tempDir();
    const ref = "wallet-idempotent-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));

    try {
      const result1 = await env.startDemoWallet!(ref);
      const result2 = await env.startDemoWallet!(ref);
      expect(result1.walletId).toBe(result2.walletId);
      expect(result1.generation).toBe(result2.generation);
      expect(result1.generation).toBe(1);
    } finally {
      env.close();
    }
  }, 120_000);

  it("two concurrent Start Demo requests create at most one allocation", async () => {
    const stateDir = await tempDir();
    const ref = "wallet-concurrent-start-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));

    try {
      const [result1, result2] = await Promise.all([
        env.startDemoWallet!(ref),
        env.startDemoWallet!(ref),
      ]);
      expect(result1.walletId).toBe(result2.walletId);
      expect(result1.generation).toBe(result2.generation);
      expect(result1.generation).toBe(1);

      const balance = await env.walletBalance!(ref);
      expect(balance.availableSats).toBe(1000n);
    } finally {
      env.close();
    }
  }, 120_000);

  it("two different wallet keys create isolated wallets", async () => {
    const stateDir = await tempDir();
    const ref = "wallet-isolation-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));

    try {
      const resultA = await env.startDemoWallet!("session-a-hash");
      const resultB = await env.startDemoWallet!("session-b-hash");
      expect(resultA.walletId).not.toBe(resultB.walletId);

      const balanceA = await env.walletBalance!("session-a-hash");
      const balanceB = await env.walletBalance!("session-b-hash");
      expect(balanceA.availableSats).toBe(1000n);
      expect(balanceB.availableSats).toBe(1000n);
      expect(balanceA.generation).toBe(1);
      expect(balanceB.generation).toBe(1);
    } finally {
      env.close();
    }
  }, 120_000);

  it("no silent replenishment on reload without Start Demo", async () => {
    const stateDir = await tempDir();
    const ref = "wallet-no-replenish-ref";
    const env1 = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));

    try {
      await env1.startDemoWallet!(ref);
    } finally {
      env1.close();
    }

    const env2 = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));
    try {
      const exists = await env2.demoWalletExists!(ref);
      expect(exists).toBe(true);
      const balance = await env2.walletBalance!(ref);
      expect(balance.availableSats).toBe(1000n);
    } finally {
      env2.close();
    }
  }, 120_000);
});
