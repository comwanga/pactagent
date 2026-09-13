import { createHash, randomUUID } from "node:crypto";

import {
  Amount,
  CheckStateEnum,
  Keyset,
  LockBuilder,
  Mint,
  MintOperationError,
  Wallet,
  deserializeProofs,
  deserializeSwapPreview,
  getPubKeyFromPrivKey,
  serializeProofs,
  serializeSwapPreview,
  type Logger,
  type MintKeyset,
  type P2PKOptions,
  type Proof,
  type ProofLike,
  type RequestFn,
  type RequestOptions,
  type SerializedBlindedSignature,
  type SerializedSwapPreview,
  type SwapPreview,
} from "@cashu/cashu-ts";

import { findForbiddenPublicMaterial } from "../domain/forbidden-material";
import { sats, type Sats } from "../domain/money";

export const CASHU_TEST_MINT_UNIT = "sat";
export const CASHU_TEST_MINT_REQUIRED_NUTS = [7, 9, 10, 11] as const;
export const CASHU_TEST_MINT_DEFAULT_TIMEOUT_MS = 10_000;
export const CASHU_TEST_MINT_DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

export type CashuTestMintErrorCode =
  | "invalid_mint_configuration"
  | "mint_unavailable"
  | "mint_timeout"
  | "unsupported_mint_capability"
  | "unsupported_unit"
  | "invalid_spending_condition"
  | "insufficient_value"
  | "proof_already_spent"
  | "proof_pending"
  | "operation_rejected"
  | "reconciliation_required"
  | "malformed_mint_response"
  | "privacy_boundary_violation";

export type CashuOperationStatus =
  | "not_submitted"
  | "submitted_unknown"
  | "succeeded"
  | "failed_definitively";

export class CashuTestMintError extends Error {
  readonly code: CashuTestMintErrorCode;
  readonly operationStatus: CashuOperationStatus;
  readonly operationId?: string;

  constructor(
    code: CashuTestMintErrorCode,
    message: string,
    operationStatus: CashuOperationStatus = "not_submitted",
    operationId?: string,
  ) {
    super(message);
    this.name = "CashuTestMintError";
    this.code = code;
    this.operationStatus = operationStatus;
    this.operationId = operationId;
  }

  toJSON(): Readonly<Record<string, string>> {
    return Object.freeze({
      name: this.name,
      code: this.code,
      message: this.message,
      operation_status: this.operationStatus,
      ...(this.operationId === undefined ? {} : { operation_id: this.operationId }),
    });
  }
}

function cashuError(
  code: CashuTestMintErrorCode,
  message: string,
  operationStatus: CashuOperationStatus = "not_submitted",
  operationId?: string,
): never {
  throw new CashuTestMintError(code, message, operationStatus, operationId);
}

export interface CashuTestMintConfiguration {
  readonly testMintUrl: string;
  readonly unit: "sat";
  readonly maximumExposureSats: Sats;
  readonly requestTimeoutMs?: number;
  readonly maximumResponseBytes?: number;
}

export interface NormalizedCashuTestMintConfiguration {
  readonly testMintUrl: string;
  readonly unit: "sat";
  readonly maximumExposureSats: Sats;
  readonly requestTimeoutMs: number;
  readonly maximumResponseBytes: number;
}

function positiveBoundedInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    cashuError("invalid_mint_configuration", `${label} must be a positive safe integer`);
  }
  return value;
}

