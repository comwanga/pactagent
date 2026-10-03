/*
 * Server-side error logging for the runtime API surface (Issue #39).
 *
 * Responses stay redacted; this only records sanitized runtime error
 * messages in operator logs so production failures can be diagnosed.
 */

export function logRuntimeApiError(route: string, error: unknown): void {
  console.error(
    `runtime api failure [${route}]:`,
    error instanceof Error ? error.message : String(error),
  );
  if (error instanceof Error && error.stack) {
    console.error(`runtime api failure stack [${route}]:\n${error.stack}`);
  }
}
