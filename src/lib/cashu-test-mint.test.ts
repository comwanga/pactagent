import {
  CheckStateEnum,
  deserializeProofs,
  type P2PKOptions,
  type Proof,
} from "@cashu/cashu-ts";
import { describe, expect, it, vi } from "vitest";

import { sats } from "../domain/money";
import {
  CashuPrivateBackendError,
  CashuTestMintError,
  createCashuTestMintAdapterWithBackend,
  createInMemoryCashuPrivateStore,
  createPrivateCashuFunding,
  createPrivateCashuSpendingKey,
  normalizeCashuTestMintConfiguration,
  normalizeCashuPrivateProofState,
  type CashuMintCapabilitySnapshot,
  type CashuMintPrivateBackend,
  type CashuPrivatePreparedSwap,
  type CashuPrivateProofState,
  type CashuPrivateSwapResult,
  type CashuTestMintPort,
} from "./cashu-test-mint";

const MINT_URL = "https://testmint.example/cashu";
const KEYSET_ID = "00aabbccddeeff";
const CURVE_POINT =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const LOCK_SECRET = "01".padStart(64, "0");
const REFUND_SECRET = "02".padStart(64, "0");

function proof(amount: bigint, suffix: string, keysetId = KEYSET_ID): Proof {
  return deserializeProofs([
    {
      id: keysetId,
      amount: amount.toString(),
      secret: `private-proof-secret-${suffix}`,
      C: CURVE_POINT,
      witness: `private-witness-${suffix}`,
    },
  ])[0];
}

function sum(proofs: readonly Proof[]): bigint {
  return proofs.reduce((total, item) => total + item.amount.toBigInt(), 0n);
}

function defaultSnapshot(
  overrides: Partial<CashuMintCapabilitySnapshot> = {},
): CashuMintCapabilitySnapshot {
  return {
    mintUrl: MINT_URL,
    nuts: { 7: true, 9: true, 10: true, 11: true },
    keysets: [
      {
        id: KEYSET_ID,
        unit: "sat",
        active: true,
        inputFeePpk: 1,
        hasKeys: true,
      },
    ],
    ...overrides,
  };
}

class FakeCashuBackend implements CashuMintPrivateBackend {
  snapshot = defaultSnapshot();
  readonly prepareFailures: CashuPrivateBackendError[] = [];
  readonly submitFailures: CashuPrivateBackendError[] = [];
  states: readonly CashuPrivateProofState[] = [{ state: "unspent" }];
  restoreSucceeds = false;
  malformedSubmit = false;
  rawFailureMarker?: string;
  capabilityCalls = 0;
  prepareCalls = 0;
  submitCalls = 0;
  inspectCalls = 0;
  restoreCalls = 0;

  async inspectCapabilities(): Promise<CashuMintCapabilitySnapshot> {
    this.capabilityCalls += 1;
    return this.snapshot;
  }

  async prepareLock(input: {
    readonly proofs: readonly Proof[];
    readonly amountSats: bigint;
    readonly options: P2PKOptions;
  }): Promise<CashuPrivatePreparedSwap> {
    void input.options;
    return this.prepare("lock", input.proofs, input.amountSats);
  }

  async prepareSpend(input: {
    readonly proofs: readonly Proof[];
    readonly amountSats: bigint;
    readonly spendingKeyHex: string;
  }): Promise<CashuPrivatePreparedSwap> {
    void input.spendingKeyHex;
    return this.prepare("spend", input.proofs, input.amountSats);
  }

  private prepare(
    kind: "lock" | "spend",
    proofs: readonly Proof[],
    amountSats: bigint,
  ): CashuPrivatePreparedSwap {
    this.prepareCalls += 1;
    const failure = this.prepareFailures.shift();
    if (failure) throw failure;
    if (this.rawFailureMarker) throw new Error(this.rawFailureMarker);
    return {
      kind,
      inputProofs: proofs,
      requestedAmountSats: amountSats,
      opaque: Object.freeze({ privateBlindingMaterial: "private-blinding-marker" }),
    };
  }

  resultFor(prepared: CashuPrivatePreparedSwap): CashuPrivateSwapResult {
    const inputAmount = sum(prepared.inputProofs);
    const outputAmount =
      prepared.kind === "lock"
        ? prepared.requestedAmountSats + 1n
        : prepared.requestedAmountSats;
    const fee = 1n;
    const changeAmount = inputAmount - outputAmount - fee;
    return {
      sendProofs: [proof(outputAmount, `${prepared.kind}-send`)],
      keepProofs: changeAmount > 0n ? [proof(changeAmount, `${prepared.kind}-change`)] : [],
    };
  }

