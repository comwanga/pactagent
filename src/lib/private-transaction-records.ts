import type { CashuPrivateStore } from "./cashu-test-mint";
import { type PrivateDataCipher, PrivateDataError } from "./private-data";

function record(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PrivateDataError();
  const result = value as Record<string, unknown>;
  if (result.version !== 1 || result.transactionId !== key ||
      (result.storageRevision !== undefined && (!Number.isSafeInteger(result.storageRevision) || (result.storageRevision as number) < 0))) throw new PrivateDataError();
  return result;
}

/** Protects only requester transaction rows; Cashu scopes and their operation identities are unchanged. */
export class PrivateTransactionRecords {
  constructor(readonly store: CashuPrivateStore, readonly cipher: PrivateDataCipher) {
    if (!store.compareAndSet) throw new PrivateDataError();
  }
  #decode(raw: unknown, key: string): { value: Record<string, unknown>; legacy: boolean } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PrivateDataError();
    const candidate = raw as Record<string, unknown>;
    const encrypted = ["format", "algorithm", "ciphertext", "nonce", "tag", "keyId"].some(field => field in candidate);
    const value = record(encrypted ? this.cipher.open("transaction", key, raw) : raw, key);
    if (!encrypted && (!value.privateTerms || typeof value.privateSaltHex !== "string" || !/^[0-9a-f]{64}$/.test(value.privateSaltHex))) throw new PrivateDataError();
    return { value, legacy: !encrypted };
  }
  async read(key: string, migrate = true): Promise<unknown | undefined> {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await this.store.read("transaction", key);
        if (raw === undefined) return undefined;
        const decoded = this.#decode(raw, key);
        const value = { ...decoded.value, storageRevision: decoded.value.storageRevision ?? 0 };
        if (!migrate || (!decoded.legacy && (raw as { keyId: string }).keyId === this.cipher.activeKeyId)) return value;
        if (await this.store.compareAndSet!("transaction", key, raw, this.cipher.seal("transaction", key, value))) return value;
      }
      throw new PrivateDataError();
    } catch { throw new PrivateDataError(); }
  }
  async write(key: string, value: unknown, expectedRevision: number): Promise<number> {
    try {
      const proposed = record(value, key);
      const raw = await this.store.read("transaction", key);
      const previous = raw === undefined ? undefined : this.#decode(raw, key).value;
      if ((previous?.storageRevision ?? 0) !== expectedRevision ||
          (previous?.purgedAt !== undefined && (proposed.privateTerms !== undefined || proposed.privateSaltHex !== undefined))) throw new PrivateDataError();
      const revision = expectedRevision + 1;
      if (!Number.isSafeInteger(revision)) throw new PrivateDataError();
      const encrypted = this.cipher.seal("transaction", key, { ...proposed, storageRevision: revision });
      if (!await this.store.compareAndSet!("transaction", key, raw, encrypted)) throw new PrivateDataError();
      return revision;
    } catch { throw new PrivateDataError(); }
  }
}