export function normalizeCashuTestMintUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    cashuError("invalid_mint_configuration", "Cashu test mint URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname === ""
  ) {
    cashuError(
      "invalid_mint_configuration",
      "Cashu test mint URL must be an HTTPS URL without credentials, query, or fragment",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export function normalizeCashuTestMintConfiguration(
  input: CashuTestMintConfiguration,
): NormalizedCashuTestMintConfiguration {
  if (input.unit !== CASHU_TEST_MINT_UNIT) {
    cashuError("unsupported_unit", "Cashu test mint adapter requires the sat unit");
  }
  if (typeof input.maximumExposureSats !== "bigint") {
    cashuError("invalid_mint_configuration", "Cashu test mint exposure cap is invalid");
  }
  try {
    Amount.from(input.maximumExposureSats);
  } catch {
    cashuError(
      "invalid_mint_configuration",
      "Cashu test mint exposure cap is outside the library-supported range",
    );
  }
  if (input.maximumExposureSats < 1n) {
    cashuError("invalid_mint_configuration", "Cashu test mint exposure cap must be positive");
  }
  return Object.freeze({
    testMintUrl: normalizeCashuTestMintUrl(input.testMintUrl),
    unit: CASHU_TEST_MINT_UNIT,
    maximumExposureSats: input.maximumExposureSats,
    requestTimeoutMs: positiveBoundedInteger(
      input.requestTimeoutMs ?? CASHU_TEST_MINT_DEFAULT_TIMEOUT_MS,
      "Cashu request timeout",
    ),
    maximumResponseBytes: positiveBoundedInteger(
      input.maximumResponseBytes ?? CASHU_TEST_MINT_DEFAULT_MAX_RESPONSE_BYTES,
      "Cashu maximum response size",
    ),
  });
}

export interface ValidatedMintCapabilities {
  readonly mintUrl: string;
  readonly unit: "sat";
  readonly nuts: Readonly<{
    nut07ProofState: true;
    nut09Restore: true;
    nut10SpendingConditions: true;
    nut11P2pk: true;
  }>;
  readonly activeKeyset: Readonly<{
    id: string;
    inputFeePpk: number;
  }>;
}

export interface CashuPrivateHandle {
  readonly reference: string;
}

export interface CashuSettlementFacts {
  readonly mintUrl: string;
  readonly unit: "sat";
  readonly amountSats: Sats;
  readonly inputAmountSats: Sats;
  readonly outputAmountSats: Sats;
  readonly changeAmountSats: Sats;
  readonly mintFeeSats: Sats;
  readonly reservedSpendFeeSats: Sats;
}

export interface CashuOperationSucceeded {
  readonly status: "succeeded";
  readonly operationId: string;
  readonly handle: CashuPrivateHandle;
  readonly facts: CashuSettlementFacts;
}

export interface CashuReconciliationRequired {
  readonly status: "submitted_unknown";
  readonly outcome: "reconciliation_required";
  readonly operationId: string;
}

export type CashuMutationResult = CashuOperationSucceeded | CashuReconciliationRequired;

export type CashuProofState = "unspent" | "pending" | "spent";

export interface ProofStateSummary {
  readonly handle: CashuPrivateHandle;
  readonly state: CashuProofState | "mixed";
  readonly proofCount: number;
  readonly unspentCount: number;
  readonly pendingCount: number;
  readonly spentCount: number;
}

export interface CashuP2PKSpendingCondition {
  readonly lockPublicKey: string;
  readonly refundPublicKey?: string;
  readonly locktime?: number;
}

export class PrivateCashuFunding {
  toJSON(): never {
    cashuError(
      "privacy_boundary_violation",
      "Private Cashu funding material cannot be serialized",
    );
  }
}

export class PrivateCashuSpendingKey {
  readonly publicKey: string;

  constructor(publicKey: string) {
    this.publicKey = publicKey;
  }

  toJSON(): never {
    cashuError(
      "privacy_boundary_violation",
      "Private Cashu spending key cannot be serialized",
    );
  }
}

interface PrivateFundingMaterial {
  readonly fingerprint: string;
  readonly mintUrl: string;
  readonly unit: "sat";
  readonly proofs: readonly Proof[];
}

const privateFundingMaterial = new WeakMap<PrivateCashuFunding, PrivateFundingMaterial>();
const privateSpendingKeys = new WeakMap<PrivateCashuSpendingKey, string>();

function randomPrivateReference(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseProofs(value: readonly ProofLike[]): readonly Proof[] {
  let proofs: Proof[];
  try {
    proofs = deserializeProofs([...value]);
  } catch {
    cashuError("operation_rejected", "Private Cashu proof material is malformed");
  }
  if (
    proofs.length === 0 ||
    proofs.some(
      (proof) =>
        typeof proof.id !== "string" ||
        proof.id.length === 0 ||
        typeof proof.secret !== "string" ||
        proof.secret.length === 0 ||
        typeof proof.C !== "string" ||
        proof.C.length === 0 ||
        amountToBigInt(proof.amount) < 1n,
    )
  ) {
    cashuError("operation_rejected", "Private Cashu proof material is malformed");
  }
  return proofs;
}

function fingerprintPrivateProofs(proofs: readonly Proof[]): string {
  const serialized = serializeProofs([...proofs]).sort();
  return createHash("sha256").update(JSON.stringify(serialized)).digest("hex");
}

export function createPrivateCashuFunding(input: {
  readonly mintUrl: string;
  readonly unit: "sat";
  readonly proofs: readonly ProofLike[];
}): PrivateCashuFunding {
  if (input.unit !== CASHU_TEST_MINT_UNIT) {
    cashuError("unsupported_unit", "Private Cashu funding must use sat");
  }
  const proofs = parseProofs(input.proofs);
  const funding = new PrivateCashuFunding();
  privateFundingMaterial.set(funding, {
    fingerprint: fingerprintPrivateProofs(proofs),
    mintUrl: normalizeCashuTestMintUrl(input.mintUrl),
    unit: CASHU_TEST_MINT_UNIT,
    proofs,
  });
  return Object.freeze(funding);
}

export function createPrivateCashuSpendingKey(input: {
  readonly purpose: "cashu-nut11";
  readonly secretKeyHex: string;
}): PrivateCashuSpendingKey {
  if (input.purpose !== "cashu-nut11" || !/^[0-9a-f]{64}$/.test(input.secretKeyHex)) {
    cashuError("invalid_spending_condition", "Cashu NUT-11 spending key is malformed");
  }
  let publicKey: string;
  try {
    const bytes = Uint8Array.from(
      input.secretKeyHex.match(/.{2}/g) ?? [],
      (byte) => Number.parseInt(byte, 16),
    );
    publicKey = bytesToHex(getPubKeyFromPrivKey(bytes));
  } catch {
    cashuError("invalid_spending_condition", "Cashu NUT-11 spending key is invalid");
  }
  const key = new PrivateCashuSpendingKey(publicKey);
  privateSpendingKeys.set(key, input.secretKeyHex);
  return Object.freeze(key);
}

function validateCashuPublicKey(value: string): string {
  if (!/^(02|03)[0-9a-f]{64}$/.test(value)) {
    cashuError(
      "invalid_spending_condition",
      "Cashu NUT-11 public keys must use compressed secp256k1 encoding",
    );
  }
  try {
    new LockBuilder().addMainPubkey(value).toOptions();
  } catch {
    cashuError("invalid_spending_condition", "Cashu NUT-11 public key is invalid");
  }
  return value;
}

function validateSpendingCondition(
  input: CashuP2PKSpendingCondition,
): Readonly<{
  condition: CashuP2PKSpendingCondition;
  options: P2PKOptions;
  allowedPublicKeys: readonly string[];
}> {
  const lockPublicKey = validateCashuPublicKey(input.lockPublicKey);
  if (input.locktime !== undefined && (!Number.isSafeInteger(input.locktime) || input.locktime < 1)) {
    cashuError("invalid_spending_condition", "Cashu NUT-11 locktime is invalid");
  }
  if (input.refundPublicKey !== undefined && input.locktime === undefined) {
    cashuError(
      "invalid_spending_condition",
      "Cashu NUT-11 refund key requires a locktime",
    );
  }
  const refundPublicKey =
    input.refundPublicKey === undefined
      ? undefined
      : validateCashuPublicKey(input.refundPublicKey);
  if (refundPublicKey === lockPublicKey) {
    cashuError(
      "invalid_spending_condition",
      "Cashu NUT-11 lock and refund keys must be distinct",
    );
  }
  try {
    const builder = new LockBuilder().addMainPubkey(lockPublicKey);
    if (input.locktime !== undefined) builder.lockUntil(input.locktime);
    if (refundPublicKey !== undefined) builder.addRefundPubkey(refundPublicKey);
    const options = builder.toOptions();
    return Object.freeze({
      condition: Object.freeze({
        lockPublicKey,
        ...(refundPublicKey === undefined ? {} : { refundPublicKey }),
        ...(input.locktime === undefined ? {} : { locktime: input.locktime }),
      }),
      options,
      allowedPublicKeys: Object.freeze(
        refundPublicKey === undefined ? [lockPublicKey] : [lockPublicKey, refundPublicKey],
      ),
    });
  } catch {
    cashuError("invalid_spending_condition", "Cashu NUT-11 spending condition is invalid");
  }
}

export interface PrepareLockedValueInput {
  readonly operationId: string;
  readonly funding: PrivateCashuFunding;
  readonly amountSats: Sats;
  readonly spendingCondition: CashuP2PKSpendingCondition;
}

export interface SpendLockedValueInput {
  readonly operationId: string;
  readonly handle: CashuPrivateHandle;
  readonly spendingKey: PrivateCashuSpendingKey;
}

export interface CashuTestMintPort {
  inspectCapabilities(): Promise<ValidatedMintCapabilities>;
  prepareLockedValue(input: PrepareLockedValueInput): Promise<CashuMutationResult>;
  inspectProofState(handle: CashuPrivateHandle): Promise<ProofStateSummary>;
  spendLockedValue(input: SpendLockedValueInput): Promise<CashuMutationResult>;
}

export interface CashuPrivateStore {
  read(scope: string, key: string): Promise<unknown | undefined>;
  write(scope: string, key: string, value: unknown): Promise<void>;
}

export function createInMemoryCashuPrivateStore(): CashuPrivateStore {
  const records = new Map<string, unknown>();
  return Object.freeze({
    async read(scope: string, key: string): Promise<unknown | undefined> {
      return records.get(`${scope}:${key}`);
    },
    async write(scope: string, key: string, value: unknown): Promise<void> {
      records.set(`${scope}:${key}`, value);
    },
    toJSON(): never {
      cashuError(
        "privacy_boundary_violation",
        "Private Cashu store cannot be serialized",
      );
    },
  });
}

export interface CashuMintCapabilitySnapshot {
  readonly mintUrl: string;
  readonly nuts: Readonly<Partial<Record<7 | 9 | 10 | 11, boolean>>>;
  readonly keysets: readonly Readonly<{
    id: string;
    unit: string;
    active: boolean;
    inputFeePpk: number;
    hasKeys: boolean;
  }>[];
}

export interface CashuPrivatePreparedSwap {
  readonly kind: "lock" | "spend";
  readonly inputProofs: readonly Proof[];
  readonly requestedAmountSats: bigint;
  readonly opaque: unknown;
}

export interface CashuPrivateSwapResult {
  readonly keepProofs: readonly Proof[];
  readonly sendProofs: readonly Proof[];
}

export interface CashuPrivateProofState {
  readonly state: CashuProofState;
}

export type CashuPrivateBackendErrorCode =
  | "timeout"
  | "unavailable"
  | "unsupported"
  | "insufficient_value"
  | "proof_already_spent"
  | "proof_pending"
  | "rejected"
  | "malformed_response";

export class CashuPrivateBackendError extends Error {
  readonly code: CashuPrivateBackendErrorCode;
  readonly submissionStatus: Exclude<CashuOperationStatus, "succeeded">;

  constructor(
    code: CashuPrivateBackendErrorCode,
    submissionStatus: Exclude<CashuOperationStatus, "succeeded">,
  ) {
    super("Private Cashu backend operation failed");
    this.name = "CashuPrivateBackendError";
    this.code = code;
    this.submissionStatus = submissionStatus;
  }
}

/** @internal Private bearer-material boundary used for deterministic adapter tests. */
export interface CashuMintPrivateBackend {
  inspectCapabilities(): Promise<CashuMintCapabilitySnapshot>;
  prepareLock(input: {
    readonly proofs: readonly Proof[];
    readonly amountSats: bigint;
    readonly options: P2PKOptions;
  }): Promise<CashuPrivatePreparedSwap>;
  prepareSpend(input: {
    readonly proofs: readonly Proof[];
    readonly amountSats: bigint;
    readonly spendingKeyHex: string;
  }): Promise<CashuPrivatePreparedSwap>;
  submit(prepared: CashuPrivatePreparedSwap): Promise<CashuPrivateSwapResult>;
  inspectProofStates(proofs: readonly Proof[]): Promise<readonly CashuPrivateProofState[]>;
  restore(prepared: CashuPrivatePreparedSwap): Promise<CashuPrivateSwapResult | undefined>;
}

interface PrivateValueRecord {
  readonly proofs: readonly Proof[];
  readonly amountSats: bigint;
  readonly allowedPublicKeys: readonly string[];
}

interface StoredOperation {
  readonly fingerprint: string;
  readonly kind: "lock" | "spend";
  readonly status: CashuOperationStatus;
  readonly prepared?: CashuPrivatePreparedSwap;
  readonly result?: CashuOperationSucceeded;
  readonly errorCode?: CashuTestMintErrorCode;
  readonly allowedPublicKeys: readonly string[];
}

function isStoredOperation(value: unknown): value is StoredOperation {
  return typeof value === "object" && value !== null && "fingerprint" in value && "status" in value;
}

function isPrivateValueRecord(value: unknown): value is PrivateValueRecord {
  return typeof value === "object" && value !== null && "proofs" in value && "amountSats" in value;
}

function amountToBigInt(value: { toString(): string } | bigint | number | string): bigint {
  try {
    const amount = BigInt(value.toString());
    if (amount < 0n) throw new Error("negative amount");
    return amount;
  } catch {
    cashuError("malformed_mint_response", "Cashu mint returned a malformed amount");
  }
}

function sumProofAmounts(proofs: readonly Proof[]): bigint {
  return proofs.reduce((total, proof) => total + amountToBigInt(proof.amount), 0n);
}

function safeSats(value: bigint): Sats {
  try {
    return sats(value);
  } catch {
    cashuError("malformed_mint_response", "Cashu mint returned an invalid satoshi amount");
  }
}

function validateOperationId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(value) || findForbiddenPublicMaterial(value)) {
    cashuError("operation_rejected", "Cashu operation id is invalid");
  }
  return value;
}

function safeHandle(reference: string): CashuPrivateHandle {
  return Object.freeze({ reference });
}

function reconciliationRequired(operationId: string): CashuReconciliationRequired {
  return Object.freeze({
    status: "submitted_unknown",
    outcome: "reconciliation_required",
    operationId,
  });
}

function mapBackendError(
  error: CashuPrivateBackendError,
  operationId?: string,
): CashuTestMintError {
  const code: CashuTestMintErrorCode =
    error.code === "timeout"
      ? "mint_timeout"
      : error.code === "unavailable"
        ? "mint_unavailable"
        : error.code === "unsupported"
          ? "unsupported_mint_capability"
          : error.code === "insufficient_value"
            ? "insufficient_value"
            : error.code === "proof_already_spent"
              ? "proof_already_spent"
              : error.code === "proof_pending"
                ? "proof_pending"
                : error.code === "malformed_response"
                  ? "malformed_mint_response"
                  : "operation_rejected";
  return new CashuTestMintError(
    code,
    `Cashu test mint operation failed (${code})`,
    error.submissionStatus,
    operationId,
  );
}

class CashuTestMintAdapter implements CashuTestMintPort {
  private capabilities?: ValidatedMintCapabilities;
  private capabilitySnapshot?: CashuMintCapabilitySnapshot;
  private readonly inFlight = new Map<
    string,
    Readonly<{ fingerprint: string; promise: Promise<CashuMutationResult> }>
  >();

  constructor(
    private readonly configuration: NormalizedCashuTestMintConfiguration,
    private readonly backend: CashuMintPrivateBackend,
    private readonly store: CashuPrivateStore,
  ) {}

  async inspectCapabilities(): Promise<ValidatedMintCapabilities> {
    let snapshot: CashuMintCapabilitySnapshot;
    try {
      snapshot = await this.backend.inspectCapabilities();
    } catch (error) {
      if (error instanceof CashuPrivateBackendError) throw mapBackendError(error);
      cashuError("mint_unavailable", "Cashu test mint capability inspection failed");
    }
    if (normalizeCashuTestMintUrl(snapshot.mintUrl) !== this.configuration.testMintUrl) {
      cashuError(
        "invalid_mint_configuration",
        "Cashu capability response does not match the configured test mint",
      );
    }
    for (const nut of CASHU_TEST_MINT_REQUIRED_NUTS) {
      if (snapshot.nuts[nut] !== true) {
        cashuError(
          "unsupported_mint_capability",
          `Configured Cashu test mint does not support required NUT-${nut.toString().padStart(2, "0")}`,
        );
      }
    }
    const satKeysets = snapshot.keysets.filter((keyset) => keyset.unit === CASHU_TEST_MINT_UNIT);
    if (satKeysets.length === 0) {
      cashuError("unsupported_unit", "Configured Cashu test mint does not provide sat keysets");
    }
    if (
      snapshot.keysets.some(
        (keyset) =>
          typeof keyset.id !== "string" ||
          keyset.id.length === 0 ||
          !Number.isSafeInteger(keyset.inputFeePpk) ||
          keyset.inputFeePpk < 0,
      )
    ) {
      cashuError(
        "unsupported_mint_capability",
        "Configured Cashu test mint returned invalid keyset fee metadata",
      );
    }
    const activeKeyset = satKeysets
      .filter((keyset) => keyset.active && keyset.hasKeys)
      .sort(
        (left, right) =>
          left.inputFeePpk - right.inputFeePpk || left.id.localeCompare(right.id),
      )[0];
    if (!activeKeyset) {
      cashuError(
        "unsupported_mint_capability",
        "Configured Cashu test mint has no usable active sat keyset",
      );
    }
    this.capabilitySnapshot = snapshot;
    this.capabilities = Object.freeze({
      mintUrl: this.configuration.testMintUrl,
      unit: CASHU_TEST_MINT_UNIT,
      nuts: Object.freeze({
        nut07ProofState: true,
        nut09Restore: true,
        nut10SpendingConditions: true,
        nut11P2pk: true,
      }),
      activeKeyset: Object.freeze({
        id: activeKeyset.id,
        inputFeePpk: activeKeyset.inputFeePpk,
      }),
    });
    return this.capabilities;
  }

  private async ensureCapabilities(): Promise<ValidatedMintCapabilities> {
    return this.capabilities ?? this.inspectCapabilities();
  }

  private assertProofKeysets(proofs: readonly Proof[]): void {
    const knownSatKeysets = new Set(
      this.capabilitySnapshot?.keysets
        .filter((keyset) => keyset.unit === CASHU_TEST_MINT_UNIT && keyset.hasKeys)
        .map((keyset) => keyset.id) ?? [],
    );
    if (proofs.some((proof) => !knownSatKeysets.has(proof.id))) {
      cashuError(
        "unsupported_mint_capability",
        "Private Cashu value references an unknown or incompatible keyset",
      );
    }
  }

  private async readOperation(operationId: string): Promise<StoredOperation | undefined> {
    let value: unknown;
    try {
      value = await this.store.read(this.configuration.testMintUrl, `operation:${operationId}`);
    } catch {
      cashuError("operation_rejected", "Private Cashu operation storage is unavailable");
    }
    if (value === undefined) return undefined;
    if (!isStoredOperation(value)) {
      cashuError("operation_rejected", "Private Cashu operation storage is malformed");
    }
    return value;
  }

  private async writeOperation(operationId: string, value: StoredOperation): Promise<void> {
    try {
      await this.store.write(
        this.configuration.testMintUrl,
        `operation:${operationId}`,
        Object.freeze(value),
      );
    } catch {
      cashuError("operation_rejected", "Private Cashu operation storage is unavailable");
    }
  }

  private async readValue(handle: CashuPrivateHandle): Promise<PrivateValueRecord> {
    if (!/^cashu_private_[0-9a-f-]{36}$/.test(handle.reference)) {
      cashuError("operation_rejected", "Private Cashu handle is invalid");
    }
    let value: unknown;
    try {
      value = await this.store.read(this.configuration.testMintUrl, `value:${handle.reference}`);
    } catch {
      cashuError("operation_rejected", "Private Cashu value storage is unavailable");
    }
    if (!isPrivateValueRecord(value)) {
      cashuError("operation_rejected", "Private Cashu handle was not found");
    }
    return value;
  }

  private async writeValue(reference: string, value: PrivateValueRecord): Promise<void> {
    try {
      await this.store.write(
        this.configuration.testMintUrl,
        `value:${reference}`,
        Object.freeze(value),
      );
    } catch {
      cashuError("operation_rejected", "Private Cashu value storage is unavailable");
    }
  }

  private runIdempotent(
    operationId: string,
    fingerprint: string,
    operation: () => Promise<CashuMutationResult>,
  ): Promise<CashuMutationResult> {
    const active = this.inFlight.get(operationId);
    if (active) {
      if (active.fingerprint !== fingerprint) {
        return Promise.reject(
          new CashuTestMintError(
            "operation_rejected",
            "Cashu operation id was reused with different parameters",
          ),
        );
      }
      return active.promise;
    }
    const promise = operation().finally(() => this.inFlight.delete(operationId));
    this.inFlight.set(operationId, { fingerprint, promise });
    return promise;
  }

  async prepareLockedValue(input: PrepareLockedValueInput): Promise<CashuMutationResult> {
    const operationId = validateOperationId(input.operationId);
    if (
      typeof input.amountSats !== "bigint" ||
      input.amountSats < 1n ||
      input.amountSats > this.configuration.maximumExposureSats
    ) {
      return Promise.reject(
        new CashuTestMintError(
          "insufficient_value",
          "Requested Cashu value is outside the configured test exposure cap",
          "not_submitted",
          operationId,
        ),
      );
    }
    const condition = validateSpendingCondition(input.spendingCondition);
    const funding = privateFundingMaterial.get(input.funding);
    if (!funding) {
      return Promise.reject(
        new CashuTestMintError(
          "operation_rejected",
          "Private Cashu funding object is invalid",
          "not_submitted",
          operationId,
        ),
      );
    }
    if (
      funding.mintUrl !== this.configuration.testMintUrl ||
      funding.unit !== CASHU_TEST_MINT_UNIT
    ) {
      return Promise.reject(
        new CashuTestMintError(
          "invalid_mint_configuration",
          "Private Cashu funding does not belong to the configured test mint",
          "not_submitted",
          operationId,
        ),
      );
    }
    const fingerprint = JSON.stringify({
      kind: "lock",
      funding: funding.fingerprint,
      amount: input.amountSats.toString(),
      condition: condition.condition,
    });
    return this.runIdempotent(operationId, fingerprint, async () => {
      await this.ensureCapabilities();
      this.assertProofKeysets(funding.proofs);
      const existing = await this.readOperation(operationId);
      if (
        existing &&
        (existing.fingerprint !== fingerprint ||
          existing.status !== "not_submitted" ||
          existing.prepared !== undefined)
      ) {
        return this.resumeExisting(operationId, fingerprint, existing);
      }
      if (sumProofAmounts(funding.proofs) < input.amountSats) {
        const error = new CashuTestMintError(
          "insufficient_value",
          "Private Cashu funding is insufficient",
          "not_submitted",
          operationId,
        );
        await this.writeOperation(operationId, {
          fingerprint,
          kind: "lock",
          status: "not_submitted",
          errorCode: error.code,
          allowedPublicKeys: condition.allowedPublicKeys,
        });
        throw error;
      }
      let prepared: CashuPrivatePreparedSwap;
      try {
        prepared = await this.backend.prepareLock({
          proofs: funding.proofs,
          amountSats: input.amountSats,
          options: condition.options,
        });
      } catch (error) {
        const normalized =
          error instanceof CashuPrivateBackendError
            ? mapBackendError(error, operationId)
            : new CashuTestMintError(
                "operation_rejected",
                "Cashu locked-value preparation failed",
                "not_submitted",
                operationId,
              );
        await this.writeOperation(operationId, {
          fingerprint,
          kind: "lock",
          status: "not_submitted",
          errorCode: normalized.code,
          allowedPublicKeys: condition.allowedPublicKeys,
        });
        throw normalized;
      }
      await this.writeOperation(operationId, {
        fingerprint,
        kind: "lock",
        status: "not_submitted",
        prepared,
        allowedPublicKeys: condition.allowedPublicKeys,
      });
      return this.submitPrepared(
        operationId,
        fingerprint,
        "lock",
        prepared,
        condition.allowedPublicKeys,
      );
    });
  }

  async spendLockedValue(input: SpendLockedValueInput): Promise<CashuMutationResult> {
    const operationId = validateOperationId(input.operationId);
    const secretKey = privateSpendingKeys.get(input.spendingKey);
    if (!secretKey) {
      return Promise.reject(
        new CashuTestMintError(
          "invalid_spending_condition",
          "Cashu spending key object is invalid",
          "not_submitted",
          operationId,
        ),
      );
    }
    const fingerprint = JSON.stringify({
      kind: "spend",
      handle: input.handle.reference,
      publicKey: input.spendingKey.publicKey,
    });
    return this.runIdempotent(operationId, fingerprint, async () => {
      const value = await this.readValue(input.handle);
      if (!value.allowedPublicKeys.includes(input.spendingKey.publicKey)) {
        cashuError(
          "invalid_spending_condition",
          "Cashu spending key does not match the locked value",
          "not_submitted",
          operationId,
        );
      }
      await this.ensureCapabilities();
      this.assertProofKeysets(value.proofs);
      const existing = await this.readOperation(operationId);
      if (
        existing &&
        (existing.fingerprint !== fingerprint ||
          existing.status !== "not_submitted" ||
          existing.prepared !== undefined)
      ) {
        return this.resumeExisting(operationId, fingerprint, existing);
      }
      let prepared: CashuPrivatePreparedSwap;
      try {
        prepared = await this.backend.prepareSpend({
          proofs: value.proofs,
          amountSats: value.amountSats,
          spendingKeyHex: secretKey,
        });
      } catch (error) {
        const normalized =
          error instanceof CashuPrivateBackendError
            ? mapBackendError(error, operationId)
            : new CashuTestMintError(
                "operation_rejected",
                "Cashu locked-value spend preparation failed",
                "not_submitted",
                operationId,
              );
        await this.writeOperation(operationId, {
          fingerprint,
          kind: "spend",
          status: "not_submitted",
          errorCode: normalized.code,
          allowedPublicKeys: [],
        });
        throw normalized;
      }
      await this.writeOperation(operationId, {
        fingerprint,
        kind: "spend",
        status: "not_submitted",
        prepared,
        allowedPublicKeys: [],
      });
      return this.submitPrepared(operationId, fingerprint, "spend", prepared, []);
    });
  }

  private async resumeExisting(
    operationId: string,
    fingerprint: string,
    existing: StoredOperation,
  ): Promise<CashuMutationResult> {
    if (existing.fingerprint !== fingerprint) {
      cashuError(
        "operation_rejected",
        "Cashu operation id was reused with different parameters",
        "not_submitted",
        operationId,
      );
    }
    if (existing.status === "succeeded" && existing.result) return existing.result;
    if (existing.status === "submitted_unknown" && existing.prepared) {
      return this.reconcilePrepared(operationId, existing);
    }
    if (existing.status === "failed_definitively") {
      cashuError(
        existing.errorCode ?? "operation_rejected",
        "Cashu operation previously failed definitively",
        "failed_definitively",
        operationId,
      );
    }
    // A prior not-submitted attempt can be prepared and submitted again safely.
    if (existing.prepared) {
      return this.submitPrepared(
        operationId,
        existing.fingerprint,
        existing.kind,
        existing.prepared,
        existing.allowedPublicKeys,
      );
    }
    cashuError(
      existing.errorCode ?? "operation_rejected",
      "Cashu operation was not submitted",
      "not_submitted",
      operationId,
    );
  }

  private async submitPrepared(
    operationId: string,
    fingerprint: string,
    kind: "lock" | "spend",
    prepared: CashuPrivatePreparedSwap,
    allowedPublicKeys: readonly string[],
  ): Promise<CashuMutationResult> {
    try {
      const result = await this.backend.submit(prepared);
      try {
        return await this.completeSuccessfulOperation(
          operationId,
          fingerprint,
          kind,
          prepared,
          allowedPublicKeys,
          result,
        );
      } catch {
        await this.writeOperation(operationId, {
          fingerprint,
          kind,
          status: "submitted_unknown",
          prepared,
          allowedPublicKeys,
        });
        return reconciliationRequired(operationId);
      }
    } catch (error) {
      if (
        !(error instanceof CashuPrivateBackendError) ||
        error.submissionStatus === "submitted_unknown"
      ) {
        await this.writeOperation(operationId, {
          fingerprint,
          kind,
          status: "submitted_unknown",
          prepared,
          allowedPublicKeys,
        });
        return reconciliationRequired(operationId);
      }
      const normalized = mapBackendError(error, operationId);
      await this.writeOperation(operationId, {
        fingerprint,
        kind,
        status: error.submissionStatus,
        prepared,
        errorCode: normalized.code,
        allowedPublicKeys,
      });
      throw normalized;
    }
  }

  private async reconcilePrepared(
    operationId: string,
    operation: StoredOperation,
  ): Promise<CashuMutationResult> {
    const prepared = operation.prepared;
    if (!prepared) return reconciliationRequired(operationId);
    try {
      const states = await this.backend.inspectProofStates(prepared.inputProofs);
      if (
        states.length !== prepared.inputProofs.length ||
        states.some((state) => !["unspent", "pending", "spent"].includes(state.state)) ||
        !states.every((state) => state.state === "spent")
      ) {
        return reconciliationRequired(operationId);
      }
      const restored = await this.backend.restore(prepared);
      if (!restored) return reconciliationRequired(operationId);
      return this.completeSuccessfulOperation(
        operationId,
        operation.fingerprint,
        operation.kind,
        prepared,
        operation.allowedPublicKeys,
        restored,
      );
    } catch {
      return reconciliationRequired(operationId);
    }
  }

  private async completeSuccessfulOperation(
    operationId: string,
    fingerprint: string,
    kind: "lock" | "spend",
    prepared: CashuPrivatePreparedSwap,
    allowedPublicKeys: readonly string[],
    result: CashuPrivateSwapResult,
  ): Promise<CashuOperationSucceeded> {
    const inputAmount = sumProofAmounts(prepared.inputProofs);
    const outputAmount = sumProofAmounts(result.sendProofs);
    const changeAmount = sumProofAmounts(result.keepProofs);
    const mintFee = inputAmount - outputAmount - changeAmount;
    const reservedSpendFee =
      kind === "lock" ? outputAmount - prepared.requestedAmountSats : 0n;
    if (
      result.sendProofs.length === 0 ||
      inputAmount < 1n ||
      outputAmount < prepared.requestedAmountSats ||
      (kind === "spend" && outputAmount !== prepared.requestedAmountSats) ||
      mintFee < 0n ||
      reservedSpendFee < 0n
    ) {
      cashuError(
        "malformed_mint_response",
        "Cashu mint returned inconsistent value accounting",
        "submitted_unknown",
        operationId,
      );
    }
    this.assertProofKeysets([...result.keepProofs, ...result.sendProofs]);
    const reference = randomPrivateReference("cashu_private");
    await this.writeValue(reference, {
      proofs: result.sendProofs,
      amountSats: prepared.requestedAmountSats,
      allowedPublicKeys: kind === "lock" ? allowedPublicKeys : [],
    });
    const succeeded: CashuOperationSucceeded = Object.freeze({
      status: "succeeded",
      operationId,
      handle: safeHandle(reference),
      facts: Object.freeze({
        mintUrl: this.configuration.testMintUrl,
        unit: CASHU_TEST_MINT_UNIT,
        amountSats: safeSats(prepared.requestedAmountSats),
        inputAmountSats: safeSats(inputAmount),
        outputAmountSats: safeSats(outputAmount),
        changeAmountSats: safeSats(changeAmount),
        mintFeeSats: safeSats(mintFee),
        reservedSpendFeeSats: safeSats(reservedSpendFee),
      }),
    });
    await this.writeOperation(operationId, {
      fingerprint,
      kind,
      status: "succeeded",
      prepared,
      result: succeeded,
      allowedPublicKeys,
    });
    return succeeded;
  }

  async inspectProofState(handle: CashuPrivateHandle): Promise<ProofStateSummary> {
    const value = await this.readValue(handle);
    await this.ensureCapabilities();
    this.assertProofKeysets(value.proofs);
    let states: readonly CashuPrivateProofState[];
    try {
      states = await this.backend.inspectProofStates(value.proofs);
    } catch (error) {
      if (error instanceof CashuPrivateBackendError) throw mapBackendError(error);
      cashuError("mint_unavailable", "Cashu proof-state inspection failed");
    }
    if (
      states.length !== value.proofs.length ||
      states.some((state) => !["unspent", "pending", "spent"].includes(state.state))
    ) {
      cashuError("malformed_mint_response", "Cashu mint returned malformed proof states");
    }
    const unspentCount = states.filter((state) => state.state === "unspent").length;
    const pendingCount = states.filter((state) => state.state === "pending").length;
    const spentCount = states.filter((state) => state.state === "spent").length;
    const state: ProofStateSummary["state"] =
      unspentCount === states.length
        ? "unspent"
        : pendingCount === states.length
          ? "pending"
          : spentCount === states.length
            ? "spent"
            : "mixed";
    return Object.freeze({
      handle: safeHandle(handle.reference),
      state,
      proofCount: states.length,
      unspentCount,
      pendingCount,
      spentCount,
    });
  }
}

/** @internal Constructs the adapter around a deterministic private backend for tests. */
export function createCashuTestMintAdapterWithBackend(input: {
  readonly configuration: CashuTestMintConfiguration;
  readonly backend: CashuMintPrivateBackend;
  readonly privateStore: CashuPrivateStore;
}): CashuTestMintPort {
  return new CashuTestMintAdapter(
    normalizeCashuTestMintConfiguration(input.configuration),
    input.backend,
    input.privateStore,
  );
}

class BoundedCashuRequestError extends Error {
  readonly kind: "timeout" | "unavailable" | "rejected" | "malformed";

  constructor(kind: "timeout" | "unavailable" | "rejected" | "malformed") {
    super("Bounded Cashu request failed");
    this.name = "BoundedCashuRequestError";
    this.kind = kind;
  }
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    throw new BoundedCashuRequestError("malformed");
  }
  if (!response.body) throw new BoundedCashuRequestError("malformed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new BoundedCashuRequestError("malformed");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function endpointBelongsToMint(endpoint: string, mintUrl: string): boolean {
  try {
    const endpointUrl = new URL(endpoint);
    const configured = new URL(mintUrl);
    const basePath = configured.pathname.replace(/\/$/, "");
    return (
      endpointUrl.protocol === "https:" &&
      endpointUrl.origin === configured.origin &&
      (basePath === "" ||
        endpointUrl.pathname === basePath ||
        endpointUrl.pathname.startsWith(`${basePath}/`)) &&
      endpointUrl.username === "" &&
      endpointUrl.password === "" &&
      endpointUrl.hash === ""
    );
  } catch {
    return false;
  }
}

function createBoundedCashuRequest(
  configuration: NormalizedCashuTestMintConfiguration,
): RequestFn {
  return async <T>(options: RequestOptions): Promise<T> => {
    if (!endpointBelongsToMint(options.endpoint, configuration.testMintUrl)) {
      throw new BoundedCashuRequestError("rejected");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), configuration.requestTimeoutMs);
    const body =
      options.requestBody === undefined
        ? undefined
        : JSON.stringify(options.requestBody, (_key, value: unknown) => {
            if (typeof value !== "bigint") return value;
            if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) {
              throw new BoundedCashuRequestError("malformed");
            }
            return Number(value);
          });
    let response: Response;
    try {
      response = await fetch(options.endpoint, {
        method: options.method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
        body,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof BoundedCashuRequestError) throw error;
      throw new BoundedCashuRequestError(controller.signal.aborted ? "timeout" : "unavailable");
    }
    try {
      const text = await readBoundedResponse(response, configuration.maximumResponseBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new BoundedCashuRequestError("malformed");
      }
      if (!response.ok) {
        const failure = parsed as { code?: unknown; detail?: unknown };
        if (typeof failure.code === "number" && typeof failure.detail === "string") {
          throw new MintOperationError(failure.code, failure.detail);
        }
        throw new BoundedCashuRequestError("rejected");
      }
      return parsed as T;
    } finally {
      clearTimeout(timeout);
    }
  };
}

