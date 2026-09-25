import {
  createPactAgentRuntime,
  PactAgentRuntimeError,
  type PactAgentRuntime,
  type PactAgentRuntimeConfig,
} from "./pactagent-runtime";
import { createPactAgentRuntimeFromEnv, type PactAgentRuntimeEnv } from "./pactagent-runtime.live";
import { PactAgentWorkflowError } from "./pactagent-workflow";

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

let explicitConfig: PactAgentRuntimeConfig | undefined;
let runtime: PactAgentRuntime | undefined;
let started = false;
let liveEnv: PactAgentRuntimeEnv | undefined;
let shutdownInFlight: Promise<void> | undefined;
let configuredClose: (() => void) | undefined;

export function configurePactAgentRuntime(
  config: PactAgentRuntimeConfig,
  closeResources?: () => void,
): void {
  if (explicitConfig !== undefined || runtime !== undefined) {
    throw new Error("PactAgent runtime is already configured");
  }
  explicitConfig = config;
  configuredClose = closeResources;
}

export function resetPactAgentRuntime(): void {
  explicitConfig = undefined;
  runtime = undefined;
  started = false;
  liveEnv = undefined;
  shutdownInFlight = undefined;
  configuredClose = undefined;
}

export async function getPactAgentRuntime(): Promise<PactAgentRuntime> {
  if (!runtime) {
    if (explicitConfig) {
      runtime = createPactAgentRuntime(explicitConfig);
    } else {
      liveEnv = await createPactAgentRuntimeFromEnv();
      runtime = liveEnv.runtime;
      started = true;
    }
  }
  if (!started) {
    await runtime.start();
    started = true;
  }
  return runtime;
}

export async function shutdownPactAgentRuntime(): Promise<void> {
  if (shutdownInFlight) return shutdownInFlight;
  shutdownInFlight = (async () => {
    try {
      if (runtime && started) await runtime.shutdown();
    } finally {
      started = false;
      if (liveEnv) {
        liveEnv.close();
        liveEnv = undefined;
      } else if (configuredClose) {
        const close = configuredClose;
        configuredClose = undefined;
        close();
      }
    }
  })();
  return shutdownInFlight;
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
  if (error instanceof PactAgentRuntimeError) {
    return { error: error.message, code: error.code };
  }
  if (
    error instanceof PactAgentWorkflowError &&
    error.code === "reconciliation_required"
  ) {
    return { error: "Transaction requires reconciliation", code: "reconciliation_required" };
  }
  return { error: "Internal error", code: "internal_error" };
}

export function apiStatusForError(error: unknown): number {
  if (!(error instanceof PactAgentRuntimeError)) return 500;
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

/** Bearer-token authorization for the API surface. */
export function isAuthorized(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${token}`;
}
