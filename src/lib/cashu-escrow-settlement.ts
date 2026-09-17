import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { findForbiddenPublicMaterial } from "../domain/forbidden-material";
import type { NostrPublicKey, NostrSigner, SignedNostrEvent } from "../domain/nostr";
import { sats } from "../domain/money";
import {
  DOCUMENT_SUMMARY_PROFILE_ID,
  PactServiceAgreementError,
  createPactAgreementTransition,
  parsePactAgreementTransitionEvent,
  reconstructPactAgreementHistory,
  type PactAgreementContext,
  type PactAgreementHistoryOk,
  type PactAgreementState,
} from "../domain/pact-service-agreement";
import { parseCashuEscrowDescriptorEvent } from "../domain/pontmore-escrow";
import {
  CashuTestMintError,
  isPrivateCashuSpendingKey,
  normalizeCashuTestMintUrl,
  type CashuMutationResult,
  type CashuOperationSucceeded,
  type CashuP2PKSpendingCondition,
  type CashuPrivateValueDeliveryPort,
  type CashuPrivateHandle,
  type CashuSettlementFacts,
  type CashuTestMintPort,
  type PrivateCashuBeneficiaryDestination,
  type PrivateCashuFunding,
  type PrivateCashuSpendingKey,
} from "./cashu-test-mint";
import type { NostrRelayAdapter } from "./nostr-relay";
import {
  publishSignedPactAgreementTransition,
  signPactAgreementTransition,
} from "./pact-service-agreement-publication";

export const PACT_CASHU_ESCROW_SERVICE_VERSION = 1;
export const PACT_CASHU_ESCROW_DOCUMENT_SUMMARY_AMOUNT_SATS = sats(350n);
export const PACT_CASHU_ESCROW_CLOCK_SKEW_SECONDS = 1;

export type PactCashuSettlementErrorCode =
  | "invalid_request"
  | "unsupported_mint_or_unit"
  | "unsupported_spending_condition"
  | "agreement_mismatch"
  | "participant_mismatch"
  | "unauthorized_operation"
  | "invalid_state"
  | "stale_state"
  | "idempotency_conflict"
  | "funding_not_confirmed"
  | "completion_not_authorized"
  | "timeout_not_reached"
  | "already_released"
  | "already_refunded"
  | "settlement_conflict"
  | "mint_unavailable"
  | "reconciliation_required"
  | "privacy_boundary_violation";

export class PactCashuSettlementError extends Error {
  readonly code: PactCashuSettlementErrorCode;

  constructor(code: PactCashuSettlementErrorCode, message: string) {
    super(message);
    this.name = "PactCashuSettlementError";
    this.code = code;
  }

  toJSON(): Readonly<{ name: string; code: PactCashuSettlementErrorCode; message: string }> {
    return Object.freeze({ name: this.name, code: this.code, message: this.message });
  }
}

function settlementError(code: PactCashuSettlementErrorCode, message: string): never {
  throw new PactCashuSettlementError(code, message);
}

export type PactCashuEscrowOperationalState =
  | "prepared"
  | "funding_pending"
  | "funding_reconciliation_required"
  | "funding_confirmed"
  | "funded"
  | "release_authorized"
  | "release_pending"
  | "release_reconciliation_required"
  | "release_confirmed"
  | "settled"
  | "refund_authorized"
  | "refund_pending"
  | "refund_reconciliation_required"
  | "refund_confirmed"
  | "refunded";

export interface PactCashuEscrowStatus {
  readonly serviceVersion: 1;
  readonly escrowReference: string;
  readonly agreementId: string;
  readonly agreementRoot: string;
  readonly state: PactCashuEscrowOperationalState;
  readonly version: number;
  readonly amountSats: "350";
  readonly unit: "sat";
  readonly resultReference?: string;
  readonly settlementReference?: string;
  readonly refundReference?: string;
  readonly transitionEventId?: string;
}

export type PactCashuMutationOutcome = "confirmed" | "publication_pending" | "reconciliation_required";

export interface PactCashuSettlementResult {
  readonly outcome: PactCashuMutationOutcome;
  readonly escrow: PactCashuEscrowStatus;
}

export interface PactCashuClock {
  now(): number;
}