const REDACTING_CASHU_LOGGER: Logger = Object.freeze({
  error(): void {},
  warn(): void {},
  info(): void {},
  debug(): void {},
  trace(): void {},
  log(): void {},
});

interface CashuTsPreparedOpaque {
  readonly preview: SerializedSwapPreview;
  readonly unselectedProofs: readonly string[];
  readonly spendingKeyHex?: string;
}

function isCashuTsPreparedOpaque(value: unknown): value is CashuTsPreparedOpaque {
  return typeof value === "object" && value !== null && "preview" in value && "unselectedProofs" in value;
}

function backendFailure(
  error: unknown,
  submissionStatus: Exclude<CashuOperationStatus, "succeeded">,
): CashuPrivateBackendError {
  if (error instanceof CashuPrivateBackendError) return error;
  if (error instanceof BoundedCashuRequestError) {
    return new CashuPrivateBackendError(
      error.kind === "timeout"
        ? "timeout"
        : error.kind === "unavailable"
          ? "unavailable"
          : error.kind === "malformed"
            ? "malformed_response"
            : "rejected",
      submissionStatus,
    );
  }
  if (error instanceof MintOperationError) {
    const ambiguous = [11001, 11002, 11003, 11004].includes(error.code);
    return new CashuPrivateBackendError(
      error.code === 11001
        ? "proof_already_spent"
        : error.code === 11002
          ? "proof_pending"
          : "rejected",
      ambiguous ? "submitted_unknown" : "failed_definitively",
    );
  }
  return new CashuPrivateBackendError("rejected", submissionStatus);
}

