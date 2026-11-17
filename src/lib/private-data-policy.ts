export const DEFAULT_PRIVATE_DATA_RETENTION_DAYS = 7;
export const PRIVATE_DATA_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Non-secret policy only; safe to project from the server into the disclosure. */
export function privateDataRetentionDays(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const value = env.PACTAGENT_PRIVATE_DATA_RETENTION_DAYS;
  if (value === undefined) return DEFAULT_PRIVATE_DATA_RETENTION_DAYS;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 365) {
    throw new TypeError("Invalid private-data retention configuration");
  }
  return Number(value);
}
