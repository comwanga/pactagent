import {
  deserializeProofs,
  type P2PKOptions,
  type Proof,
} from "@cashu/cashu-ts";

import {
  CashuPrivateBackendError,
  createPrivateCashuFunding,
  type CashuMintCapabilitySnapshot,
  type CashuMintPrivateBackend,
  type CashuPrivatePreparedSwap,
  type CashuPrivateProofState,
  type CashuPrivateSwapResult,
} from "./cashu-test-mint";

/*
 * Shared test-only fake backend for CashuTestMintAdapter.
 *
 * Used by both cashu-test-mint.test.ts and cashu-escrow-settlement.test.ts
 * to compose the real CashuTestMintAdapter state machine with a deterministic
 * fake backend — without importing one test file from another.
 */

export const FAKE_MINT_URL = "https://testmint.example/cashu";
export const FAKE_KEYSET_ID = "00aabbccddeeff";
export const FAKE_CURVE_POINT =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

export function fakeProof(amount: bigint, suffix: string, keysetId = FAKE_KEYSET_ID): Proof {
  return deserializeProofs([
    {
      id: keysetId,
      amount: amount.toString(),
      secret: `private-proof-secret-${suffix}`,
      C: FAKE_CURVE_POINT,
      witness: `private-witness-${suffix}`,
    },
  ])[0];
}

export function fakeSum(proofs: readonly Proof[]): bigint {
  return proofs.reduce((total, item) => total + item.amount.toBigInt(), 0n);
}

export function fakeDefaultSnapshot(
  overrides: Partial<CashuMintCapabilitySnapshot> = {},
): CashuMintCapabilitySnapshot {
  return {
    mintUrl: FAKE_MINT_URL,
    nuts: { 7: true, 9: true, 10: true, 11: true },
    keysets: [
      {
        id: FAKE_KEYSET_ID,
        unit: "sat",
        active: true,
        inputFeePpk: 1,
        hasKeys: true,
      },
    ],
    ...overrides,
  };
}

export function fakeFunding(amount = 400n, keysetId = FAKE_KEYSET_ID) {
  return createPrivateCashuFunding({
    mintUrl: FAKE_MINT_URL,
    unit: "sat",
    proofs: [fakeProof(amount, "funding", keysetId)],
  });
}

export class FakeCashuBackend implements CashuMintPrivateBackend {
  snapshot = fakeDefaultSnapshot();
  readonly prepareFailures: CashuPrivateBackendError[] = [];
  readonly submitFailures: CashuPrivateBackendError[] = [];
  states: readonly CashuPrivateProofState[] = [{ state: "unspent" }];
  restoreSucceeds = false;
  malformedSubmit = false;
  malformedExposure = false;
  rawFailureMarker?: string;
  inspectThrow?: CashuPrivateBackendError;
  restoreThrow?: CashuPrivateBackendError;
  onSubmitEntry?: () => Promise<void> | void;
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
    const prepared = this.prepare("spend", input.proofs, input.amountSats);
    return {
      ...prepared,
      opaque: Object.freeze({
        privateBlindingMaterial: "private-blinding-marker",
        spendingKeyHex: input.spendingKeyHex,
      }),
    };
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
      exposureAmountSats:
        this.malformedExposure && kind === "lock"
          ? amountSats - 1n
          : kind === "lock"
            ? amountSats + 1n
            : amountSats,
      opaque: Object.freeze({ privateBlindingMaterial: "private-blinding-marker" }),
    };
  }

  resultFor(prepared: CashuPrivatePreparedSwap): CashuPrivateSwapResult {
    const inputAmount = fakeSum(prepared.inputProofs);
    const outputAmount =
      prepared.kind === "lock"
        ? prepared.requestedAmountSats + 1n
        : prepared.requestedAmountSats;
    const fee = 1n;
    const changeAmount = inputAmount - outputAmount - fee;
    return {
      sendProofs: [fakeProof(outputAmount, `${prepared.kind}-send`)],
      keepProofs: changeAmount > 0n ? [fakeProof(changeAmount, `${prepared.kind}-change`)] : [],
    };
  }

  async submit(prepared: CashuPrivatePreparedSwap): Promise<CashuPrivateSwapResult> {
    this.submitCalls += 1;
    if (this.onSubmitEntry) await this.onSubmitEntry();
    const failure = this.submitFailures.shift();
    if (failure) throw failure;
    const result = this.resultFor(prepared);
    if (!this.malformedSubmit) return result;
    return {
      ...result,
      sendProofs: [fakeProof(fakeSum(prepared.inputProofs) + 1n, "malformed")],
    };
  }

  async inspectProofStates(
    proofs: readonly Proof[],
  ): Promise<readonly CashuPrivateProofState[]> {
    this.inspectCalls += 1;
    if (this.inspectThrow) throw this.inspectThrow;
    if (this.states.length === proofs.length) return this.states;
    return proofs.map(() => this.states[0] ?? { state: "unspent" });
  }

  async restore(
    prepared: CashuPrivatePreparedSwap,
  ): Promise<CashuPrivateSwapResult | undefined> {
    this.restoreCalls += 1;
    if (this.restoreThrow) throw this.restoreThrow;
    return this.restoreSucceeds ? this.resultFor(prepared) : undefined;
  }
}