class CashuTsMintBackend implements CashuMintPrivateBackend {
  private readonly mint: Mint;
  private readonly wallet: Wallet;
  private walletLoaded = false;

  constructor(private readonly configuration: NormalizedCashuTestMintConfiguration) {
    this.mint = new Mint(configuration.testMintUrl, {
      customRequest: createBoundedCashuRequest(configuration),
      logger: REDACTING_CASHU_LOGGER,
    });
    this.wallet = new Wallet(this.mint, {
      unit: CASHU_TEST_MINT_UNIT,
      logger: REDACTING_CASHU_LOGGER,
    });
  }

  async inspectCapabilities(): Promise<CashuMintCapabilitySnapshot> {
    try {
      const [info, keysetResponse] = await Promise.all([
        this.mint.getInfo(),
        this.mint.getKeySets(),
      ]);
      const keyIdsWithKeys = new Set<string>();
      for (const keyset of keysetResponse.keysets.filter((value) => value.active)) {
        const response = await this.mint.getKeys(keyset.id);
        const keys = response.keysets.find((value) => value.id === keyset.id);
        if (keys && Keyset.fromMintApi(keyset, keys).verify()) keyIdsWithKeys.add(keyset.id);
      }
      return {
        mintUrl: this.configuration.testMintUrl,
        nuts: {
          7: info.nuts["7"]?.supported === true,
          9: info.nuts["9"]?.supported === true,
          10: info.nuts["10"]?.supported === true,
          11: info.nuts["11"]?.supported === true,
        },
        keysets: keysetResponse.keysets.map((keyset: MintKeyset) => ({
          id: keyset.id,
          unit: keyset.unit,
          active: keyset.active,
          inputFeePpk: keyset.input_fee_ppk ?? 0,
          hasKeys: keyIdsWithKeys.has(keyset.id),
        })),
      };
    } catch (error) {
      throw backendFailure(error, "not_submitted");
    }
  }

