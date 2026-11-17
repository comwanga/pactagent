import { createHash, timingSafeEqual } from "node:crypto";
import { isAdmissionLimitError } from "./admission-control";
import {
  createPactAgentRuntime,
  PactAgentRuntimeError,
  isPactAgentRuntimeError,
  type PactAgentRuntime,
  type PactAgentRuntimeConfig,
} from "./pactagent-runtime";
import { createPactAgentRuntimeFromEnv, type PactAgentRuntimeEnv } from "./pactagent-runtime.live";
import { isPactAgentWorkflowError } from "./pactagent-workflow";

/*
 * Process-wide PactAgent runtime singleton used by the HTTP API surface.
 *
 * A single long-lived runtime owns the relay connection, SQLite stores, and
 * identity boundaries. It is configured in one of two ways:
 *
 *   - explicitly via `configurePactAgentRuntime` (deterministic tests), or
 *   - implicitly from environment via `createPactAgentRuntimeFromEnv` (the
 *     opt-in live lane). Missing environment configuration throws an explicit
 *     error on first use — never a fallback to production or an arbitrary mint.
 */

interface RuntimeSingletonState {
  explicitConfig?: PactAgentRuntimeConfig;
  runtime?: PactAgentRuntime;
  started: boolean;
  liveEnv?: PactAgentRuntimeEnv;
  initializationInFlight?: Promise<PactAgentRuntime>;
  shutdownInFlight?: Promise<void>;
  shutdownPending: boolean;
  configuredClose?: () => void;
}

// Route bundles must share initialization ownership as well as execution permits.
const runtimeStateKey = Symbol.for("pactagent.runtime.singleton");
const runtimeGlobal = globalThis as typeof globalThis & { [runtimeStateKey]?: RuntimeSingletonState };
const state = runtimeGlobal[runtimeStateKey] ??= { started: false, shutdownPending: false };

export function configurePactAgentRuntime(
  config: PactAgentRuntimeConfig,
  closeResources?: () => void,
): void {
  if (state.explicitConfig !== undefined || state.runtime !== undefined ||
      state.initializationInFlight || state.shutdownInFlight) {
    throw new Error("PactAgent runtime is already configured");
  }
  state.explicitConfig = config;
  state.configuredClose = closeResources;
}

export function resetPactAgentRuntime(): void {
  // Synchronous test reset must not orphan resources owned by an unfinished lifecycle.
  if (state.initializationInFlight || state.shutdownPending) {
    throw new Error("PactAgent runtime lifecycle is still in progress");
  }
  state.explicitConfig = undefined;
  state.runtime = undefined;
  state.started = false;
  state.liveEnv = undefined;
  state.shutdownInFlight = undefined;
  state.configuredClose = undefined;
}

export async function getPactAgentRuntime(): Promise<PactAgentRuntime> {
  if (state.shutdownInFlight) {
    throw new PactAgentRuntimeError("invalid_configuration", "Runtime is shutting down");
  }
  if (state.runtime && state.started) return state.runtime;
  const initialization = state.initializationInFlight ??= Promise.resolve().then(async () => {
    if (state.explicitConfig) {
      state.runtime ??= createPactAgentRuntime(state.explicitConfig);
      await state.runtime.start();
    } else {
      // The env-based (live) path requires a valid runtime API token before
      // initializing privileged runtime resources. The explicit-config path
      // is used by deterministic tests that do not rely on bearer auth.
      validateRuntimeApiToken();
      // The factory owns cleanup on failure. Publish only its completed environment.
      const environment = await createPactAgentRuntimeFromEnv();
      state.liveEnv = environment;
      state.runtime = environment.runtime;
    }
    state.started = true;
    return state.runtime;
  });
  try {
    const initialized = await initialization;
    if (state.shutdownInFlight) {
      throw new PactAgentRuntimeError("invalid_configuration", "Runtime is shutting down");
    }
    return initialized;
  } finally {
    // All waiters observe the same outcome; a failed attempt can be retried.
    if (state.initializationInFlight === initialization) state.initializationInFlight = undefined;
  }
}

/** Return the composition of the runtime actually instantiated in this process. */
export function getRunningPactAgentRuntimeComposition(): PactAgentRuntimeEnv["composition"] | undefined {
  return state.liveEnv?.composition;
}

export async function shutdownPactAgentRuntime(): Promise<void> {
  if (state.shutdownInFlight) return state.shutdownInFlight;
  state.shutdownPending = true;
  state.shutdownInFlight = Promise.resolve().then(async () => {
    try {
      // Do not close stores while startup still owns them. Failed factories clean up themselves.
      await state.initializationInFlight?.catch(() => undefined);
      if (state.runtime && state.started) await state.runtime.shutdown();
    } finally {
      state.started = false;
      try {
        if (state.liveEnv) {
          const environment = state.liveEnv;
          state.liveEnv = undefined;
          environment.close();
        } else if (state.configuredClose) {
          const close = state.configuredClose;
          state.configuredClose = undefined;
          close();
        }
      } finally {
        state.shutdownPending = false;
      }
    }
  });
  return state.shutdownInFlight;
}

