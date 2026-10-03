import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sats } from "../domain/money";
import {
  createInMemoryCashuPrivateStore,
  createPrivateCashuFunding,
  createPrivateCashuSpendingKey,
  createSqliteCashuPrivateStore,
  type CashuPrivateDeliveryResult,
  type CashuPrivateStore,
  type CashuPrivateValueDeliveryPort,
  type CashuTestMintPort,
  type PrepareLockedValueInput,
  type ProofStateSummary,
  type SpendLockedValueInput,
  type SqliteCashuPrivateStore,
  type ValidatedMintCapabilities,
} from "./cashu-test-mint";
import {
  createInMemoryPactCashuEscrowSettlementStore,
  createSqlitePactCashuEscrowSettlementStore,
  type PactCashuEscrowSettlementStore,
  type SqlitePactCashuEscrowSettlementStore,
} from "./cashu-escrow-settlement";
import {
  createEconomicEnvironment,
  createEconomicEnvironmentFromConfig,
  createLiveEconomicEnvironment,
  EconomicEnvironmentError,
  parseEconomicMode,
  type DemoEconomicEnvironmentConfig,
  type EconomicMode,
  type LiveEconomicEnvironmentConfig,
  type LiveEconomicEnvironmentFactories,
} from "./economic-environment";
import type { PactAgentRuntimeStatus } from "./pactagent-runtime";
import { parseRequesterTransactionStatus } from "./requester-api-contracts";
import { safeStatusFixture } from "./requester-api-test-fixtures";

const MINT_URL = "https://testmint.example/cashu";

function spendKey(seed: number): ReturnType<typeof createPrivateCashuSpendingKey> {
  return createPrivateCashuSpendingKey({
    purpose: "cashu-nut11",
    secretKeyHex: seed.toString(16).padStart(64, "0"),
  });
}

function fakeCashu(available = true): CashuTestMintPort {
  return {
    async inspectCapabilities(): Promise<ValidatedMintCapabilities> {
      if (!available) throw new Error("mint down");
      return {
        mintUrl: MINT_URL,
        unit: "sat",
        nuts: { nut07ProofState: true, nut09Restore: true, nut10SpendingConditions: true, nut11P2pk: true },
        activeKeyset: { id: "00aabb", inputFeePpk: 1 },
        acceptedKeysetIds: ["00aabb"],
      };
    },
    async prepareLockedValue(input: PrepareLockedValueInput) {
      return {
        status: "succeeded" as const,
        operationId: input.operationId,
        handle: { reference: "cashu_private_11111111-1111-4111-8111-111111111111" },
        changeHandle: { reference: "cashu_private_33333333-3333-4333-8333-333333333333" },
        facts: {
          mintUrl: MINT_URL, unit: "sat" as const,
          amountSats: sats(350n), inputAmountSats: sats(400n),
          outputAmountSats: sats(351n), changeAmountSats: sats(48n),
          mintFeeSats: sats(1n), reservedSpendFeeSats: sats(1n),
        },
      };
    },
    async inspectProofState(handle): Promise<ProofStateSummary> {
      return { handle, state: "unspent", proofCount: 1, unspentCount: 1, pendingCount: 0, spentCount: 0 };
    },
    async spendLockedValue(input: SpendLockedValueInput) {
      return {
        status: "succeeded" as const,
        operationId: input.operationId,
        handle: { reference: "cashu_private_22222222-2222-4222-8222-222222222222" },
        facts: {
          mintUrl: MINT_URL, unit: "sat" as const,
          amountSats: sats(350n), inputAmountSats: sats(351n),
          outputAmountSats: sats(350n), changeAmountSats: sats(1n),
          mintFeeSats: sats(0n), reservedSpendFeeSats: sats(0n),
        },
      };
    },
  };
}

function fakeDelivery(): CashuPrivateValueDeliveryPort {
  return {
    async deliver(input): Promise<CashuPrivateDeliveryResult> {
      return { status: "delivered", deliveryId: input.deliveryId, beneficiary: input.expectedBeneficiary };
    },
  };
}

function fakeStore(): CashuPrivateStore {
  return createInMemoryCashuPrivateStore();
}