  private async ensureWallet(): Promise<void> {
    if (this.walletLoaded) return;
    try {
      await this.wallet.loadMint();
      this.walletLoaded = true;
    } catch (error) {
      throw backendFailure(error, "not_submitted");
    }
  }

  private prepared(
    kind: "lock" | "spend",
    preview: SwapPreview,
    spendingKeyHex?: string,
  ): CashuPrivatePreparedSwap {
    return {
      kind,
      inputProofs: preview.inputs,
      requestedAmountSats: amountToBigInt(preview.amount),
      opaque: {
        preview: serializeSwapPreview(preview),
        unselectedProofs: serializeProofs(preview.unselectedProofs ?? []),
        ...(spendingKeyHex === undefined ? {} : { spendingKeyHex }),
      } satisfies CashuTsPreparedOpaque,
    };
  }

  async prepareLock(input: {
    readonly proofs: readonly Proof[];
    readonly amountSats: bigint;
    readonly options: P2PKOptions;
  }): Promise<CashuPrivatePreparedSwap> {
    await this.ensureWallet();
    try {
      const preview = await this.wallet.ops
        .send(input.amountSats, [...input.proofs])
        .asLocked(input.options)
        .keepAsRandom()
        .includeFees(true)
        .prepare();
      return this.prepared("lock", preview);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      throw new CashuPrivateBackendError(
        message.includes("insufficient") ? "insufficient_value" : "rejected",
        "not_submitted",
      );
    }
  }

