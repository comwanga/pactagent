import { generateSecretKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { type NostrPublicKey } from "../domain/nostr";
import { WebSocketNostrRelayAdapter } from "./nostr-relay";
import { createLocalNostrSigner } from "./nostr-signer";
import { createLocalNostrEncrypter } from "./private-task-transport";
import { createPactAgentProviderService } from "./pactagent-provider-service";
import { createSqliteProviderIdempotencyStore } from "./provider-idempotency-store";
import { readProviderServiceConfig } from "./provider-service-config";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const RELAY_URL = process.env.PACTAGENT_HOSTED_PROTOCOL_URL ?? "wss://localhost:8443";

function createTestStore() {
  const dir = mkdtempSync(join(tmpdir(), "pactagent-provider-test-"));
  return createSqliteProviderIdempotencyStore(join(dir, "provider-ops.sqlite"));
}

function uniqueIds() {
  const suffix = bytesToHex(generateSecretKey()).slice(0, 8);
  return {
    providerDefinitionIdentifier: `test-provider-${suffix}`,
    offerIdentifier: `test-offer-${suffix}`,
    escrowDescriptorIdentifier: `test-escrow-${suffix}`,
  };
}

function isRelayAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(RELAY_URL);
    const timer = setTimeout(() => {
      socket.close();
      resolve(false);
    }, 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve(true);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

const relayAvailable = await isRelayAvailable();
const liveIt = relayAvailable ? it : it.skip;

describe("PactAgent hosted provider service protocol", () => {
  liveIt(
    "provider publishes artifacts and achieves protocol readiness through the relay",
    async () => {
      const providerSk = bytesToHex(generateSecretKey());
      const escrowSk = bytesToHex(generateSecretKey());

      const providerSigner = createLocalNostrSigner(providerSk);
      const providerEncrypter = createLocalNostrEncrypter(providerSk);
      const escrowAuthorityPublicKey = createLocalNostrSigner(escrowSk).publicKey as NostrPublicKey;

      const relay = new WebSocketNostrRelayAdapter(RELAY_URL, {
        connectTimeoutMs: 10_000,
        defaultTimeoutMs: 15_000,
      });
      await relay.connect();

      try {
        const providerService = createPactAgentProviderService({
          providerSigner,
          providerEncrypter,
          relay,
          relayUrl: RELAY_URL,
          clock: () => Math.floor(Date.now() / 1000),
          offerAmountSats: 350n,
          maximumExecutionSeconds: 120,
          escrowTimeoutSeconds: 900,
          escrowAuthorityPublicKey,
          idempotencyStore: createTestStore(),
          ...uniqueIds(),
          pollIntervalMs: 1_000,
          transitionWaitTimeoutMs: 30_000,
        });

        await providerService.start();
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        const readiness = await providerService.readiness();
        expect(readiness.processAlive).toBe(true);
        expect(readiness.protocolReady).toBe(true);
        expect(readiness.artifactsPublished).toBe(true);
        expect(readiness.providerPublicKey).toBe(providerSigner.publicKey);
        expect(readiness.providerDefinitionReference).toBeDefined();
        expect(readiness.offerReference).toBeDefined();
        expect(readiness.escrowDescriptorReference).toBeDefined();

        await providerService.stop();
      } finally {
        await relay.disconnect().catch(() => undefined);
      }
    },
    30_000,
  );

  liveIt(
    "rejects agreements not addressed to this provider",
    async () => {
      const providerSk = bytesToHex(generateSecretKey());
      const escrowSk = bytesToHex(generateSecretKey());
      const providerSigner = createLocalNostrSigner(providerSk);
      const providerEncrypter = createLocalNostrEncrypter(providerSk);
      const escrowAuthorityPublicKey = createLocalNostrSigner(escrowSk).publicKey as NostrPublicKey;

      const relay = new WebSocketNostrRelayAdapter(RELAY_URL, {
        connectTimeoutMs: 10_000,
        defaultTimeoutMs: 15_000,
      });
      await relay.connect();

      try {
        const providerService = createPactAgentProviderService({
          providerSigner,
          providerEncrypter,
          relay,
          relayUrl: RELAY_URL,
          clock: () => Math.floor(Date.now() / 1000),
          offerAmountSats: 350n,
          maximumExecutionSeconds: 120,
          escrowTimeoutSeconds: 900,
          escrowAuthorityPublicKey,
          idempotencyStore: createTestStore(),
          ...uniqueIds(),
          pollIntervalMs: 1_000,
        });

        await providerService.start();
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        const readiness = await providerService.readiness();
        expect(readiness.agreementsProcessed).toBe(0);

        await providerService.stop();
      } finally {
        await relay.disconnect().catch(() => undefined);
      }
    },
    30_000,
  );

  liveIt("provider identity is stable and does not change after restart", async () => {
    const providerSk = bytesToHex(generateSecretKey());
    const escrowSk = bytesToHex(generateSecretKey());
    const providerSigner = createLocalNostrSigner(providerSk);
    const providerEncrypter = createLocalNostrEncrypter(providerSk);
    const escrowAuthorityPublicKey = createLocalNostrSigner(escrowSk).publicKey as NostrPublicKey;

    const relay = new WebSocketNostrRelayAdapter(RELAY_URL, {
      connectTimeoutMs: 10_000,
      defaultTimeoutMs: 15_000,
    });
    await relay.connect();

    try {
      const config = {
        providerSigner,
        providerEncrypter,
        relay,
        relayUrl: RELAY_URL,
        clock: () => Math.floor(Date.now() / 1000),
        offerAmountSats: 350n as const,
        maximumExecutionSeconds: 120,
        escrowTimeoutSeconds: 900,
        escrowAuthorityPublicKey,
        idempotencyStore: createTestStore(),
        pollIntervalMs: 1_000,
      };

      const service1 = createPactAgentProviderService(config);
      await service1.start();
      const pubkey1 = service1.providerPublicKey;
      await service1.stop();

      const service2 = createPactAgentProviderService(config);
      await service2.start();
      const pubkey2 = service2.providerPublicKey;
      await service2.stop();

      expect(pubkey1).toBe(pubkey2);
    } finally {
      await relay.disconnect().catch(() => undefined);
    }
  }, 30_000);
});

describe("PactAgent provider service configuration (no relay required)", () => {
  it("fails closed when hosted mode has no provider identity", () => {
    expect(() =>
      readProviderServiceConfig({
        PACTAGENT_PROVIDER_MODE: "hosted",
        PACTAGENT_LIVE_RELAY_URL: "wss://relay.example",
        PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY: "ab".repeat(32),
      }),
    ).toThrow(/Hosted provider mode requires.*stable identity/);
  });

  it("rejects browser-controlled relay URL in NEXT_PUBLIC_*", () => {
    expect(() =>
      readProviderServiceConfig({
        PACTAGENT_PROVIDER_MODE: "local",
        PACTAGENT_LIVE_RELAY_URL: undefined,
        NEXT_PUBLIC_RELAY_URL: "wss://relay.example",
        PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: "01".repeat(32),
        PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY: "03".repeat(32),
      }),
    ).toThrow(/PACTAGENT_LIVE_RELAY_URL is required/);
  });
});
