import "server-only";

import { getDecodedToken, type Proof } from "@cashu/cashu-ts";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { sats } from "../domain/money";
import {
  createBoundedCashuWallet,
  createCashuPrivateFundingSource,
  createCashuPrivateValueDelivery,
  createCashuTestMintAdapter,
  createPrivateCashuFunding,
  createPrivateCashuProofImport,
  createPrivateCashuSpendingKey,
  createSqliteCashuPrivateStore,
  isPrivateCashuSpendingKey,
  normalizeCashuMintUrl,
  normalizeDemoPrivateHostAllowlist,
  readCashuPrivateValueProofs,
  type CashuMintTransportPolicy,
  type CashuPrivateStore,
  type CashuPrivateValueDeliveryPort,
  type CashuTestMintConfiguration,
  type CashuTestMintPort,
  type PrivateCashuFunding,
  type PrivateCashuSpendingKey,
  type SqliteCashuPrivateStore,
} from "./cashu-test-mint";
import {
  createSqlitePactCashuEscrowSettlementStore,
  type PactCashuEscrowSettlementStore,
  type SqlitePactCashuEscrowSettlementStore,
} from "./cashu-escrow-settlement";

/*
 * Economic environment abstraction (Issue #35).
 *
 * The single authoritative economic composition boundary. Production code
 * must construct economic resources through this module, not by directly
 * building Cashu adapters, private stores, settlement stores, spending keys,
 * or funding resolvers elsewhere.
 *
 * The mode is explicit and fails closed. It is never inferred from the mint
 * URL. There is no automatic fallback live → demo or demo → live.
 *
 * PactAgentWorkflowDependencies remains mode-agnostic. The workflow, agreement,
 * escrow, NIP-59, settlement, and reconciliation layers do not know the mode.
 * Only this composition layer does.
 *
 * This module is server-only. It carries private stores, spending keys, and
 * funding resolution. It must never enter a browser bundle.
 */

export type EconomicMode = "demo" | "live";

export type EconomicEnvironmentErrorCode =
  | "invalid_economic_mode"
  | "economic_mode_required"
  | "economic_mode_conflict"
  | "demo_economic_environment_not_configured"
  | "demo_funding_exhausted"
  | "demo_wallet_not_started"
  | "demo_provisioning_reconciliation_required"
  | "demo_reset_blocked";

export class EconomicEnvironmentError extends Error {
  readonly code: EconomicEnvironmentErrorCode;

  constructor(code: EconomicEnvironmentErrorCode, message: string) {
    super(message);
    this.name = "EconomicEnvironmentError";
    this.code = code;
  }

  toJSON(): Readonly<{ name: string; code: EconomicEnvironmentErrorCode; message: string }> {
    return Object.freeze({ name: this.name, code: this.code, message: this.message });
  }
}

/**
 * Parse an explicit economic mode. Fail closed on anything other than the two
 * literal supported values. Never infer mode from mint URL or configuration
 * presence.
 */
export function parseEconomicMode(value: unknown): EconomicMode {
  if (value === "demo" || value === "live") return value;
  throw new EconomicEnvironmentError(
    "invalid_economic_mode",
    'Economic mode must be explicitly set to "demo" or "live"',
  );
}

/*
 * Capability semantics (Blocker 3):
 *
 * mintAvailable:
 *   The configured mint can be contacted and exposes the required NUT
 *   capabilities and active sat keysets. Derived from an actual
 *   `cashu.inspectCapabilities()` probe. Does not spend, mint, or mutate
 *   economic state.
 *
 * walletReady:
 *   The wallet implementation can initialize sufficiently to perform the
 *   required Cashu operations. Derived from a concrete construction-time
 *   fact, not a separate economic probe: a successfully constructed economic
 *   environment has already executed `cashu.inspectCapabilities()` (mint
 *   metadata loaded, required NUT-07/09/10/11 capabilities and active sat
 *   keysets obtained) and imported or restored funding. That demonstrated
 *   initialization is the minimum readiness fact for the #35 definition
 *   ("Wallet implementation can initialize for Cashu operations"). It is
 *   asserted by the production factories at construction and returned as-is
 *   by `inspectCapabilities()` without repeating an economic action. The
 *   low-level factory accepts it as an explicit composer-asserted input.
 *
 * fundingAvailable:
 *   The economic environment has a successfully configured, resolvable funding
 *   source that `resolveFunding` can return. For a live environment that has
 *   successfully imported and bound funding, this is `true`. For a demo
 *   environment with restored or freshly bootstrapped funding, this is `true`
 *   while unspent demo funding remains. Does not expose funding amount,
 *   proofs, token, or reference material.
 *
 * demoResetAvailable:
 *   The implementation supports the demo reset operation. `false` at #36;
 *   automatic demo replenishment is explicitly deferred to #37. An operator
 *   may replenish exhausted demo funding through an explicit bootstrap
 *   command rather than silent re-minting on restart.
 */

/**
 * Safe, secret-free server-side capability projection. Every field is derived
 * from the actual implementation, not from promises about future milestones.
 * Never exposes proofs, wallet secrets, mint private keys, seed material,
 * bearer tokens, or funding tokens.
 */
export interface EconomicEnvironmentCapabilities {
  readonly mode: EconomicMode;
  readonly unit: "sat";
  readonly mintAvailable: boolean;
  readonly fundingAvailable: boolean;
  readonly walletReady: boolean;
  readonly demoResetAvailable: boolean;
}

/**
 * The economic environment boundary. Owns the Cashu wallet/mint ports,
 * settlement store, private store, spending keys, and funding resolution.
 * The workflow consumes the same `PactAgentWorkflowDependencies` regardless of
 * mode; only the composition below this boundary differs.
 */
export interface EconomicEnvironment {
  readonly mode: EconomicMode;
  readonly mintUrl: string;
  readonly unit: "sat";
  readonly cashu: CashuTestMintPort;
  readonly privateDelivery: CashuPrivateValueDeliveryPort;
  readonly privateStore: CashuPrivateStore;
  readonly settlementStore: PactCashuEscrowSettlementStore;
  readonly normalSpendKey: PrivateCashuSpendingKey;
  readonly refundSpendKey: PrivateCashuSpendingKey;
  readonly resolveFunding: (reference: string) => Promise<PrivateCashuFunding>;
  readonly close: () => void;
  readonly collectWalletOutputs: (walletKey: string, escrowReference: string) => Promise<void>;
  readonly bindDemoTransactionFunding?: (
    walletKey: string,
    transactionId: string,
  ) => Promise<DemoTransactionFundingBinding>;
  readonly finalizeDemoTransaction?: (
    fundingReference: string,
    transactionId: string,
    outcome: DemoTransactionTerminalOutcome,
    escrowReference?: string,
  ) => Promise<void>;
  readonly resetDemoWallet?: (walletKey: string, idempotencyKey: string) => Promise<WalletSnapshot>;
  readonly walletBalance?: (walletKey: string) => Promise<WalletBalance>;
  readonly demoWalletStatus?: (walletKey: string) => Promise<DemoWalletStatus>;
  readonly startDemoWallet?: (walletKey: string) => Promise<WalletSnapshot>;
  readonly demoWalletExists?: (walletKey: string) => Promise<boolean>;
  inspectCapabilities(): Promise<EconomicEnvironmentCapabilities>;
}