  async prepareSpend(input: {
    readonly proofs: readonly Proof[];
    readonly amountSats: bigint;
    readonly spendingKeyHex: string;
  }): Promise<CashuPrivatePreparedSwap> {
    await this.ensureWallet();
    try {
      const preview = await this.wallet.ops
        .send(input.amountSats, [...input.proofs])
        .asRandom()
        .keepAsRandom()
        .prepare();
      return this.prepared("spend", preview, input.spendingKeyHex);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      throw new CashuPrivateBackendError(
        message.includes("insufficient") ? "insufficient_value" : "rejected",
        "not_submitted",
      );
    }
  }

  private preview(value: CashuTsPreparedOpaque): SwapPreview {
    const preview = deserializeSwapPreview(value.preview);
    return {
      ...preview,
      unselectedProofs: deserializeProofs([...value.unselectedProofs]),
    };
  }

  async submit(prepared: CashuPrivatePreparedSwap): Promise<CashuPrivateSwapResult> {
    if (!isCashuTsPreparedOpaque(prepared.opaque)) {
      throw new CashuPrivateBackendError("malformed_response", "not_submitted");
    }
    try {
      const result = await this.wallet.completeSwap(
        this.preview(prepared.opaque),
        prepared.opaque.spendingKeyHex,
      );
      return { keepProofs: result.keep, sendProofs: result.send };
    } catch (error) {
      throw backendFailure(error, "submitted_unknown");
    }
  }

