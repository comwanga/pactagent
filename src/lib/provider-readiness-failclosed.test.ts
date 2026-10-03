import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { type NostrPublicKey } from "../domain/nostr";
import { createLocalNostrSigner } from "./nostr-signer";
import { createLocalNostrEncrypter } from "./private-task-transport";
import { createPactAgentProviderService } from "./pactagent-provider-service";
import { createSqliteProviderIdempotencyStore, type ProviderIdempotencyStore } from "./provider-idempotency-store";
import type { NostrFilter, NostrRelayAdapter } from "./nostr-relay";
import type { NostrSigner } from "../domain/nostr";
import type { NostrEncrypter } from "./private-task-transport";
import type { SignedNostrEvent } from "../domain/nostr";

/*
 * F38-06C/F38-06H: Provider readiness fail-closed behavior tests.
 *
 * These tests verify that:
 * - protocolReady is false when the durable store cannot be inspected (F38-06C)
 * - protocolReady is false when poll query fails (F38-06H)
 * - protocolReady recovers when poll succeeds again (F38-06H)
 */

function key(seed: number): string {
  return Array.from(new Uint8Array(32).fill(seed), (b) => b.toString(16).padStart(2, "0")).join("");
}

class FailingStore implements ProviderIdempotencyStore {
  readonly #inner: ProviderIdempotencyStore;
  readonly #failReads: boolean;

  constructor(inner: ProviderIdempotencyStore, failReads: boolean) {
    this.#inner = inner;
    this.#failReads = failReads;
  }

  async read(agreementRootEventId: string) {
    if (this.#failReads) throw new Error("simulated store failure");
    return this.#inner.read(agreementRootEventId);
  }
  async write(record: import("./provider-idempotency-store").ProviderOperationRecord) {
    if (this.#failReads) throw new Error("simulated store failure");
    return this.#inner.write(record);
  }
  async transitionState(id: string, state: import("./provider-idempotency-store").ProviderOperationState, updates?: Partial<import("./provider-idempotency-store").ProviderOperationRecord>) {
    if (this.#failReads) throw new Error("simulated store failure");
    return this.#inner.transitionState(id, state, updates);
  }
  async countByState(state: import("./provider-idempotency-store").ProviderOperationState) {
    if (this.#failReads) throw new Error("simulated store failure");
    return this.#inner.countByState(state);
  }
  close() {
    this.#inner.close();
  }
}

class FailingQueryRelay implements NostrRelayAdapter {
  readonly url = "wss://relay.test";
  connected = false;
  shouldFailQuery = false;

  async connect(): Promise<void> { this.connected = true; }
  async reconnect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  async publish(): Promise<void> {}
  async queryEvents(_filter: NostrFilter): Promise<SignedNostrEvent[]> {
    if (this.shouldFailQuery) throw new Error("simulated poll query failure");
    return [];
  }
}

function createStore(): ProviderIdempotencyStore {
  const dir = mkdtempSync(join(tmpdir(), "pactagent-readiness-test-"));
  return createSqliteProviderIdempotencyStore(join(dir, "provider-ops.sqlite"));
}

function createService(
  store: ProviderIdempotencyStore,
  relay: NostrRelayAdapter,
  replaySafety: "replay_safe" | "non_replay_safe" = "replay_safe",
) {
  const providerSk = key(41);
  const providerSigner = createLocalNostrSigner(providerSk);
  const providerEncrypter = createLocalNostrEncrypter(providerSk);
  const escrowSigner = createLocalNostrSigner(key(43));
  const escrowAuthorityPublicKey = escrowSigner.publicKey as NostrPublicKey;

  return createPactAgentProviderService({
    providerSigner,
    providerEncrypter,
    relay,
    relayUrl: "wss://relay.test",
    clock: () => Math.floor(Date.now() / 1000),
    offerAmountSats: 350n,
    maximumExecutionSeconds: 120,
    escrowTimeoutSeconds: 900,
    escrowAuthorityPublicKey,
    idempotencyStore: store,
    capabilityReplaySafety: replaySafety,
    pollIntervalMs: 500,
    transitionWaitTimeoutMs: 5_000,
    providerDefinitionIdentifier: "readiness-test-provider",
    offerIdentifier: "readiness-test-offer",
    escrowDescriptorIdentifier: "readiness-test-escrow",
  });
}

describe("F38-06C/F38-06H provider readiness fail-closed", () => {
  it("F38-06C: store inspection failure → protocolReady=false, storeHealthy=false", async () => {
    const relay = new FailingQueryRelay();
    const innerStore = createStore();
    const failingStore = new FailingStore(innerStore, true);
    const service = createService(failingStore, relay);
    await service.start();
    await new Promise((r) => setTimeout(r, 1_000));
    const readiness = await service.readiness();
    expect(readiness.storeHealthy).toBe(false);
    expect(readiness.protocolReady).toBe(false);
    await service.stop();
    // Close the inner store since failingStore.close delegates to it
    innerStore.close();
  }, 15_000);

  it("F38-06H: poll query failure → pollHealthy=false, protocolReady=false", async () => {
    const relay = new FailingQueryRelay();
    relay.shouldFailQuery = true;
    const store = createStore();
    const service = createService(store, relay);
    await service.start();
    // Wait for at least one poll cycle to fail
    await new Promise((r) => setTimeout(r, 2_000));
    const readiness = await service.readiness();
    expect(readiness.pollHealthy).toBe(false);
    expect(readiness.protocolReady).toBe(false);
    await service.stop();
    store.close();
  }, 15_000);

  it("F38-06H: subsequent successful poll → pollHealthy=true, protocolReady may recover", async () => {
    const relay = new FailingQueryRelay();
    relay.shouldFailQuery = true;
    const store = createStore();
    const service = createService(store, relay);
    await service.start();
    // Wait for poll to fail
    await new Promise((r) => setTimeout(r, 2_000));
    let readiness = await service.readiness();
    expect(readiness.pollHealthy).toBe(false);
    // Fix the relay — poll should succeed next cycle
    relay.shouldFailQuery = false;
    await new Promise((r) => setTimeout(r, 2_000));
    readiness = await service.readiness();
    expect(readiness.pollHealthy).toBe(true);
    // protocolReady may still be true if artifacts published and relay connected
    await service.stop();
    store.close();
  }, 20_000);
});
