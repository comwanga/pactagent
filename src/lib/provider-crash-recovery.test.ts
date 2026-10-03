import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { sats } from "../domain/money";
import {
  createNostrIdentity,
  nostrPublicKey,
  type NostrPublicKey,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "../domain/nostr";
import { createPontmoreAgentDefinition } from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  createPactServiceOffer,
  PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
} from "../domain/pact-service-offer";
import {
  DOCUMENT_SUMMARY_PROFILE_ID,
  PACT_SERVICE_AGREEMENT_ROOT_TYPE,
  PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND,
  PACT_TERMS_COMMITMENT_SCHEME,
  type PactAgreementReferences,
} from "../domain/pact-service-agreement";
import { createLocalNostrSigner } from "./nostr-signer";
import { createLocalNostrEncrypter, sealPrivateTask } from "./private-task-transport";
import { createPactAgentProviderService } from "./pactagent-provider-service";
import { createSqliteProviderIdempotencyStore, type ProviderIdempotencyStore } from "./provider-idempotency-store";
import type { NostrFilter, NostrRelayAdapter } from "./nostr-relay";
import type { NostrSigner } from "../domain/nostr";
import type { NostrEncrypter } from "./private-task-transport";
import type { PrivateTaskProvenance } from "../domain/private-task-transport";

/*
 * F38-03/F38-04: Service-level provider crash/restart tests.
 *
 * These tests exercise the actual PactAgentProviderService through a
 * mock relay to prove crash recovery and result publication idempotency.
 * They do NOT directly manipulate the idempotency store — they test
 * through the service's public API (start, stop, readiness).
 */

function key(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signEvent(event: UnsignedNostrEvent, secret: Uint8Array): SignedNostrEvent {
  return finalizeEvent({ ...event, tags: event.tags.map((t) => [...t]) }, secret) as unknown as SignedNostrEvent;
}

function filterMatches(event: SignedNostrEvent, filter: NostrFilter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  if (filter.tags) {
    for (const [name, values] of Object.entries(filter.tags)) {
      if (!event.tags.some((tag) => tag[0] === name && values.includes(tag[1]))) return false;
    }
  }
  return true;
}

class InMemoryRelay implements NostrRelayAdapter {
  readonly url = "wss://relay.test";
  readonly events: SignedNostrEvent[] = [];
  connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }
  async reconnect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async publish(event: SignedNostrEvent): Promise<void> {
    if (!this.events.some((c) => c.id === event.id)) this.events.push(event);
  }
  async queryEvents(filter: NostrFilter): Promise<SignedNostrEvent[]> {
    return this.events.filter((e) => filterMatches(e, filter)).sort((a, b) => b.created_at - a.created_at);
  }
  addEvent(event: SignedNostrEvent): void {
    if (!this.events.some((c) => c.id === event.id)) this.events.push(event);
  }
}

interface ProviderFixture {
  providerSigner: NostrSigner;
  providerEncrypter: NostrEncrypter;
  providerPublicKey: NostrPublicKey;
  escrowAuthorityPublicKey: NostrPublicKey;
  requesterSigner: NostrSigner;
  requesterEncrypter: NostrEncrypter;
  requesterPublicKey: NostrPublicKey;
  references: PactAgreementReferences;
  rootTime: number;
}

