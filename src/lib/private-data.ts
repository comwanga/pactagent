import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from "node:crypto";
import { privateDataRetentionDays } from "./private-data-policy";

const errorBrand = Symbol.for("pactagent.private-data-error");
export class PrivateDataError extends Error {
  readonly [errorBrand] = true;
  constructor() { super("Private transaction data is unavailable"); this.name = "PrivateDataError"; }
}
export function isPrivateDataError(value: unknown): value is PrivateDataError {
  return typeof value === "object" && value !== null && errorBrand in value && value[errorBrand] === true;
}

export interface PrivateDataEnvelope {
  readonly format: "pactagent-private-record";
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}
export interface PrivateDataCipher {
  readonly activeKeyId: string;
  seal(scope: string, key: string, value: unknown): PrivateDataEnvelope;
  open(scope: string, key: string, value: unknown): unknown;
}
const MAX_BYTES = 8 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PrivateDataError();
  return value as Record<string, unknown>;
}
function binary(value: unknown, size?: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_BYTES / 3) * 4) throw new PrivateDataError();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (size !== undefined && bytes.length !== size) || bytes.length > MAX_BYTES) throw new PrivateDataError();
  return bytes;
}

export function createPrivateDataCipher(keyring: Readonly<Record<string, string>>, activeKeyId: string): PrivateDataCipher {
  try {
    const entries = Object.entries(object(keyring));
    if (entries.length < 1 || entries.length > 16) throw new PrivateDataError();
    const keys = new Map(entries.map(([id, hex]) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) throw new PrivateDataError();
      const bytes = Buffer.from(hex, "hex");
      const key = createSecretKey(bytes);
      bytes.fill(0);
      return [id, key] as const;
    }));
    if (!keys.has(activeKeyId)) throw new PrivateDataError();
    const aad = (scope: string, key: string, keyId: string) => Buffer.from(JSON.stringify(["pactagent-private-record", 1, "aes-256-gcm", scope, key, keyId]));
    return Object.freeze({
      activeKeyId,
      seal(scope: string, key: string, value: unknown): PrivateDataEnvelope {
        try {
          const serialized = JSON.stringify(value);
          if (serialized === undefined || Buffer.byteLength(serialized) > MAX_BYTES) throw new PrivateDataError();
          const nonce = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", keys.get(activeKeyId)!, nonce, { authTagLength: 16 });
          cipher.setAAD(aad(scope, key, activeKeyId));
          const ciphertext = Buffer.concat([cipher.update(serialized, "utf8"), cipher.final()]);
          return Object.freeze({ format: "pactagent-private-record", version: 1, algorithm: "aes-256-gcm", keyId: activeKeyId,
            nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
        } catch { throw new PrivateDataError(); }
      },
      open(scope: string, key: string, value: unknown): unknown {
        try {
          const envelope = object(value);
          const fields = ["format", "version", "algorithm", "keyId", "nonce", "ciphertext", "tag"];
          if (Object.keys(envelope).length !== fields.length || Object.keys(envelope).some(field => !fields.includes(field)) ||
              envelope.format !== "pactagent-private-record" || envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm" ||
              typeof envelope.keyId !== "string" || !keys.has(envelope.keyId)) throw new PrivateDataError();
          const decipher = createDecipheriv("aes-256-gcm", keys.get(envelope.keyId)!, binary(envelope.nonce, 12), { authTagLength: 16 });
          decipher.setAAD(aad(scope, key, envelope.keyId));
          decipher.setAuthTag(binary(envelope.tag, 16));
          const unverified = decipher.update(binary(envelope.ciphertext));
          const final = decipher.final(); // Authentication must finish before parsing or returning any plaintext.
          return JSON.parse(Buffer.concat([unverified, final]).toString("utf8"));
        } catch { throw new PrivateDataError(); }
      },
      toJSON(): never { throw new PrivateDataError(); },
    });
  } catch { throw new PrivateDataError(); }
}

export function privateDataConfigurationFromEnv(env: Readonly<Record<string, string | undefined>> = process.env) {
  try {
    const raw = env.PACTAGENT_PRIVATE_DATA_KEYRING;
    const active = env.PACTAGENT_PRIVATE_DATA_ACTIVE_KEY_ID;
    if (!raw || raw.length > 8192 || !active) throw new PrivateDataError();
    return { cipher: createPrivateDataCipher(object(JSON.parse(raw)) as Record<string, string>, active), retentionSeconds: privateDataRetentionDays(env) * 86400 };
  } catch { throw new PrivateDataError(); }
}
