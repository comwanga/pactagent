import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckStateEnum, MintQuoteState, serializeProofs, type Proof } from "@cashu/cashu-ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBoundedCashuWallet,
  createSqliteCashuPrivateStore,
  type CashuTestMintPort,
  type SqliteCashuPrivateStore,
} from "./cashu-test-mint";
import { fakeProof, FAKE_KEYSET_ID } from "./cashu-test-fixture";
import {
  createDemoEconomicEnvironment,
  type DemoEconomicEnvironmentConfig,
  type LiveEconomicEnvironmentFactories,
} from "./economic-environment";

const MINT_URL = "http://127.0.0.1:3338";
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pactagent-wallet-remediation-"));
  directories.push(directory);
  return directory;
}

function config(stateDirectory: string): DemoEconomicEnvironmentConfig {
  return {
    mintUrl: MINT_URL,
    stateDirectory,
    normalSpendKeyHex: "61".repeat(32),
    refundSpendKeyHex: "62".repeat(32),
    fundingReference: "legacy-demo-reference-unused",
    initialBalanceSats: 1000,
  };
}

function cashuPort(): CashuTestMintPort {
  return {
    async inspectCapabilities() {
      return {
        mintUrl: MINT_URL,
        unit: "sat",
        nuts: {
          nut07ProofState: true,
          nut09Restore: true,
          nut10SpendingConditions: true,
          nut11P2pk: true,
        },
        activeKeyset: { id: FAKE_KEYSET_ID, inputFeePpk: 0 },
        acceptedKeysetIds: [FAKE_KEYSET_ID],
      };
    },
    async prepareLockedValue() { throw new Error("not exercised"); },
    async inspectProofState() { throw new Error("not exercised"); },
    async spendLockedValue() { throw new Error("not exercised"); },
  };
}

function proofWallet(options: {
  readonly onMint?: () => void;
  readonly proofs?: readonly Proof[];
} = {}) {
  let quoteSequence = 0;
  const wallet = {
    loadMint: vi.fn(async () => undefined),
    createMintQuote: vi.fn(async () => ({ quote: `quote-${++quoteSequence}` })),
    checkMintQuote: vi.fn(async () => ({ state: MintQuoteState.PAID })),
    mintProofsBolt11: vi.fn(async () => {
      options.onMint?.();
      return [...(options.proofs ?? [fakeProof(1000n, "demo-allocation")])];
    }),
    checkProofsStates: vi.fn(async (proofs: readonly Proof[]) =>
      proofs.map(() => ({ state: CheckStateEnum.UNSPENT }))),
  };
  return wallet as unknown as ReturnType<typeof createBoundedCashuWallet>;
}

function factories(
  wallet: ReturnType<typeof createBoundedCashuWallet>,
  privateStore?: SqliteCashuPrivateStore,
): LiveEconomicEnvironmentFactories {
  return {
    ...(privateStore === undefined ? {} : { createPrivateStore: () => privateStore }),
    createCashuAdapter: () => cashuPort(),
    createDemoProofWallet: () => wallet,
  };
}

function interceptingStore(
  base: SqliteCashuPrivateStore,
  beforeWrite: (scope: string, key: string, value: unknown) => void,
): SqliteCashuPrivateStore {
  return {
    read: base.read.bind(base),
    async write(scope, key, value) {
      beforeWrite(scope, key, value);
      await base.write(scope, key, value);
    },
    withExclusiveLock: base.withExclusiveLock.bind(base),
    close: base.close.bind(base),
  };
}

