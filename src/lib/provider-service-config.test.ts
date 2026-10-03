import { describe, expect, it } from "vitest";
import { getPublicKey } from "nostr-tools/pure";

import {
  readProviderServiceConfig,
  wireProviderService,
} from "./provider-service-config";

const VALID_PRIVATE_KEY = "01".repeat(32);
const ESCROW_AUTHORITY_PRIVATE_KEY = "03".repeat(32);

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PACTAGENT_LIVE_RELAY_URL: "wss://localhost:8443",
    PACTAGENT_PROVIDER_MODE: "local",
    PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: VALID_PRIVATE_KEY,
    PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY: ESCROW_AUTHORITY_PRIVATE_KEY,
    ...overrides,
  };
}

describe("readProviderServiceConfig", () => {
  it("reads a valid local configuration", () => {
    const config = readProviderServiceConfig(baseEnv());
    expect(config.mode).toBe("local");
    expect(config.relayUrl).toBe("wss://localhost:8443");
    expect(config.providerPrivateKeyHex).toBe(VALID_PRIVATE_KEY);
    expect(config.offerAmountSats).toBe(350);
    expect(config.pollIntervalMs).toBe(3000);
  });

  // F38-06A: Missing mode FAILS CLOSED — no silent default to local.
  it("fails when provider mode is missing (fail closed, no default to local)", () => {
    expect(() =>
      readProviderServiceConfig(baseEnv({ PACTAGENT_PROVIDER_MODE: undefined })),
    ).toThrow(/PACTAGENT_PROVIDER_MODE is required/);
  });

  it("reads hosted mode when PACTAGENT_PROVIDER_MODE is hosted", () => {
    const config = readProviderServiceConfig(baseEnv({ PACTAGENT_PROVIDER_MODE: "hosted" }));
    expect(config.mode).toBe("hosted");
  });

  it("fails when relay URL is missing", () => {
    expect(() => readProviderServiceConfig(baseEnv({ PACTAGENT_LIVE_RELAY_URL: undefined }))).toThrow(
      /PACTAGENT_LIVE_RELAY_URL is required/,
    );
  });

  it("fails when provider private key is missing", () => {
    expect(() =>
      readProviderServiceConfig(baseEnv({ PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: undefined })),
    ).toThrow(/PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY is required/);
  });

  it("fails closed in hosted mode without provider identity", () => {
    expect(() =>
      readProviderServiceConfig(
        baseEnv({
          PACTAGENT_PROVIDER_MODE: "hosted",
          PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: undefined,
        }),
      ),
    ).toThrow(/Hosted provider mode requires.*stable identity/);
  });

  it("fails when provider key is invalid", () => {
    expect(() =>
      readProviderServiceConfig(baseEnv({ PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: "not-a-key" })),
    ).toThrow(/not a valid 32-byte hex private key/);
  });

  it("fails when escrow authority public key is missing", () => {
    expect(() =>
      readProviderServiceConfig(baseEnv({ PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY: undefined })),
    ).toThrow(/PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY/);
  });

  it("fails when offer amount is invalid", () => {
    expect(() =>
      readProviderServiceConfig(baseEnv({ PACTAGENT_PROVIDER_OFFER_SATS: "0" })),
    ).toThrow(/must be a positive integer/);
    expect(() =>
      readProviderServiceConfig(baseEnv({ PACTAGENT_PROVIDER_OFFER_SATS: "-1" })),
    ).toThrow(/must be a positive integer/);
  });

  it("fails when poll interval is too small", () => {
    expect(() =>
      readProviderServiceConfig(baseEnv({ PACTAGENT_PROVIDER_POLL_INTERVAL_MS: "100" })),
    ).toThrow(/at least 500/);
  });

  it("fails when execution seconds is out of range", () => {
    expect(() =>
      readProviderServiceConfig(baseEnv({ PACTAGENT_PROVIDER_MAX_EXECUTION_SECONDS: "0" })),
    ).toThrow(/between 1 and 300/);
    expect(() =>
      readProviderServiceConfig(baseEnv({ PACTAGENT_PROVIDER_MAX_EXECUTION_SECONDS: "301" })),
    ).toThrow(/between 1 and 300/);
  });

  // F38-06A: Provider mode must be a closed set — unknown values FAIL.
  it("fails when provider mode is an unknown value (closed set)", () => {
    expect(() =>
      readProviderServiceConfig(baseEnv({ PACTAGENT_PROVIDER_MODE: "staging" })),
    ).toThrow(/must be "local" or "hosted"/);
  });

  it("fails when provider mode is an empty string (not just missing)", () => {
    expect(() =>
      readProviderServiceConfig(baseEnv({ PACTAGENT_PROVIDER_MODE: "production" })),
    ).toThrow(/must be "local" or "hosted"/);
  });

  // F38-06B: Escrow private key must be cryptographically derived to public key.
  it("derives escrow public key from private key when public key is not provided", () => {
    const expectedPubkey = getPublicKey(
      Uint8Array.from(Buffer.from(ESCROW_AUTHORITY_PRIVATE_KEY, "hex")),
    );
    const config = readProviderServiceConfig(
      baseEnv({
        PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY: undefined,
        PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY: ESCROW_AUTHORITY_PRIVATE_KEY,
      }),
    );
    expect(config.escrowAuthorityPublicKey).toBe(expectedPubkey);
    // The derived value must NOT be the raw private key string.
    expect(config.escrowAuthorityPublicKey).not.toBe(ESCROW_AUTHORITY_PRIVATE_KEY);
  });

  it("prefers explicit public key over private key derivation", () => {
    const explicitPubkey = "ab".repeat(32);
    const config = readProviderServiceConfig(
      baseEnv({
        PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY: explicitPubkey,
        PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY: ESCROW_AUTHORITY_PRIVATE_KEY,
      }),
    );
    expect(config.escrowAuthorityPublicKey).toBe(explicitPubkey);
  });

  it("fails when escrow private key is invalid for derivation", () => {
    expect(() =>
      readProviderServiceConfig(
        baseEnv({
          PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY: undefined,
          PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY: "not-a-valid-key",
        }),
      ),
    ).toThrow(/not a valid 32-byte hex private key/);
  });
});

describe("wireProviderService", () => {
  it("wires signer, encrypter, and relay from configuration", () => {
    const config = readProviderServiceConfig(baseEnv());
    const wiring = wireProviderService(config);
    expect(wiring.providerSigner.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(wiring.providerEncrypter.publicKey).toBe(wiring.providerSigner.publicKey);
    expect(wiring.relay.url).toBe("wss://localhost:8443");
    expect(wiring.relayUrl).toBe("wss://localhost:8443");
  });
});