export async function runBoundedRuntimeShutdown(timeoutMilliseconds = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      shutdownPactAgentRuntime(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMilliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function handleRuntimeTermination(
  exit: (code: number) => void = (code) => process.exit(code),
  timeoutMilliseconds = 5_000,
): Promise<void> {
  try {
    await runBoundedRuntimeShutdown(timeoutMilliseconds);
    exit(0);
  } catch {
    exit(1);
  }
}

const shutdownRegistration = Symbol.for("pactagent.runtime.shutdown-handlers");
const shutdownGlobal = globalThis as typeof globalThis & { [shutdownRegistration]?: boolean };
export function registerPactAgentRuntimeShutdownHandlers(): void {
  if (shutdownGlobal[shutdownRegistration]) return;
  shutdownGlobal[shutdownRegistration] = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void handleRuntimeTermination();
    });
  }
}

if (process.env.NODE_ENV !== "test") registerPactAgentRuntimeShutdownHandlers();

/** Redacted, secret-free API error DTO. Never exposes raw causes or stack traces. */
export function toApiError(error: unknown): { error: string; code: string } {
  if (isAdmissionLimitError(error)) return { error: error.message, code: error.code };
  if (isPactAgentRuntimeError(error)) {
    return { error: error.message, code: error.code };
  }
  if (isPactAgentWorkflowError(error)) {
    // A workflow error is a handled, durably-persisted transaction outcome
    // (the authoritative failure is observable through status), not a server
    // fault — with the sole exception of a privacy-boundary assertion, whose
    // detail must never surface to a caller.
    if (error.code === "privacy_boundary_violation") {
      return { error: "Internal error", code: "internal_error" };
    }
    if (error.code === "reconciliation_required") {
      return { error: "Transaction requires reconciliation", code: "reconciliation_required" };
    }
    return {
      error: "The transaction could not be completed; check its status or refund after the timeout",
      code: "transaction_not_completed",
    };
  }
  return { error: "Internal error", code: "internal_error" };
}

export function apiStatusForError(error: unknown): number {
  if (isAdmissionLimitError(error)) return 429;
  if (isPactAgentWorkflowError(error)) {
    // Handled, durably-recorded workflow outcomes are not internal faults; the
    // client should re-read the authoritative status. Only an internal
    // privacy-boundary assertion is treated as a genuine 500.
    return error.code === "privacy_boundary_violation" ? 500 : 409;
  }
  if (!isPactAgentRuntimeError(error)) return 500;
  switch (error.code) {
    case "transaction_not_found":
      return 404;
    case "invalid_request":
      return 400;
    case "result_not_available":
    case "report_not_available":
    case "transaction_in_progress":
      return 409;
    default:
      return 500;
  }
}

/*
 * Runtime API bearer-token policy (Issue #67).
 *
 * The token is a privileged operator credential, not per-user authorization.
 * It grants read access to every transaction's private result and control of
 * refund, reconcile, and reset. Its format is validated at startup; its
 * comparison is constant-time over SHA-256 digests so the comparison itself
 * does not leak the configured value through timing.
 */

const BEARER_PREFIX = "Bearer ";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;
const MAX_PRESENTED_LENGTH = 512;

/** Validates PACTAGENT_RUNTIME_API_TOKEN at startup; never prints the token. */
export function validateRuntimeApiToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const token = env.PACTAGENT_RUNTIME_API_TOKEN;
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new PactAgentRuntimeError(
      "invalid_configuration",
      "PACTAGENT_RUNTIME_API_TOKEN is missing or below the minimum required format (at least 16 alphanumeric, dash, or underscore characters); generate a cryptographically random token",
    );
  }
}

/** Bearer-token authorization for the API surface. Constant-time over SHA-256 digests. */
export function isAuthorized(request: Request, token: string | undefined): boolean {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
  const header = request.headers.get("authorization");
  if (
    header === null ||
    header.length < BEARER_PREFIX.length ||
    header.length > BEARER_PREFIX.length + MAX_PRESENTED_LENGTH
  ) return false;
  if (header.slice(0, BEARER_PREFIX.length) !== BEARER_PREFIX) return false;
  const presented = header.slice(BEARER_PREFIX.length);
  if (presented.length === 0) return false;
  const presentedDigest = createHash("sha256").update(presented).digest();
  const expectedDigest = createHash("sha256").update(token).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}