export interface CreateEconomicEnvironmentInput {
  readonly mode: EconomicMode;
  readonly mintUrl: string;
  readonly allowedDemoPrivateHosts?: readonly string[];
  readonly cashu: CashuTestMintPort;
  readonly privateDelivery: CashuPrivateValueDeliveryPort;
  readonly privateStore: CashuPrivateStore;
  readonly settlementStore: PactCashuEscrowSettlementStore;
  readonly normalSpendKey: PrivateCashuSpendingKey;
  readonly refundSpendKey: PrivateCashuSpendingKey;
  readonly resolveFunding: (reference: string) => Promise<PrivateCashuFunding>;
  readonly collectWalletOutputs: (walletKey: string, escrowReference: string) => Promise<void>;
  readonly bindDemoTransactionFunding?: (
    walletKey: string,
    transactionId: string,
  ) => Promise<DemoTransactionFundingBinding>;
  readonly finalizeDemoTransaction?: (
    fundingReference: string,
    transactionId: string,
    outcome: DemoTransactionTerminalOutcome,
    escrowReference?: string,
  ) => Promise<void>;
  readonly resetDemoWallet?: (walletKey: string, idempotencyKey: string) => Promise<WalletSnapshot>;
  readonly walletBalance?: (walletKey: string) => Promise<WalletBalance>;
  readonly demoWalletStatus?: (walletKey: string) => Promise<DemoWalletStatus>;
  readonly startDemoWallet?: (walletKey: string) => Promise<WalletSnapshot>;
  readonly demoWalletExists?: (walletKey: string) => Promise<boolean>;
  readonly fundingAvailable: boolean;
  /**
   * Construction-time wallet readiness fact. Production factories assert
   * `true` after successfully executing `inspectCapabilities()` and
   * importing/restoring funding. Defaults to `false` for low-level test
   * composition that does not demonstrate real initialization.
   */
  readonly walletReady?: boolean;
  readonly close: () => void;
}

/**
 * Create an economic environment from an explicit mode and pre-built economic
 * ports. This low-level factory is used by tests that inject fake adapters.
 * The mint URL is server-side configuration only; it is never accepted from the
 * browser. Validates that spending keys are distinct private NUT-11 keys.
 */
export function createEconomicEnvironment(
  input: CreateEconomicEnvironmentInput,
): EconomicEnvironment {
  const mode = parseEconomicMode(input.mode);
  const transportPolicy: CashuMintTransportPolicy = mode === "demo" ? "demo-loopback" : "live-https";
  const mintUrl = normalizeCashuMintUrl(input.mintUrl, transportPolicy, input.allowedDemoPrivateHosts);
  if (
    !isPrivateCashuSpendingKey(input.normalSpendKey) ||
    !isPrivateCashuSpendingKey(input.refundSpendKey) ||
    input.normalSpendKey.publicKey === input.refundSpendKey.publicKey
  ) {
    throw new EconomicEnvironmentError(
      "economic_mode_conflict",
      "Economic environment requires distinct private Cashu spend and refund keys",
    );
  }
  const fundingAvailable = input.fundingAvailable;
  const walletReady = input.walletReady ?? false;
  return Object.freeze({
    mode,
    mintUrl,
    unit: "sat" as const,
    cashu: input.cashu,
    privateDelivery: input.privateDelivery,
    privateStore: input.privateStore,
    settlementStore: input.settlementStore,
    normalSpendKey: input.normalSpendKey,
    refundSpendKey: input.refundSpendKey,
    resolveFunding: input.resolveFunding,
    close: input.close,
    collectWalletOutputs: input.collectWalletOutputs,
    ...(input.bindDemoTransactionFunding === undefined
      ? {}
      : { bindDemoTransactionFunding: input.bindDemoTransactionFunding }),
    ...(input.finalizeDemoTransaction === undefined
      ? {}
      : { finalizeDemoTransaction: input.finalizeDemoTransaction }),
    ...(input.resetDemoWallet === undefined ? {} : { resetDemoWallet: input.resetDemoWallet }),
    ...(input.walletBalance === undefined ? {} : { walletBalance: input.walletBalance }),
    ...(input.demoWalletStatus === undefined ? {} : { demoWalletStatus: input.demoWalletStatus }),
    ...(input.startDemoWallet === undefined ? {} : { startDemoWallet: input.startDemoWallet }),
    ...(input.demoWalletExists === undefined ? {} : { demoWalletExists: input.demoWalletExists }),
    async inspectCapabilities(): Promise<EconomicEnvironmentCapabilities> {
      let mintAvailable = false;
      try {
        await input.cashu.inspectCapabilities();
        mintAvailable = true;
      } catch {
        mintAvailable = false;
      }
      return Object.freeze({
        mode,
        unit: "sat",
        mintAvailable,
        fundingAvailable,
        walletReady,
        demoResetAvailable: input.resetDemoWallet !== undefined,
      });
    },
  });
}

export interface LiveEconomicEnvironmentConfig {
  readonly mintUrl: string;
  readonly stateDirectory: string;
  readonly normalSpendKeyHex: string;
  readonly refundSpendKeyHex: string;
  readonly fundingToken: string;
  readonly fundingReference: string;
}

/**
 * @internal Test-injectable factory overrides for deterministic lifecycle
 * testing. Production code never passes this parameter; the real factories
 * are used by default. Tests inject custom factories to observe real close
 * calls on real production objects (SQLite stores, Cashu adapter) without
 * external network dependencies.
 */
export interface LiveEconomicEnvironmentFactories {
  readonly createPrivateStore?: (databasePath: string) => SqliteCashuPrivateStore;
  readonly createSettlementStore?: (databasePath: string) => SqlitePactCashuEscrowSettlementStore;
  readonly createCashuAdapter?: (config: {
    readonly mintUrl: string;
    readonly privateStore: CashuPrivateStore;
    readonly transportPolicy: CashuMintTransportPolicy;
  }) => CashuTestMintPort;
  /** @internal Deterministic failure-injection seam for Demo provisioning. */
  readonly createDemoProofWallet?: (
    configuration: CashuTestMintConfiguration,
  ) => ReturnType<typeof createBoundedCashuWallet>;
}

/**
 * Close all resources in reverse acquisition order, attempting every cleanup
 * even if an earlier close fails. Returns the first error encountered (if any),
 * so the caller can preserve/rethrow the original construction error.
 */