  async inspectProofStates(proofs: readonly Proof[]): Promise<readonly CashuPrivateProofState[]> {
    await this.ensureWallet();
    try {
      const states = await this.wallet.checkProofsStates([...proofs]);
      return states.map((state) => ({
        state:
          state.state === CheckStateEnum.UNSPENT
            ? "unspent"
            : state.state === CheckStateEnum.PENDING
              ? "pending"
              : "spent",
      }));
    } catch (error) {
      throw backendFailure(error, "not_submitted");
    }
  }

  async restore(prepared: CashuPrivatePreparedSwap): Promise<CashuPrivateSwapResult | undefined> {
    if (!isCashuTsPreparedOpaque(prepared.opaque)) return undefined;
    await this.ensureWallet();
    try {
      const preview = this.preview(prepared.opaque);
      const keepOutputs = preview.keepOutputs ?? [];
      const sendOutputs = preview.sendOutputs ?? [];
      const allOutputs = [...keepOutputs, ...sendOutputs];
      const restored = await this.mint.restore({
        outputs: allOutputs.map((output) => output.blindedMessage),
      });
      const signatures = new Map<string, SerializedBlindedSignature>();
      restored.outputs.forEach((output, index) => {
        const signature = restored.signatures[index];
        if (signature) signatures.set(output.B_, signature);
      });
      if (signatures.size !== allOutputs.length) return undefined;
      const keyset = this.wallet.getKeyset(preview.keysetId);
      const toProofs = (outputs: typeof allOutputs): Proof[] =>
        outputs.map((output) => {
          const signature = signatures.get(output.blindedMessage.B_);
          if (!signature) throw new Error("missing restored signature");
          return output.toProof(signature, keyset);
        });
      return {
        keepProofs: [
          ...toProofs(keepOutputs),
          ...deserializeProofs([...prepared.opaque.unselectedProofs]),
        ],
        sendProofs: toProofs(sendOutputs),
      };
    } catch (error) {
      throw backendFailure(error, "submitted_unknown");
    }
  }
}

export function createCashuTestMintAdapter(input: {
  readonly configuration: CashuTestMintConfiguration;
  readonly privateStore: CashuPrivateStore;
}): CashuTestMintPort {
  const configuration = normalizeCashuTestMintConfiguration(input.configuration);
  return new CashuTestMintAdapter(
    configuration,
    new CashuTsMintBackend(configuration),
    input.privateStore,
  );
}