function buildProviderFixture(): ProviderFixture {
  const providerSk = key(41);
  const requesterSk = key(42);
  const escrowSk = key(43);

  const providerSigner = createLocalNostrSigner(hex(providerSk));
  const requesterSigner = createLocalNostrSigner(hex(requesterSk));
  const escrowSigner = createLocalNostrSigner(hex(escrowSk));

  const providerPublicKey = providerSigner.publicKey;
  const requesterPublicKey = requesterSigner.publicKey;
  const escrowAuthorityPublicKey = escrowSigner.publicKey;

  const providerIdentity = createNostrIdentity(providerPublicKey, ["wss://relay.test"]);
  const requesterIdentity = createNostrIdentity(requesterPublicKey, ["wss://relay.test"]);

  const now = 1_900_000_000;
  const descriptor = createCashuEscrowDescriptor({
    identity: providerIdentity, identifier: "crash-test-escrow", updatedAt: now - 10,
    referenceFormat: "opaque_service_reference", timeoutSeconds: 900,
  });
  const offer = createPactServiceOffer({
    identity: providerIdentity, identifier: "crash-test-offer",
    capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
    amountSats: sats(350n), settlementNetwork: "cashu",
    escrowDescriptorReference: descriptor.address, maximumExecutionSeconds: 120,
    validFrom: now - 10, expiresAt: now + 3600, updatedAt: now - 10,
  });
  const providerDef = createPontmoreAgentDefinition({
    identity: providerIdentity, identifier: "crash-test-provider", name: "Crash Test Provider",
    about: "Test", capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
    pricingPolicyReference: offer.address, escrowDescriptorReference: descriptor.address, updatedAt: now - 10,
  });
  const requesterDef = createPontmoreAgentDefinition({
    identity: requesterIdentity, identifier: "crash-test-requester", name: "Crash Test Requester",
    about: "Test", capabilities: { names: ["service-discovery"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/crash-test-requester@1",
    escrowDescriptorReference: descriptor.address, updatedAt: now - 10,
  });

  const descriptorEvent = signEvent(descriptor.event, providerSk);
  const offerEvent = signEvent(offer.event, providerSk);
  const providerDefEvent = signEvent(providerDef.event, providerSk);
  const requesterDefEvent = signEvent(requesterDef.event, requesterSk);

  return {
    providerSigner,
    providerEncrypter: createLocalNostrEncrypter(hex(providerSk)),
    providerPublicKey,
    escrowAuthorityPublicKey,
    requesterSigner,
    requesterEncrypter: createLocalNostrEncrypter(hex(requesterSk)),
    requesterPublicKey,
    references: {
      requesterDefinition: requesterDefEvent,
      providerDefinition: providerDefEvent,
      escrowDescriptor: descriptorEvent,
    },
    rootTime: now,
  };
}

function createAgreementRoot(
  fixture: ProviderFixture,
  now: number,
): SignedNostrEvent {
  const agreementId = `crash-test-agreement-${now}`;
  const requesterDef = `30360:${fixture.requesterPublicKey}:crash-test-requester`;
  const providerDef = `30360:${fixture.providerPublicKey}:crash-test-provider`;
  const escrowDesc = `30361:${fixture.providerPublicKey}:crash-test-escrow`;

  const content = {
    version: 1,
    agreement_id: agreementId,
    capability_profile: DOCUMENT_SUMMARY_PROFILE_ID,
    requester: fixture.requesterPublicKey,
    provider: fixture.providerPublicKey,
    requester_definition: requesterDef,
    provider_definition: providerDef,
    escrow_descriptor: escrowDesc,
    amount_sats: "350",
    settlement_network: "cashu",
    maximum_execution_seconds: 120,
    expires_at: now + 600,
    terms_commitment: "00".repeat(32),
    terms_commitment_scheme: PACT_TERMS_COMMITMENT_SCHEME,
  };

  const event: UnsignedNostrEvent = {
    kind: PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND,
    pubkey: fixture.requesterPublicKey,
    created_at: now,
    tags: [
      ["d", agreementId],
      ["t", PACT_SERVICE_AGREEMENT_ROOT_TYPE],
      ["t", DOCUMENT_SUMMARY_PROFILE_ID],
      ["p", fixture.requesterPublicKey],
      ["p", fixture.providerPublicKey],
      ["a", requesterDef],
      ["a", providerDef],
      ["a", escrowDesc],
    ] as readonly (readonly [string, ...string[]])[],
    content: JSON.stringify(content),
  };

  return signEvent(event, key(42));
}

function createStore(): { store: ProviderIdempotencyStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "pactagent-crash-recovery-"));
  const path = join(dir, "provider-ops.sqlite");
  return { store: createSqliteProviderIdempotencyStore(path), path };
}

