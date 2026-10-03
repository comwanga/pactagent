import "server-only";

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { nostrPublicKey, type NostrPublicKey } from "../domain/nostr";

/*
 * Durable provider idempotency store (Issue #38 Blocker 1).
 *
 * SQLite-backed crash-safe store for tracking provider agreement processing
 * state across restarts. Prevents duplicate agreement processing, task
 * execution, and result publication after a provider service restart.
 *
 * F38-03: Expanded state machine with precise substates to prevent
 * premature "complete" after crash. Recovery must reconcile durable
 * local state + authoritative relay history before deciding action.
 *
 * State machine:
 *
 *   received → acceptance_prepared → acceptance_published → waiting_for_funding → processing → result_prepared → result_published → transitions_reconciling → complete
 *                                                     ↓                        ↓                 ↓                    ↓                      ↓
 *               recovery_required ←──────────────────┘              recovery_required   recovery_required   recovery_required      recovery_required
 *
 * F38-04: Result publication is crash-idempotent. The exact signed
 * NIP-59 gift-wrap event is persisted in `preparedEventJson` before
 * the first publish. On restart from result_prepared, the persisted
 * event is reused — NO new randomized gift wrap is generated.
 *
 * Recovery rules:
 *   received:              re-process from the beginning (agreement was seen but not started).
 *   acceptance_prepared:   acceptance transition was constructed but not published. Re-publish.
 *   acceptance_published:  acceptance was published. Continue waiting for funding. NOT complete.
 *   waiting_for_funding:    accepted, waiting for escrow_funded. Continue waiting. NOT complete.
 *   processing:             UNCERTAIN — execution may or may not have occurred.
 *                           If the capability is replay_safe AND no result is on the relay:
 *                             permitted deterministic replay → result_prepared.
 *                           If the capability is non_replay_safe AND no result is on the relay:
 *                             transition to recovery_required. NO automatic re-execution.
 *                           If a result IS on the relay: skip to result_published.
 *   recovery_required:      explicit operator recovery state. The provider MUST NOT
 *                           automatically re-execute. Operator resolves via doctor/reconcile.
 *   result_prepared:        result was computed and the exact gift-wrap event was persisted.
 *                           Re-publish the SAME persisted event. No re-execution.
 *                           No new randomized gift wrap.
 *   result_published:       result is on the relay. Reconcile missing public lifecycle
 *                           transitions. Continue to terminal state. NOT complete until
 *                           relay shows settled/refunded.
 *   transitions_reconciling: restoring missing public lifecycle transitions.
 *   complete:               fully terminal — relay shows settled or refunded.
 *                           Never re-execute.
 *
 * The store uses WAL mode with synchronous=FULL for crash safety.
 * File permissions are 0600 (private application state).
 */

export type ProviderOperationState =
  | "received"
  | "acceptance_prepared"
  | "acceptance_published"
  | "waiting_for_funding"
  | "processing"
  | "result_prepared"
  | "result_published"
  | "transitions_reconciling"
  | "recovery_required"
  | "complete";

/**
 * Capability execution replay-safety policy (Issue #38 Final Blocker 2).
 *
 * An uncertain post-execution crash MUST NOT automatically cause duplicate
 * execution unless the capability is explicitly declared safe/idempotent for
 * re-execution.
 *
 * replay_safe:        The capability is pure/deterministic enough that
 *                     re-executing after an uncertain crash produces the same
 *                     result without duplicate side effects.
 *                     document-summary@1 is replay_safe: it is a deterministic
 *                     text extraction + frequency-based summarization with no
 *                     external side effects.
 *
 * non_replay_safe:    The capability may have external side effects.
 *                     After an uncertain crash in "processing" state, the
 *                     provider enters "recovery_required" and does NOT
 *                     automatically re-execute. An operator must resolve.
 */
export type CapabilityReplaySafety = "replay_safe" | "non_replay_safe";

export interface ProviderOperationRecord {
  readonly agreementRootEventId: string;
  readonly agreementId: string;
  readonly requesterPublicKey: NostrPublicKey;
  readonly state: ProviderOperationState;
  readonly resultReference: string | undefined;
  readonly resultSummary: string | undefined;
  readonly acceptedTransitionEventId: string | undefined;
  readonly taskDeliveredTransitionEventId: string | undefined;
  readonly resultSubmittedTransitionEventId: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly failureCode: string | undefined;
  /**
   * F38-04: The exact signed NIP-59 gift-wrap event JSON, persisted
   * before the first external publish. On restart from result_prepared,
   * this exact event is re-published — NO new randomized gift wrap.
   * This ensures crash-idempotent result publication.
   */
  readonly preparedEventJson?: string;
}