  async submit(prepared: CashuPrivatePreparedSwap): Promise<CashuPrivateSwapResult> {
    this.submitCalls += 1;
    const failure = this.submitFailures.shift();
    if (failure) throw failure;
    const result = this.resultFor(prepared);
    if (!this.malformedSubmit) return result;
    return {
      ...result,
      sendProofs: [proof(sum(prepared.inputProofs) + 1n, "malformed")],
    };
  }

  async inspectProofStates(
    proofs: readonly Proof[],
  ): Promise<readonly CashuPrivateProofState[]> {
    this.inspectCalls += 1;
    if (this.states.length === proofs.length) return this.states;
    return proofs.map(() => this.states[0] ?? { state: "unspent" });
  }

  async restore(
    prepared: CashuPrivatePreparedSwap,
  ): Promise<CashuPrivateSwapResult | undefined> {
    this.restoreCalls += 1;
    return this.restoreSucceeds ? this.resultFor(prepared) : undefined;
  }
}

function harness(backend = new FakeCashuBackend()): {
  backend: FakeCashuBackend;
  adapter: CashuTestMintPort;
} {
  return {
    backend,
    adapter: createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: `${MINT_URL}/`,
        unit: "sat",
        maximumExposureSats: sats(1_000n),
      },
      backend,
      privateStore: createInMemoryCashuPrivateStore(),
    }),
  };
}

function funding(amount = 400n, keysetId = KEYSET_ID) {
  return createPrivateCashuFunding({
    mintUrl: MINT_URL,
    unit: "sat",
    proofs: [proof(amount, "funding", keysetId)],
  });
}

function spendingKey(secretKeyHex = LOCK_SECRET) {
  return createPrivateCashuSpendingKey({
    purpose: "cashu-nut11",
    secretKeyHex,
  });
}

async function prepare(
  adapter: CashuTestMintPort,
  operationId = "prepare-0001",
) {
  const lockKey = spendingKey();
  const result = await adapter.prepareLockedValue({
    operationId,
    funding: funding(),
    amountSats: sats(350n),
    spendingCondition: { lockPublicKey: lockKey.publicKey },
  });
  if (result.status !== "succeeded") throw new Error("test preparation did not succeed");
  return { result, lockKey };
}

describe("Cashu test-mint configuration and capabilities", () => {
  it("normalizes one explicit HTTPS test mint and requires sat", () => {
    expect(
      normalizeCashuTestMintConfiguration({
        testMintUrl: `${MINT_URL}///`,
        unit: "sat",
        maximumExposureSats: sats(100n),
      }).testMintUrl,
    ).toBe(MINT_URL);

    expect(() =>
      normalizeCashuTestMintConfiguration({
        testMintUrl: "http://testmint.example",
        unit: "sat",
        maximumExposureSats: sats(100n),
      }),
    ).toThrowError(CashuTestMintError);
    expect(() =>
      normalizeCashuTestMintConfiguration({
        testMintUrl: "https://credential@testmint.example?mint=other",
        unit: "sat",
        maximumExposureSats: sats(100n),
      }),
    ).toThrowError(CashuTestMintError);
  });

  it("validates NUT-07, NUT-09, NUT-10, NUT-11, sat, key material, and fees", async () => {
    const { adapter } = harness();
    await expect(adapter.inspectCapabilities()).resolves.toEqual({
      mintUrl: MINT_URL,
      unit: "sat",
      nuts: {
        nut07ProofState: true,
        nut09Restore: true,
        nut10SpendingConditions: true,
        nut11P2pk: true,
      },
      activeKeyset: { id: KEYSET_ID, inputFeePpk: 1 },
    });
  });

  it("fails closed when a required capability is unsupported", async () => {
    const backend = new FakeCashuBackend();
    backend.snapshot = defaultSnapshot({ nuts: { 7: true, 9: true, 10: true, 11: false } });
    await expect(harness(backend).adapter.inspectCapabilities()).rejects.toMatchObject({
      code: "unsupported_mint_capability",
      operationStatus: "not_submitted",
    });
  });

  it("rejects an unsupported mint unit", async () => {
    const backend = new FakeCashuBackend();
    backend.snapshot = defaultSnapshot({
      keysets: [
        { id: KEYSET_ID, unit: "usd", active: true, inputFeePpk: 1, hasKeys: true },
      ],
    });
    await expect(harness(backend).adapter.inspectCapabilities()).rejects.toMatchObject({
      code: "unsupported_unit",
    });
  });

  it("rejects missing keys and malformed keyset fee metadata", async () => {
    const missingKeys = new FakeCashuBackend();
    missingKeys.snapshot = defaultSnapshot({
      keysets: [
        { id: KEYSET_ID, unit: "sat", active: true, inputFeePpk: 1, hasKeys: false },
      ],
    });
    await expect(harness(missingKeys).adapter.inspectCapabilities()).rejects.toMatchObject({
      code: "unsupported_mint_capability",
    });

    const badFee = new FakeCashuBackend();
    badFee.snapshot = defaultSnapshot({
      keysets: [
        { id: KEYSET_ID, unit: "sat", active: true, inputFeePpk: -1, hasKeys: true },
      ],
    });
    await expect(harness(badFee).adapter.inspectCapabilities()).rejects.toMatchObject({
      code: "unsupported_mint_capability",
    });
  });

  it("rejects capability data for any mint other than the configured mint", async () => {
    const backend = new FakeCashuBackend();
    backend.snapshot = defaultSnapshot({ mintUrl: "https://other-mint.example" });
    await expect(harness(backend).adapter.inspectCapabilities()).rejects.toMatchObject({
      code: "invalid_mint_configuration",
    });
  });
});