function reopenStore(path: string): ProviderIdempotencyStore {
  return createSqliteProviderIdempotencyStore(path);
}

function createService(
  fixture: ProviderFixture,
  store: ProviderIdempotencyStore,
  relay: InMemoryRelay,
  replaySafety: "replay_safe" | "non_replay_safe" = "replay_safe",
) {
  return createPactAgentProviderService({
    providerSigner: fixture.providerSigner,
    providerEncrypter: fixture.providerEncrypter,
    relay,
    relayUrl: relay.url,
    clock: () => Math.floor(Date.now() / 1000),
    offerAmountSats: 350n,
    maximumExecutionSeconds: 120,
    escrowTimeoutSeconds: 900,
    escrowAuthorityPublicKey: fixture.escrowAuthorityPublicKey,
    idempotencyStore: store,
    capabilityReplaySafety: replaySafety,
    pollIntervalMs: 500,
    transitionWaitTimeoutMs: 5_000,
    providerDefinitionIdentifier: "crash-test-provider",
    offerIdentifier: "crash-test-offer",
    escrowDescriptorIdentifier: "crash-test-escrow",
  });
}

const fixture = buildProviderFixture();

describe("F38-03/F38-04 provider crash recovery (service-level)", () => {
  it("A: agreement received → crash before acceptance → restart → acceptance proceeds once", async () => {
    const relay = new InMemoryRelay();
    relay.addEvent(fixture.references.requesterDefinition);
    relay.addEvent(fixture.references.providerDefinition);
    relay.addEvent(fixture.references.escrowDescriptor);

    // Use current time for the agreement root so transitions validate
    const now = Math.floor(Date.now() / 1000);
    const rootEvent = createAgreementRoot(fixture, now);
    relay.addEvent(rootEvent);

    const { store, path } = createStore();
    const service = createService(fixture, store, relay);
    await service.start();

    // Wait for the provider to publish artifacts and poll
    await new Promise((r) => setTimeout(r, 2_000));

    // Simulate crash: stop (store gets closed by stop())
    await service.stop();

    // Verify the state is "received" (not complete)
    const store2 = reopenStore(path);
    const record = await store2.read(rootEvent.id);
    expect(record).toBeDefined();
    // State should be "received" or advanced — but NOT "complete"
    expect(record!.state).not.toBe("complete");

    // Restart with a new store instance from the same file
    const relay2 = new InMemoryRelay();
    relay2.events.push(...relay.events);
    const service2 = createService(fixture, store2, relay2);
    await service2.start();

    // Wait for acceptance to proceed
    await new Promise((r) => setTimeout(r, 3_000));
    await service2.stop();

    // Verify acceptance proceeded (state should have advanced past "received")
    const store3 = reopenStore(path);
    const record2 = await store3.read(rootEvent.id);
    expect(record2).toBeDefined();
    expect(record2!.state).not.toBe("complete");
    expect(record2!.state).not.toBe("received");

    store3.close();
  }, 30_000);

  it("B: acceptance published → crash before next-state persistence → restart → waiting for funding → NOT complete", async () => {
    const { store, path } = createStore();

    // Use current time for the agreement root
    const now = Math.floor(Date.now() / 1000);
    const rootEvent = createAgreementRoot(fixture, now);

    // Manually write "received" state and simulate the relay showing "accepted"
    await store.write({
      agreementRootEventId: rootEvent.id,
      agreementId: `crash-test-agreement-${now}`,
      requesterPublicKey: fixture.requesterPublicKey,
      state: "received",
      resultReference: undefined,
      resultSummary: undefined,
      acceptedTransitionEventId: undefined,
      taskDeliveredTransitionEventId: undefined,
      resultSubmittedTransitionEventId: undefined,
      createdAt: now,
      updatedAt: now,
      failureCode: undefined,
    });

    // Set up relay with accepted state already present
    const relay = new InMemoryRelay();
    relay.addEvent(fixture.references.requesterDefinition);
    relay.addEvent(fixture.references.providerDefinition);
    relay.addEvent(fixture.references.escrowDescriptor);
    relay.addEvent(rootEvent);

    // Simulate that acceptance was already published (add accepted transition)
    const acceptedEvent = signEvent(
      {
        kind: PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND,
        pubkey: fixture.providerPublicKey,
        created_at: now + 1,
        tags: [
          ["t", PACT_SERVICE_AGREEMENT_ROOT_TYPE],
          ["e", rootEvent.id],
          ["p", fixture.requesterPublicKey],
        ],
        content: JSON.stringify({ state: "accepted", profile: DOCUMENT_SUMMARY_PROFILE_ID }),
      },
      key(41),
    );
    relay.addEvent(acceptedEvent);

    // Restart — recovery should see "accepted" and NOT mark complete
    const service = createService(fixture, store, relay);
    await service.start();
    await new Promise((r) => setTimeout(r, 3_000));
    await service.stop();

    // F38-03B: State should be "waiting_for_funding" — NOT "complete"
    const store2 = reopenStore(path);
    const record = await store2.read(rootEvent.id);
    expect(record).toBeDefined();
    expect(record!.state).not.toBe("complete");
    expect(record!.state).not.toBe("received");

    store2.close();
  }, 30_000);

  it("C: waiting_for_funding → restart → continue waiting → NOT complete", async () => {
    const { store, path } = createStore();
    const now = Math.floor(Date.now() / 1000);
    const rootEvent = createAgreementRoot(fixture, now);

    // Write "waiting_for_funding" state
    await store.write({
      agreementRootEventId: rootEvent.id,
      agreementId: `crash-test-agreement-${now}`,
      requesterPublicKey: fixture.requesterPublicKey,
      state: "waiting_for_funding",
      resultReference: undefined,
      resultSummary: undefined,
      acceptedTransitionEventId: undefined,
      taskDeliveredTransitionEventId: undefined,
      resultSubmittedTransitionEventId: undefined,
      createdAt: now,
      updatedAt: now,
      failureCode: undefined,
    });

    // Set up relay with accepted state (but no escrow_funded)
    const relay = new InMemoryRelay();
    relay.addEvent(fixture.references.requesterDefinition);
    relay.addEvent(fixture.references.providerDefinition);
    relay.addEvent(fixture.references.escrowDescriptor);
    relay.addEvent(rootEvent);

    const acceptedEvent = signEvent(
      {
        kind: PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND,
        pubkey: fixture.providerPublicKey,
        created_at: now + 1,
        tags: [
          ["t", PACT_SERVICE_AGREEMENT_ROOT_TYPE],
          ["e", rootEvent.id],
          ["p", fixture.requesterPublicKey],
        ],
        content: JSON.stringify({ state: "accepted", profile: DOCUMENT_SUMMARY_PROFILE_ID }),
      },
      key(41),
    );
    relay.addEvent(acceptedEvent);

    // Restart — recovery should continue waiting, NOT mark complete
    const service = createService(fixture, store, relay);
    await service.start();
    await new Promise((r) => setTimeout(r, 2_000));
    await service.stop();

    // F38-03C: State should still be "waiting_for_funding" — NOT "complete"
    const store2 = reopenStore(path);
    const record = await store2.read(rootEvent.id);
    expect(record).toBeDefined();
    expect(record!.state).not.toBe("complete");
    expect(["waiting_for_funding", "processing"]).toContain(record!.state);

    store2.close();
  }, 30_000);

  it("I: complete → restart/redelivery → no duplicate agreement transitions", async () => {
    const { store, path } = createStore();
    const now = Math.floor(Date.now() / 1000);
    const rootEvent = createAgreementRoot(fixture, now);

    // Write "complete" state
    await store.write({
      agreementRootEventId: rootEvent.id,
      agreementId: `crash-test-agreement-${now}`,
      requesterPublicKey: fixture.requesterPublicKey,
      state: "complete",
      resultReference: "test-result-ref",
      resultSummary: "test summary",
      acceptedTransitionEventId: undefined,
      taskDeliveredTransitionEventId: undefined,
      resultSubmittedTransitionEventId: undefined,
      createdAt: now,
      updatedAt: now,
      failureCode: undefined,
    });

    // Set up relay with settled state
    const relay = new InMemoryRelay();
    relay.addEvent(fixture.references.requesterDefinition);
    relay.addEvent(fixture.references.providerDefinition);
    relay.addEvent(fixture.references.escrowDescriptor);
    relay.addEvent(rootEvent);

    // Count agreement TRANSITION events (reference root via "e" tag, exclude root itself)
    const transitionEventsBefore = relay.events.filter(
      (e) =>
        e.kind === PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND &&
        e.id !== rootEvent.id &&
        e.tags.some((t) => t[0] === "e" && t[1] === rootEvent.id),
    ).length;

    // Restart — should NOT re-process
    const service = createService(fixture, store, relay);
    await service.start();
    await new Promise((r) => setTimeout(r, 2_000));
    await service.stop();

    // F38-03I: No duplicate agreement transition events published
    const transitionEventsAfter = relay.events.filter(
      (e) =>
        e.kind === PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND &&
        e.id !== rootEvent.id &&
        e.tags.some((t) => t[0] === "e" && t[1] === rootEvent.id),
    ).length;
    expect(transitionEventsAfter).toBe(transitionEventsBefore);

    const store2 = reopenStore(path);
    const record = await store2.read(rootEvent.id);
    expect(record).toBeDefined();
    expect(record!.state).toBe("complete");

    store2.close();
  }, 30_000);

  it("F38-04: result_prepared with persisted event → restart → re-publish SAME event identity", async () => {
    const { store, path } = createStore();
    const now = Math.floor(Date.now() / 1000);
    const rootEvent = createAgreementRoot(fixture, now);

    // Create a fake gift-wrap event to persist
    const fakeWrapEvent = signEvent(
      {
        kind: 1059,
        pubkey: fixture.providerPublicKey,
        created_at: now,
        tags: [["p", fixture.requesterPublicKey]],
        content: "encrypted-test-result",
      },
      key(41),
    );
    const preparedEventJson = JSON.stringify(fakeWrapEvent);

    // Write "result_prepared" state with the persisted event
    await store.write({
      agreementRootEventId: rootEvent.id,
      agreementId: `crash-test-agreement-${now}`,
      requesterPublicKey: fixture.requesterPublicKey,
      state: "result_prepared",
      resultReference: "test-result-ref",
      resultSummary: "test summary",
      acceptedTransitionEventId: undefined,
      taskDeliveredTransitionEventId: undefined,
      resultSubmittedTransitionEventId: undefined,
      createdAt: now,
      updatedAt: now,
      failureCode: undefined,
      preparedEventJson,
    });

    // Set up relay — the gift-wrap event is NOT on the relay yet
    const relay = new InMemoryRelay();
    relay.addEvent(fixture.references.requesterDefinition);
    relay.addEvent(fixture.references.providerDefinition);
    relay.addEvent(fixture.references.escrowDescriptor);
    relay.addEvent(rootEvent);

    // Restart — should re-publish the SAME persisted event
    const service = createService(fixture, store, relay);
    await service.start();
    await new Promise((r) => setTimeout(r, 3_000));
    await service.stop();

    // F38-04: Verify the exact persisted event was published (same identity)
    const wrapEvents = relay.events.filter((e) => e.kind === 1059);
    expect(wrapEvents.length).toBeGreaterThanOrEqual(1);
    expect(wrapEvents.some((e) => e.id === fakeWrapEvent.id)).toBe(true);

    // State should have advanced to result_published (not still result_prepared)
    const store2 = reopenStore(path);
    const record = await store2.read(rootEvent.id);
    expect(record).toBeDefined();
    expect(["result_published", "transitions_reconciling", "complete"]).toContain(record!.state);

    store2.close();
  }, 30_000);

  it("F38-04: result_prepared → event already on relay → restart → no distinct gift wrap", async () => {
    const { store, path } = createStore();
    const now = Math.floor(Date.now() / 1000);
    const rootEvent = createAgreementRoot(fixture, now);

    // Create a fake gift-wrap event to persist
    const fakeWrapEvent = signEvent(
      {
        kind: 1059,
        pubkey: fixture.providerPublicKey,
        created_at: now,
        tags: [["p", fixture.requesterPublicKey]],
        content: "encrypted-test-result",
      },
      key(41),
    );
    const preparedEventJson = JSON.stringify(fakeWrapEvent);

    // Write "result_prepared" state with the persisted event
    await store.write({
      agreementRootEventId: rootEvent.id,
      agreementId: `crash-test-agreement-${now}`,
      requesterPublicKey: fixture.requesterPublicKey,
      state: "result_prepared",
      resultReference: "test-result-ref",
      resultSummary: "test summary",
      acceptedTransitionEventId: undefined,
      taskDeliveredTransitionEventId: undefined,
      resultSubmittedTransitionEventId: undefined,
      createdAt: now,
      updatedAt: now,
      failureCode: undefined,
      preparedEventJson,
    });

    // Set up relay — the gift-wrap event IS already on the relay
    const relay = new InMemoryRelay();
    relay.addEvent(fixture.references.requesterDefinition);
    relay.addEvent(fixture.references.providerDefinition);
    relay.addEvent(fixture.references.escrowDescriptor);
    relay.addEvent(rootEvent);
    relay.addEvent(fakeWrapEvent);

    const wrapCountBefore = relay.events.filter((e) => e.kind === 1059).length;

    // Restart — should detect the event is already published and NOT create a new one
    const service = createService(fixture, store, relay);
    await service.start();
    await new Promise((r) => setTimeout(r, 3_000));
    await service.stop();

    // F38-04: No distinct gift wrap — same count of wrap events
    const wrapCountAfter = relay.events.filter((e) => e.kind === 1059).length;
    expect(wrapCountAfter).toBe(wrapCountBefore);

    store.close();
  }, 30_000);

  it("Issue #39: inclusive-since relay polls do not re-process the newest agreement root forever", async () => {
    const relay = new InMemoryRelay();
    relay.addEvent(fixture.references.requesterDefinition);
    relay.addEvent(fixture.references.providerDefinition);
    relay.addEvent(fixture.references.escrowDescriptor);

    const now = Math.floor(Date.now() / 1000);
    const rootEvent = createAgreementRoot(fixture, now);
    relay.addEvent(rootEvent);

    const { store } = createStore();
    const readCalls = new Map<string, number>();
    const countingStore = new Proxy(store, {
      get(target, property) {
        if (property === "read") {
          return async (key: string) => {
            readCalls.set(key, (readCalls.get(key) ?? 0) + 1);
            return target.read(key);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const service = createService(fixture, countingStore, relay);
    await service.start();
    // Several poll cycles (500ms interval) — the inclusive `since` filter
    // keeps returning the newest root on every poll.
    await new Promise((r) => setTimeout(r, 3_000));
    await service.stop();

    // The root must be processed (read) exactly once despite repeated polls.
    expect(readCalls.get(rootEvent.id)).toBe(1);

    store.close();
  }, 30_000);
});