export type ProviderIdempotencyErrorCode =
  | "store_unavailable"
  | "record_not_found"
  | "invalid_state_transition"
  | "invalid_record";

export class ProviderIdempotencyError extends Error {
  readonly code: ProviderIdempotencyErrorCode;

  constructor(code: ProviderIdempotencyErrorCode, message: string) {
    super(message);
    this.name = "ProviderIdempotencyError";
    this.code = code;
  }
}

const VALID_STATES: ReadonlySet<string> = new Set([
  "received",
  "acceptance_prepared",
  "acceptance_published",
  "waiting_for_funding",
  "processing",
  "result_prepared",
  "result_published",
  "transitions_reconciling",
  "recovery_required",
  "complete",
]);

const STATE_TRANSITIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["received", new Set(["acceptance_prepared", "processing", "acceptance_published", "waiting_for_funding", "result_prepared", "result_published", "recovery_required", "complete"])],
  ["acceptance_prepared", new Set(["acceptance_published", "waiting_for_funding", "processing", "recovery_required", "complete"])],
  ["acceptance_published", new Set(["waiting_for_funding", "processing", "recovery_required", "complete"])],
  ["waiting_for_funding", new Set(["processing", "recovery_required", "complete"])],
  ["processing", new Set(["result_prepared", "result_published", "transitions_reconciling", "recovery_required", "complete"])],
  ["recovery_required", new Set(["result_prepared", "result_published", "transitions_reconciling", "complete"])],
  ["result_prepared", new Set(["result_published", "transitions_reconciling", "complete"])],
  ["result_published", new Set(["transitions_reconciling", "complete"])],
  ["transitions_reconciling", new Set(["complete", "result_published"])],
  ["complete", new Set()],
]);

function isValidStateTransition(from: string, to: string): boolean {
  if (from === to) return true;
  const allowed = STATE_TRANSITIONS.get(from);
  return allowed !== undefined && allowed.has(to);
}

interface PersistedRecord {
  readonly version: 1;
  readonly agreement_root_event_id: string;
  readonly agreement_id: string;
  readonly requester_public_key: string;
  readonly state: string;
  readonly result_reference: string | null;
  readonly result_summary: string | null;
  readonly accepted_transition_event_id: string | null;
  readonly task_delivered_transition_event_id: string | null;
  readonly result_submitted_transition_event_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly failure_code: string | null;
  readonly prepared_event_json: string | null;
}

function toPersisted(record: ProviderOperationRecord): PersistedRecord {
  return {
    version: 1,
    agreement_root_event_id: record.agreementRootEventId,
    agreement_id: record.agreementId,
    requester_public_key: record.requesterPublicKey,
    state: record.state,
    result_reference: record.resultReference ?? null,
    result_summary: record.resultSummary ?? null,
    accepted_transition_event_id: record.acceptedTransitionEventId ?? null,
    task_delivered_transition_event_id: record.taskDeliveredTransitionEventId ?? null,
    result_submitted_transition_event_id: record.resultSubmittedTransitionEventId ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    failure_code: record.failureCode ?? null,
    prepared_event_json: record.preparedEventJson ?? null,
  };
}

function fromPersisted(raw: unknown): ProviderOperationRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new ProviderIdempotencyError("invalid_record", "Persisted record is not an object");
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.version !== 1) {
    throw new ProviderIdempotencyError("invalid_record", "Persisted record version is unsupported");
  }
  if (
    typeof candidate.agreement_root_event_id !== "string" ||
    typeof candidate.agreement_id !== "string" ||
    typeof candidate.requester_public_key !== "string" ||
    typeof candidate.state !== "string" ||
    !VALID_STATES.has(candidate.state) ||
    typeof candidate.created_at !== "number" ||
    typeof candidate.updated_at !== "number"
  ) {
    throw new ProviderIdempotencyError("invalid_record", "Persisted record is malformed");
  }
  return Object.freeze({
    agreementRootEventId: candidate.agreement_root_event_id,
    agreementId: candidate.agreement_id,
    requesterPublicKey: nostrPublicKey(candidate.requester_public_key as string),
    state: candidate.state as ProviderOperationState,
    resultReference: typeof candidate.result_reference === "string" ? candidate.result_reference : undefined,
    resultSummary: typeof candidate.result_summary === "string" ? candidate.result_summary : undefined,
    acceptedTransitionEventId:
      typeof candidate.accepted_transition_event_id === "string"
        ? candidate.accepted_transition_event_id
        : undefined,
    taskDeliveredTransitionEventId:
      typeof candidate.task_delivered_transition_event_id === "string"
        ? candidate.task_delivered_transition_event_id
        : undefined,
    resultSubmittedTransitionEventId:
      typeof candidate.result_submitted_transition_event_id === "string"
        ? candidate.result_submitted_transition_event_id
        : undefined,
    createdAt: candidate.created_at as number,
    updatedAt: candidate.updated_at as number,
    failureCode: typeof candidate.failure_code === "string" ? candidate.failure_code : undefined,
    preparedEventJson: typeof (candidate as Record<string, unknown>).prepared_event_json === "string"
      ? (candidate as Record<string, unknown>).prepared_event_json as string
      : undefined,
  });
}

