import type { CashuPrivateStore } from "./cashu-test-mint";
import { createPrivateDataCipher } from "./private-data";
import { PrivateTransactionRecords } from "./private-transaction-records";

// Synthetic, non-secret fixture key, stable across child-process restart tests. Never a production default.
export const PRIVATE_DATA_TEST_ENV = {
  PACTAGENT_PRIVATE_DATA_KEYRING: JSON.stringify({ fixture: "ab".repeat(32) }),
  PACTAGENT_PRIVATE_DATA_ACTIVE_KEY_ID: "fixture",
};
export function testPrivateData() {
  return { cipher: createPrivateDataCipher({ fixture: "ab".repeat(32) }, "fixture"), retentionSeconds: 7 * 86400 };
}
export function readPrivateTransaction(store: CashuPrivateStore, key: string): Promise<unknown> {
  return new PrivateTransactionRecords(store, testPrivateData().cipher).read(key);
}

/** Deliberate old-format setup for recovery tests, not a production persistence path. */
export function writeLegacyPrivateTransaction(store: CashuPrivateStore, key: string, value: unknown): Promise<void> {
  const legacy = { ...(value as Record<string, unknown>) };
  delete legacy.terminalReport; delete legacy.reportUnavailable;
  delete legacy.retentionStartedAt; delete legacy.purgedAt; delete legacy.storageRevision;
  return store.write("transaction", key, legacy);
}