function closeAll(resources: ReadonlyArray<() => void>): void {
  let firstError: unknown;
  for (let i = resources.length - 1; i >= 0; i--) {
    try {
      resources[i]();
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

/**
 * Production factory for the live economic environment. Constructs the SQLite
 * private store, settlement store, Cashu adapter, private delivery, spending
 * keys, and funding resolver from server-side configuration. This is the
 * single authoritative economic composition site for live mode.
 *
 * Resource acquisition is staged: if a later step fails, every previously
 * acquired closeable resource is closed in reverse acquisition order. The
 * original construction error is preserved and rethrown after cleanup.
 *
 * Demo mode is not available through this factory. Before #36 implements the
 * FakeWallet-backed demo mint, demo composition must fail explicitly.
 */
export async function createLiveEconomicEnvironment(
  config: LiveEconomicEnvironmentConfig,
  factories?: LiveEconomicEnvironmentFactories,
): Promise<EconomicEnvironment> {
  const mintUrl = normalizeCashuMintUrl(config.mintUrl, "live-https");
  const stateDirectory = resolve(config.stateDirectory);

  const createPrivateStore = factories?.createPrivateStore ?? ((dbPath: string) =>
    createSqliteCashuPrivateStore(dbPath));
  const createSettlementStoreFn = factories?.createSettlementStore ?? ((dbPath: string) =>
    createSqlitePactCashuEscrowSettlementStore(dbPath));
  const createCashuAdapterFn = factories?.createCashuAdapter ?? ((cfg: {
    readonly mintUrl: string;
    readonly privateStore: CashuPrivateStore;
    readonly transportPolicy: CashuMintTransportPolicy;
  }) =>
    createCashuTestMintAdapter({
      configuration: {
        testMintUrl: cfg.mintUrl,
        unit: "sat",
        maximumExposureSats: sats(400n),
        requestTimeoutMs: 10_000,
        maximumResponseBytes: 500_000,
        transportPolicy: cfg.transportPolicy,
      },
      privateStore: cfg.privateStore,
    }));

  // Staged acquisition: track each closeable resource for reverse-order cleanup.
  const closeables: Array<() => void> = [];
  let fundingImported = false;

  try {
    // 1. SQLite private Cashu store
    const privateStore = createPrivateStore(
      join(stateDirectory, "cashu-private.sqlite"),
    );
    closeables.push(() => privateStore.close());

    // 2. SQLite settlement store
    const settlementStore = createSettlementStoreFn(
      join(stateDirectory, "escrow-settlement.sqlite"),
    );
    closeables.push(() => settlementStore.close());

    // 3. Cashu adapter (not closeable, but may fail)
    const cashu = createCashuAdapterFn({
      mintUrl,
      privateStore,
      transportPolicy: "live-https",
    });

    // 4. Private delivery (not closeable separately)
    const privateDelivery = createCashuPrivateValueDelivery({
      configuration: {
        testMintUrl: mintUrl,
        unit: "sat",
        maximumExposureSats: sats(400n),
        transportPolicy: "live-https",
      },
      privateStore,
    });

    // 5. Spending keys (not closeable)
    const normalSpendKey = createPrivateCashuSpendingKey({
      purpose: "cashu-nut11",
      secretKeyHex: config.normalSpendKeyHex,
    });
    const refundSpendKey = createPrivateCashuSpendingKey({
      purpose: "cashu-nut11",
      secretKeyHex: config.refundSpendKeyHex,
    });

    // 6. Mint capability inspection (may throw on mint unavailability)
    const capabilities = await cashu.inspectCapabilities();

    // 7. Funding token decoding and import (may throw on invalid token)
    const decoded = getDecodedToken(config.fundingToken, capabilities.acceptedKeysetIds);
    if (decoded.unit !== undefined && decoded.unit !== "sat") {
      throw new EconomicEnvironmentError(
        "economic_mode_conflict",
        "Live funding token does not use the sat unit",
      );
    }
    const source = createCashuPrivateFundingSource({
      configuration: {
        testMintUrl: mintUrl,
        unit: "sat",
        maximumExposureSats: sats(400n),
        requestTimeoutMs: 10_000,
        maximumResponseBytes: 500_000,
        transportPolicy: "live-https",
      },
      cashu,
    });
    const imported = createPrivateCashuProofImport({
      mintUrl: decoded.mint,
      unit: "sat",
      proofs: decoded.proofs,
    });
    const funding = await source.importFunding(imported);

    // 8. Funding-reference persistence (may throw on store failure)
    await privateStore.write("funding-reference", config.fundingReference, {
      version: 1,
      source: "configured-live-import",
    });
    fundingImported = true;

    return createEconomicEnvironment({
      mode: "live",
      mintUrl,
      cashu,
      privateDelivery,
      privateStore,
      settlementStore,
      normalSpendKey,
      refundSpendKey,
      fundingAvailable: fundingImported,
      walletReady: true,
      close() {
        closeAll([() => settlementStore.close(), () => privateStore.close()]);
      },
      resolveFunding: async (reference: string): Promise<PrivateCashuFunding> => {
        const lookupReference =
          reference === "legacy-configured-funding" ? config.fundingReference : reference;
        const authorization = await privateStore.read("funding-reference", lookupReference);
        if (
          (reference !== config.fundingReference && reference !== "legacy-configured-funding") ||
          typeof authorization !== "object" ||
          authorization === null ||
          (authorization as { source?: unknown }).source !== "configured-live-import"
        ) {
          throw new EconomicEnvironmentError(
            "economic_mode_conflict",
            "Funding reference was not found",
          );
        }
        return funding;
      },
      collectWalletOutputs: async () => {
        // Live mode does not use the Demo Wallet model. Output handles from
        // live escrow operations are managed by the operator, not aggregated
        // into a wallet-owned funding source.
      },
    });
  } catch (constructionError) {
    // Close all previously acquired resources in reverse order.
    // Cleanup errors do not replace the original construction error.
    try {
      closeAll(closeables);
    } catch {
      // Preserve the original construction error; suppress cleanup errors.
    }
    throw constructionError;
  }
}

export interface DemoEconomicEnvironmentConfig {
  readonly mintUrl: string;
  readonly stateDirectory: string;
  readonly normalSpendKeyHex: string;
  readonly refundSpendKeyHex: string;
  readonly fundingReference: string;
  /**
   * Initial demo wallet allocation in sats. Server-controlled, never accepted
   * from the browser. Defaults to 1000 (Issue #37). The #36 400-sat bootstrap
   * is superseded by this per-session allocation.
   */
  readonly initialBalanceSats?: number;
  /**
   * Explicit private-network DNS hosts allowed for HTTP demo mint transport
   * (Issue #39 Railway deployment). Only DNS names (no IPs, no wildcards).
   * HTTPS and HTTP loopback remain allowed without listing. The live economic
   * policy is never affected by this list.
   */
  readonly allowedPrivateHosts?: readonly string[];
}

/**
 * Private store scope for durable demo funding material. The encoded token
 * persisted under this scope is server-only private application state stored
 * in the demo private SQLite store (chmod 0600). It is never logged, never
 * placed in browser-accessible storage, never placed in requester DTOs, and
 * never placed in plaintext config/.env. It lives under the demo state
 * boundary and is never reused by live composition.
 */
const DEMO_FUNDING_STORE_SCOPE = "demo-funding";
const DEMO_FUNDING_SOURCE = "demo-mint-bootstrap";

interface PersistedDemoFunding {
  readonly version: 1;
  readonly token: string;
  readonly mintUrl: string;
  readonly unit: "sat";
  readonly source: "demo-mint-bootstrap";
  readonly createdAt: number;
}

function asPersistedDemoFunding(value: unknown): PersistedDemoFunding | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.source !== DEMO_FUNDING_SOURCE) return undefined;
  if (typeof record.token !== "string" || record.token.length === 0) return undefined;
  if (typeof record.mintUrl !== "string" || record.unit !== "sat") return undefined;
  return {
    version: 1,
    token: record.token,
    mintUrl: record.mintUrl,
    unit: "sat",
    source: DEMO_FUNDING_SOURCE,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
  };
}

/*
 * Demo Wallet model (Issue #37 Amendment).
 *
 * A Demo Wallet owns multiple private Cashu value handles resulting from:
 *   - initial allocation (bootstrap minting)
 *   - transaction change (from prepareLockedValue)
 *   - timeout refund (from refundEscrow)
 *   - settlement change (from releaseEscrow)
 *
 * The wallet balance is derived from all wallet-owned authoritative Cashu value,
 * not merely the original bootstrap token. resolveFunding aggregates unspent
 * proofs across all registered handles.
 *
 * The wallet record is stored under ("demo-wallet", "current").
 * Handle entries are stored under ("demo-wallet-handles", <handleReference>).
 */

const DEMO_WALLET_SCOPE = "demo-wallet";
const DEMO_WALLET_HANDLES_SCOPE = "demo-wallet-handles";

export type DemoWalletHandleSource =
  | "initial-funding"
  | "funding-change"
  | "refund"
  | "refund-change"
  | "settlement-change";

interface PersistedDemoWallet {
  readonly version: 1;
  readonly walletId: string;
  readonly walletKey: string;
  readonly generation: number;
  readonly status: "provisioning" | "active" | "retired";
  readonly mintUrl: string;
  readonly unit: "sat";
  readonly createdAt: number;
  readonly retiredAt?: number;
  readonly handleReferences: readonly string[];
  readonly transactionIds: readonly string[];
}

interface DemoWalletHandleEntry {
  readonly version: 1;
  readonly walletId: string;
  readonly walletKey: string;
  readonly generation: number;
  readonly transactionId: string;
  readonly escrowReference: string;
  readonly handleReference: string;
  readonly source: DemoWalletHandleSource;
  readonly amountSats: string;
  readonly createdAt: number;
}

export interface WalletBalance {
  readonly availableSats: bigint;
  readonly generation: number;
}

export interface WalletSnapshot {
  readonly walletId: string;
  readonly generation: number;
}

export type DemoTransactionTerminalOutcome =
  | "settled"
  | "refunded"
  | "resolved_not_funded";

export interface DemoTransactionFundingBinding {
  readonly fundingReference: string;
  readonly generation: number;
}

export interface DemoWalletStatus extends WalletBalance {
  readonly resetAvailable: boolean;
  readonly accountingPending: boolean;
}

interface ProvisioningRecord {
  readonly version: 1;
  readonly walletKey: string;
  readonly operation: "start" | "reset";
  readonly generation: number;
  readonly sourceGeneration: number;
  readonly idempotencyKey: string;
  readonly quoteId: string;
  readonly state:
    | "quote_created"
    | "mint_submitting"
    | "token_persisted"
    | "complete"
    | "reconciliation_required";
  readonly token?: string;
  readonly walletId?: string;
  readonly createdAt: number;
}

interface DemoWalletTransactionBinding {
  readonly version: 1;
  readonly walletKey: string;
  readonly walletId: string;
  readonly generation: number;
  readonly transactionId: string;
  readonly fundingReference: string;
  readonly state: "bound" | "collection_pending" | "complete";
  readonly outcome?: DemoTransactionTerminalOutcome;
  readonly escrowReference?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const DEMO_WALLET_PROVISIONING_SCOPE = "demo-wallet-provisioning";
const DEMO_WALLET_TRANSACTION_SCOPE = "demo-wallet-transactions";
const DEMO_WALLET_GENERATION_SCOPE = "demo-wallet-generations";
const DEMO_WALLET_INITIAL_BALANCE_MAXIMUM_SATS = 100_000;
const RESET_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/;
const WALLET_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;

function asPersistedDemoWallet(value: unknown): PersistedDemoWallet | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  if (typeof record.walletId !== "string" || typeof record.generation !== "number") return undefined;
  if (record.status !== "provisioning" && record.status !== "active" && record.status !== "retired") return undefined;
  if (typeof record.walletKey !== "string") return undefined;
  if (typeof record.mintUrl !== "string" || record.unit !== "sat") return undefined;
  if (typeof record.createdAt !== "number") return undefined;
  if (!Array.isArray(record.handleReferences)) return undefined;
  if (!record.handleReferences.every((r) => typeof r === "string")) return undefined;
  if (record.transactionIds !== undefined && !Array.isArray(record.transactionIds)) return undefined;
  if (
    Array.isArray(record.transactionIds) &&
    !record.transactionIds.every((transactionId) => typeof transactionId === "string" && TRANSACTION_ID.test(transactionId))
  ) return undefined;
  return {
    version: 1,
    walletId: record.walletId,
    walletKey: record.walletKey,
    generation: record.generation,
    status: record.status as "provisioning" | "active" | "retired",
    mintUrl: record.mintUrl,
    unit: "sat",
    createdAt: record.createdAt,
    ...(typeof record.retiredAt === "number" ? { retiredAt: record.retiredAt } : {}),
    handleReferences: Object.freeze([...record.handleReferences]),
    transactionIds: Object.freeze(
      Array.isArray(record.transactionIds) ? [...record.transactionIds] as string[] : [],
    ),
  };
}

function asProvisioningRecord(value: unknown): ProvisioningRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  if (typeof record.walletKey !== "string" || typeof record.quoteId !== "string") return undefined;
  if (typeof record.generation !== "number" || typeof record.sourceGeneration !== "number") return undefined;
  if (typeof record.idempotencyKey !== "string" || !RESET_IDEMPOTENCY_KEY.test(record.idempotencyKey)) return undefined;
  if (typeof record.createdAt !== "number") return undefined;
  if (record.operation !== "start" && record.operation !== "reset") return undefined;
  if (![
    "quote_created",
    "mint_submitting",
    "token_persisted",
    "complete",
    "reconciliation_required",
  ].includes(record.state as string)) return undefined;
  if (record.token !== undefined && typeof record.token !== "string") return undefined;
  if (record.walletId !== undefined && typeof record.walletId !== "string") return undefined;
  return {
    version: 1,
    walletKey: record.walletKey,
    operation: record.operation as "start" | "reset",
    generation: record.generation,
    sourceGeneration: record.sourceGeneration,
    idempotencyKey: record.idempotencyKey,
    quoteId: record.quoteId,
    state: record.state as ProvisioningRecord["state"],
    ...(typeof record.token === "string" ? { token: record.token } : {}),
    ...(typeof record.walletId === "string" ? { walletId: record.walletId } : {}),
    createdAt: record.createdAt,
  };
}