describe("Issue #37 remediation: provisioning and generation authority", () => {
  it("retries safely when a crash occurs before mint submission", async () => {
    const stateDirectory = temporaryDirectory();
    const baseStore = createSqliteCashuPrivateStore(join(stateDirectory, "cashu-private.sqlite"));
    let failBeforeSubmission = true;
    const store = interceptingStore(baseStore, (scope, _key, value) => {
      if (
        scope === "demo-wallet-provisioning" &&
        (value as { state?: unknown }).state === "mint_submitting" &&
        failBeforeSubmission
      ) {
        failBeforeSubmission = false;
        throw new Error("injected crash before mint submission");
      }
    });
    const wallet = proofWallet();
    const env = await createDemoEconomicEnvironment(config(stateDirectory), factories(wallet, store));
    try {
      await expect(env.startDemoWallet!("session-wallet-before-submit")).rejects.toThrow();
      expect(wallet.mintProofsBolt11).not.toHaveBeenCalled();
      const completed = await env.startDemoWallet!("session-wallet-before-submit");
      expect(completed.generation).toBe(1);
      expect(wallet.createMintQuote).toHaveBeenCalledTimes(1);
      expect(wallet.mintProofsBolt11).toHaveBeenCalledTimes(1);
      const responseLossRetry = await env.startDemoWallet!("session-wallet-before-submit");
      expect(responseLossRetry).toEqual(completed);
      expect(wallet.mintProofsBolt11).toHaveBeenCalledTimes(1);
    } finally {
      env.close();
    }
  });

  it("fails closed after uncertain mint success and never creates a replacement quote", async () => {
    const stateDirectory = temporaryDirectory();
    const baseStore = createSqliteCashuPrivateStore(join(stateDirectory, "cashu-private.sqlite"));
    let externalMintSucceeded = false;
    let injectFailure = true;
    const store = interceptingStore(baseStore, (scope, _key, value) => {
      if (
        scope === "demo-wallet-provisioning" &&
        externalMintSucceeded &&
        (value as { state?: unknown }).state === "token_persisted" &&
        injectFailure
      ) throw new Error("injected crash after external mint success");
    });
    const wallet = proofWallet({ onMint: () => { externalMintSucceeded = true; } });
    const env = await createDemoEconomicEnvironment(config(stateDirectory), factories(wallet, store));
    try {
      await expect(env.startDemoWallet!("session-wallet-uncertain"))
        .rejects.toMatchObject({ code: "demo_provisioning_reconciliation_required" });
      expect(wallet.createMintQuote).toHaveBeenCalledTimes(1);
      expect(wallet.mintProofsBolt11).toHaveBeenCalledTimes(1);
      injectFailure = false;
      await expect(env.startDemoWallet!("session-wallet-uncertain"))
        .rejects.toMatchObject({ code: "demo_provisioning_reconciliation_required" });
      expect(wallet.createMintQuote).toHaveBeenCalledTimes(1);
      expect(wallet.mintProofsBolt11).toHaveBeenCalledTimes(1);
    } finally {
      env.close();
    }
  });

  it("applies the same fail-closed uncertainty boundary to Reset", async () => {
    const stateDirectory = temporaryDirectory();
    const baseStore = createSqliteCashuPrivateStore(join(stateDirectory, "cashu-private.sqlite"));
    let resetMintSucceeded = false;
    let injectFailure = true;
    const store = interceptingStore(baseStore, (scope, _key, value) => {
      const record = value as { operation?: unknown; state?: unknown };
      if (
        scope === "demo-wallet-provisioning" &&
        record.operation === "reset" &&
        record.state === "token_persisted" &&
        resetMintSucceeded &&
        injectFailure
      ) throw new Error("injected Reset crash after external mint success");
    });
    let mintCalls = 0;
    const wallet = proofWallet({ onMint: () => {
      mintCalls += 1;
      if (mintCalls > 1) resetMintSucceeded = true;
    } });
    const env = await createDemoEconomicEnvironment(config(stateDirectory), factories(wallet, store));
    try {
      await env.startDemoWallet!("session-wallet-reset-uncertain");
      await expect(env.resetDemoWallet!("session-wallet-reset-uncertain", "reset-uncertain-0001"))
        .rejects.toMatchObject({ code: "demo_provisioning_reconciliation_required" });
      injectFailure = false;
      await expect(env.resetDemoWallet!("session-wallet-reset-uncertain", "reset-uncertain-0001"))
        .rejects.toMatchObject({ code: "demo_provisioning_reconciliation_required" });
      await expect(env.resetDemoWallet!("session-wallet-reset-uncertain", "reset-new-intent-0002"))
        .rejects.toMatchObject({ code: "demo_provisioning_reconciliation_required" });
      expect(wallet.createMintQuote).toHaveBeenCalledTimes(2);
      expect(wallet.mintProofsBolt11).toHaveBeenCalledTimes(2);
    } finally {
      env.close();
    }
  });

  it("recovers token-persisted provisioning locally without a second mint", async () => {
    const stateDirectory = temporaryDirectory();
    const baseStore = createSqliteCashuPrivateStore(join(stateDirectory, "cashu-private.sqlite"));
    let failFundingPersistence = true;
    const store = interceptingStore(baseStore, (scope) => {
      if (scope === "demo-funding" && failFundingPersistence) {
        failFundingPersistence = false;
        throw new Error("injected crash after token persistence");
      }
    });
    const wallet = proofWallet();
    const env = await createDemoEconomicEnvironment(config(stateDirectory), factories(wallet, store));
    try {
      await expect(env.startDemoWallet!("session-wallet-token-persisted")).rejects.toThrow();
      expect(wallet.mintProofsBolt11).toHaveBeenCalledTimes(1);
      const recovered = await env.startDemoWallet!("session-wallet-token-persisted");
      expect(recovered.generation).toBe(1);
      expect(wallet.createMintQuote).toHaveBeenCalledTimes(1);
      expect(wallet.mintProofsBolt11).toHaveBeenCalledTimes(1);
    } finally {
      env.close();
    }
  });

  it("same reset identity converges while a new identity creates a new safe generation", async () => {
    const stateDirectory = temporaryDirectory();
    const wallet = proofWallet();
    const env = await createDemoEconomicEnvironment(config(stateDirectory), factories(wallet));
    await env.startDemoWallet!("session-wallet-reset-idempotency");
    const first = await env.resetDemoWallet!("session-wallet-reset-idempotency", "reset-intent-0001");
    const retry = await env.resetDemoWallet!("session-wallet-reset-idempotency", "reset-intent-0001");
    const next = await env.resetDemoWallet!("session-wallet-reset-idempotency", "reset-intent-0002");
    expect(first.generation).toBe(2);
    expect(retry).toEqual(first);
    expect(next.generation).toBe(3);
    expect(wallet.createMintQuote).toHaveBeenCalledTimes(3);
    env.close();
  });

  it("serializes concurrent same-key and different-key reset intents", async () => {
    const stateDirectory = temporaryDirectory();
    const wallet = proofWallet();
    const env = await createDemoEconomicEnvironment(config(stateDirectory), factories(wallet));
    try {
      const walletKey = "session-wallet-concurrent-reset";
      await env.startDemoWallet!(walletKey);
      const [sameA, sameB] = await Promise.all([
        env.resetDemoWallet!(walletKey, "reset-concurrent-same"),
        env.resetDemoWallet!(walletKey, "reset-concurrent-same"),
      ]);
      expect(sameA).toEqual(sameB);
      expect(sameA.generation).toBe(2);

      const [differentA, differentB] = await Promise.all([
        env.resetDemoWallet!(walletKey, "reset-concurrent-next-a"),
        env.resetDemoWallet!(walletKey, "reset-concurrent-next-b"),
      ]);
      expect([differentA.generation, differentB.generation].sort()).toEqual([3, 4]);
      expect(wallet.createMintQuote).toHaveBeenCalledTimes(4);
    } finally {
      env.close();
    }
  });

  it("serializes Start with transaction generation binding", async () => {
    const stateDirectory = temporaryDirectory();
    const wallet = proofWallet();
    const env = await createDemoEconomicEnvironment(config(stateDirectory), factories(wallet));
    try {
      const walletKey = "session-wallet-start-generation-race";
      const transactionId = "txn_start_generation_race_01";
      const [startResult, bindingResult] = await Promise.allSettled([
        env.startDemoWallet!(walletKey),
        env.bindDemoTransactionFunding!(walletKey, transactionId),
      ]);
      expect(startResult.status).toBe("fulfilled");
      if (bindingResult.status === "rejected") {
        expect(bindingResult.reason).toMatchObject({ code: "demo_wallet_not_started" });
      } else {
        expect(bindingResult.value.generation).toBe(1);
      }
      expect((await env.bindDemoTransactionFunding!(walletKey, transactionId)).generation).toBe(1);
      expect(wallet.createMintQuote).toHaveBeenCalledTimes(1);
    } finally {
      env.close();
    }
  });

  it("blocks reset for every bound nonterminal transaction even after UI state is closed", async () => {
    const stateDirectory = temporaryDirectory();
    const env = await createDemoEconomicEnvironment(config(stateDirectory), factories(proofWallet()));
    await env.startDemoWallet!("session-wallet-reset-exposure");
    await env.bindDemoTransactionFunding!("session-wallet-reset-exposure", "txn_bound_exposure_01");
    await expect(env.resetDemoWallet!("session-wallet-reset-exposure", "reset-intent-blocked"))
      .rejects.toMatchObject({ code: "demo_reset_blocked" });
    expect((await env.demoWalletStatus!("session-wallet-reset-exposure")).resetAvailable).toBe(false);
    env.close();
  });

  it("reports the authoritative initial proof value without inflation", async () => {
    const stateDirectory = temporaryDirectory();
    const repeatedProof = fakeProof(1000n, "same-proof");
    const env = await createDemoEconomicEnvironment(
      config(stateDirectory),
      factories(proofWallet({ proofs: [repeatedProof] })),
    );
    await env.startDemoWallet!("session-wallet-proof-dedup");
    const status = await env.demoWalletStatus!("session-wallet-proof-dedup");
    expect(status.availableSats).toBe(1000n);
    env.close();
  });

  it("durably retries failed terminal output collection exactly once", async () => {
    const stateDirectory = temporaryDirectory();
    const baseStore = createSqliteCashuPrivateStore(join(stateDirectory, "cashu-private.sqlite"));
    let failOwnerPersistence = false;
    const store = interceptingStore(baseStore, (scope) => {
      if (scope === "demo-wallet-handles" && failOwnerPersistence) {
        throw new Error("injected output owner persistence failure");
      }
    });
    const env = await createDemoEconomicEnvironment(
      config(stateDirectory),
      factories(proofWallet(), store),
    );
    try {
      const walletKey = "session-wallet-output-recovery";
      const transactionId = "txn_output_recovery_01";
      const escrowReference = "pactescrow_11111111-1111-4111-8111-111111111111";
      const handleReference = "cashu_private_22222222-2222-4222-8222-222222222222";
      await env.startDemoWallet!(walletKey);
      const binding = await env.bindDemoTransactionFunding!(walletKey, transactionId);
      // Adversarially repeat the exact initial proof under another handle.
      // Aggregation must count its proof identity once, not each reference.
      const outputProof = fakeProof(1000n, "demo-allocation");
      await env.privateStore.write(MINT_URL, `value:${handleReference}`, {
        version: 1,
        proofs: serializeProofs([outputProof]),
        amountSats: "1000",
        allowedPublicKeys: [],
      });
      await env.settlementStore.insert(`escrow:${escrowReference}`, {
        revision: 1,
        state: "settled",
        fundingChangeHandle: { reference: handleReference },
      });

      failOwnerPersistence = true;
      await expect(env.finalizeDemoTransaction!(
        binding.fundingReference,
        transactionId,
        "settled",
        escrowReference,
      )).rejects.toThrow("injected output owner persistence failure");
      expect((await env.demoWalletStatus!(walletKey)).accountingPending).toBe(true);

      env.close();
      failOwnerPersistence = false;
      const recoveredEnvironment = await createDemoEconomicEnvironment(
        config(stateDirectory),
        factories(proofWallet()),
      );
      try {
        const recovered = await recoveredEnvironment.demoWalletStatus!(walletKey);
        expect(recovered.accountingPending).toBe(false);
        expect(recovered.availableSats).toBe(1000n);
        await recoveredEnvironment.finalizeDemoTransaction!(
          binding.fundingReference,
          transactionId,
          "settled",
          escrowReference,
        );
        const generation = await recoveredEnvironment.privateStore.read(
          "demo-wallet-generations",
          `${walletKey}:1`,
        ) as { handleReferences: readonly string[] };
        expect(generation.handleReferences).toEqual([handleReference]);
      } finally {
        recoveredEnvironment.close();
      }
    } finally {
      env.close();
    }
  });

  it("rejects rebinding one private handle to another transaction", async () => {
    const stateDirectory = temporaryDirectory();
    const env = await createDemoEconomicEnvironment(config(stateDirectory), factories(proofWallet()));
    try {
      const walletKey = "session-wallet-handle-owner";
      const sharedHandle = "cashu_private_33333333-3333-4333-8333-333333333333";
      await env.startDemoWallet!(walletKey);
      await env.privateStore.write(MINT_URL, `value:${sharedHandle}`, {
        version: 1,
        proofs: serializeProofs([fakeProof(500n, "shared-handle")]),
        amountSats: "500",
        allowedPublicKeys: [],
      });
      const first = await env.bindDemoTransactionFunding!(walletKey, "txn_handle_owner_01");
      const firstEscrow = "pactescrow_44444444-4444-4444-8444-444444444444";
      await env.settlementStore.insert(`escrow:${firstEscrow}`, {
        revision: 1,
        state: "settled",
        fundingChangeHandle: { reference: sharedHandle },
      });
      await env.finalizeDemoTransaction!(first.fundingReference, "txn_handle_owner_01", "settled", firstEscrow);

      const second = await env.bindDemoTransactionFunding!(walletKey, "txn_handle_owner_02");
      const secondEscrow = "pactescrow_55555555-5555-4555-8555-555555555555";
      await env.settlementStore.insert(`escrow:${secondEscrow}`, {
        revision: 1,
        state: "settled",
        fundingChangeHandle: { reference: sharedHandle },
      });
      await expect(env.finalizeDemoTransaction!(
        second.fundingReference,
        "txn_handle_owner_02",
        "settled",
        secondEscrow,
      )).rejects.toMatchObject({ code: "economic_mode_conflict" });
    } finally {
      env.close();
    }
  });

  it("serializes Reset with transaction generation binding", async () => {
    const stateDirectory = temporaryDirectory();
    const env = await createDemoEconomicEnvironment(config(stateDirectory), factories(proofWallet()));
    try {
      const walletKey = "session-wallet-generation-race";
      await env.startDemoWallet!(walletKey);
      const [bindingResult, resetResult] = await Promise.allSettled([
        env.bindDemoTransactionFunding!(walletKey, "txn_generation_race_01"),
        env.resetDemoWallet!(walletKey, "reset-generation-race-01"),
      ]);
      expect(bindingResult.status).toBe("fulfilled");
      if (bindingResult.status !== "fulfilled") throw bindingResult.reason;
      if (resetResult.status === "fulfilled") {
        expect(bindingResult.value.generation).toBe(resetResult.value.generation);
      } else {
        expect(bindingResult.value.generation).toBe(1);
        expect(resetResult.reason).toMatchObject({ code: "demo_reset_blocked" });
      }
    } finally {
      env.close();
    }
  });
});