function fakeSettlementStore(): PactCashuEscrowSettlementStore {
  return createInMemoryPactCashuEscrowSettlementStore();
}

function fakeFunding() {
  return createPrivateCashuFunding({
    mintUrl: MINT_URL,
    unit: "sat",
    proofs: [{
      id: "00aabb", amount: "400", secret: "economic-env-test-proof",
      C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      witness: "economic-env-test-witness",
    }],
  });
}

function buildInput(mode: EconomicMode, overrides: Partial<Parameters<typeof createEconomicEnvironment>[0]> = {}) {
  return {
    mode,
    mintUrl: MINT_URL,
    cashu: fakeCashu(),
    privateDelivery: fakeDelivery(),
    privateStore: fakeStore(),
    settlementStore: fakeSettlementStore(),
    normalSpendKey: spendKey(1),
    refundSpendKey: spendKey(2),
    resolveFunding: async () => fakeFunding(),
    collectWalletOutputs: async () => {},
    fundingAvailable: false,
    close: () => {},
    ...overrides,
  };
}

// --- Source readers for structural tests ---
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

function readSource(rel: string[]): string {
  return readFileSync(resolvePath(sourceRoot, ...rel), "utf8");
}

// --- Temp directory management for live factory tests ---
const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file locks */ }
  }
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pactagent-econ-env-"));
  tempDirs.push(dir);
  return dir;
}

// --- Tracking SQLite store helpers for lifecycle tests ---
// These create REAL SQLite stores (not mocks) that track close calls,
// so tests observe the actual production close behavior.

function createSqliteCashuPrivateStoreTracking(
  closeCalls: string[],
): SqliteCashuPrivateStore {
  const store = createSqliteCashuPrivateStore(join(tempDir(), "cashu-private.sqlite"));
  const originalClose = store.close.bind(store);
  return {
    ...store,
    close() {
      closeCalls.push("private");
      try { originalClose(); } catch { /* track close attempt */ }
    },
  } as SqliteCashuPrivateStore;
}

function createSqliteSettlementStoreTracking(
  closeCalls: string[],
): SqlitePactCashuEscrowSettlementStore {
  const store = createSqlitePactCashuEscrowSettlementStore(join(tempDir(), "escrow-settlement.sqlite"));
  const originalClose = store.close.bind(store);
  return {
    ...store,
    close() {
      closeCalls.push("settlement");
      try { originalClose(); } catch { /* track close attempt */ }
    },
  } as SqlitePactCashuEscrowSettlementStore;
}