describe("Cashu test-mint private operations", () => {
  it("prepares locked value with integer-safe fee accounting and only safe output", async () => {
    const { adapter } = harness();
    const { result } = await prepare(adapter);

    expect(result.facts).toEqual({
      mintUrl: MINT_URL,
      unit: "sat",
      amountSats: 350n,
      inputAmountSats: 400n,
      outputAmountSats: 351n,
      changeAmountSats: 48n,
      mintFeeSats: 1n,
      reservedSpendFeeSats: 1n,
    });
    expect(result.handle.reference).toMatch(/^cashu_private_[0-9a-f-]{36}$/);
  });

  it("spends locked value only with the matching private Cashu key", async () => {
    const { adapter } = harness();
    const locked = await prepare(adapter);
    const spent = await adapter.spendLockedValue({
      operationId: "spend-000001",
      handle: locked.result.handle,
      spendingKey: locked.lockKey,
    });

    expect(spent.status).toBe("succeeded");
    if (spent.status === "succeeded") {
      expect(spent.facts).toMatchObject({
        amountSats: 350n,
        inputAmountSats: 351n,
        outputAmountSats: 350n,
        mintFeeSats: 1n,
      });
    }

    const other = await prepare(adapter, "prepare-0002");
    await expect(
      adapter.spendLockedValue({
        operationId: "spend-000002",
        handle: other.result.handle,
        spendingKey: spendingKey(REFUND_SECRET),
      }),
    ).rejects.toMatchObject({ code: "invalid_spending_condition" });
  });

  it("rejects insufficient value before submission", async () => {
    const { adapter, backend } = harness();
    const key = spendingKey();
    await expect(
      adapter.prepareLockedValue({
        operationId: "prepare-0003",
        funding: funding(20n),
        amountSats: sats(50n),
        spendingCondition: { lockPublicKey: key.publicKey },
      }),
    ).rejects.toMatchObject({
      code: "insufficient_value",
      operationStatus: "not_submitted",
    });
    expect(backend.prepareCalls).toBe(0);
    expect(backend.submitCalls).toBe(0);
  });

  it("rejects malformed, zero, x-only, and incomplete refund spending conditions", async () => {
    expect(() => spendingKey("00".repeat(32))).toThrowError(CashuTestMintError);
    expect(() =>
      createPrivateCashuSpendingKey({
        purpose: "cashu-nut11",
        secretKeyHex: "A".repeat(64),
      }),
    ).toThrowError(CashuTestMintError);

    const { adapter, backend } = harness();
    await expect(
      adapter.prepareLockedValue({
        operationId: "prepare-0004",
        funding: funding(),
        amountSats: sats(50n),
        spendingCondition: { lockPublicKey: "ab".repeat(32) },
      }),
    ).rejects.toMatchObject({ code: "invalid_spending_condition" });
    const lock = spendingKey();
    const refund = spendingKey(REFUND_SECRET);
    await expect(
      adapter.prepareLockedValue({
        operationId: "prepare-0005",
        funding: funding(),
        amountSats: sats(50n),
        spendingCondition: {
          lockPublicKey: lock.publicKey,
          refundPublicKey: refund.publicKey,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_spending_condition" });
    expect(backend.capabilityCalls).toBe(0);
  });

  it.each(["unspent", "pending", "spent"] as const)(
    "reports %s proof state without exposing proofs",
    async (state) => {
      const { adapter, backend } = harness();
      const locked = await prepare(adapter);
      backend.states = [{ state }];
      await expect(adapter.inspectProofState(locked.result.handle)).resolves.toMatchObject({
        state,
        proofCount: 1,
        [`${state}Count`]: 1,
      });
    },
  );

  it("rejects an unknown Cashu proof state instead of treating it as spent", () => {
    expect(normalizeCashuPrivateProofState(CheckStateEnum.SPENT)).toEqual({ state: "spent" });

    let caught: unknown;
    try {
      normalizeCashuPrivateProofState("UNKNOWN" as unknown as CheckStateEnum);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CashuPrivateBackendError);
    expect(caught).toMatchObject({
      code: "malformed_response",
      submissionStatus: "not_submitted",
    });
  });

  it("rejects value from an unknown or incompatible keyset", async () => {
    const { adapter, backend } = harness();
    const key = spendingKey();
    await expect(
      adapter.prepareLockedValue({
        operationId: "prepare-0006",
        funding: funding(400n, "unknown-keyset"),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: key.publicKey },
      }),
    ).rejects.toMatchObject({ code: "unsupported_mint_capability" });
    expect(backend.submitCalls).toBe(0);
  });

  it("accepts a valid locktime refund path and rejects funding from another mint", async () => {
    const { adapter, backend } = harness();
    const lock = spendingKey();
    const refund = spendingKey(REFUND_SECRET);
    await expect(
      adapter.prepareLockedValue({
        operationId: "refund-path-01",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: {
          lockPublicKey: lock.publicKey,
          refundPublicKey: refund.publicKey,
          locktime: 1_900_000_000,
        },
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    const otherMintFunding = createPrivateCashuFunding({
      mintUrl: "https://other-testmint.example",
      unit: "sat",
      proofs: [proof(400n, "other-mint")],
    });
    await expect(
      adapter.prepareLockedValue({
        operationId: "wrong-mint-01",
        funding: otherMintFunding,
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: lock.publicKey },
      }),
    ).rejects.toMatchObject({ code: "invalid_mint_configuration" });
    expect(backend.submitCalls).toBe(1);
  });
});

describe("Cashu test-mint retry and reconciliation", () => {
  it("retries safely when preparation timed out before submission", async () => {
    const backend = new FakeCashuBackend();
    backend.prepareFailures.push(new CashuPrivateBackendError("timeout", "not_submitted"));
    const { adapter } = harness(backend);
    const key = spendingKey();
    const request = {
      operationId: "retry-before-1",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    };
    await expect(adapter.prepareLockedValue(request)).rejects.toMatchObject({
      code: "mint_timeout",
      operationStatus: "not_submitted",
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(backend.prepareCalls).toBe(2);
    expect(backend.submitCalls).toBe(1);
  });

  it("never blindly resubmits after a timeout that may have submitted", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    const { adapter } = harness(backend);
    const key = spendingKey();
    const request = {
      operationId: "retry-after-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    };

    await expect(adapter.prepareLockedValue(request)).resolves.toEqual({
      status: "submitted_unknown",
      outcome: "reconciliation_required",
      operationId: request.operationId,
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "submitted_unknown",
      outcome: "reconciliation_required",
    });
    expect(backend.submitCalls).toBe(1);
    expect(backend.inspectCalls).toBe(1);
    expect(backend.restoreCalls).toBe(0);
  });

  it("uses NUT-07 and NUT-09 to reconcile a submitted operation", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    backend.states = [{ state: "spent" }];
    backend.restoreSucceeds = true;
    const { adapter } = harness(backend);
    const key = spendingKey();
    const request = {
      operationId: "reconcile-0001",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    };

    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "submitted_unknown",
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(backend.submitCalls).toBe(1);
    expect(backend.inspectCalls).toBe(1);
    expect(backend.restoreCalls).toBe(1);
  });

  it("reconciles from private stored context after the adapter is reconstructed", async () => {
    const privateStore = createInMemoryCashuPrivateStore();
    const firstBackend = new FakeCashuBackend();
    firstBackend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    const configuration = {
      testMintUrl: MINT_URL,
      unit: "sat" as const,
      maximumExposureSats: sats(1_000n),
    };
    const firstAdapter = createCashuTestMintAdapterWithBackend({
      configuration,
      backend: firstBackend,
      privateStore,
    });
    const key = spendingKey();
    const request = {
      operationId: "restart-00001",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    };
    await expect(firstAdapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "submitted_unknown",
    });

    const secondBackend = new FakeCashuBackend();
    secondBackend.states = [{ state: "spent" }];
    secondBackend.restoreSucceeds = true;
    const reconstructedAdapter = createCashuTestMintAdapterWithBackend({
      configuration,
      backend: secondBackend,
      privateStore,
    });
    await expect(
      reconstructedAdapter.prepareLockedValue({ ...request, funding: funding() }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(secondBackend.submitCalls).toBe(0);
    expect(secondBackend.inspectCalls).toBe(1);
    expect(secondBackend.restoreCalls).toBe(1);
  });

  it("returns reconciliation_required for malformed post-submit accounting", async () => {
    const backend = new FakeCashuBackend();
    backend.malformedSubmit = true;
    const { adapter } = harness(backend);
    const key = spendingKey();
    await expect(
      adapter.prepareLockedValue({
        operationId: "malformed-0001",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: key.publicKey },
      }),
    ).resolves.toMatchObject({
      status: "submitted_unknown",
      outcome: "reconciliation_required",
    });
  });

  it("deduplicates successful retries and rejects operation-id parameter reuse", async () => {
    const { adapter, backend } = harness();
    const key = spendingKey();
    const request = {
      operationId: "duplicate-0001",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    };
    const first = await adapter.prepareLockedValue(request);
    const duplicate = await adapter.prepareLockedValue(request);
    expect(duplicate).toEqual(first);
    expect(backend.submitCalls).toBe(1);

    await expect(
      adapter.prepareLockedValue({ ...request, amountSats: sats(349n) }),
    ).rejects.toMatchObject({ code: "operation_rejected" });
    expect(backend.submitCalls).toBe(1);
  });

  it("rejects operation-id reuse after a not-submitted failure", async () => {
    const { adapter, backend } = harness();
    const key = spendingKey();
    await expect(
      adapter.prepareLockedValue({
        operationId: "failed-reuse-1",
        funding: funding(20n),
        amountSats: sats(50n),
        spendingCondition: { lockPublicKey: key.publicKey },
      }),
    ).rejects.toMatchObject({ code: "insufficient_value" });
    await expect(
      adapter.prepareLockedValue({
        operationId: "failed-reuse-1",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: key.publicKey },
      }),
    ).rejects.toMatchObject({ code: "operation_rejected" });
    expect(backend.submitCalls).toBe(0);
  });

  it("remembers definitive failures and does not resubmit them", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("rejected", "failed_definitively"),
    );
    const { adapter } = harness(backend);
    const key = spendingKey();
    const request = {
      operationId: "definite-0001",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    };
    await expect(adapter.prepareLockedValue(request)).rejects.toMatchObject({
      code: "operation_rejected",
      operationStatus: "failed_definitively",
    });
    await expect(adapter.prepareLockedValue(request)).rejects.toMatchObject({
      code: "operation_rejected",
      operationStatus: "failed_definitively",
    });
    expect(backend.submitCalls).toBe(1);
  });
});

describe("Cashu test-mint privacy boundary", () => {
  it("prevents direct serialization of private bearer and key material", () => {
    expect(() => JSON.stringify(funding())).toThrowError(CashuTestMintError);
    expect(() => JSON.stringify(spendingKey())).toThrowError(CashuTestMintError);
    expect(() => JSON.stringify(createInMemoryCashuPrivateStore())).toThrowError(
      CashuTestMintError,
    );
  });

  it("redacts library failures and keeps secrets out of results and captured logs", async () => {
    const marker =
      "cashuA_PRIVATE_TOKEN private-proof-secret private-witness private-blinding-marker mint-credential";
    const backend = new FakeCashuBackend();
    backend.rawFailureMarker = marker;
    const consoleSpies = (["error", "warn", "info", "debug", "log"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const { adapter } = harness(backend);
    const key = spendingKey();
    let caught: unknown;
    try {
      await adapter.prepareLockedValue({
        operationId: "privacy-00001",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: key.publicKey },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CashuTestMintError);
    const serializedError = JSON.stringify(caught);
    expect(serializedError).not.toContain(marker);
    expect(serializedError).not.toContain("private-proof-secret");
    expect(serializedError).not.toContain("private-witness");
    expect("cause" in (caught as object)).toBe(false);
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);

    backend.rawFailureMarker = undefined;
    const successful = await adapter.prepareLockedValue({
      operationId: "privacy-00002",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    });
    const serializedResult = JSON.stringify(successful, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    for (const secret of [
      "cashuA_PRIVATE_TOKEN",
      "private-proof-secret",
      "private-witness",
      "private-blinding-marker",
      LOCK_SECRET,
      "mint-credential",
    ]) {
      expect(serializedResult).not.toContain(secret);
    }
    consoleSpies.forEach((spy) => spy.mockRestore());
  });
});
