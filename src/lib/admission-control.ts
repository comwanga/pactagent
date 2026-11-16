import type { CashuPrivateStore } from "./cashu-test-mint";

export const ADMISSION_DAY_MS = 86_400_000;

const admissionErrorKey = Symbol.for("pactagent.admission-error");

export class AdmissionLimitError extends Error {
  readonly [admissionErrorKey] = true;
  readonly code = "rate_limited" as const;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Request capacity is temporarily unavailable; please retry later");
    this.name = "AdmissionLimitError";
    this.retryAfterSeconds = Math.min(86_400, Math.max(1, Math.ceil(retryAfterSeconds)));
  }
}

/** The gate is shared across route bundles, so its error identity must be shared too. */
export function isAdmissionLimitError(error: unknown): error is AdmissionLimitError {
  return typeof error === "object" && error !== null && admissionErrorKey in error &&
    error[admissionErrorKey] === true && "code" in error && error.code === "rate_limited" &&
    "message" in error && error.message === "Request capacity is temporarily unavailable; please retry later" && "retryAfterSeconds" in error &&
    Number.isSafeInteger(error.retryAfterSeconds) && (error.retryAfterSeconds as number) >= 1 &&
    (error.retryAfterSeconds as number) <= 86_400;
}

export function admissionHeaders(error: unknown): Record<string, string> {
  return isAdmissionLimitError(error) ? { "Retry-After": String(error.retryAfterSeconds) } : {};
}

export function admissionInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new TypeError("Invalid admission configuration");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new TypeError("Invalid admission configuration");
  return parsed;
}

export function readAdmissionLimits(env: Readonly<Record<string, string | undefined>> = process.env) {
  return Object.freeze({
    ipPerMinute: admissionInteger(env.PACTAGENT_BFF_IP_PER_MINUTE, 240, 10_000),
    sessionPerMinute: admissionInteger(env.PACTAGENT_BFF_SESSION_PER_MINUTE, 120, 10_000),
    sessionsPerDay: admissionInteger(env.PACTAGENT_SESSIONS_PER_DAY, 256, 10_000),
    walletsPerDay: admissionInteger(env.PACTAGENT_WALLET_ALLOCATIONS_PER_DAY, 64, 1_000),
    newTransactions: admissionInteger(env.PACTAGENT_NEW_TRANSACTION_CAPACITY, 2, 32),
    recoveryTransactions: admissionInteger(env.PACTAGENT_RECOVERY_CAPACITY, 1, 8),
  });
}

/** Fixed UTC-minute windows. Full unexpired maps reject new keys instead of evicting budgets. */
export class RequestBudgets {
  readonly #buckets = {
    ordinary: new Map<string, { window: number; count: number }>(),
    recovery: new Map<string, { window: number; count: number }>(),
  };
  constructor(readonly maximumKeys = 4096) {}

  consume(key: string, limit: number, nowMs: number, lane: "ordinary" | "recovery" = "ordinary"): void {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("Invalid admission configuration");
    }
    const buckets = this.#buckets[lane];
    const window = Math.floor(nowMs / 60_000);
    const existing = buckets.get(key);
    const retry = ((window + 1) * 60_000 - nowMs) / 1000;
    if (existing && existing.window >= window) {
      if (existing.count >= limit) throw new AdmissionLimitError(retry);
      existing.count++;
      return;
    }
    if (!existing && buckets.size >= this.maximumKeys) {
      for (const [id, value] of buckets) if (value.window < window) buckets.delete(id);
      if (buckets.size >= this.maximumKeys) throw new AdmissionLimitError(retry);
    }
    buckets.set(key, { window, count: 1 });
  }
}

const budgetsKey = Symbol.for("pactagent.request-budgets");
const processBudgets = globalThis as typeof globalThis & { [budgetsKey]?: RequestBudgets };
export function sharedRequestBudgets(): RequestBudgets {
  return processBudgets[budgetsKey] ??= new RequestBudgets();
}
export function resetRequesterBudgetsForTesting(): void {
  delete processBudgets[budgetsKey];
}

/** Two bounded lanes: new admissions cannot consume recovery capacity. No waiting queue. */
export class TransactionAdmission {
  #new = 0;
  #recovery = 0;
  constructor(readonly newCapacity: number, readonly recoveryCapacity: number) {
    if (![newCapacity, recoveryCapacity].every(v => Number.isSafeInteger(v) && v > 0)) {
      throw new TypeError("Invalid admission configuration");
    }
  }

  acquire(kind: "new" | "recovery"): () => void {
    if (kind === "new" ? this.#new >= this.newCapacity : this.#recovery >= this.recoveryCapacity) {
      throw new AdmissionLimitError(1);
    }
    if (kind === "new") this.#new++; else this.#recovery++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === "new") this.#new--; else this.#recovery--;
    };
  }

  async run<T>(kind: "new" | "recovery", operation: () => Promise<T>): Promise<T> {
    const release = this.acquire(kind);
    try { return await operation(); } finally { release(); }
  }
}

// Share across Next.js route bundles and all runtime objects in this Node process.
// This is not coordination between independent processes or replicas.
const transactionKey = Symbol.for("pactagent.transaction-admission");
const processAdmission = globalThis as typeof globalThis & { [transactionKey]?: TransactionAdmission };
export function processTransactionAdmission(): TransactionAdmission {
  const limits = readAdmissionLimits();
  const existing = processAdmission[transactionKey];
  if (existing && (existing.newCapacity !== limits.newTransactions || existing.recoveryCapacity !== limits.recoveryTransactions)) {
    throw new TypeError("Admission configuration changed while the runtime is active");
  }
  return processAdmission[transactionKey] ??= new TransactionAdmission(limits.newTransactions, limits.recoveryTransactions);
}

/** One retained metadata record; uses the existing durable private-store lock and storage. */
export async function reserveWalletAllocation(
  store: CashuPrivateStore,
  limit: number,
  nowMs = Date.now(),
): Promise<void> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Invalid admission configuration");
  }
  await store.withExclusiveLock("resource-admission", "wallet-allocations", async () => {
    const raw = await store.read("resource-admission", "wallet-allocations");
    const day = Math.floor(nowMs / ADMISSION_DAY_MS);
    let count = 0;
    if (raw !== undefined) {
      if (typeof raw !== "object" || raw === null || !("day" in raw) || !("count" in raw) ||
        !Number.isSafeInteger(raw.day) || (raw.day as number) < 0 || !Number.isSafeInteger(raw.count) || (raw.count as number) < 0) {
        throw new TypeError("Invalid admission accounting state");
      }
      const previous = raw as { day: number; count: number };
      if (previous.day > day) throw new AdmissionLimitError(((previous.day + 1) * ADMISSION_DAY_MS - nowMs) / 1000);
      if (previous.day === day) count = previous.count;
    }
    if (count >= limit) throw new AdmissionLimitError(((day + 1) * ADMISSION_DAY_MS - nowMs) / 1000);
    await store.write("resource-admission", "wallet-allocations", { day, count: count + 1 });
  });
}