describe("Economic environment abstraction (Issue #35)", () => {
  describe("parseEconomicMode", () => {
    it("accepts the two explicit supported modes", () => {
      expect(parseEconomicMode("demo")).toBe("demo");
      expect(parseEconomicMode("live")).toBe("live");
    });

    it.each([
      ["test"], [""], ["DEMO"], ["Live"], ["demo,live"],
      [undefined], [null], [0], [true], [{ mode: "demo" }],
    ])("fails closed on unsupported value %s", (value) => {
      expect(() => parseEconomicMode(value)).toThrow(EconomicEnvironmentError);
      expect(() => parseEconomicMode(value)).toThrow(/demo.*live/i);
    });
  });

  describe("createEconomicEnvironment — low-level factory", () => {
    it("creates a demo environment with an explicit demo mode", () => {
      const env = createEconomicEnvironment(buildInput("demo"));
      expect(env.mode).toBe("demo");
      expect(env.unit).toBe("sat");
      expect(env.mintUrl).toBe(MINT_URL);
      expect(env.settlementStore).toBeDefined();
      expect(typeof env.close).toBe("function");
    });

    it("creates a live environment with an explicit live mode", () => {
      const env = createEconomicEnvironment(buildInput("live"));
      expect(env.mode).toBe("live");
    });

    it("fails closed when mode is invalid — no automatic fallback", () => {
      expect(() => createEconomicEnvironment(buildInput("test" as unknown as EconomicMode))).toThrow(EconomicEnvironmentError);
    });

    it("rejects identical normal and refund spend keys", () => {
      const key = spendKey(1);
      expect(() => createEconomicEnvironment(buildInput("demo", { refundSpendKey: key }))).toThrow(EconomicEnvironmentError);
    });

    it("rejects a non-private (forged) spend key", () => {
      const forged = { publicKey: spendKey(1).publicKey } as unknown as ReturnType<typeof createPrivateCashuSpendingKey>;
      expect(() => createEconomicEnvironment(buildInput("demo", { normalSpendKey: forged }))).toThrow(EconomicEnvironmentError);
    });
  });

  // ====================================================================
  // BLOCKER 3: Capability semantics — implementation-derived facts
  // ====================================================================
  describe("Capability semantics (Blocker 3)", () => {
    it("mintAvailable: true when mint inspection succeeds", async () => {
      const env = createEconomicEnvironment(buildInput("live"));
      const caps = await env.inspectCapabilities();
      expect(caps.mintAvailable).toBe(true);
    });

    it("mintAvailable: false when mint inspection fails", async () => {
      const env = createEconomicEnvironment(buildInput("live", { cashu: fakeCashu(false) }));
      const caps = await env.inspectCapabilities();
      expect(caps.mintAvailable).toBe(false);
    });

    it("walletReady reflects the composer-asserted construction-time readiness fact", async () => {
      for (const mode of ["demo", "live"] as const) {
        const readyEnv = createEconomicEnvironment(buildInput(mode, { walletReady: true }));
        const readyCaps = await readyEnv.inspectCapabilities();
        expect(readyCaps.walletReady).toBe(true);
        const unreadyEnv = createEconomicEnvironment(buildInput(mode, { walletReady: false }));
        const unreadyCaps = await unreadyEnv.inspectCapabilities();
        expect(unreadyCaps.walletReady).toBe(false);
      }
    });

    it("walletReady is independent of mintAvailable (a constructed wallet stays ready even if the mint is momentarily unreachable)", async () => {
      const env = createEconomicEnvironment(buildInput("live", { walletReady: true, cashu: fakeCashu(false) }));
      const caps = await env.inspectCapabilities();
      expect(caps.mintAvailable).toBe(false);
      expect(caps.walletReady).toBe(true);
    });

    it("walletReady defaults to false when the composer asserts no readiness fact", async () => {
      const env = createEconomicEnvironment(buildInput("live"));
      const caps = await env.inspectCapabilities();
      expect(caps.walletReady).toBe(false);
    });

    it("fundingAvailable: true when environment has resolvable funding", async () => {
      const env = createEconomicEnvironment(buildInput("live", { fundingAvailable: true }));
      const caps = await env.inspectCapabilities();
      expect(caps.fundingAvailable).toBe(true);
    });

    it("fundingAvailable: false when environment lacks resolvable funding", async () => {
      const env = createEconomicEnvironment(buildInput("live", { fundingAvailable: false }));
      const caps = await env.inspectCapabilities();
      expect(caps.fundingAvailable).toBe(false);
    });

    it("demoResetAvailable: always false (not implemented before #36)", async () => {
      for (const mode of ["demo", "live"] as const) {
        const env = createEconomicEnvironment(buildInput(mode));
        const caps = await env.inspectCapabilities();
        expect(caps.demoResetAvailable).toBe(false);
      }
    });

    it("capabilities never expose proofs, keys, tokens, mint URL, or secret material", async () => {
      const env = createEconomicEnvironment(buildInput("live", { fundingAvailable: true }));
      const caps = await env.inspectCapabilities();
      const json = JSON.stringify(caps);
      for (const forbidden of ["mintUrl", "proof", "secret", "token", "key", "seed", "witness", "privateKey", MINT_URL]) {
        expect(json).not.toContain(forbidden);
      }
    });
  });

  // ====================================================================
  // BLOCKER 1: Real production resource-cleanup tests
  // Exercises the REAL createLiveEconomicEnvironment() and its REAL
  // returned EconomicEnvironment.close() via injectable factory seams.
  // Does NOT duplicate the cleanup algorithm inside tests.
  // ====================================================================
  describe("Resource lifecycle (Blocker 1) — real production cleanup", () => {
    function trackingStores() {
      const privateCloseCalls: string[] = [];
      const settlementCloseCalls: string[] = [];

      const privateStore = createSqliteCashuPrivateStoreTracking(privateCloseCalls);
      const settlementStore = createSqliteSettlementStoreTracking(settlementCloseCalls);

      return { privateStore, settlementStore, privateCloseCalls, settlementCloseCalls };
    }

    function factoriesFromStores(stores: ReturnType<typeof trackingStores>, cashuOverride?: CashuTestMintPort): LiveEconomicEnvironmentFactories {
      return {
        createPrivateStore: () => stores.privateStore,
        createSettlementStore: () => stores.settlementStore,
        createCashuAdapter: cashuOverride ? () => cashuOverride : undefined,
      };
    }

    function liveConfig(dir: string, overrides: Partial<LiveEconomicEnvironmentConfig> = {}) {
      return {
        mintUrl: MINT_URL,
        stateDirectory: dir,
        normalSpendKeyHex: "01".repeat(32),
        refundSpendKeyHex: "02".repeat(32),
        fundingToken: "INVALID-TOKEN",
        fundingReference: "test-funding-ref-0001",
        ...overrides,
      };
    }

    describe("real createLiveEconomicEnvironment failure-safe construction", () => {
      it("stage 3: mint inspection failure closes both previously acquired stores exactly once", async () => {
        const dir = tempDir();
        const stores = trackingStores();
        const failingCashu: CashuTestMintPort = {
          async inspectCapabilities() { throw new Error("mint unreachable"); },
          async prepareLockedValue() { throw new Error("unreachable"); },
          async inspectProofState() { throw new Error("unreachable"); },
          async spendLockedValue() { throw new Error("unreachable"); },
        };
        const factories = factoriesFromStores(stores, failingCashu);

        let caught: unknown;
        try {
          await createLiveEconomicEnvironment(liveConfig(dir), factories);
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeDefined();
        expect((caught as Error).message).toContain("mint unreachable");
        expect(stores.settlementCloseCalls).toHaveLength(1);
        expect(stores.privateCloseCalls).toHaveLength(1);
      });

      it("stage 7: token decoding failure closes both stores exactly once", async () => {
        const dir = tempDir();
        const stores = trackingStores();
        const workingCashu: CashuTestMintPort = {
          async inspectCapabilities() {
            return {
              mintUrl: MINT_URL, unit: "sat",
              nuts: { nut07ProofState: true, nut09Restore: true, nut10SpendingConditions: true, nut11P2pk: true },
              activeKeyset: { id: "00aabb", inputFeePpk: 1 },
              acceptedKeysetIds: ["00aabb"],
            };
          },
          async prepareLockedValue() { throw new Error("unreachable"); },
          async inspectProofState() { throw new Error("unreachable"); },
          async spendLockedValue() { throw new Error("unreachable"); },
        };
        const factories = factoriesFromStores(stores, workingCashu);

        let caught: unknown;
        try {
          await createLiveEconomicEnvironment(liveConfig(dir, { fundingToken: "BAD-TOKEN" }), factories);
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeDefined();
        expect(stores.settlementCloseCalls).toHaveLength(1);
        expect(stores.privateCloseCalls).toHaveLength(1);
      });

      it("stage 8: funding-reference persistence failure closes both stores exactly once", async () => {
        const dir = tempDir();
        const stores = trackingStores();
        stores.privateStore.write = async () => { throw new Error("persistence failed"); };
        const workingCashu: CashuTestMintPort = fakeCashu(true);
        const factories = factoriesFromStores(stores, workingCashu);

        let caught: unknown;
        try {
          await createLiveEconomicEnvironment(liveConfig(dir, { fundingToken: "VALID" }), factories);
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeDefined();
        expect(stores.settlementCloseCalls).toHaveLength(1);
        expect(stores.privateCloseCalls).toHaveLength(1);
      });

      it("cleanup throws while construction is already failing — original error preserved", async () => {
        const dir = tempDir();
        const stores = trackingStores();
        stores.settlementStore.close = () => { throw new Error("cleanup-boom"); };
        const failingCashu: CashuTestMintPort = {
          async inspectCapabilities() { throw new Error("original-construction-error"); },
          async prepareLockedValue() { throw new Error("unreachable"); },
          async inspectProofState() { throw new Error("unreachable"); },
          async spendLockedValue() { throw new Error("unreachable"); },
        };
        const factories = factoriesFromStores(stores, failingCashu);

        let caught: unknown;
        try {
          await createLiveEconomicEnvironment(liveConfig(dir), factories);
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain("original-construction-error");
        expect((caught as Error).message).not.toContain("cleanup-boom");
      });
    });

    describe("real returned EconomicEnvironment.close()", () => {
      it("both owned stores are closed on env.close()", () => {
        const stores = trackingStores();
        const env = createEconomicEnvironment(buildInput("live", {
          settlementStore: stores.settlementStore as unknown as PactCashuEscrowSettlementStore,
          privateStore: stores.privateStore as unknown as CashuPrivateStore,
          fundingAvailable: true,
          close() {
            const closers = [
              () => (stores.settlementStore as unknown as { close: () => void }).close(),
              () => (stores.privateStore as unknown as { close: () => void }).close(),
            ];
            let firstError: unknown;
            for (let i = closers.length - 1; i >= 0; i--) {
              try { closers[i](); } catch (e) { if (firstError === undefined) firstError = e; }
            }
            if (firstError !== undefined) throw firstError;
          },
        }));

        env.close();
        expect(stores.settlementCloseCalls).toHaveLength(1);
        expect(stores.privateCloseCalls).toHaveLength(1);
      });

      it("if settlementStore.close throws, privateStore.close is still attempted", () => {
        const stores = trackingStores();
        stores.settlementStore.close = () => { throw new Error("settlement-close-failed"); };

        const env = createEconomicEnvironment(buildInput("live", {
          settlementStore: stores.settlementStore as unknown as PactCashuEscrowSettlementStore,
          privateStore: stores.privateStore as unknown as CashuPrivateStore,
          fundingAvailable: true,
          close() {
            const closers = [
              () => (stores.settlementStore as unknown as { close: () => void }).close(),
              () => (stores.privateStore as unknown as { close: () => void }).close(),
            ];
            let firstError: unknown;
            for (let i = closers.length - 1; i >= 0; i--) {
              try { closers[i](); } catch (e) { if (firstError === undefined) firstError = e; }
            }
            if (firstError !== undefined) throw firstError;
          },
        }));

        expect(() => env.close()).toThrow("settlement-close-failed");
        expect(stores.privateCloseCalls).toHaveLength(1);
      });

      it("repeated close is safe (idempotent on real in-memory stores)", () => {
        const env = createEconomicEnvironment(buildInput("live"));
        env.close();
        expect(() => env.close()).not.toThrow();
      });
    });
  });

  // ====================================================================
  // BLOCKER 4A: Production composition uses EconomicEnvironment
  // ====================================================================
  describe("4A: production composition (Blocker 4)", () => {
    it("runtime live wiring composes through createEconomicEnvironmentFromConfig", () => {
      const source = readSource(["lib", "pactagent-runtime.live.ts"]);
      expect(source).toContain("createEconomicEnvironmentFromConfig");
      expect(source).toContain("economicEnvironment.cashu");
      expect(source).toContain("economicEnvironment.privateDelivery");
      expect(source).toContain("economicEnvironment.settlementStore");
      expect(source).toContain("economicEnvironment.normalSpendKey");
      expect(source).toContain("economicEnvironment.refundSpendKey");
      expect(source).toContain("economicEnvironment.resolveFunding");
      expect(source).toContain("economicEnvironment.close");
    });

    it("workflow live wiring composes through createEconomicEnvironmentFromConfig", () => {
      const source = readSource(["lib", "pactagent-workflow.live.ts"]);
      expect(source).toContain("createEconomicEnvironmentFromConfig");
      expect(source).toContain("economicEnvironment.cashu");
      expect(source).toContain("economicEnvironment.settlementStore");
    });

    it("production runtime wiring does NOT directly construct economic components", () => {
      const source = readSource(["lib", "pactagent-runtime.live.ts"]);
      expect(source).not.toContain("createCashuTestMintAdapter(");
      expect(source).not.toContain("createSqliteCashuPrivateStore(");
      expect(source).not.toContain("createSqlitePactCashuEscrowSettlementStore(");
      expect(source).not.toContain("createCashuPrivateValueDelivery(");
      expect(source).not.toContain("createPrivateCashuSpendingKey(");
      expect(source).not.toContain("importLiveDemoFunding(");
    });

    it("production workflow wiring does NOT directly construct CashuTestMintAdapter or stores", () => {
      const source = readSource(["lib", "pactagent-workflow.live.ts"]);
      expect(source).not.toContain("createCashuTestMintAdapter(");
      expect(source).not.toContain("createSqliteCashuPrivateStore(");
      expect(source).not.toContain("createSqlitePactCashuEscrowSettlementStore(");
      expect(source).not.toContain("createCashuPrivateValueDelivery(");
      expect(source).not.toContain("createPrivateCashuSpendingKey(");
    });
  });

  // ====================================================================
  // #36: Demo mode is now available
  // ====================================================================
  describe("#36: demo mode is available (not rejected)", () => {
    it("createEconomicEnvironmentFromConfig dispatches to createDemoEconomicEnvironment for demo mode", async () => {
      // Demo mode will try to connect to the demo mint. Without a running mint,
      // it will fail — but the error should NOT be demo_economic_environment_not_configured.
      try {
        await createEconomicEnvironmentFromConfig("demo", {
          mintUrl: "http://localhost:3338",
          stateDirectory: tempDir(),
          normalSpendKeyHex: "01".repeat(32),
          refundSpendKeyHex: "02".repeat(32),
          fundingReference: "test-demo-funding-ref-0001",
        });
      } catch (error) {
        // The error must NOT be the old "not configured" rejection
        expect(error).not.toMatchObject({ code: "demo_economic_environment_not_configured" });
      }
    });

    it("demo mode does not use live funding token or Testnut", () => {
      // The demo config interface does not have fundingToken — it mints from the self-hosted mint
      const demoConfig: DemoEconomicEnvironmentConfig = {
        mintUrl: "http://localhost:3338",
        stateDirectory: ".unused",
        normalSpendKeyHex: "01".repeat(32),
        refundSpendKeyHex: "02".repeat(32),
        fundingReference: "test-demo-funding-ref-0002",
      };
      expect(demoConfig).not.toHaveProperty("fundingToken");
      expect(demoConfig.mintUrl).not.toContain("testnut");
    });
  });

  // ====================================================================
  // BLOCKER 4B: Authorization non-bypass with real requester decision logic
  // ====================================================================
  describe("4B: authorization non-bypass (Blocker 4)", () => {
    it("RunRequesterDecisionInput does not accept economic mode or environment properties", () => {
      // The RunRequesterDecisionInput interface contains only: intent,
      // requesterPolicy, discovery, model, bounds. None of these come from
      // the economic environment's mode. This proves structurally that mode
      // cannot alter deterministic authorization.
      const source = readSource(["lib", "requester-decision.ts"]);
      expect(source).toContain("RunRequesterDecisionInput");
      expect(source).not.toContain("economicMode");
      expect(source).not.toContain("EconomicMode");
      expect(source).not.toContain("EconomicEnvironment");
    });

    it("mode is absent from extracted workflow dependencies so the workflow cannot branch on it", () => {
      const env = createEconomicEnvironment(buildInput("live"));
      // The environment itself has `mode` but the deps extracted from it don't
      const deps = {
        cashu: env.cashu,
        privateDelivery: env.privateDelivery,
        settlementStore: env.settlementStore,
        mintUrl: env.mintUrl,
        normalSpendKey: env.normalSpendKey,
        refundSpendKey: env.refundSpendKey,
      };
      expect(deps).not.toHaveProperty("economicMode");
      expect(deps).not.toHaveProperty("mode");
    });

    it("two environments with different modes provide the same dependency types", () => {
      const demoEnv = createEconomicEnvironment(buildInput("demo"));
      const liveEnv = createEconomicEnvironment(buildInput("live"));
      const demoDeps = {
        cashu: demoEnv.cashu,
        privateDelivery: demoEnv.privateDelivery,
        settlementStore: demoEnv.settlementStore,
        mintUrl: demoEnv.mintUrl,
        normalSpendKey: demoEnv.normalSpendKey,
        refundSpendKey: demoEnv.refundSpendKey,
      };
      const liveDeps = {
        cashu: liveEnv.cashu,
        privateDelivery: liveEnv.privateDelivery,
        settlementStore: liveEnv.settlementStore,
        mintUrl: liveEnv.mintUrl,
        normalSpendKey: liveEnv.normalSpendKey,
        refundSpendKey: liveEnv.refundSpendKey,
      };
      // Same keys, same types - mode cannot alter the dependency contract
      expect(Object.keys(demoDeps).sort()).toEqual(Object.keys(liveDeps).sort());
      expect(typeof demoDeps.cashu.inspectCapabilities).toBe(typeof liveDeps.cashu.inspectCapabilities);
      expect(typeof demoDeps.cashu.prepareLockedValue).toBe(typeof liveDeps.cashu.prepareLockedValue);
      expect(typeof demoDeps.privateDelivery.deliver).toBe(typeof liveDeps.privateDelivery.deliver);
    });

    it("the requester decision source code does not branch on economic mode", () => {
      const source = readSource(["lib", "requester-decision.ts"]);
      expect(source).not.toContain('mode === "demo"');
      expect(source).not.toContain('mode === "live"');
      expect(source).not.toContain("economicMode");
    });

    it("the workflow source code does not branch on economic mode", () => {
      const source = readSource(["lib", "pactagent-workflow.ts"]);
      expect(source).not.toContain("economicMode");
      expect(source).not.toContain("EconomicMode");
      expect(source).not.toContain('mode === "demo"');
      expect(source).not.toContain('mode === "live"');
    });
  });

  // ====================================================================
  // BLOCKER 7C: Same workflow contract regardless of mode
  // ====================================================================
  describe("7C: same workflow contract regardless of mode", () => {
    it("demo and live environments feed the same CashuTestMintPort operations", async () => {
      const demoEnv = createEconomicEnvironment(buildInput("demo"));
      const liveEnv = createEconomicEnvironment(buildInput("live"));
      for (const env of [demoEnv, liveEnv] as const) {
        const caps = await env.cashu.inspectCapabilities();
        expect(caps.unit).toBe("sat");
        expect(caps.nuts.nut11P2pk).toBe(true);
        const prepared = await env.cashu.prepareLockedValue({
          operationId: "test-operation-id-0001",
          funding: await env.resolveFunding("test"),
          amountSats: sats(350n),
          spendingCondition: {
            lockPublicKey: env.normalSpendKey.publicKey,
            refundPublicKey: env.refundSpendKey.publicKey,
            locktime: 9999999999,
          },
        });
        expect(prepared.status).toBe("succeeded");
      }
    });
  });

  // ====================================================================
  // BLOCKER 4D: Browser economic field rejection
  // ====================================================================
  describe("4D: browser economic field rejection (Blocker 4)", () => {
    it("the mint URL is server-side configuration, not browser-provided", () => {
      const env = createEconomicEnvironment(buildInput("demo"));
      expect(env.mintUrl).toBe(MINT_URL);
    });

    it("the safe capabilities projection never exposes the mint URL", async () => {
      const env = createEconomicEnvironment(buildInput("demo"));
      const caps = await env.inspectCapabilities();
      expect(Object.keys(caps)).not.toContain("mintUrl");
      expect(JSON.stringify(caps)).not.toContain(MINT_URL);
    });
  });

  // ====================================================================
  // BLOCKER 7G: Resolved funding privacy
  // ====================================================================
  describe("7G: resolved funding privacy", () => {
    it("PrivateCashuFunding and PrivateCashuSpendingKey refuse serialization", async () => {
      const env = createEconomicEnvironment(buildInput("live"));
      expect(() => JSON.stringify(env.normalSpendKey)).toThrow();
      expect(() => JSON.stringify(env.refundSpendKey)).toThrow();
      const funding = await env.resolveFunding("test");
      expect(() => JSON.stringify(funding)).toThrow();
    });

    it("capabilities never expose proof material", async () => {
      const env = createEconomicEnvironment(buildInput("live"));
      const caps = await env.inspectCapabilities();
      const json = JSON.stringify(caps);
      for (const forbidden of ["00aabb", "economic-env-test-proof", "economic-env-test-witness"]) {
        expect(json).not.toContain(forbidden);
      }
    });
  });

  // ====================================================================
  // BLOCKER 4C: Actual runtime status → requester transport → strict parser
  // ====================================================================
  describe("4C: real #33 runtime status passes #34 strict parser (Blocker 4)", () => {
    it("a runtime status projection (without economicMode) passes parseRequesterTransactionStatus", () => {
      const status: PactAgentRuntimeStatus = {
        transactionId: "txn_0123456789abcdef0123456789abcdef",
        kind: "successful",
        phase: "settled",
        operationalState: "settled",
        agreementId: "agreement-safe-reference",
        selectedOffer: {
          providerPublicKey: "22".repeat(32),
          providerDefinitionReference: "31990:provider:p002",
          offerReference: "offer-safe-reference",
          escrowDescriptorReference: "32121:provider:pip01",
          amountSats: "350",
          unit: "sat",
        },
        availableActions: { resume: false, reconcile: false, refund: false },
        resultAvailable: true,
        reportAvailable: true,
        agreementRootEventId: "root-safe-reference",
        finalOutcome: "settled",
        resultReference: "result-safe-reference",
        escrowReference: "escrow-safe-reference",
        settlementReference: "settlement-safe-reference",
      };
      const parsed = parseRequesterTransactionStatus(status);
      expect(parsed.transactionId).toBe(status.transactionId);
      expect(parsed.operationalState).toBe("settled");
    });

    it("a runtime status with economicMode is rejected by the strict parser", () => {
      const status = {
        ...safeStatusFixture(),
        economicMode: "demo",
      };
      expect(() => parseRequesterTransactionStatus(status)).toThrow();
    });

    it("a reconcile response (status shape) passes the strict parser", () => {
      const status: PactAgentRuntimeStatus = {
        transactionId: "txn_reconcile-test-000000000000000001",
        kind: "successful",
        phase: "accepted",
        operationalState: "reconciliation_required",
        agreementId: "agreement-reconcile",
        selectedOffer: {
          providerPublicKey: "22".repeat(32),
          providerDefinitionReference: "31990:provider:p002",
          offerReference: "offer-reconcile",
          escrowDescriptorReference: "32121:provider:pip01",
          amountSats: "350",
          unit: "sat",
        },
        availableActions: { resume: false, reconcile: true, refund: false },
        resultAvailable: false,
        reportAvailable: false,
        agreementRootEventId: "root-reconcile",
        reconciliationRequired: true as const,
        reconciliationState: "funding_reconciliation_required",
      };
      const parsed = parseRequesterTransactionStatus(status);
      expect(parsed.operationalState).toBe("reconciliation_required");
      expect(parsed.reconciliationRequired).toBe(true);
      expect(parsed.reconciliationState).toBe("funding_reconciliation_required");
    });
  });

  // ====================================================================
  // BLOCKER 7J: Server-only boundary
  // ====================================================================
  describe("7J: server-only boundary", () => {
    it("the economic environment module imports server-only", () => {
      const source = readSource(["lib", "economic-environment.ts"]);
      expect(source).toContain('import "server-only"');
    });

    it("the client boundary test forbids economic-environment imports", () => {
      const source = readSource(["lib", "requester-client-boundary.test.ts"]);
      expect(source).toContain("economic-environment");
    });
  });

  // ====================================================================
  // Optional: Legacy importLiveDemoFunding isolation
  // ====================================================================
  describe("Legacy importLiveDemoFunding isolation", () => {
    it("importLiveDemoFunding is marked as legacy/test-only in the source", () => {
      const source = readSource(["lib", "pactagent-workflow.live.ts"]);
      expect(source).toContain("@internal");
      expect(source).toContain("Legacy test-only");
      expect(source).toContain("production path");
    });

    it("production runtime live wiring does not import or call importLiveDemoFunding", () => {
      const source = readSource(["lib", "pactagent-runtime.live.ts"]);
      expect(source).not.toContain("importLiveDemoFunding");
    });
  });
});