export interface ProviderIdempotencyStore {
  read(agreementRootEventId: string): Promise<ProviderOperationRecord | undefined>;
  write(record: ProviderOperationRecord): Promise<void>;
  transitionState(
    agreementRootEventId: string,
    newState: ProviderOperationState,
    updates?: Partial<Omit<ProviderOperationRecord, "agreementRootEventId" | "state">>,
  ): Promise<ProviderOperationRecord>;
  /**
   * F38-06C: Count records in a given state from the durable store.
   * Used by provider readiness to report recoveryRequiredCount.
   */
  countByState(state: ProviderOperationState): Promise<number>;
  close(): void;
}

function storeError(message: string): never {
  throw new ProviderIdempotencyError("store_unavailable", message);
}

export function createSqliteProviderIdempotencyStore(
  databasePath: string,
): ProviderIdempotencyStore {
  if (typeof databasePath !== "string" || databasePath.length < 1 || databasePath === ":memory:") {
    storeError("Durable provider idempotency database path is invalid");
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
      CREATE TABLE IF NOT EXISTS pact_provider_operations (
        agreement_root_event_id TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    chmodSync(resolvedPath, 0o600);
  } catch {
    storeError("Durable provider idempotency store is unavailable");
  }

  const readStatement = database.prepare(
    "SELECT value_json FROM pact_provider_operations WHERE agreement_root_event_id = ?",
  );
  const upsertStatement = database.prepare(`
    INSERT INTO pact_provider_operations (agreement_root_event_id, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(agreement_root_event_id) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `);
  let closed = false;

  function ensureOpen(): void {
    if (closed) storeError("Durable provider idempotency store is closed");
  }

  return {
    async read(agreementRootEventId: string): Promise<ProviderOperationRecord | undefined> {
      ensureOpen();
      const result = readStatement.get(agreementRootEventId) as
        | { value_json: string }
        | undefined;
      if (result === undefined) return undefined;
      try {
        return fromPersisted(JSON.parse(result.value_json));
      } catch (error) {
        if (error instanceof ProviderIdempotencyError) throw error;
        storeError("Persisted provider operation record is corrupt");
      }
    },

    async write(record: ProviderOperationRecord): Promise<void> {
      ensureOpen();
      const persisted = toPersisted(record);
      upsertStatement.run(
        record.agreementRootEventId,
        JSON.stringify(persisted),
        record.updatedAt,
      );
    },

    async transitionState(
      agreementRootEventId: string,
      newState: ProviderOperationState,
      updates: Partial<Omit<ProviderOperationRecord, "agreementRootEventId" | "state">> = {},
    ): Promise<ProviderOperationRecord> {
      ensureOpen();
      const existing = await this.read(agreementRootEventId);
      if (!existing) {
        storeError("Cannot transition state for a record that does not exist");
      }
      if (!isValidStateTransition(existing.state, newState)) {
        throw new ProviderIdempotencyError(
          "invalid_state_transition",
          `Cannot transition from ${existing.state} to ${newState}`,
        );
      }
      const now = Math.floor(Date.now() / 1000);
      const updated: ProviderOperationRecord = Object.freeze({
        ...existing,
        ...updates,
        agreementRootEventId: existing.agreementRootEventId,
        state: newState,
        updatedAt: now,
      });
      await this.write(updated);
      return updated;
    },

    async countByState(state: ProviderOperationState): Promise<number> {
      ensureOpen();
      // F38-06C: Count records by state from the durable store.
      // JSON value_json contains "state":"<state>" — use a SQL LIKE filter.
      const result = database.prepare(
        "SELECT COUNT(*) as cnt FROM pact_provider_operations WHERE value_json LIKE ?",
      ).get(`%"state":"${state}"%`) as { cnt: number };
      return result.cnt;
    },

    close(): void {
      if (closed) return;
      closed = true;
      try {
        database.close();
      } catch {
        // Best-effort close.
      }
    },
  };
}

void randomUUID;