export interface PactCashuEscrowSettlementStore {
  read(key: string): Promise<unknown | undefined>;
  insert(key: string, value: unknown): Promise<boolean>;
  compareAndSet(key: string, expectedRevision: number, value: unknown): Promise<boolean>;
  withExclusiveLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export function createInMemoryPactCashuEscrowSettlementStore(): PactCashuEscrowSettlementStore {
  const values = new Map<string, unknown>();
  const tails = new Map<string, Promise<void>>();
  return Object.freeze({
    async read(key: string): Promise<unknown | undefined> {
      return values.get(key);
    },
    async insert(key: string, value: unknown): Promise<boolean> {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    async compareAndSet(key: string, expectedRevision: number, value: unknown): Promise<boolean> {
      const current = values.get(key) as { revision?: unknown } | undefined;
      if (!current || current.revision !== expectedRevision) return false;
      values.set(key, value);
      return true;
    },
    async withExclusiveLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
      const prior = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = prior.then(() => gate);
      tails.set(key, tail);
      await prior;
      try {
        return await operation();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  });
}

export interface SqlitePactCashuEscrowSettlementStore
  extends PactCashuEscrowSettlementStore {
  close(): void;
}

const SQLITE_LOCK_LEASE_MILLISECONDS = 30_000;
const SQLITE_LOCK_HEARTBEAT_MILLISECONDS = 5_000;
const SQLITE_LOCK_RETRY_MILLISECONDS = 20;
const SQLITE_LOCK_WAIT_MILLISECONDS = 60_000;

function storeError(message: string): never {
  settlementError("invalid_state", message);
}

function storeKey(value: string): string {
  if (!/^[A-Za-z0-9:._-]{1,256}$/.test(value)) {
    settlementError("invalid_request", "Settlement store key is invalid");
  }
  return value;
}

function storeRevision(value: unknown): number {
  if (
    typeof value !== "object" ||
    value === null ||
    !("revision" in value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1
  ) {
    settlementError("invalid_request", "Settlement store value has no valid revision");
  }
  return value.revision as number;
}

function serializeStoreValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    settlementError("invalid_request", "Settlement store value is not serializable");
  }
}

function parseStoreValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return storeError("Durable settlement store contains malformed data");
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

/**
 * Durable process-safe settlement storage. The SQLite file contains only the
 * coordinator's private operational records and must not be publicly served.
 */
export function createSqlitePactCashuEscrowSettlementStore(
  databasePath: string,
): SqlitePactCashuEscrowSettlementStore {
  if (typeof databasePath !== "string" || databasePath.length < 1 || databasePath === ":memory:") {
    settlementError("invalid_request", "Durable settlement database path is invalid");
  }
  const resolvedPath = resolve(databasePath);
  let database: DatabaseSync;
  try {
    mkdirSync(dirname(resolvedPath), { recursive: true });
    database = new DatabaseSync(resolvedPath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS pact_cashu_settlement_values (
        store_key TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pact_cashu_settlement_locks (
        lock_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
    `);
    chmodSync(resolvedPath, 0o600);
  } catch {
    return storeError("Durable settlement store is unavailable");
  }

  const readStatement = database.prepare(
    "SELECT value_json FROM pact_cashu_settlement_values WHERE store_key = ?",
  );
  const insertStatement = database.prepare(
    "INSERT OR IGNORE INTO pact_cashu_settlement_values (store_key, revision, value_json) VALUES (?, ?, ?)",
  );
  const compareAndSetStatement = database.prepare(
    "UPDATE pact_cashu_settlement_values SET revision = ?, value_json = ? WHERE store_key = ? AND revision = ?",
  );
  const acquireStatement = database.prepare(`
    INSERT INTO pact_cashu_settlement_locks (lock_key, owner, expires_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(lock_key) DO UPDATE SET
      owner = excluded.owner,
      expires_at_ms = excluded.expires_at_ms
    WHERE pact_cashu_settlement_locks.expires_at_ms <= ?
  `);
  const heartbeatStatement = database.prepare(
    "UPDATE pact_cashu_settlement_locks SET expires_at_ms = ? WHERE lock_key = ? AND owner = ?",
  );
  const releaseStatement = database.prepare(
    "DELETE FROM pact_cashu_settlement_locks WHERE lock_key = ? AND owner = ?",
  );
  let closed = false;

  function ensureOpen(): void {
    if (closed) storeError("Durable settlement store is closed");
  }

  async function acquire(key: string): Promise<Readonly<{ owner: string; release: () => void }>> {
    const owner = randomUUID();
    const deadline = Date.now() + SQLITE_LOCK_WAIT_MILLISECONDS;
    while (Date.now() <= deadline) {
      ensureOpen();
      const now = Date.now();
      try {
        const result = acquireStatement.run(
          key,
          owner,
          now + SQLITE_LOCK_LEASE_MILLISECONDS,
          now,
        );
        if (result.changes === 1) {
          const heartbeat = setInterval(() => {
            try {
              heartbeatStatement.run(Date.now() + SQLITE_LOCK_LEASE_MILLISECONDS, key, owner);
            } catch {
              // The final operation/CAS still fails closed if storage became unavailable.
            }
          }, SQLITE_LOCK_HEARTBEAT_MILLISECONDS);
          heartbeat.unref();
          return Object.freeze({
            owner,
            release(): void {
              clearInterval(heartbeat);
              try {
                releaseStatement.run(key, owner);
              } catch {
                // A failed release expires through the bounded lease.
              }
            },
          });
        }
      } catch {
        return storeError("Durable settlement store lock is unavailable");
      }
      await wait(SQLITE_LOCK_RETRY_MILLISECONDS);
    }
    return storeError("Durable settlement store lock timed out");
  }

  return Object.freeze({
    async read(key: string): Promise<unknown | undefined> {
      ensureOpen();
      try {
        const row = readStatement.get(storeKey(key)) as { value_json: string } | undefined;
        return row === undefined ? undefined : parseStoreValue(row.value_json);
      } catch (error) {
        if (error instanceof PactCashuSettlementError) throw error;
        return storeError("Durable settlement store read failed");
      }
    },
    async insert(key: string, value: unknown): Promise<boolean> {
      ensureOpen();
      const revision = storeRevision(value);
      const serialized = serializeStoreValue(value);
      try {
        return insertStatement.run(storeKey(key), revision, serialized).changes === 1;
      } catch {
        return storeError("Durable settlement store insert failed");
      }
    },
    async compareAndSet(
      key: string,
      expectedRevision: number,
      value: unknown,
    ): Promise<boolean> {
      ensureOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        settlementError("invalid_request", "Settlement store revision is invalid");
      }
      const revision = storeRevision(value);
      const serialized = serializeStoreValue(value);
      try {
        return (
          compareAndSetStatement.run(revision, serialized, storeKey(key), expectedRevision)
            .changes === 1
        );
      } catch {
        return storeError("Durable settlement store compare-and-set failed");
      }
    },
    async withExclusiveLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
      ensureOpen();
      const validatedKey = storeKey(key);
      const lease = await acquire(validatedKey);
      try {
        return await operation();
      } finally {
        lease.release();
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        database.close();
      } catch {
        return storeError("Durable settlement store close failed");
      }
    },
  });
}

type SettlementOperationType =
  | "prepare"
  | "fund"
  | "authorize_release"
  | "release"
  | "authorize_refund"
  | "refund"
  | "deliver_provider_payout"
  | "deliver_requester_refund";

interface StoredSettlementOperation {
  readonly type: SettlementOperationType;
  readonly fingerprint: string;
  readonly status: "pending" | "reconciliation_required" | "publication_pending" | "succeeded" | "failed";
}

interface StoredReleaseAuthorization {
  readonly eventId: string;
  readonly predecessor: string;
  readonly resultReference: string;
  readonly authorizer: NostrPublicKey;
  readonly expiresAt: number;
  readonly operationKey: string;
}

interface StoredRefundAuthorization {
  readonly eventId: string;
  readonly predecessor: string;
  readonly authorizer: NostrPublicKey;
  readonly basis: "timeout" | "rejected";
  readonly operationKey: string;
}

interface StoredCashuFacts {
  readonly mintUrl: string;
  readonly amountSats: string;
  readonly inputAmountSats: string;
  readonly outputAmountSats: string;
  readonly changeAmountSats: string;
  readonly mintFeeSats: string;
  readonly reservedSpendFeeSats: string;
}

interface StoredEscrowRecord {
  readonly revision: number;
  readonly serviceVersion: 1;
  readonly reference: string;
  readonly agreementId: string;
  readonly agreementRoot: string;
  readonly requester: NostrPublicKey;
  readonly provider: NostrPublicKey;
  readonly escrowAuthority: NostrPublicKey;
  readonly escrowAuthoritySource: string;
  readonly escrowDescriptor: string;
  readonly mintUrl: string;
  readonly unit: "sat";
  readonly amountSats: "350";
  readonly capabilityProfile: typeof DOCUMENT_SUMMARY_PROFILE_ID;
  readonly agreementExpiresAt: number;
  readonly acceptedEventId: string;
  readonly timeoutPolicy: "refund-trigger timeout";
  readonly timeoutDurationSeconds: number;
  readonly locktime: number;
  readonly clockSkewSeconds: 1;
  readonly spendingCondition: CashuP2PKSpendingCondition;
  readonly state: PactCashuEscrowOperationalState;
  readonly economicClaim: "none" | "release" | "refund";
  readonly operations: Readonly<Record<string, StoredSettlementOperation>>;
  readonly fundingHandle?: CashuPrivateHandle;
  readonly fundingChangeHandle?: CashuPrivateHandle;
  readonly fundingFacts?: StoredCashuFacts;
  readonly settlementHandle?: CashuPrivateHandle;
  readonly settlementChangeHandle?: CashuPrivateHandle;
  readonly refundHandle?: CashuPrivateHandle;
  readonly refundChangeHandle?: CashuPrivateHandle;
  readonly releaseAuthorization?: StoredReleaseAuthorization;
  readonly refundAuthorization?: StoredRefundAuthorization;
  readonly settlementReference?: string;
  readonly refundReference?: string;
  readonly pendingTransition?: SignedNostrEvent;
  readonly lastPublishedTransitionId?: string;
}

interface StoredPreparation {
  readonly revision: number;
  readonly requestFingerprint: string;
  readonly escrowReference: string;
}

interface StoredAgreementEscrow {
  readonly revision: number;
  readonly requestFingerprint: string;
  readonly escrowReference: string;
}

function isStoredEscrowRecord(value: unknown): value is StoredEscrowRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "revision" in value &&
    "reference" in value &&
    "operations" in value &&
    "state" in value
  );
}

function isStoredPreparation(value: unknown): value is StoredPreparation {
  return (
    typeof value === "object" &&
    value !== null &&
    "revision" in value &&
    "requestFingerprint" in value &&
    "escrowReference" in value
  );
}

function isStoredAgreementEscrow(value: unknown): value is StoredAgreementEscrow {
  return isStoredPreparation(value);
}

function validateIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(value) || findForbiddenPublicMaterial(value)) {
    settlementError("invalid_request", "Settlement idempotency key is invalid");
  }
  return value;
}

function validateEscrowReference(value: string): string {
  if (!/^pactescrow_[0-9a-f-]{36}$/.test(value)) {
    settlementError("invalid_request", "Escrow reference is invalid");
  }
  return value;
}

function safeTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    settlementError("invalid_request", "Settlement clock returned an invalid time");
  }
  return value;
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function operationFingerprint(input: {
  readonly record: StoredEscrowRecord;
  readonly type: SettlementOperationType;
  readonly expectedVersion: number;
  readonly expectedState: PactCashuEscrowOperationalState;
  readonly actor: string;
  readonly authorizationReference?: string;
  readonly resultReference?: string;
}): string {
  return fingerprint({
    service_version: PACT_CASHU_ESCROW_SERVICE_VERSION,
    escrow_reference: input.record.reference,
    agreement_id: input.record.agreementId,
    operation_type: input.type,
    expected_state: input.expectedState,
    expected_version: input.expectedVersion,
    actor: input.actor,
    amount_sats: input.record.amountSats,
    authorization_reference: input.authorizationReference ?? null,
    result_reference: input.resultReference ?? null,
  });
}

function cashuOperationId(record: StoredEscrowRecord, type: "fund" | "release" | "refund", key: string): string {
  return `cashu_${fingerprint({ escrow: record.reference, type, key }).slice(0, 58)}`;
}

function privateDeliveryId(
  record: StoredEscrowRecord,
  type: "provider-payout" | "requester-funding-change" | "requester-settlement-change" | "requester-refund" | "requester-refund-change",
): string {
  return `cashu_delivery_${fingerprint({ escrow: record.reference, type }).slice(0, 48)}`;
}

function publicReference(prefix: "pactescrow" | "pactsettlement" | "pactrefund"): string {
  return `${prefix}_${randomUUID()}`;
}

function status(record: StoredEscrowRecord): PactCashuEscrowStatus {
  return Object.freeze({
    serviceVersion: 1,
    escrowReference: record.reference,
    agreementId: record.agreementId,
    agreementRoot: record.agreementRoot,
    state: record.state,
    version: record.revision,
    amountSats: "350",
    unit: "sat",
    ...(record.releaseAuthorization === undefined
      ? {}
      : { resultReference: record.releaseAuthorization.resultReference }),
    ...(record.settlementReference === undefined
      ? {}
      : { settlementReference: record.settlementReference }),
    ...(record.refundReference === undefined ? {} : { refundReference: record.refundReference }),
    ...(record.lastPublishedTransitionId === undefined
      ? {}
      : { transitionEventId: record.lastPublishedTransitionId }),
  });
}

function result(record: StoredEscrowRecord, outcome: PactCashuMutationOutcome): PactCashuSettlementResult {
  return Object.freeze({ outcome, escrow: status(record) });
}

function mapAgreementFailure(error: unknown): never {
  if (error instanceof PactServiceAgreementError) {
    settlementError(
      error.code === "signer_not_authorized" ? "unauthorized_operation" : "invalid_state",
      "Agreement history is not valid for settlement",
    );
  }
  settlementError("invalid_state", "Agreement history is not valid for settlement");
}

function validatedHistory(
  context: PactAgreementContext,
  events: readonly SignedNostrEvent[],
): PactAgreementHistoryOk {
  try {
    const history = reconstructPactAgreementHistory(context, events);
    if (history.status === "forked") {
      settlementError("invalid_state", "Forked agreement history cannot authorize settlement");
    }
    return history;
  } catch (error) {
    if (error instanceof PactCashuSettlementError) throw error;
    return mapAgreementFailure(error);
  }
}

function currentTransition(history: PactAgreementHistoryOk): SignedNostrEvent | undefined {
  return history.transitions.at(-1)?.event;
}

function transitionStateBeforeTip(history: PactAgreementHistoryOk): PactAgreementState {
  return history.transitions.at(-2)?.content.state ?? "proposed";
}

function assertState(history: PactAgreementHistoryOk, expected: PactAgreementState): void {
  if (history.currentState !== expected) {
    settlementError("invalid_state", "Agreement is not in the required settlement state");
  }
}

function assertNotFutureDated(
  history: PactAgreementHistoryOk,
  now: number,
  skewSeconds: number,
): void {
  const tip = currentTransition(history);
  if (tip && tip.created_at > now + skewSeconds) {
    settlementError("stale_state", "Agreement authorization is future-dated");
  }
}

function assertContextMatchesRecord(record: StoredEscrowRecord, context: PactAgreementContext): void {
  if (
    context.root.event.id !== record.agreementRoot ||
    context.root.content.agreement_id !== record.agreementId ||
    context.root.content.escrow_descriptor !== record.escrowDescriptor
  ) {
    settlementError("agreement_mismatch", "Settlement request references another agreement");
  }
  if (
    context.root.content.requester !== record.requester ||
    context.root.content.provider !== record.provider
  ) {
    settlementError("participant_mismatch", "Settlement participants do not match the escrow");
  }
  if (
    !context.escrowAuthority ||
    context.escrowAuthority.authority !== record.escrowAuthority ||
    context.escrowAuthority.sourceReference !== record.escrowAuthoritySource
  ) {
    settlementError("unauthorized_operation", "Settlement authority does not match the escrow");
  }
}

function toStoredFacts(facts: CashuSettlementFacts): StoredCashuFacts {
  return Object.freeze({
    mintUrl: facts.mintUrl,
    amountSats: facts.amountSats.toString(),
    inputAmountSats: facts.inputAmountSats.toString(),
    outputAmountSats: facts.outputAmountSats.toString(),
    changeAmountSats: facts.changeAmountSats.toString(),
    mintFeeSats: facts.mintFeeSats.toString(),
    reservedSpendFeeSats: facts.reservedSpendFeeSats.toString(),
  });
}

function validateCashuSuccess(
  success: CashuOperationSucceeded,
  mintUrl: string,
  operation: "fund" | "release" | "refund",
): void {
  const facts = success.facts;
  const input = facts.inputAmountSats;
  const output = facts.outputAmountSats;
  const change = facts.changeAmountSats;
  const fee = facts.mintFeeSats;
  const reserved = facts.reservedSpendFeeSats;
  if (
    facts.mintUrl !== mintUrl ||
    facts.unit !== "sat" ||
    facts.amountSats !== PACT_CASHU_ESCROW_DOCUMENT_SUMMARY_AMOUNT_SATS ||
    input !== output + change + fee ||
    (operation === "fund" && output !== facts.amountSats + reserved) ||
    (operation !== "fund" && (output !== facts.amountSats || reserved !== 0n))
  ) {
    settlementError(
      operation === "fund" ? "funding_not_confirmed" : "settlement_conflict",
      "Cashu settlement accounting does not match the bound escrow",
    );
  }
}

function mapCashuFailure(error: unknown, operation: "fund" | "release" | "refund"): never {
  if (error instanceof CashuTestMintError) {
    if (error.code === "invalid_mint_configuration" || error.code === "unsupported_unit") {
      settlementError("unsupported_mint_or_unit", "Cashu mint or unit is unsupported");
    }
    if (error.code === "invalid_spending_condition") {
      settlementError("unsupported_spending_condition", "Cashu spending condition is unsupported");
    }
    if (error.code === "mint_timeout" || error.code === "mint_unavailable") {
      settlementError("mint_unavailable", "Cashu mint operation is unavailable");
    }
    if (error.code === "reconciliation_required" || error.operationStatus === "submitted_unknown") {
      settlementError("reconciliation_required", "Cashu operation requires reconciliation");
    }
    settlementError(
      operation === "fund" ? "funding_not_confirmed" : "settlement_conflict",
      "Cashu operation was not confirmed",
    );
  }
  settlementError("mint_unavailable", "Cashu operation failed");
}

function cashuFailureNeedsReconciliation(error: unknown): boolean {
  return error instanceof CashuTestMintError && error.operationStatus === "submitted_unknown";
}

export interface PreparePactCashuEscrowInput {
  readonly idempotencyKey: string;
  readonly context: PactAgreementContext;
  readonly history: readonly SignedNostrEvent[];
}

export interface FundPactCashuEscrowInput {
  readonly idempotencyKey: string;
  readonly escrowReference: string;
  readonly expectedVersion: number;
  readonly context: PactAgreementContext;
  readonly history: readonly SignedNostrEvent[];
  readonly funding: PrivateCashuFunding;
}

export interface SubmitReleaseAuthorizationInput {
  readonly idempotencyKey: string;
  readonly escrowReference: string;
  readonly expectedVersion: number;
  readonly context: PactAgreementContext;
  readonly history: readonly SignedNostrEvent[];
  readonly resultReference: string;
}

export interface ReleasePactCashuEscrowInput {
  readonly idempotencyKey: string;
  readonly escrowReference: string;
  readonly expectedVersion: number;
  readonly context: PactAgreementContext;
  readonly history: readonly SignedNostrEvent[];
}

export interface SubmitRefundAuthorizationInput {
  readonly idempotencyKey: string;
  readonly escrowReference: string;
  readonly expectedVersion: number;
  readonly context: PactAgreementContext;
  readonly history: readonly SignedNostrEvent[];
  readonly basis: "timeout" | "rejected";
}

export interface RefundPactCashuEscrowInput {
  readonly idempotencyKey: string;
  readonly escrowReference: string;
  readonly expectedVersion: number;
  readonly context: PactAgreementContext;
  readonly history: readonly SignedNostrEvent[];
}

export interface DeliverProviderPayoutInput {
  readonly idempotencyKey: string;
  readonly escrowReference: string;
  readonly expectedVersion: number;
  readonly providerDestination: PrivateCashuBeneficiaryDestination;
  readonly requesterChangeDestination: PrivateCashuBeneficiaryDestination;
}

export interface DeliverRequesterRefundInput {
  readonly idempotencyKey: string;
  readonly escrowReference: string;
  readonly expectedVersion: number;
  readonly requesterDestination: PrivateCashuBeneficiaryDestination;
}

export interface PactCashuPrivateDeliveryResult {
  readonly outcome: "delivered" | "reconciliation_required";
  readonly escrowReference: string;
}

export interface PactCashuEscrowSettlementCoordinator {
  prepareEscrow(input: PreparePactCashuEscrowInput): Promise<PactCashuSettlementResult>;
  fundEscrow(input: FundPactCashuEscrowInput): Promise<PactCashuSettlementResult>;
  inspectEscrowStatus(escrowReference: string): Promise<PactCashuEscrowStatus>;
  submitReleaseAuthorization(input: SubmitReleaseAuthorizationInput): Promise<PactCashuSettlementResult>;
  releaseEscrow(input: ReleasePactCashuEscrowInput): Promise<PactCashuSettlementResult>;
  submitRefundAuthorization(input: SubmitRefundAuthorizationInput): Promise<PactCashuSettlementResult>;
  refundEscrow(input: RefundPactCashuEscrowInput): Promise<PactCashuSettlementResult>;
  deliverProviderPayout(input: DeliverProviderPayoutInput): Promise<PactCashuPrivateDeliveryResult>;
  deliverRequesterRefund(input: DeliverRequesterRefundInput): Promise<PactCashuPrivateDeliveryResult>;
}

export interface PactCashuEscrowSettlementCoordinatorDependencies {
  readonly mintUrl: string;
  readonly cashu: CashuTestMintPort;
  readonly privateDelivery: CashuPrivateValueDeliveryPort;
  readonly store: PactCashuEscrowSettlementStore;
  readonly escrowAuthoritySigner: NostrSigner;
  readonly normalSpendKey: PrivateCashuSpendingKey;
  readonly refundSpendKey: PrivateCashuSpendingKey;
  readonly relay: NostrRelayAdapter;
  readonly clock: PactCashuClock;
}

class PactCashuCoordinator implements PactCashuEscrowSettlementCoordinator {
  private readonly mintUrl: string;

  constructor(private readonly dependencies: PactCashuEscrowSettlementCoordinatorDependencies) {
    this.mintUrl = normalizeCashuTestMintUrl(dependencies.mintUrl);
    if (
      !isPrivateCashuSpendingKey(dependencies.normalSpendKey) ||
      !isPrivateCashuSpendingKey(dependencies.refundSpendKey) ||
      dependencies.normalSpendKey.publicKey === dependencies.refundSpendKey.publicKey
    ) {
      settlementError(
        "unsupported_spending_condition",
        "Settlement coordinator requires distinct private Cashu spend and refund keys",
      );
    }
  }

  private escrowKey(reference: string): string {
    return `escrow:${validateEscrowReference(reference)}`;
  }

  private async readEscrow(reference: string): Promise<StoredEscrowRecord> {
    const value = await this.dependencies.store.read(this.escrowKey(reference));
    if (!isStoredEscrowRecord(value)) {
      settlementError("invalid_request", "Escrow reference was not found");
    }
    return value;
  }

  private async save(
    current: StoredEscrowRecord,
    changes: Omit<Partial<StoredEscrowRecord>, "revision">,
  ): Promise<StoredEscrowRecord> {
    const next = Object.freeze({ ...current, ...changes, revision: current.revision + 1 });
    const saved = await this.dependencies.store.compareAndSet(
      this.escrowKey(current.reference),
      current.revision,
      next,
    );
    if (!saved) settlementError("stale_state", "Escrow state changed concurrently");
    return next;
  }

  private operation(
    record: StoredEscrowRecord,
    key: string,
    type: SettlementOperationType,
    operationFingerprintValue: string,
    expectedVersion: number,
  ): StoredSettlementOperation | undefined {
    const existing = record.operations[key];
    if (existing) {
      if (existing.type !== type || existing.fingerprint !== operationFingerprintValue) {
        settlementError("idempotency_conflict", "Idempotency key was reused with different parameters");
      }
      return existing;
    }
    if (!Number.isSafeInteger(expectedVersion) || record.revision !== expectedVersion) {
      settlementError("stale_state", "Escrow version does not match the expected version");
    }
    return undefined;
  }

  private async setOperation(
    record: StoredEscrowRecord,
    key: string,
    operation: StoredSettlementOperation,
    changes: Omit<Partial<StoredEscrowRecord>, "revision" | "operations"> = {},
  ): Promise<StoredEscrowRecord> {
    return this.save(record, {
      ...changes,
      operations: Object.freeze({ ...record.operations, [key]: Object.freeze(operation) }),
    });
  }

  private contextHistory(
    record: StoredEscrowRecord,
    context: PactAgreementContext,
    events: readonly SignedNostrEvent[],
  ): PactAgreementHistoryOk {
    assertContextMatchesRecord(record, context);
    return validatedHistory(context, events);
  }

  async prepareEscrow(input: PreparePactCashuEscrowInput): Promise<PactCashuSettlementResult> {
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    return this.dependencies.store.withExclusiveLock(`agreement:${input.context.root.event.id}`, async () => {
      const history = validatedHistory(input.context, input.history);
      assertState(history, "accepted");
      const now = safeTime(this.dependencies.clock.now());
      assertNotFutureDated(history, now, PACT_CASHU_ESCROW_CLOCK_SKEW_SECONDS);
      const root = input.context.root;
      if (
        root.content.capability_profile !== DOCUMENT_SUMMARY_PROFILE_ID ||
        root.content.amount_sats !== "350"
      ) {
        settlementError("agreement_mismatch", "Escrow requires document-summary@1 at 350 sats");
      }
      if (root.content.settlement_network !== "cashu") {
        settlementError("unsupported_mint_or_unit", "Agreement does not use Cashu settlement");
      }
      const authority = input.context.escrowAuthority;
      if (!authority || authority.authority !== this.dependencies.escrowAuthoritySigner.publicKey) {
        settlementError("unauthorized_operation", "Configured signer is not the bound escrow authority");
      }
      try {
        createPactAgreementTransition({
          context: input.context,
          history: input.history,
          predecessorEventId: currentTransition(history)?.id ?? null,
          nextState: "escrow_funded",
          actor: authority.authority,
          actorRole: "escrow",
          createdAt: currentTransition(history)?.created_at ?? now,
        });
      } catch (error) {
        return mapAgreementFailure(error);
      }
      const descriptor = parseCashuEscrowDescriptorEvent(input.context.references.escrowDescriptor);
      const accepted = history.transitions.at(-1)!;
      const locktime = accepted.event.created_at + descriptor.content.dispute_rules.timeout.duration_seconds;
      if (!Number.isSafeInteger(locktime)) {
        settlementError("invalid_request", "Escrow locktime is invalid");
      }
      let capabilities;
      try {
        capabilities = await this.dependencies.cashu.inspectCapabilities();
      } catch (error) {
        return mapCashuFailure(error, "fund");
      }
      if (capabilities.mintUrl !== this.mintUrl || capabilities.unit !== "sat") {
        settlementError("unsupported_mint_or_unit", "Cashu adapter configuration does not match escrow");
      }
      const requestFingerprint = fingerprint({
        service_version: 1,
        agreement_id: root.content.agreement_id,
        agreement_root: root.event.id,
        operation_type: "prepare",
        expected_state: "accepted",
        expected_version: 0,
        actor: authority.authority,
        amount_sats: "350",
        unit: "sat",
        mint_url: this.mintUrl,
        escrow_descriptor: root.content.escrow_descriptor,
        lock_public_key: this.dependencies.normalSpendKey.publicKey,
        refund_public_key: this.dependencies.refundSpendKey.publicKey,
        locktime,
      });
      const preparationKey = `preparation:${idempotencyKey}`;
      const agreementKey = `agreement-escrow:${root.event.id}`;
      const storedPreparation = await this.dependencies.store.read(preparationKey);
      const storedAgreement = await this.dependencies.store.read(agreementKey);
      let escrowReference: string;
      if (storedPreparation !== undefined) {
        if (
          !isStoredPreparation(storedPreparation) ||
          storedPreparation.requestFingerprint !== requestFingerprint
        ) {
          settlementError("idempotency_conflict", "Preparation key was reused with different parameters");
        }
        escrowReference = storedPreparation.escrowReference;
      } else if (storedAgreement !== undefined) {
        if (
          !isStoredAgreementEscrow(storedAgreement) ||
          storedAgreement.requestFingerprint !== requestFingerprint
        ) {
          settlementError("agreement_mismatch", "Agreement is already bound to another escrow");
        }
        escrowReference = storedAgreement.escrowReference;
        const insertedPreparation = await this.dependencies.store.insert(
          preparationKey,
          Object.freeze({ revision: 1, requestFingerprint, escrowReference }),
        );
        if (!insertedPreparation) {
          settlementError("idempotency_conflict", "Preparation key changed concurrently");
        }
      } else {
        escrowReference = publicReference("pactescrow");
        const inserted = await this.dependencies.store.insert(
          preparationKey,
          Object.freeze({ revision: 1, requestFingerprint, escrowReference }),
        );
        if (!inserted) settlementError("stale_state", "Escrow preparation changed concurrently");
      }
      if (storedAgreement === undefined) {
        const insertedAgreement = await this.dependencies.store.insert(
          agreementKey,
          Object.freeze({ revision: 1, requestFingerprint, escrowReference }),
        );
        if (!insertedAgreement) settlementError("stale_state", "Agreement escrow binding changed concurrently");
      } else if (
        !isStoredAgreementEscrow(storedAgreement) ||
        storedAgreement.requestFingerprint !== requestFingerprint ||
        storedAgreement.escrowReference !== escrowReference
      ) {
        settlementError("agreement_mismatch", "Agreement is already bound to another escrow");
      }
      const existing = await this.dependencies.store.read(this.escrowKey(escrowReference));
      if (isStoredEscrowRecord(existing)) return result(existing, "confirmed");
      const operationFingerprintValue = fingerprint({
        request_fingerprint: requestFingerprint,
        escrow_reference: escrowReference,
      });
      const record: StoredEscrowRecord = Object.freeze({
        revision: 1,
        serviceVersion: 1,
        reference: escrowReference,
        agreementId: root.content.agreement_id,
        agreementRoot: root.event.id,
        requester: root.content.requester as NostrPublicKey,
        provider: root.content.provider as NostrPublicKey,
        escrowAuthority: authority.authority,
        escrowAuthoritySource: authority.sourceReference,
        escrowDescriptor: root.content.escrow_descriptor,
        mintUrl: this.mintUrl,
        unit: "sat",
        amountSats: "350",
        capabilityProfile: DOCUMENT_SUMMARY_PROFILE_ID,
        agreementExpiresAt: root.content.expires_at,
        acceptedEventId: accepted.event.id,
        timeoutPolicy: "refund-trigger timeout",
        timeoutDurationSeconds: descriptor.content.dispute_rules.timeout.duration_seconds,
        locktime,
        clockSkewSeconds: 1,
        spendingCondition: Object.freeze({
          lockPublicKey: this.dependencies.normalSpendKey.publicKey,
          refundPublicKey: this.dependencies.refundSpendKey.publicKey,
          locktime,
        }),
        state: "prepared",
        economicClaim: "none",
        operations: Object.freeze({
          [idempotencyKey]: Object.freeze({
            type: "prepare",
            fingerprint: operationFingerprintValue,
            status: "succeeded",
          }),
        }),
      });
      const inserted = await this.dependencies.store.insert(this.escrowKey(escrowReference), record);
      if (!inserted) {
        const existing = await this.readEscrow(escrowReference);
        return result(existing, "confirmed");
      }
      return result(record, "confirmed");
    });
  }

  async inspectEscrowStatus(escrowReference: string): Promise<PactCashuEscrowStatus> {
    return status(await this.readEscrow(escrowReference));
  }

  private async publishConfirmedTransition(input: {
    record: StoredEscrowRecord;
    context: PactAgreementContext;
    historyEvents: readonly SignedNostrEvent[];
    history: PactAgreementHistoryOk;
    expectedState: PactAgreementState;
    targetState: "escrow_funded" | "settled" | "refunded";
    finalOperationalState: "funded" | "settled" | "refunded";
    operationKey: string;
  }): Promise<{ record: StoredEscrowRecord; published: boolean }> {
    let record = input.record;
    let history = input.history;
    if (history.currentState === input.targetState) {
      const tip = currentTransition(history)!;
      if (!record.pendingTransition || tip.id !== record.pendingTransition.id) {
        settlementError("settlement_conflict", "Agreement contains a different settlement transition");
      }
      record = await this.setOperation(
        record,
        input.operationKey,
        { ...record.operations[input.operationKey], status: "succeeded" },
        {
          state: input.finalOperationalState,
          economicClaim:
            input.targetState === "settled"
              ? "release"
              : input.targetState === "refunded"
                ? "refund"
                : record.economicClaim,
          lastPublishedTransitionId: tip.id,
          pendingTransition: undefined,
        },
      );
      return { record, published: true };
    }
    assertState(history, input.expectedState);
    let signedEvent = record.pendingTransition;
    if (!signedEvent) {
      try {
        const tip = currentTransition(history);
        const draft = createPactAgreementTransition({
          context: input.context,
          history: input.historyEvents,
          predecessorEventId: tip?.id ?? null,
          nextState: input.targetState,
          actor: record.escrowAuthority,
          actorRole: "escrow",
          createdAt: Math.max(safeTime(this.dependencies.clock.now()), tip?.created_at ?? 0),
        });
        const signed = await signPactAgreementTransition({
          context: input.context,
          history: input.historyEvents,
          transition: draft,
          signer: this.dependencies.escrowAuthoritySigner,
        });
        signedEvent = signed.event;
        record = await this.save(record, { pendingTransition: signedEvent });
      } catch {
        return { record, published: false };
      }
    }
    try {
      const parsed = parsePactAgreementTransitionEvent(
        signedEvent,
        input.context.root.content.capability_profile,
      );
      await publishSignedPactAgreementTransition({
        context: input.context,
        history: input.historyEvents,
        transition: { event: signedEvent, content: parsed.content },
        relay: this.dependencies.relay,
      });
      history = validatedHistory(input.context, [...input.historyEvents, signedEvent]);
      if (history.currentState !== input.targetState) {
        settlementError("invalid_state", "Published settlement transition did not advance history");
      }
      record = await this.setOperation(
        record,
        input.operationKey,
        { ...record.operations[input.operationKey], status: "succeeded" },
        {
          state: input.finalOperationalState,
          economicClaim:
            input.targetState === "settled"
              ? "release"
              : input.targetState === "refunded"
                ? "refund"
                : record.economicClaim,
          lastPublishedTransitionId: signedEvent.id,
          pendingTransition: undefined,
        },
      );
      return { record, published: true };
    } catch {
      record = await this.setOperation(
        record,
        input.operationKey,
        { ...record.operations[input.operationKey], status: "publication_pending" },
      );
      return { record, published: false };
    }
  }

  async fundEscrow(input: FundPactCashuEscrowInput): Promise<PactCashuSettlementResult> {
    const reference = validateEscrowReference(input.escrowReference);
    const key = validateIdempotencyKey(input.idempotencyKey);
    return this.dependencies.store.withExclusiveLock(this.escrowKey(reference), async () => {
      let record = await this.readEscrow(reference);
      let history = this.contextHistory(record, input.context, input.history);
      const operationFingerprintValue = operationFingerprint({
        record,
        type: "fund",
        expectedVersion: input.expectedVersion,
        expectedState: "prepared",
        actor: record.escrowAuthority,
      });
      const existing = this.operation(record, key, "fund", operationFingerprintValue, input.expectedVersion);
      if (existing?.status === "succeeded") return result(record, "confirmed");
      if (!existing) {
        assertState(history, "accepted");
        if (record.state !== "prepared") settlementError("invalid_state", "Escrow is not ready for funding");
        record = await this.setOperation(
          record,
          key,
          { type: "fund", fingerprint: operationFingerprintValue, status: "pending" },
          { state: "funding_pending" },
        );
      }
      if (record.state === "funded") return result(record, "confirmed");
      if (record.state === "funding_confirmed") {
        const published = await this.publishConfirmedTransition({
          record,
          context: input.context,
          historyEvents: input.history,
          history,
          expectedState: "accepted",
          targetState: "escrow_funded",
          finalOperationalState: "funded",
          operationKey: key,
        });
        return result(published.record, published.published ? "confirmed" : "publication_pending");
      }
      assertState(history, "accepted");
      let cashuResult: CashuMutationResult;
      try {
        cashuResult = await this.dependencies.cashu.prepareLockedValue({
          operationId: cashuOperationId(record, "fund", key),
          funding: input.funding,
          amountSats: PACT_CASHU_ESCROW_DOCUMENT_SUMMARY_AMOUNT_SATS,
          spendingCondition: record.spendingCondition,
        });
      } catch (error) {
        if (cashuFailureNeedsReconciliation(error)) {
          record = await this.setOperation(
            record,
            key,
            { ...record.operations[key], status: "reconciliation_required" },
            { state: "funding_reconciliation_required" },
          );
          return result(record, "reconciliation_required");
        }
        record = await this.setOperation(
          record,
          key,
          { ...record.operations[key], status: "failed" },
          { state: "prepared" },
        );
        return mapCashuFailure(error, "fund");
      }
      if (cashuResult.status === "submitted_unknown") {
        record = await this.setOperation(
          record,
          key,
          { ...record.operations[key], status: "reconciliation_required" },
          { state: "funding_reconciliation_required" },
        );
        return result(record, "reconciliation_required");
      }
      try {
        validateCashuSuccess(cashuResult, this.mintUrl, "fund");
      } catch (error) {
        record = await this.setOperation(
          record,
          key,
          { ...record.operations[key], status: "reconciliation_required" },
          { state: "funding_reconciliation_required" },
        );
        throw error;
      }
      record = await this.setOperation(
        record,
        key,
        { ...record.operations[key], status: "pending" },
        {
          state: "funding_confirmed",
          fundingHandle: cashuResult.handle,
          fundingChangeHandle: cashuResult.changeHandle,
          fundingFacts: toStoredFacts(cashuResult.facts),
        },
      );
      history = this.contextHistory(record, input.context, input.history);
      const published = await this.publishConfirmedTransition({
        record,
        context: input.context,
        historyEvents: input.history,
        history,
        expectedState: "accepted",
        targetState: "escrow_funded",
        finalOperationalState: "funded",
        operationKey: key,
      });
      return result(published.record, published.published ? "confirmed" : "publication_pending");
    });
  }

  async submitReleaseAuthorization(
    input: SubmitReleaseAuthorizationInput,
  ): Promise<PactCashuSettlementResult> {
    const reference = validateEscrowReference(input.escrowReference);
    const key = validateIdempotencyKey(input.idempotencyKey);
    return this.dependencies.store.withExclusiveLock(this.escrowKey(reference), async () => {
      let record = await this.readEscrow(reference);
      const history = this.contextHistory(record, input.context, input.history);
      assertState(history, "release_authorized");
      const authorization = history.transitions.at(-1)!;
      const verified = history.transitions.at(-2);
      const resultReference = verified?.content.result_reference;
      if (
        verified?.content.state !== "result_verified" ||
        !resultReference ||
        resultReference !== input.resultReference ||
        authorization.content.actor !== record.requester
      ) {
        settlementError("completion_not_authorized", "Release authorization does not match completion");
      }
      const now = safeTime(this.dependencies.clock.now());
      assertNotFutureDated(history, now, record.clockSkewSeconds);
      if (now >= record.locktime || authorization.event.created_at >= record.locktime) {
        settlementError("completion_not_authorized", "Release authorization has expired");
      }
      const operationFingerprintValue = operationFingerprint({
        record,
        type: "authorize_release",
        expectedVersion: input.expectedVersion,
        expectedState: "funded",
        actor: authorization.event.pubkey,
        authorizationReference: authorization.event.id,
        resultReference,
      });
      const existing = this.operation(
        record,
        key,
        "authorize_release",
        operationFingerprintValue,
        input.expectedVersion,
      );
      if (existing?.status === "succeeded") return result(record, "confirmed");
      if (record.releaseAuthorization && record.releaseAuthorization.operationKey !== key) {
        settlementError("completion_not_authorized", "Release authorization was already consumed");
      }
      if (record.state !== "funded") settlementError("funding_not_confirmed", "Escrow funding is not confirmed");
      record = await this.setOperation(
        record,
        key,
        {
          type: "authorize_release",
          fingerprint: operationFingerprintValue,
          status: "succeeded",
        },
        {
          state: "release_authorized",
          releaseAuthorization: Object.freeze({
            eventId: authorization.event.id,
            predecessor: authorization.content.predecessor!,
            resultReference,
            authorizer: authorization.event.pubkey,
            expiresAt: record.locktime,
            operationKey: key,
          }),
        },
      );
      return result(record, "confirmed");
    });
  }

  async releaseEscrow(input: ReleasePactCashuEscrowInput): Promise<PactCashuSettlementResult> {
    return this.executeEconomic(input, "release");
  }

  async submitRefundAuthorization(
    input: SubmitRefundAuthorizationInput,
  ): Promise<PactCashuSettlementResult> {
    const reference = validateEscrowReference(input.escrowReference);
    const key = validateIdempotencyKey(input.idempotencyKey);
    return this.dependencies.store.withExclusiveLock(this.escrowKey(reference), async () => {
      let record = await this.readEscrow(reference);
      const history = this.contextHistory(record, input.context, input.history);
      assertState(history, "refund_authorized");
      const authorization = history.transitions.at(-1)!;
      const previous = transitionStateBeforeTip(history);
      const now = safeTime(this.dependencies.clock.now());
      assertNotFutureDated(history, now, record.clockSkewSeconds);
      if (authorization.content.actor !== record.requester) {
        settlementError("unauthorized_operation", "Refund signer is not the bound requester");
      }
      if (input.basis === "timeout") {
        if (now < record.locktime || authorization.event.created_at < record.locktime) {
          settlementError("timeout_not_reached", "Escrow refund locktime has not been reached");
        }
        if (previous !== "escrow_funded" && previous !== "accepted") {
          settlementError("invalid_state", "Timeout refund does not follow an eligible state");
        }
      } else if (previous !== "rejected") {
        settlementError("invalid_state", "Rejected refund does not follow a rejected result");
      }
      const operationFingerprintValue = operationFingerprint({
        record,
        type: "authorize_refund",
        expectedVersion: input.expectedVersion,
        expectedState: "funded",
        actor: authorization.event.pubkey,
        authorizationReference: authorization.event.id,
      });
      const existing = this.operation(
        record,
        key,
        "authorize_refund",
        operationFingerprintValue,
        input.expectedVersion,
      );
      if (existing?.status === "succeeded") return result(record, "confirmed");
      if (record.refundAuthorization && record.refundAuthorization.operationKey !== key) {
        settlementError("unauthorized_operation", "Refund authorization was already consumed");
      }
      if (!record.fundingHandle || record.state !== "funded") {
        settlementError("funding_not_confirmed", "Escrow funding is not confirmed");
      }
      record = await this.setOperation(
        record,
        key,
        { type: "authorize_refund", fingerprint: operationFingerprintValue, status: "succeeded" },
        {
          state: "refund_authorized",
          refundAuthorization: Object.freeze({
            eventId: authorization.event.id,
            predecessor: authorization.content.predecessor!,
            authorizer: authorization.event.pubkey,
            basis: input.basis,
            operationKey: key,
          }),
        },
      );
      return result(record, "confirmed");
    });
  }

  async refundEscrow(input: RefundPactCashuEscrowInput): Promise<PactCashuSettlementResult> {
    return this.executeEconomic(input, "refund");
  }

  async deliverProviderPayout(
    input: DeliverProviderPayoutInput,
  ): Promise<PactCashuPrivateDeliveryResult> {
    return this.deliverPrivateValue(input, "provider");
  }

  async deliverRequesterRefund(
    input: DeliverRequesterRefundInput,
  ): Promise<PactCashuPrivateDeliveryResult> {
    return this.deliverPrivateValue(input, "requester_refund");
  }

  private async deliverPrivateValue(
    input: DeliverProviderPayoutInput | DeliverRequesterRefundInput,
    direction: "provider" | "requester_refund",
  ): Promise<PactCashuPrivateDeliveryResult> {
    const reference = validateEscrowReference(input.escrowReference);
    const key = validateIdempotencyKey(input.idempotencyKey);
    return this.dependencies.store.withExclusiveLock(this.escrowKey(reference), async () => {
      let record = await this.readEscrow(reference);
      const type: SettlementOperationType =
        direction === "provider" ? "deliver_provider_payout" : "deliver_requester_refund";
      const requiredState = direction === "provider" ? "settled" : "refunded";
      const operationFingerprintValue = operationFingerprint({
        record,
        type,
        expectedVersion: input.expectedVersion,
        expectedState: requiredState,
        actor: direction === "provider" ? record.provider : record.requester,
      });
      const existing = this.operation(
        record,
        key,
        type,
        operationFingerprintValue,
        input.expectedVersion,
      );
      if (existing?.status === "succeeded") {
        return Object.freeze({ outcome: "delivered", escrowReference: reference });
      }
      if (record.state !== requiredState) {
        settlementError("invalid_state", "Escrow output is not ready for private delivery");
      }
      const deliveries =
        direction === "provider"
          ? [
              {
                handle: record.settlementHandle,
                deliveryId: privateDeliveryId(record, "provider-payout"),
                beneficiary: record.provider,
                destination: (input as DeliverProviderPayoutInput).providerDestination,
              },
              {
                handle: record.fundingChangeHandle,
                deliveryId: privateDeliveryId(record, "requester-funding-change"),
                beneficiary: record.requester,
                destination: (input as DeliverProviderPayoutInput).requesterChangeDestination,
              },
              {
                handle: record.settlementChangeHandle,
                deliveryId: privateDeliveryId(record, "requester-settlement-change"),
                beneficiary: record.requester,
                destination: (input as DeliverProviderPayoutInput).requesterChangeDestination,
              },
            ]
          : [
              {
                handle: record.refundHandle,
                deliveryId: privateDeliveryId(record, "requester-refund"),
                beneficiary: record.requester,
                destination: (input as DeliverRequesterRefundInput).requesterDestination,
              },
              {
                handle: record.fundingChangeHandle,
                deliveryId: privateDeliveryId(record, "requester-funding-change"),
                beneficiary: record.requester,
                destination: (input as DeliverRequesterRefundInput).requesterDestination,
              },
              {
                handle: record.refundChangeHandle,
                deliveryId: privateDeliveryId(record, "requester-refund-change"),
                beneficiary: record.requester,
                destination: (input as DeliverRequesterRefundInput).requesterDestination,
              },
            ];
      if (!deliveries[0].handle) {
        settlementError("invalid_state", "Escrow payout is missing from private custody");
      }
      if (!existing) {
        record = await this.setOperation(record, key, {
          type,
          fingerprint: operationFingerprintValue,
          status: "pending",
        });
      }
      try {
        for (const delivery of deliveries) {
          if (!delivery.handle) continue;
          await this.dependencies.privateDelivery.deliver({
            deliveryId: delivery.deliveryId,
            handle: delivery.handle,
            expectedBeneficiary: delivery.beneficiary,
            destination: delivery.destination,
          });
        }
      } catch (error) {
        if (
          error instanceof CashuTestMintError &&
          (error.code === "reconciliation_required" ||
            error.operationStatus === "submitted_unknown")
        ) {
          await this.setOperation(record, key, {
            ...record.operations[key],
            status: "reconciliation_required",
          });
          return Object.freeze({
            outcome: "reconciliation_required",
            escrowReference: reference,
          });
        }
        settlementError("unauthorized_operation", "Private Cashu output delivery failed");
      }
      await this.setOperation(record, key, {
        ...record.operations[key],
        status: "succeeded",
      });
      return Object.freeze({ outcome: "delivered", escrowReference: reference });
    });
  }

  private async executeEconomic(
    input: ReleasePactCashuEscrowInput | RefundPactCashuEscrowInput,
    type: "release" | "refund",
  ): Promise<PactCashuSettlementResult> {
    const reference = validateEscrowReference(input.escrowReference);
    const key = validateIdempotencyKey(input.idempotencyKey);
    return this.dependencies.store.withExclusiveLock(this.escrowKey(reference), async () => {
      let record = await this.readEscrow(reference);
      let history = this.contextHistory(record, input.context, input.history);
      if (type === "release" && record.state === "refunded") {
        settlementError("already_refunded", "Escrow has already been refunded");
      }
      if (type === "refund" && record.state === "settled") {
        settlementError("already_released", "Escrow has already been released");
      }
      const authorization =
        type === "release" ? record.releaseAuthorization : record.refundAuthorization;
      if (!authorization) {
        settlementError(
          type === "release" ? "completion_not_authorized" : "unauthorized_operation",
          "Settlement authorization is missing",
        );
      }
      const expectedLifecycleState = type === "release" ? "release_authorized" : "refund_authorized";
      const operationFingerprintValue = operationFingerprint({
        record,
        type,
        expectedVersion: input.expectedVersion,
        expectedState: type === "release" ? "release_authorized" : "refund_authorized",
        actor: authorization.authorizer,
        authorizationReference: authorization.eventId,
        resultReference: type === "release" ? record.releaseAuthorization?.resultReference : undefined,
      });
      const existing = this.operation(record, key, type, operationFingerprintValue, input.expectedVersion);
      if (existing?.status === "succeeded") return result(record, "confirmed");
      if (record.state === "refunded") {
        settlementError("already_refunded", "Escrow has already been refunded");
      }
      if (record.state === "settled") {
        settlementError("already_released", "Escrow has already been released");
      }
      if (type === "release" && record.economicClaim === "refund") {
        settlementError("settlement_conflict", "Refund already won");
      }
      if (type === "refund" && record.economicClaim === "release") {
        settlementError("settlement_conflict", "Release already won");
      }
      assertState(history, expectedLifecycleState);
      if (currentTransition(history)?.id !== authorization.eventId) {
        settlementError("stale_state", "Settlement authorization is stale");
      }
      const now = safeTime(this.dependencies.clock.now());
      assertNotFutureDated(history, now, record.clockSkewSeconds);
      if (type === "release" && now >= record.locktime) {
        settlementError("completion_not_authorized", "Release authorization has expired");
      }
      if (type === "refund" && record.refundAuthorization?.basis === "timeout" && now < record.locktime) {
        settlementError("timeout_not_reached", "Escrow refund locktime has not been reached");
      }
      const confirmedState = type === "release" ? "release_confirmed" : "refund_confirmed";
      if (record.state === confirmedState) {
        const published = await this.publishConfirmedTransition({
          record,
          context: input.context,
          historyEvents: input.history,
          history,
          expectedState: expectedLifecycleState,
          targetState: type === "release" ? "settled" : "refunded",
          finalOperationalState: type === "release" ? "settled" : "refunded",
          operationKey: key,
        });
        return result(published.record, published.published ? "confirmed" : "publication_pending");
      }
      if (!existing) {
        const expectedOperationalState = type === "release" ? "release_authorized" : "refund_authorized";
        if (record.state !== expectedOperationalState || !record.fundingHandle) {
          settlementError("invalid_state", "Escrow is not ready for economic execution");
        }
        record = await this.setOperation(
          record,
          key,
          { type, fingerprint: operationFingerprintValue, status: "pending" },
          {
            state: type === "release" ? "release_pending" : "refund_pending",
            economicClaim: type,
          },
        );
      }
      if (!record.fundingHandle) settlementError("funding_not_confirmed", "Escrow funding is missing");
      let cashuResult: CashuMutationResult;
      try {
        const spendingKey =
          type === "release" || now < record.locktime
            ? this.dependencies.normalSpendKey
            : this.dependencies.refundSpendKey;
        cashuResult = await this.dependencies.cashu.spendLockedValue({
          operationId: cashuOperationId(record, type, key),
          handle: record.fundingHandle,
          spendingKey,
        });
      } catch (error) {
        if (cashuFailureNeedsReconciliation(error)) {
          record = await this.setOperation(
            record,
            key,
            { ...record.operations[key], status: "reconciliation_required" },
            {
              state:
                type === "release"
                  ? "release_reconciliation_required"
                  : "refund_reconciliation_required",
            },
          );
          return result(record, "reconciliation_required");
        }
        record = await this.setOperation(
          record,
          key,
          { ...record.operations[key], status: "failed" },
          {
            state: type === "release" ? "release_authorized" : "refund_authorized",
            economicClaim: "none",
          },
        );
        return mapCashuFailure(error, type);
      }
      if (cashuResult.status === "submitted_unknown") {
        record = await this.setOperation(
          record,
          key,
          { ...record.operations[key], status: "reconciliation_required" },
          {
            state:
              type === "release"
                ? "release_reconciliation_required"
                : "refund_reconciliation_required",
          },
        );
        return result(record, "reconciliation_required");
      }
      try {
        validateCashuSuccess(cashuResult, this.mintUrl, type);
      } catch (error) {
        record = await this.setOperation(
          record,
          key,
          { ...record.operations[key], status: "reconciliation_required" },
          {
            state:
              type === "release"
                ? "release_reconciliation_required"
                : "refund_reconciliation_required",
          },
        );
        throw error;
      }
      record = await this.setOperation(
        record,
        key,
        { ...record.operations[key], status: "pending" },
        {
          state: confirmedState,
          ...(type === "release"
            ? {
                settlementReference:
                  record.settlementReference ?? publicReference("pactsettlement"),
                settlementHandle: cashuResult.handle,
                settlementChangeHandle: cashuResult.changeHandle,
              }
            : {
                refundReference: record.refundReference ?? publicReference("pactrefund"),
                refundHandle: cashuResult.handle,
                refundChangeHandle: cashuResult.changeHandle,
              }),
        },
      );
      history = this.contextHistory(record, input.context, input.history);
      const published = await this.publishConfirmedTransition({
        record,
        context: input.context,
        historyEvents: input.history,
        history,
        expectedState: expectedLifecycleState,
        targetState: type === "release" ? "settled" : "refunded",
        finalOperationalState: type === "release" ? "settled" : "refunded",
        operationKey: key,
      });
      return result(published.record, published.published ? "confirmed" : "publication_pending");
    });
  }
}

export function createPactCashuEscrowSettlementCoordinator(
  dependencies: PactCashuEscrowSettlementCoordinatorDependencies,
): PactCashuEscrowSettlementCoordinator {
  return new PactCashuCoordinator(dependencies);
}