/** @internal Parses a wallet handle entry from a stored value. */
export function parseDemoWalletHandleEntry(value: unknown): DemoWalletHandleEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  if (
    typeof record.walletId !== "string" ||
    typeof record.walletKey !== "string" ||
    typeof record.generation !== "number" ||
    typeof record.transactionId !== "string" ||
    typeof record.escrowReference !== "string" ||
    typeof record.handleReference !== "string"
  ) return undefined;
  if (typeof record.amountSats !== "string" || typeof record.createdAt !== "number") return undefined;
  const validSources: readonly DemoWalletHandleSource[] = [
    "initial-funding", "funding-change", "refund", "refund-change", "settlement-change",
  ];
  if (!validSources.includes(record.source as DemoWalletHandleSource)) return undefined;
  return {
    version: 1,
    walletId: record.walletId,
    walletKey: record.walletKey,
    generation: record.generation,
    transactionId: record.transactionId,
    escrowReference: record.escrowReference,
    handleReference: record.handleReference,
    source: record.source as DemoWalletHandleSource,
    amountSats: record.amountSats,
    createdAt: record.createdAt,
  };
}

function asDemoWalletTransactionBinding(value: unknown): DemoWalletTransactionBinding | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.walletKey !== "string" ||
    typeof record.walletId !== "string" ||
    typeof record.generation !== "number" ||
    typeof record.transactionId !== "string" ||
    typeof record.fundingReference !== "string" ||
    !["bound", "collection_pending", "complete"].includes(record.state as string) ||
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number" ||
    (record.outcome !== undefined && !["settled", "refunded", "resolved_not_funded"].includes(record.outcome as string)) ||
    (record.escrowReference !== undefined && typeof record.escrowReference !== "string")
  ) return undefined;
  return {
    version: 1,
    walletKey: record.walletKey,
    walletId: record.walletId,
    generation: record.generation,
    transactionId: record.transactionId,
    fundingReference: record.fundingReference,
    state: record.state as DemoWalletTransactionBinding["state"],
    ...(record.outcome === undefined ? {} : { outcome: record.outcome as DemoTransactionTerminalOutcome }),
    ...(record.escrowReference === undefined ? {} : { escrowReference: record.escrowReference }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function generateWalletId(): string {
  return `demo-wallet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Production factory for the demo economic environment. Constructs the same
 * Cashu adapter, SQLite stores, spending keys, and private delivery as the
 * live environment, but against a self-hosted Cashu mint backed by
 * FakeWallet. Demo sats have NO monetary value.
 *
 * Issue #37: Per-session wallet ownership.
 *
 * Each requester session owns an isolated Demo Wallet identified by the
 * session hash (walletKey). Wallets are stored under
 * ("demo-wallet", <walletKey>) and funding under
 * ("demo-funding", <walletKey>:<generation>).
 *
 * START DEMO:
 *   POST /api/requester/demo/start → startDemoWallet(sessionHash)
 *   Creates exactly one wallet generation per session. Idempotent: repeated
 *   Start Demo returns the existing active wallet. Crash-safe: provisioning
 *   records ensure exactly one allocation per generation even if the process
 *   crashes mid-mint.
 *
 * RESET DEMO:
 *   POST /api/requester/demo/reset → resetDemoWallet(sessionHash)
 *   Retires the old generation (preserving economic history) and creates a
 *   fresh bounded allocation. Terminal-state eligibility is enforced by the
 *   runtime, not here.
 *
 * NO SILENT REPLENISHMENT:
 *   Construction does NOT mint. Only explicit startDemoWallet or
 *   resetDemoWallet may mint. Low balance, exhaustion, reload, and status GET
 *   do NOT mint.
 *
 * Resource acquisition is staged with the same failure-safe cleanup pattern
 * as the live factory.
 */
export async function createDemoEconomicEnvironment(
  config: DemoEconomicEnvironmentConfig,
  factories?: LiveEconomicEnvironmentFactories,
): Promise<EconomicEnvironment> {
  const allowedPrivateHosts = normalizeDemoPrivateHostAllowlist(config.allowedPrivateHosts);
  const mintUrl = normalizeCashuMintUrl(config.mintUrl, "demo-loopback", allowedPrivateHosts);
  const stateDirectory = resolve(config.stateDirectory);
  const initialBalanceSats = config.initialBalanceSats ?? 1000;

  if (
    !Number.isSafeInteger(initialBalanceSats) ||
    initialBalanceSats <= 0 ||
    initialBalanceSats > DEMO_WALLET_INITIAL_BALANCE_MAXIMUM_SATS
  ) {
    throw new EconomicEnvironmentError(
      "invalid_economic_mode",
      `Demo wallet initial balance must be an integer between 1 and ${DEMO_WALLET_INITIAL_BALANCE_MAXIMUM_SATS}`,
    );
  }

  const demoWalletConfiguration: CashuTestMintConfiguration = {
    testMintUrl: mintUrl,
    unit: "sat",
    maximumExposureSats: sats(BigInt(initialBalanceSats)),
    requestTimeoutMs: 10_000,
    maximumResponseBytes: 500_000,
    transportPolicy: "demo-loopback",
    allowedDemoPrivateHosts: allowedPrivateHosts,
  };

  const createPrivateStore = factories?.createPrivateStore ?? ((dbPath: string) =>
    createSqliteCashuPrivateStore(dbPath));
  const createSettlementStoreFn = factories?.createSettlementStore ?? ((dbPath: string) =>
    createSqlitePactCashuEscrowSettlementStore(dbPath));
  const createCashuAdapterFn = factories?.createCashuAdapter ?? ((cfg: {
    readonly mintUrl: string;
    readonly privateStore: CashuPrivateStore;
    readonly transportPolicy: CashuMintTransportPolicy;
  }) =>
    createCashuTestMintAdapter({
      configuration: {
        testMintUrl: cfg.mintUrl,
        unit: "sat",
        maximumExposureSats: sats(BigInt(initialBalanceSats)),
        requestTimeoutMs: 10_000,
        maximumResponseBytes: 500_000,
        transportPolicy: cfg.transportPolicy,
        allowedDemoPrivateHosts: allowedPrivateHosts,
      },
      privateStore: cfg.privateStore,
    }));

  const closeables: Array<() => void> = [];

  try {
    const privateStore = createPrivateStore(
      join(stateDirectory, "cashu-private.sqlite"),
    );
    closeables.push(() => privateStore.close());

    const settlementStore = createSettlementStoreFn(
      join(stateDirectory, "escrow-settlement.sqlite"),
    );
    closeables.push(() => settlementStore.close());

    const cashu = createCashuAdapterFn({
      mintUrl,
      privateStore,
      transportPolicy: "demo-loopback",
    });

    const privateDelivery = createCashuPrivateValueDelivery({
      configuration: {
        testMintUrl: mintUrl,
        unit: "sat",
        maximumExposureSats: sats(BigInt(initialBalanceSats)),
        transportPolicy: "demo-loopback",
        allowedDemoPrivateHosts: allowedPrivateHosts,
      },
      privateStore,
    });

    const normalSpendKey = createPrivateCashuSpendingKey({
      purpose: "cashu-nut11",
      secretKeyHex: config.normalSpendKeyHex,
    });
    const refundSpendKey = createPrivateCashuSpendingKey({
      purpose: "cashu-nut11",
      secretKeyHex: config.refundSpendKeyHex,
    });

    const capabilities = await cashu.inspectCapabilities();

    /*
     * Per-session wallet helper functions (Issue #37).
     *
     * Wallets are keyed by walletKey (the requester session hash). Each
     * wallet has a monotonically increasing generation. Funding is keyed by
     * <walletKey>:<generation>.
     */

    const fundingKeyFor = (walletKey: string, generation: number): string =>
      `${walletKey}:${generation}`;
    const generationKeyFor = (walletKey: string, generation: number): string =>
      `${walletKey}:${generation}`;
    const provisioningKeyFor = (
      walletKey: string,
      operation: "start" | "reset",
      idempotencyKey: string,
    ): string => `${walletKey}:${operation}:${idempotencyKey}`;
    const transactionFundingReference = (
      walletKey: string,
      generation: number,
      transactionId: string,
    ): string => `dw:${createHash("sha256")
      .update(`${walletKey}:${generation}:${transactionId}`)
      .digest("hex")}`;

    const validateWalletKey = (walletKey: string): string => {
      if (!WALLET_KEY.test(walletKey)) {
        throw new EconomicEnvironmentError("economic_mode_conflict", "Demo wallet identity is invalid");
      }
      return walletKey;
    };
    const validateTransactionId = (transactionId: string): string => {
      if (!TRANSACTION_ID.test(transactionId)) {
        throw new EconomicEnvironmentError("economic_mode_conflict", "Demo transaction identity is invalid");
      }
      return transactionId;
    };

    const readGeneration = async (
      walletKey: string,
      generation: number,
    ): Promise<PersistedDemoWallet | undefined> => asPersistedDemoWallet(
      await privateStore.read(DEMO_WALLET_GENERATION_SCOPE, generationKeyFor(walletKey, generation)),
    );
    const writeGeneration = async (wallet: PersistedDemoWallet): Promise<void> => {
      await privateStore.write(
        DEMO_WALLET_GENERATION_SCOPE,
        generationKeyFor(wallet.walletKey, wallet.generation),
        wallet,
      );
      if (wallet.status === "active") {
        await privateStore.write(DEMO_WALLET_SCOPE, wallet.walletKey, wallet);
      }
    };

    let cachedProofWallet: Awaited<ReturnType<typeof createBoundedCashuWallet>> | undefined;

    const getProofWallet = async () => {
      if (!cachedProofWallet) {
        cachedProofWallet = factories?.createDemoProofWallet
          ? factories.createDemoProofWallet(demoWalletConfiguration)
          : createBoundedCashuWallet(demoWalletConfiguration);
        await cachedProofWallet.loadMint();
      }
      return cachedProofWallet;
    };

    const proofIdentity = (proof: Proof): string => createHash("sha256").update(JSON.stringify({
      id: proof.id,
      amount: proof.amount.toString(),
      secret: proof.secret,
      C: proof.C,
    })).digest("hex");

    const aggregateUnspentProofs = async (walletKey: string): Promise<readonly Proof[]> => {
      const uniqueProofs = new Map<string, Proof>();
      const wallet = asPersistedDemoWallet(await privateStore.read(DEMO_WALLET_SCOPE, validateWalletKey(walletKey)));
      if (!wallet || wallet.status !== "active") return [];

      const fKey = fundingKeyFor(walletKey, wallet.generation);
      const persistedFunding = asPersistedDemoFunding(await privateStore.read(DEMO_FUNDING_STORE_SCOPE, fKey));
      if (persistedFunding) {
        const decoded = getDecodedToken(persistedFunding.token, capabilities.acceptedKeysetIds);
        for (const proof of decoded.proofs) uniqueProofs.set(proofIdentity(proof), proof);
      }

      for (const ref of wallet.handleReferences) {
        const owner = parseDemoWalletHandleEntry(
          await privateStore.read(DEMO_WALLET_HANDLES_SCOPE, ref),
        );
        if (
          !owner ||
          owner.walletId !== wallet.walletId ||
          owner.walletKey !== wallet.walletKey ||
          owner.generation !== wallet.generation ||
          owner.handleReference !== ref
        ) {
          throw new EconomicEnvironmentError("economic_mode_conflict", "Demo wallet handle ownership is invalid");
        }
        const result = await readCashuPrivateValueProofs(privateStore, mintUrl, { reference: ref });
        if (result && !result.consumed) {
          for (const proof of result.proofs) uniqueProofs.set(proofIdentity(proof), proof);
        }
      }

      const allProofs = [...uniqueProofs.values()];
      if (allProofs.length === 0) return [];

      const { CheckStateEnum } = await import("@cashu/cashu-ts");
      const proofWallet = await getProofWallet();
      const states = await proofWallet.checkProofsStates(allProofs);
      return allProofs.filter((_, i) => states[i]?.state === CheckStateEnum.UNSPENT);
    };

    const writeProvisioning = async (record: ProvisioningRecord): Promise<void> => {
      await privateStore.write(DEMO_WALLET_PROVISIONING_SCOPE, record.walletKey, record);
      await privateStore.write(
        DEMO_WALLET_PROVISIONING_SCOPE,
        provisioningKeyFor(record.walletKey, record.operation, record.idempotencyKey),
        record,
      );
    };

    const completeProvisioning = async (
      walletKey: string,
      provisioning: ProvisioningRecord,
    ): Promise<WalletSnapshot> => {
      const { getEncodedToken, MintQuoteState } = await import("@cashu/cashu-ts");
      const wallet = await getProofWallet();
      if (provisioning.state === "complete" && provisioning.walletId) {
        return Object.freeze({ walletId: provisioning.walletId, generation: provisioning.generation });
      }
      if (provisioning.state === "mint_submitting" || provisioning.state === "reconciliation_required") {
        const failedClosed: ProvisioningRecord = {
          ...provisioning,
          state: "reconciliation_required",
        };
        await writeProvisioning(failedClosed);
        throw new EconomicEnvironmentError(
          "demo_provisioning_reconciliation_required",
          "Demo wallet provisioning requires operator reconciliation",
        );
      }

      let durable = provisioning;
      if (durable.state === "quote_created") {
        const checked = await wallet.checkMintQuote("bolt11", durable.quoteId);
        const quoteState = (checked as { state?: string }).state ?? "";
        if (quoteState !== MintQuoteState.PAID && quoteState !== "paid") {
          throw new EconomicEnvironmentError("economic_mode_conflict", "Demo mint quote was not paid by FakeWallet");
        }
        durable = { ...durable, state: "mint_submitting" };
        await writeProvisioning(durable);
        try {
          const mintResult = await wallet.mintProofsBolt11(String(initialBalanceSats), durable.quoteId);
          const token = getEncodedToken({ mint: mintUrl, unit: "sat", proofs: mintResult });
          durable = { ...durable, state: "token_persisted", token };
          await writeProvisioning(durable);
        } catch {
          durable = { ...durable, state: "reconciliation_required" };
          await writeProvisioning(durable);
          throw new EconomicEnvironmentError(
            "demo_provisioning_reconciliation_required",
            "Demo wallet provisioning requires operator reconciliation",
          );
        }
      }

      if (durable.state !== "token_persisted" || !durable.token) {
        throw new EconomicEnvironmentError("economic_mode_conflict", "Demo wallet provisioning state is invalid");
      }

      const fKey = fundingKeyFor(walletKey, provisioning.generation);
      const persistedFunding: PersistedDemoFunding = {
        version: 1,
        token: durable.token,
        mintUrl,
        unit: "sat",
        source: DEMO_FUNDING_SOURCE,
        createdAt: Math.floor(Date.now() / 1000),
      };
      await privateStore.write(DEMO_FUNDING_STORE_SCOPE, fKey, persistedFunding);

      const walletId = durable.walletId ?? generateWalletId();
      const existing = asPersistedDemoWallet(await privateStore.read(DEMO_WALLET_SCOPE, walletKey));
      if (durable.operation === "reset" && existing?.status === "active") {
        const retiredWallet: PersistedDemoWallet = {
          ...existing,
          status: "retired",
          retiredAt: Math.floor(Date.now() / 1000),
        };
        await privateStore.write(DEMO_WALLET_SCOPE, `retired:${existing.walletId}`, retiredWallet);
        await writeGeneration(retiredWallet);
      }
      const newWallet: PersistedDemoWallet = {
        version: 1,
        walletId,
        walletKey,
        generation: provisioning.generation,
        status: "active",
        mintUrl,
        unit: "sat",
        createdAt: Math.floor(Date.now() / 1000),
        handleReferences: Object.freeze([] as readonly string[]),
        transactionIds: Object.freeze([] as readonly string[]),
      };
      await writeGeneration(newWallet);
      durable = { ...durable, state: "complete", walletId };
      await writeProvisioning(durable);

      return Object.freeze({ walletId, generation: provisioning.generation });
    };

    /**
     * Start or reset a demo wallet with crash-safe provisioning.
     * Uses an exclusive lock on the wallet key to prevent concurrent
     * operations from creating duplicate allocations.
     */
    const provisionWallet = async (
      walletKey: string,
      operation: "start" | "reset",
      idempotencyKey: string,
    ): Promise<WalletSnapshot> => {
      validateWalletKey(walletKey);
      if (!RESET_IDEMPOTENCY_KEY.test(idempotencyKey)) {
        throw new EconomicEnvironmentError("economic_mode_conflict", "Demo wallet operation identity is invalid");
      }
      return privateStore.withExclusiveLock(DEMO_WALLET_SCOPE, walletKey, async () => {
        const existing = asPersistedDemoWallet(await privateStore.read(DEMO_WALLET_SCOPE, walletKey));

        if (operation === "start") {
          // Idempotent: if an active wallet exists, return it.
          if (existing && existing.status === "active") {
            await writeGeneration(existing);
            return Object.freeze({
              walletId: existing.walletId,
              generation: existing.generation,
            });
          }
        }

        const nextGeneration = existing ? existing.generation + 1 : 1;
        const byIdempotency = asProvisioningRecord(await privateStore.read(
          DEMO_WALLET_PROVISIONING_SCOPE,
          provisioningKeyFor(walletKey, operation, idempotencyKey),
        ));
        if (byIdempotency) return completeProvisioning(walletKey, byIdempotency);

        const activeProvisioning = asProvisioningRecord(
          await privateStore.read(DEMO_WALLET_PROVISIONING_SCOPE, walletKey),
        );
        if (
          activeProvisioning &&
          activeProvisioning.state !== "complete" &&
          activeProvisioning.idempotencyKey !== idempotencyKey
        ) {
          throw new EconomicEnvironmentError(
            "demo_provisioning_reconciliation_required",
            "A previous Demo wallet provisioning operation is unresolved",
          );
        }

        if (operation === "reset") {
          if (!existing || existing.status !== "active") {
            throw new EconomicEnvironmentError("demo_wallet_not_started", "Demo wallet is not active");
          }
          for (const transactionId of existing.transactionIds) {
            const reference = transactionFundingReference(walletKey, existing.generation, transactionId);
            const binding = asDemoWalletTransactionBinding(
              await privateStore.read(DEMO_WALLET_TRANSACTION_SCOPE, reference),
            );
            if (!binding || binding.state !== "complete") {
              throw new EconomicEnvironmentError("demo_reset_blocked", "Demo wallet has unresolved economic exposure");
            }
          }
        }

        const proofWallet = await getProofWallet();
        const quote = await proofWallet.createMintQuote("bolt11", { amount: initialBalanceSats });
        const provisioning: ProvisioningRecord = {
          version: 1,
          walletKey,
          operation,
          generation: nextGeneration,
          sourceGeneration: existing?.generation ?? 0,
          idempotencyKey,
          quoteId: quote.quote,
          state: "quote_created",
          createdAt: Math.floor(Date.now() / 1000),
        };
        await writeProvisioning(provisioning);
        return completeProvisioning(walletKey, provisioning);
      });
    };

    const bindDemoTransactionFunding = async (
      walletKey: string,
      transactionId: string,
    ): Promise<DemoTransactionFundingBinding> => {
      validateWalletKey(walletKey);
      validateTransactionId(transactionId);
      return privateStore.withExclusiveLock(DEMO_WALLET_SCOPE, walletKey, async () => {
        const wallet = asPersistedDemoWallet(await privateStore.read(DEMO_WALLET_SCOPE, walletKey));
        if (!wallet || wallet.status !== "active") {
          throw new EconomicEnvironmentError("demo_wallet_not_started", "Start Demo before creating a transaction");
        }
        const fundingReference = transactionFundingReference(walletKey, wallet.generation, transactionId);
        const existingBinding = asDemoWalletTransactionBinding(
          await privateStore.read(DEMO_WALLET_TRANSACTION_SCOPE, fundingReference),
        );
        if (existingBinding) {
          if (
            existingBinding.walletKey !== walletKey ||
            existingBinding.walletId !== wallet.walletId ||
            existingBinding.generation !== wallet.generation ||
            existingBinding.transactionId !== transactionId
          ) {
            throw new EconomicEnvironmentError("economic_mode_conflict", "Demo transaction funding ownership conflicts");
          }
          return Object.freeze({ fundingReference, generation: wallet.generation });
        }

        const updatedWallet: PersistedDemoWallet = wallet.transactionIds.includes(transactionId)
          ? wallet
          : {
              ...wallet,
              transactionIds: Object.freeze([...wallet.transactionIds, transactionId]),
            };
        await writeGeneration(updatedWallet);
        const now = Math.floor(Date.now() / 1000);
        const binding: DemoWalletTransactionBinding = {
          version: 1,
          walletKey,
          walletId: wallet.walletId,
          generation: wallet.generation,
          transactionId,
          fundingReference,
          state: "bound",
          createdAt: now,
          updatedAt: now,
        };
        await privateStore.write(DEMO_WALLET_TRANSACTION_SCOPE, fundingReference, binding);
        return Object.freeze({ fundingReference, generation: wallet.generation });
      });
    };

    const collectBindingOutputsLocked = async (
      binding: DemoWalletTransactionBinding,
    ): Promise<void> => {
      if (binding.state === "complete") return;
      if (binding.outcome === "resolved_not_funded") {
        await privateStore.write(DEMO_WALLET_TRANSACTION_SCOPE, binding.fundingReference, {
          ...binding,
          state: "complete",
          updatedAt: Math.floor(Date.now() / 1000),
        } satisfies DemoWalletTransactionBinding);
        return;
      }
      if (!binding.outcome || !binding.escrowReference) {
        throw new EconomicEnvironmentError("economic_mode_conflict", "Demo wallet output collection state is incomplete");
      }
      const escrowRaw = await settlementStore.read(`escrow:${binding.escrowReference}`);
      if (typeof escrowRaw !== "object" || escrowRaw === null) {
        throw new EconomicEnvironmentError("economic_mode_conflict", "Demo escrow output record is unavailable");
      }
      const escrow = escrowRaw as Record<string, unknown>;
      if (escrow.state !== binding.outcome) {
        throw new EconomicEnvironmentError("economic_mode_conflict", "Demo escrow terminal state does not match collection outcome");
      }

      const wallet = await readGeneration(binding.walletKey, binding.generation);
      if (
        !wallet ||
        wallet.walletId !== binding.walletId ||
        wallet.walletKey !== binding.walletKey ||
        wallet.generation !== binding.generation
      ) {
        throw new EconomicEnvironmentError("economic_mode_conflict", "Demo wallet generation is unavailable for output collection");
      }

      const candidates: Array<{ reference: string; source: DemoWalletHandleSource }> = [];
      const extract = (field: string, source: DemoWalletHandleSource): void => {
        const handle = escrow[field] as { reference?: unknown } | undefined;
        if (handle && typeof handle.reference === "string") candidates.push({ reference: handle.reference, source });
      };
      extract("fundingChangeHandle", "funding-change");
      if (binding.outcome === "settled") extract("settlementChangeHandle", "settlement-change");
      if (binding.outcome === "refunded") {
        extract("refundHandle", "refund");
        extract("refundChangeHandle", "refund-change");
      }

      const newReferences: string[] = [];
      for (const candidate of candidates) {
        const value = await readCashuPrivateValueProofs(privateStore, mintUrl, { reference: candidate.reference });
        if (!value) {
          throw new EconomicEnvironmentError("economic_mode_conflict", "Demo wallet output handle is unavailable");
        }
        const existingOwner = parseDemoWalletHandleEntry(
          await privateStore.read(DEMO_WALLET_HANDLES_SCOPE, candidate.reference),
        );
        const entry: DemoWalletHandleEntry = {
          version: 1,
          walletId: wallet.walletId,
          walletKey: wallet.walletKey,
          generation: wallet.generation,
          transactionId: binding.transactionId,
          escrowReference: binding.escrowReference,
          handleReference: candidate.reference,
          source: candidate.source,
          amountSats: value.amountSats.toString(),
          createdAt: Math.floor(Date.now() / 1000),
        };
        if (existingOwner) {
          if (
            existingOwner.walletId !== entry.walletId ||
            existingOwner.walletKey !== entry.walletKey ||
            existingOwner.generation !== entry.generation ||
            existingOwner.transactionId !== entry.transactionId ||
            existingOwner.escrowReference !== entry.escrowReference ||
            existingOwner.source !== entry.source
          ) {
            throw new EconomicEnvironmentError("economic_mode_conflict", "Demo wallet output handle already has another owner");
          }
        } else {
          await privateStore.write(DEMO_WALLET_HANDLES_SCOPE, candidate.reference, entry);
        }
        if (!wallet.handleReferences.includes(candidate.reference)) newReferences.push(candidate.reference);
      }

      if (newReferences.length > 0) {
        const updated: PersistedDemoWallet = {
          ...wallet,
          handleReferences: Object.freeze([...wallet.handleReferences, ...newReferences]),
        };
        await writeGeneration(updated);
      }
      await privateStore.write(DEMO_WALLET_TRANSACTION_SCOPE, binding.fundingReference, {
        ...binding,
        state: "complete",
        updatedAt: Math.floor(Date.now() / 1000),
      } satisfies DemoWalletTransactionBinding);
    };

    const finalizeDemoTransaction = async (
      fundingReference: string,
      transactionId: string,
      outcome: DemoTransactionTerminalOutcome,
      escrowReference?: string,
    ): Promise<void> => {
      validateTransactionId(transactionId);
      const initial = asDemoWalletTransactionBinding(
        await privateStore.read(DEMO_WALLET_TRANSACTION_SCOPE, fundingReference),
      );
      if (!initial || initial.transactionId !== transactionId || initial.fundingReference !== fundingReference) {
        throw new EconomicEnvironmentError("economic_mode_conflict", "Demo transaction funding binding is unavailable");
      }
      await privateStore.withExclusiveLock(DEMO_WALLET_SCOPE, initial.walletKey, async () => {
        const current = asDemoWalletTransactionBinding(
          await privateStore.read(DEMO_WALLET_TRANSACTION_SCOPE, fundingReference),
        );
        if (!current || current.transactionId !== transactionId) {
          throw new EconomicEnvironmentError("economic_mode_conflict", "Demo transaction funding binding is unavailable");
        }
        if (current.state === "complete") {
          if (current.outcome !== outcome || current.escrowReference !== escrowReference) {
            throw new EconomicEnvironmentError("economic_mode_conflict", "Demo transaction terminal outcome conflicts");
          }
          return;
        }
        const pending: DemoWalletTransactionBinding = {
          ...current,
          state: "collection_pending",
          outcome,
          ...(escrowReference === undefined ? {} : { escrowReference }),
          updatedAt: Math.floor(Date.now() / 1000),
        };
        await privateStore.write(DEMO_WALLET_TRANSACTION_SCOPE, fundingReference, pending);
        await collectBindingOutputsLocked(pending);
      });
    };

    const walletStatus = async (walletKey: string): Promise<DemoWalletStatus> => {
      validateWalletKey(walletKey);
      return privateStore.withExclusiveLock(DEMO_WALLET_SCOPE, walletKey, async () => {
        const wallet = asPersistedDemoWallet(await privateStore.read(DEMO_WALLET_SCOPE, walletKey));
        if (!wallet || wallet.status !== "active") {
          throw new EconomicEnvironmentError("demo_wallet_not_started", "Demo wallet is not active");
        }
        let accountingPending = false;
        for (const transactionId of wallet.transactionIds) {
          const reference = transactionFundingReference(walletKey, wallet.generation, transactionId);
          const binding = asDemoWalletTransactionBinding(
            await privateStore.read(DEMO_WALLET_TRANSACTION_SCOPE, reference),
          );
          if (!binding) {
            accountingPending = true;
            continue;
          }
          if (binding.state === "collection_pending") {
            try {
              await collectBindingOutputsLocked(binding);
            } catch {
              accountingPending = true;
              continue;
            }
          }
          const refreshed = asDemoWalletTransactionBinding(
            await privateStore.read(DEMO_WALLET_TRANSACTION_SCOPE, reference),
          );
          if (!refreshed || refreshed.state !== "complete") accountingPending = true;
        }
        const unspent = await aggregateUnspentProofs(walletKey);
        const availableSats = unspent.reduce((sum, proof) => sum + proof.amount.toBigInt(), 0n);
        return Object.freeze({
          availableSats,
          generation: wallet.generation,
          resetAvailable: !accountingPending,
          accountingPending,
        });
      });
    };

    return createEconomicEnvironment({
      mode: "demo",
      mintUrl,
      allowedDemoPrivateHosts: allowedPrivateHosts,
      cashu,
      privateDelivery,
      privateStore,
      settlementStore,
      normalSpendKey,
      refundSpendKey,
      fundingAvailable: true,
      walletReady: true,
      close() {
        closeAll([() => settlementStore.close(), () => privateStore.close()]);
      },
      startDemoWallet: async (walletKey: string): Promise<WalletSnapshot> => {
        return provisionWallet(walletKey, "start", "start-demo-wallet");
      },
      demoWalletExists: async (walletKey: string): Promise<boolean> => {
        const wallet = asPersistedDemoWallet(await privateStore.read(DEMO_WALLET_SCOPE, walletKey));
        return wallet !== undefined && wallet.status === "active";
      },
      resolveFunding: async (reference: string): Promise<PrivateCashuFunding> => {
        const binding = asDemoWalletTransactionBinding(
          await privateStore.read(DEMO_WALLET_TRANSACTION_SCOPE, reference),
        );
        if (!binding || binding.state !== "bound") {
          throw new EconomicEnvironmentError(
            "economic_mode_conflict",
            "Funding reference was not found",
          );
        }
        const wallet = await readGeneration(binding.walletKey, binding.generation);
        if (!wallet || wallet.status !== "active" || wallet.walletId !== binding.walletId) {
          throw new EconomicEnvironmentError("economic_mode_conflict", "Funding generation is not active");
        }
        const unspentProofs = await aggregateUnspentProofs(binding.walletKey);
        if (unspentProofs.length === 0) {
          throw new EconomicEnvironmentError(
            "demo_funding_exhausted",
            "Demo funding is fully spent. Use Reset Demo to create a new wallet generation.",
          );
        }
        return createPrivateCashuFunding({ mintUrl, unit: "sat", proofs: unspentProofs });
      },
      collectWalletOutputs: async (): Promise<void> => {
        throw new EconomicEnvironmentError("economic_mode_conflict", "Generation-bound output collection is required");
      },
      bindDemoTransactionFunding,
      finalizeDemoTransaction,
      resetDemoWallet: async (walletKey: string, idempotencyKey: string): Promise<WalletSnapshot> => {
        return provisionWallet(walletKey, "reset", idempotencyKey);
      },
      walletBalance: async (walletKey: string): Promise<WalletBalance> => {
        const status = await walletStatus(walletKey);
        return Object.freeze({ availableSats: status.availableSats, generation: status.generation });
      },
      demoWalletStatus: walletStatus,
    });
  } catch (constructionError) {
    try {
      closeAll(closeables);
    } catch {
      // Preserve the original construction error
    }
    throw constructionError;
  }
}

/**
 * Production factory selector. Returns the economic environment for the
 * configured mode. Demo mode constructs a self-hosted Cashu mint backed by
 * FakeWallet; live mode constructs from configured external mint and
 * funding token.
 */
export async function createEconomicEnvironmentFromConfig(
  mode: EconomicMode,
  config: LiveEconomicEnvironmentConfig | DemoEconomicEnvironmentConfig,
  factories?: LiveEconomicEnvironmentFactories,
): Promise<EconomicEnvironment> {
  const parsed = parseEconomicMode(mode);
  if (parsed === "demo") {
    return createDemoEconomicEnvironment(config as DemoEconomicEnvironmentConfig, factories);
  }
  return createLiveEconomicEnvironment(config as LiveEconomicEnvironmentConfig, factories);
}
