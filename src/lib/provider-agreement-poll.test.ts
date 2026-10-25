import { finalizeEvent } from "nostr-tools/pure";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNostrIdentity,
  type NostrPublicKey,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "../domain/nostr";
import { createPontmoreAgentDefinition, PIP00_AGENT_DEFINITION_KIND } from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  DOCUMENT_SUMMARY_PROFILE_ID,
  PACT_AGREEMENT_CLOCK_SKEW_SECONDS,
  PACT_SERVICE_AGREEMENT_ROOT_TYPE,
  PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND,
  PACT_TERMS_COMMITMENT_SCHEME,
} from "../domain/pact-service-agreement";
import { createLocalNostrSigner } from "./nostr-signer";
import { createLocalNostrEncrypter } from "./private-task-transport";
import {
  AGREEMENT_POLL_OVERLAP_SECONDS,
  createPactAgentProviderService,
  type PactAgentProviderService,
} from "./pactagent-provider-service";
import {
  createSqliteProviderIdempotencyStore,
  type ProviderIdempotencyStore,
  type ProviderOperationRecord,
  type ProviderOperationState,
} from "./provider-idempotency-store";
import { NostrRelayError, type NostrFilter, type NostrRelayAdapter } from "./nostr-relay";

/*
 * Issue #59: the standalone provider's agreement poll must only consider
 * roots addressed to it, must never let an untrusted timestamp move its
 * cursor past trusted time, and must resume from a durable cursor after a
 * restart without losing or re-accepting agreements.
 *
 * The relay fake behaves like Strfry for the filters the provider uses:
 * kinds, ids, authors, inclusive since/until, tag filters (AND across tag
 * names, OR within one), newest-first ordering and the `limit` cap. The
 * provider is driven through its public start/stop API with a controllable
 * clock; tests wait for observable relay or store effects, not fixed sleeps.
 */

const PROVIDER_SEED = 61;
const REQUESTER_SEED = 62;
const ESCROW_SEED = 63;
const OTHER_PROVIDER_SEED = 64;
const SPAMMER_SEED = 65;

function secret(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signEvent(event: UnsignedNostrEvent, seed: number): SignedNostrEvent {
  return finalizeEvent(
    { ...event, tags: event.tags.map((tag) => [...tag]) },
    secret(seed),
  ) as unknown as SignedNostrEvent;
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

function isRootPoll(filter: NostrFilter): boolean {
  return filter.ids === undefined && (filter.tags?.t ?? []).includes(PACT_SERVICE_AGREEMENT_ROOT_TYPE);
}

class StrfryLikeRelay implements NostrRelayAdapter {
  readonly url = "wss://relay.test";
  readonly events: SignedNostrEvent[] = [];
  readonly rootPolls: NostrFilter[] = [];
  /** Root poll queries to fail before answering normally again. */
  failRootPolls = 0;
  failRootPollsWith: "timeout" | "closed" = "closed";
  /** Returned on every root poll regardless of the filter (a misbehaving relay). */
  readonly unfilteredRootPollEvents: SignedNostrEvent[] = [];
  /** Raw objects returned on every root poll (malformed relay output). */
  readonly malformedRootPollEvents: unknown[] = [];
  reconnectFails = false;
  /** Agent-definition queries to fail with a timeout (transient relay fault). */
  failDefinitionQueries = 0;
  definitionQueries = 0;
  /** When set, only definition queries for this author consume failDefinitionQueries. */
  failDefinitionAuthor: string | undefined;
  /** Fails the root poll with this zero-based index once (a mid-scan relay error). */
  failRootPollIndex: number | undefined;
  readonly idQueries: NostrFilter[] = [];

  async connect(): Promise<void> {}
  async reconnect(): Promise<void> {
    if (this.reconnectFails) {
      throw new NostrRelayError({ code: "connection_failed", relayUrl: this.url, message: "offline" });
    }
  }
  async disconnect(): Promise<void> {}
  async publish(event: SignedNostrEvent): Promise<void> {
    this.add(event);
  }
  async queryEvents(filter: NostrFilter): Promise<SignedNostrEvent[]> {
    const rootPoll = isRootPoll(filter);
    if (filter.ids !== undefined) this.idQueries.push(filter);
    if (filter.kinds?.includes(PIP00_AGENT_DEFINITION_KIND)) this.definitionQueries += 1;
    if (
      filter.kinds?.includes(PIP00_AGENT_DEFINITION_KIND) &&
      this.failDefinitionQueries > 0 &&
      (this.failDefinitionAuthor === undefined || (filter.authors ?? []).includes(this.failDefinitionAuthor))
    ) {
      this.failDefinitionQueries -= 1;
      throw new NostrRelayError({ code: "query_timeout", relayUrl: this.url, message: "simulated definition timeout" });
    }
    if (rootPoll) {
      this.rootPolls.push(filter);
      if (this.failRootPollIndex === this.rootPolls.length - 1) {
        this.failRootPollIndex = undefined;
        throw new NostrRelayError({ code: "connection_closed", relayUrl: this.url, message: "simulated mid-scan failure" });
      }
      if (this.failRootPolls > 0) {
        this.failRootPolls -= 1;
        throw new NostrRelayError({
          code: this.failRootPollsWith === "timeout" ? "query_timeout" : "connection_closed",
          relayUrl: this.url,
          message: "simulated root poll failure",
        });
      }
    }
    const matched = this.events
      .filter((event) => filterMatches(event, filter))
      .sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id))
      .slice(0, filter.limit ?? 10_000);
    if (!rootPoll) return matched;
    return [
      ...(this.malformedRootPollEvents as SignedNostrEvent[]),
      ...this.unfilteredRootPollEvents,
      ...matched,
    ];
  }
  add(event: SignedNostrEvent): void {
    if (!this.events.some((candidate) => candidate.id === event.id)) this.events.push(event);
  }
}

const providerSigner = createLocalNostrSigner(hex(secret(PROVIDER_SEED)));
const requesterSigner = createLocalNostrSigner(hex(secret(REQUESTER_SEED)));
const otherProviderPublicKey = createLocalNostrSigner(hex(secret(OTHER_PROVIDER_SEED))).publicKey;
const escrowAuthorityPublicKey = createLocalNostrSigner(hex(secret(ESCROW_SEED))).publicKey;

function requesterDefinitionEvent(updatedAt: number, seed = REQUESTER_SEED): SignedNostrEvent {
  const identity = createNostrIdentity(
    createLocalNostrSigner(hex(secret(seed))).publicKey,
    ["wss://relay.test"],
  );
  const descriptor = createCashuEscrowDescriptor({
    identity: createNostrIdentity(providerSigner.publicKey, ["wss://relay.test"]),
    identifier: "poll-test-escrow",
    updatedAt,
    referenceFormat: "opaque_service_reference",
    timeoutSeconds: 900,
  });
  const definition = createPontmoreAgentDefinition({
    identity,
    identifier: "poll-test-requester",
    name: "Poll Test Requester",
    about: "Test",
    capabilities: { names: ["service-discovery"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/poll-test-requester@1",
    escrowDescriptorReference: descriptor.address,
    updatedAt,
  });
  return signEvent(definition.event, seed);
}

interface RootOptions {
  readonly createdAt: number;
  readonly label: string;
  /** Provider named in content and `p` tag. Defaults to the provider under test. */
  readonly provider?: NostrPublicKey;
  /** Author/requester. Defaults to the fixture requester. */
  readonly requesterSeed?: number;
  /** Omit the provider `p` tag (malformed tagging). */
  readonly omitProviderTag?: boolean;
  /** Tag a different provider than the content names. */
  readonly providerTagOverride?: string;
}

function agreementRoot(options: RootOptions): SignedNostrEvent {
  const requesterSeed = options.requesterSeed ?? REQUESTER_SEED;
  const requester = createLocalNostrSigner(hex(secret(requesterSeed))).publicKey;
  const provider = options.provider ?? providerSigner.publicKey;
  const agreementId = `poll-test-${options.label}`;
  const requesterDefinition = `30360:${requester}:poll-test-requester`;
  const providerDefinition = `30360:${provider}:poll-test-provider`;
  const escrowDescriptor = `30361:${provider}:poll-test-escrow`;
  const content = {
    version: 1,
    agreement_id: agreementId,
    capability_profile: DOCUMENT_SUMMARY_PROFILE_ID,
    requester,
    provider,
    requester_definition: requesterDefinition,
    provider_definition: providerDefinition,
    escrow_descriptor: escrowDescriptor,
    amount_sats: "350",
    settlement_network: "cashu",
    maximum_execution_seconds: 120,
    expires_at: options.createdAt + 600,
    terms_commitment: "00".repeat(32),
    terms_commitment_scheme: PACT_TERMS_COMMITMENT_SCHEME,
  };
  const tags: [string, string][] = [
    ["d", agreementId],
    ["t", PACT_SERVICE_AGREEMENT_ROOT_TYPE],
    ["t", DOCUMENT_SUMMARY_PROFILE_ID],
    ["p", requester],
  ];
  if (!options.omitProviderTag) tags.push(["p", options.providerTagOverride ?? provider]);
  tags.push(["a", requesterDefinition], ["a", providerDefinition], ["a", escrowDescriptor]);
  return signEvent(
    {
      kind: PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND,
      pubkey: requester,
      created_at: options.createdAt,
      tags,
      content: JSON.stringify(content),
    },
    requesterSeed,
  );
}

interface Harness {
  readonly relay: StrfryLikeRelay;
  readonly clock: { now: number };
  readonly storePath: string;
  store: ProviderIdempotencyStore;
  service: PactAgentProviderService;
}

const running: Harness[] = [];

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), "pactagent-poll-cursor-")), "provider-ops.sqlite");
}

function createHarness(options: {
  relay?: StrfryLikeRelay;
  clock?: { now: number };
  path?: string;
  store?: ProviderIdempotencyStore;
} = {}): Harness {
  const relay = options.relay ?? new StrfryLikeRelay();
  const clock = options.clock ?? { now: Math.floor(Date.now() / 1000) };
  const path = options.path ?? storePath();
  const store = options.store ?? createSqliteProviderIdempotencyStore(path);
  relay.add(requesterDefinitionEvent(clock.now - 3_600));
  const service = createPactAgentProviderService({
    providerSigner,
    providerEncrypter: createLocalNostrEncrypter(hex(secret(PROVIDER_SEED))),
    relay,
    relayUrl: relay.url,
    clock: () => clock.now,
    offerAmountSats: 350n,
    maximumExecutionSeconds: 120,
    escrowTimeoutSeconds: 900,
    escrowAuthorityPublicKey,
    idempotencyStore: store,
    capabilityReplaySafety: "replay_safe",
    pollIntervalMs: 50,
    // Zero: an accepted agreement returns to the poll loop immediately
    // instead of blocking on escrow funding that never arrives here.
    transitionWaitTimeoutMs: 0,
    providerDefinitionIdentifier: "poll-test-provider",
    offerIdentifier: "poll-test-offer",
    escrowDescriptorIdentifier: "poll-test-escrow",
  });
  const harness: Harness = { relay, clock, storePath: path, store, service };
  running.push(harness);
  return harness;
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.service.stop();
  const index = running.indexOf(harness);
  if (index >= 0) running.splice(index, 1);
}

afterEach(async () => {
  for (const harness of running.splice(0)) await harness.service.stop();
});

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/** Waits until the provider has completed `count` more root polls. */
async function waitForPolls(relay: StrfryLikeRelay, count: number): Promise<void> {
  const target = relay.rootPolls.length + count;
  await waitFor(() => relay.rootPolls.length >= target, `${count} root polls`);
  // One more poll start proves the previous poll finished its processing.
  await waitFor(() => relay.rootPolls.length > target, "the following poll");
}

function acceptedTransitions(relay: StrfryLikeRelay, root: SignedNostrEvent): number {
  return relay.events.filter((event) => {
    if (event.pubkey !== providerSigner.publicKey || event.kind !== PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND) return false;
    if (!event.tags.some((tag) => tag[0] === "e" && tag[1] === root.id)) return false;
    try {
      return (JSON.parse(event.content) as { state?: string }).state === "accepted";
    } catch {
      return false;
    }
  }).length;
}

async function discovered(harness: Harness, root: SignedNostrEvent): Promise<boolean> {
  // Read past any instrumentation so the test's own checks are not counted.
  const store = harness.store instanceof InstrumentedStore ? harness.store.inner : harness.store;
  return (await store.read(root.id)) !== undefined;
}

describe("Issue #59 reproduction: provider agreement poll cursor", () => {
  it("A: a future-dated root for another provider does not hide a later legitimate root", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    harness.relay.add(
      agreementRoot({ createdAt: now + 86_400, label: "foreign-future", provider: otherProviderPublicKey }),
    );
    await harness.service.start();
    await waitForPolls(harness.relay, 1);

    const legitimate = agreementRoot({ createdAt: now, label: "legit-after-foreign-future" });
    harness.relay.add(legitimate);
    await waitFor(() => discovered(harness, legitimate), "the legitimate root to be discovered", 5_000);
    expect(acceptedTransitions(harness.relay, legitimate)).toBe(1);
  });

  it("B: more than 100 newer roots for other providers do not starve a legitimate root", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    const legitimate = agreementRoot({ createdAt: now - 30, label: "legit-under-volume" });
    harness.relay.add(legitimate);
    for (let index = 0; index < 150; index += 1) {
      harness.relay.add(
        agreementRoot({
          createdAt: now - 20 + (index % 20),
          label: `foreign-volume-${index}`,
          provider: otherProviderPublicKey,
        }),
      );
    }
    await harness.service.start();
    await waitFor(() => discovered(harness, legitimate), "the legitimate root to be discovered", 5_000);
    expect(acceptedTransitions(harness.relay, legitimate)).toBe(1);
  });

  it("C: after a restart the provider resumes from a persisted cursor without re-accepting", async () => {
    const relay = new StrfryLikeRelay();
    const clock = { now: Math.floor(Date.now() / 1000) };
    const path = storePath();
    const first = createHarness({ relay, clock, path });
    const firstRoot = agreementRoot({ createdAt: clock.now, label: "restart-first" });
    relay.add(firstRoot);
    await first.service.start();
    await waitFor(() => discovered(first, firstRoot), "the first root to be discovered");
    await waitForPolls(relay, 1);
    await stopHarness(first);

    const persisted = createSqliteProviderIdempotencyStore(path);
    const cursor = await persisted.readPollCursor();
    persisted.close();
    expect(cursor).toBe(clock.now);

    clock.now += 30;
    const second = createHarness({ relay, clock, path });
    const secondRoot = agreementRoot({ createdAt: clock.now, label: "restart-second" });
    relay.add(secondRoot);
    await second.service.start();
    await waitFor(() => discovered(second, secondRoot), "the second root to be discovered");
    await waitForPolls(relay, 1);
    expect(acceptedTransitions(relay, firstRoot)).toBe(1);
    expect(acceptedTransitions(relay, secondRoot)).toBe(1);
  });
});

const SKEW = PACT_AGREEMENT_CLOCK_SKEW_SECONDS;
const OVERLAP = AGREEMENT_POLL_OVERLAP_SECONDS;

/** Wraps the durable store to count reads and inject cursor write failures. */
class InstrumentedStore implements ProviderIdempotencyStore {
  readonly reads = new Map<string, number>();
  failCursorWrites = false;
  failReads = false;
  /** Every cursor value written durably, in order. */
  readonly cursorWrites: number[] = [];
  onCursorWrite: ((createdAt: number) => void) | undefined;

  constructor(readonly inner: ProviderIdempotencyStore) {}

  async read(id: string) {
    this.reads.set(id, (this.reads.get(id) ?? 0) + 1);
    if (this.failReads) throw new Error("simulated SQLite read failure");
    return this.inner.read(id);
  }
  async write(record: ProviderOperationRecord) {
    return this.inner.write(record);
  }
  async transitionState(
    id: string,
    state: ProviderOperationState,
    updates?: Partial<Omit<ProviderOperationRecord, "agreementRootEventId" | "state">>,
  ) {
    return this.inner.transitionState(id, state, updates);
  }
  async countByState(state: ProviderOperationState) {
    return this.inner.countByState(state);
  }
  async listIncompleteAgreementRootEventIds() {
    return this.inner.listIncompleteAgreementRootEventIds();
  }
  async readPollCursor() {
    return this.inner.readPollCursor();
  }
  async writePollCursor(createdAt: number) {
    if (this.failCursorWrites) throw new Error("simulated SQLite write failure");
    await this.inner.writePollCursor(createdAt);
    this.cursorWrites.push(createdAt);
    this.onCursorWrite?.(createdAt);
  }
  close() {
    this.inner.close();
  }
}

function instrumented(path: string): InstrumentedStore {
  return new InstrumentedStore(createSqliteProviderIdempotencyStore(path));
}

function operationRecord(
  root: SignedNostrEvent,
  state: ProviderOperationState,
): ProviderOperationRecord {
  return {
    agreementRootEventId: root.id,
    agreementId: (JSON.parse(root.content) as { agreement_id: string }).agreement_id,
    requesterPublicKey: requesterSigner.publicKey,
    state,
    resultReference: undefined,
    resultSummary: undefined,
    acceptedTransitionEventId: undefined,
    taskDeliveredTransitionEventId: undefined,
    resultSubmittedTransitionEventId: undefined,
    createdAt: root.created_at,
    updatedAt: root.created_at,
    failureCode: undefined,
  };
}

async function seedStore(path: string, seed: (store: ProviderIdempotencyStore) => Promise<void>): Promise<void> {
  const store = createSqliteProviderIdempotencyStore(path);
  await seed(store);
  store.close();
}

function spamRoot(createdAt: number, index: number): SignedNostrEvent {
  // Addressed to the provider and validly signed, but its requester
  // definition does not exist, so it is rejected after discovery.
  return agreementRoot({ createdAt, label: `spam-${index}`, requesterSeed: SPAMMER_SEED });
}

function giftWraps(relay: StrfryLikeRelay): number {
  return relay.events.filter((event) => event.kind === 1059).length;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Issue #59 address-filtered polling", () => {
  it("queries only roots addressed to this provider, bounded by trusted time plus skew", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    await harness.service.start();
    await waitForPolls(harness.relay, 1);
    const first = harness.relay.rootPolls[0];
    expect(first.kinds).toEqual([PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND]);
    expect(first.tags).toEqual({ t: [PACT_SERVICE_AGREEMENT_ROOT_TYPE], p: [providerSigner.publicKey] });
    expect(first.since).toBe(now - OVERLAP);
    expect(first.until).toBe(now + SKEW);
    expect(first.limit).toBe(100);
  });

  it("ignores roots for other providers and mis-tagged roots even when the relay returns them", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    const foreign = agreementRoot({ createdAt: now, label: "unfiltered-foreign", provider: otherProviderPublicKey });
    const missingTag = agreementRoot({ createdAt: now, label: "missing-provider-tag", omitProviderTag: true });
    const wrongTag = agreementRoot({
      createdAt: now,
      label: "wrong-provider-tag",
      providerTagOverride: otherProviderPublicKey,
    });
    const contentForOther = agreementRoot({
      createdAt: now,
      label: "content-names-other",
      provider: otherProviderPublicKey,
      providerTagOverride: providerSigner.publicKey,
    });
    for (const event of [foreign, missingTag, wrongTag, contentForOther]) harness.relay.add(event);
    await harness.service.start();
    await waitForPolls(harness.relay, 2);
    // A misbehaving relay that ignores the filter changes nothing either.
    harness.relay.unfilteredRootPollEvents.push(foreign, missingTag, wrongTag, contentForOther);
    await waitForPolls(harness.relay, 2);
    for (const event of [foreign, missingTag, wrongTag, contentForOther]) {
      expect(await discovered(harness, event)).toBe(false);
      expect(acceptedTransitions(harness.relay, event)).toBe(0);
    }
    expect(await harness.store.readPollCursor()).toBe(now);
  });

  it("pages past more than 100 newer addressed spam roots to reach a legitimate root", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    const legitimate = agreementRoot({ createdAt: now - 100, label: "legit-under-addressed-spam" });
    harness.relay.add(legitimate);
    for (let index = 0; index < 250; index += 1) harness.relay.add(spamRoot(now - 90 + (index % 90), index));
    await harness.service.start();
    await waitFor(() => discovered(harness, legitimate), "the legitimate root under spam", 15_000);
    expect(acceptedTransitions(harness.relay, legitimate)).toBe(1);
    const untils = harness.relay.rootPolls.slice(0, 2).map((filter) => filter.until!);
    expect(untils[0]).toBe(now + SKEW);
    expect(untils[1]).toBeLessThan(untils[0]);
  });

  it("resumes a scan longer than one poll's page budget on the next poll", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    const legitimate = agreementRoot({ createdAt: now - 115, label: "legit-beyond-page-budget" });
    harness.relay.add(legitimate);
    for (let index = 0; index < 1_050; index += 1) harness.relay.add(spamRoot(now - 110 + (index % 110), index));
    await harness.service.start();
    await waitFor(() => discovered(harness, legitimate), "the legitimate root past ten pages", 60_000);
    expect(acceptedTransitions(harness.relay, legitimate)).toBe(1);
    // The cursor only moves once the whole window was covered.
    await waitFor(async () => (await harness.store.readPollCursor()) !== undefined, "the cursor write");
    expect(await harness.store.readPollCursor()).toBe(now);
  }, 90_000);

  it("steps past a second holding more than a page of roots instead of looping", async () => {
    const clock = { now: Math.floor(Date.now() / 1000) };
    const now = clock.now;
    const path = storePath();
    await seedStore(path, (store) => store.writePollCursor(now - 60));
    const harness = createHarness({ clock, path });
    const older = agreementRoot({ createdAt: now - 50, label: "legit-below-saturated-second" });
    harness.relay.add(older);
    for (let index = 0; index < 120; index += 1) harness.relay.add(spamRoot(now - 10, index));
    const log = vi.spyOn(console, "log");
    await harness.service.start();
    await waitFor(() => discovered(harness, older), "the root below the saturated second");
    await waitFor(async () => (await harness.store.readPollCursor()) === now - 10, "the cursor to pass the scan");
    expect(log.mock.calls.some(([line]) => String(line).includes("provider_poll_page_saturated"))).toBe(true);
    log.mockRestore();
  });
});

describe("Issue #59 bounded poll timestamps", () => {
  it("accepts roots at the current time, within the skew, and exactly at the skew boundary", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    const atNow = agreementRoot({ createdAt: now, label: "ts-now" });
    const withinSkew = agreementRoot({ createdAt: now + SKEW - 30, label: "ts-within-skew" });
    const atBoundary = agreementRoot({ createdAt: now + SKEW, label: "ts-boundary" });
    for (const event of [atNow, withinSkew, atBoundary]) harness.relay.add(event);
    await harness.service.start();
    for (const event of [atNow, withinSkew, atBoundary]) {
      await waitFor(() => discovered(harness, event), `root at ${event.created_at - now}s`);
    }
    await waitForPolls(harness.relay, 1);
    // Future roots are processed, but the cursor never passes trusted time.
    expect(await harness.store.readPollCursor()).toBe(now);
  });

  it("defers a root one second beyond the skew until the clock reaches it", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    const beyond = agreementRoot({ createdAt: now + SKEW + 1, label: "ts-beyond-skew" });
    harness.relay.add(beyond);
    await harness.service.start();
    await waitForPolls(harness.relay, 2);
    expect(await discovered(harness, beyond)).toBe(false);
    expect(await harness.store.readPollCursor()).toBe(now);

    harness.clock.now += 1;
    await waitFor(() => discovered(harness, beyond), "the deferred root once within skew");
  });

  it("never lets a far-future root move the cursor, even from a misbehaving relay", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    const farFuture = agreementRoot({ createdAt: now + 86_400, label: "ts-far-future" });
    harness.relay.add(farFuture);
    harness.relay.unfilteredRootPollEvents.push(farFuture);
    await harness.service.start();
    await waitForPolls(harness.relay, 2);
    expect(await discovered(harness, farFuture)).toBe(false);
    expect(await harness.store.readPollCursor()).toBe(now);

    const legitimate = agreementRoot({ createdAt: now + 5, label: "legit-after-far-future" });
    harness.relay.add(legitimate);
    await waitFor(() => discovered(harness, legitimate), "the legitimate root");
    await waitForPolls(harness.relay, 1);
    expect(await harness.store.readPollCursor()).toBe(now);
  });

  it("re-scans from trusted time when the clock moves backward", async () => {
    const harness = createHarness();
    const start = harness.clock.now;
    const first = agreementRoot({ createdAt: start, label: "clock-before-step" });
    harness.relay.add(first);
    await harness.service.start();
    await waitFor(() => discovered(harness, first), "the first root");
    await waitForPolls(harness.relay, 1);
    expect(await harness.store.readPollCursor()).toBe(start);

    harness.clock.now = start - 3_600;
    const afterStep = agreementRoot({ createdAt: harness.clock.now, label: "clock-after-step" });
    harness.relay.add(afterStep);
    await waitFor(() => discovered(harness, afterStep), "the root created after the clock stepped back");
    await waitForPolls(harness.relay, 1);
    expect(await harness.store.readPollCursor()).toBe(harness.clock.now);
    expect(harness.relay.rootPolls.at(-1)!.since).toBe(harness.clock.now - OVERLAP);
    expect(acceptedTransitions(harness.relay, first)).toBe(1);
  });

  it("pulls a persisted cursor that is ahead of the clock back to trusted time", async () => {
    const clock = { now: Math.floor(Date.now() / 1000) };
    const path = storePath();
    await seedStore(path, (store) => store.writePollCursor(clock.now + 86_400));
    const harness = createHarness({ clock, path });
    const legitimate = agreementRoot({ createdAt: clock.now, label: "legit-after-future-cursor" });
    harness.relay.add(legitimate);
    await harness.service.start();
    await waitFor(() => discovered(harness, legitimate), "the legitimate root");
    expect(harness.relay.rootPolls[0].since).toBe(clock.now - OVERLAP);
    await waitForPolls(harness.relay, 1);
    expect(await harness.store.readPollCursor()).toBe(clock.now);
  });

  it("discovers a root delivered late and out of order inside the overlap window", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    const newer = agreementRoot({ createdAt: now, label: "order-newer" });
    harness.relay.add(newer);
    await harness.service.start();
    await waitFor(() => discovered(harness, newer), "the newer root");
    await waitForPolls(harness.relay, 1);

    harness.clock.now += 10;
    const lateOlder = agreementRoot({ createdAt: now - OVERLAP + 5, label: "order-late-older" });
    harness.relay.add(lateOlder);
    await waitFor(() => discovered(harness, lateOlder), "the late older root");
    expect(acceptedTransitions(harness.relay, newer)).toBe(1);
    expect(acceptedTransitions(harness.relay, lateOlder)).toBe(1);
  });

  it("documents the limit: a root reaching the relay more than the overlap behind the cursor is not polled", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    const newer = agreementRoot({ createdAt: now, label: "limit-newer" });
    harness.relay.add(newer);
    await harness.service.start();
    await waitFor(() => discovered(harness, newer), "the newer root");
    await waitForPolls(harness.relay, 1);

    const tooLate = agreementRoot({ createdAt: now - OVERLAP - 1, label: "limit-too-late" });
    harness.relay.add(tooLate);
    await waitForPolls(harness.relay, 3);
    expect(await discovered(harness, tooLate)).toBe(false);
  });
});

describe("Issue #59 durable poll cursor", () => {
  it("starts a store without a cursor at trusted time and persists it after the first scan", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    await harness.service.start();
    await waitForPolls(harness.relay, 1);
    expect(harness.relay.rootPolls[0].since).toBe(now - OVERLAP);
    expect(await harness.store.readPollCursor()).toBe(now);
  });

  it("resumes from the persisted cursor after a restart and re-scans the overlap window", async () => {
    const relay = new StrfryLikeRelay();
    const clock = { now: Math.floor(Date.now() / 1000) };
    const path = storePath();
    const firstRoot = agreementRoot({ createdAt: clock.now, label: "resume-first" });
    relay.add(firstRoot);
    const first = createHarness({ relay, clock, path });
    await first.service.start();
    await waitFor(() => discovered(first, firstRoot), "the first root");
    await waitForPolls(relay, 1);
    await stopHarness(first);
    const cursor = clock.now;

    clock.now += 60;
    const store = instrumented(path);
    const second = createHarness({ relay, clock, path, store });
    const pollsBefore = relay.rootPolls.length;
    await second.service.start();
    await waitForPolls(relay, 1);
    expect(relay.rootPolls[pollsBefore].since).toBe(cursor - OVERLAP);
    // The first root is re-observed in the overlap and recovered once, not re-accepted.
    expect(store.reads.get(firstRoot.id)).toBe(1);
    expect(acceptedTransitions(relay, firstRoot)).toBe(1);
  });

  it("does not move the cursor while root polls fail, and resumes from it after a restart", async () => {
    const relay = new StrfryLikeRelay();
    const clock = { now: Math.floor(Date.now() / 1000) };
    const path = storePath();
    const cursor = clock.now - 30;
    await seedStore(path, (store) => store.writePollCursor(cursor));
    relay.failRootPolls = 1_000;
    const first = createHarness({ relay, clock, path });
    await first.service.start();
    clock.now += 300;
    await waitForPolls(relay, 3);
    expect((await first.service.readiness()).pollHealthy).toBe(false);
    expect(await first.store.readPollCursor()).toBe(cursor);
    await stopHarness(first);

    relay.failRootPolls = 0;
    const missed = agreementRoot({ createdAt: cursor + 10, label: "after-poll-failure" });
    relay.add(missed);
    const second = createHarness({ relay, clock, path });
    await second.service.start();
    await waitFor(() => discovered(second, missed), "the root published during the outage");
    expect(relay.rootPolls.at(-1)!.since).toBeLessThanOrEqual(missed.created_at);
  });

  it("does not report progress when the cursor cannot be written, and loses nothing on restart", async () => {
    const relay = new StrfryLikeRelay();
    const clock = { now: Math.floor(Date.now() / 1000) };
    const path = storePath();
    await seedStore(path, (store) => store.writePollCursor(clock.now - 10));
    const store = instrumented(path);
    store.failCursorWrites = true;
    const first = createHarness({ relay, clock, path, store });
    const root = agreementRoot({ createdAt: clock.now, label: "cursor-write-failure" });
    relay.add(root);
    await first.service.start();
    await waitFor(() => discovered(first, root), "the root");
    await waitForPolls(relay, 1);
    expect((await first.service.readiness()).pollHealthy).toBe(false);
    expect(await store.readPollCursor()).toBe(clock.now - 10);
    await stopHarness(first);

    // Restart after processing but before the cursor was persisted.
    const reopened = instrumented(path);
    const second = createHarness({ relay, clock, path, store: reopened });
    await second.service.start();
    await waitForPolls(relay, 1);
    expect(await reopened.readPollCursor()).toBe(clock.now);
    expect(reopened.reads.get(root.id)).toBe(1);
    expect(acceptedTransitions(relay, root)).toBe(1);
  });

  it("fails closed on a corrupt persisted cursor and resumes once it is repaired", async () => {
    const clock = { now: Math.floor(Date.now() / 1000) };
    const path = storePath();
    createSqliteProviderIdempotencyStore(path).close();
    const database = new DatabaseSync(path);
    database
      .prepare("INSERT INTO pact_provider_metadata (key, value_json, updated_at) VALUES ('agreement_poll_cursor', ?, 0)")
      .run("{corrupt");
    database.close();

    const harness = createHarness({ clock, path });
    const root = agreementRoot({ createdAt: clock.now, label: "after-corrupt-cursor" });
    harness.relay.add(root);
    await harness.service.start();
    await sleep(500);
    expect(harness.relay.rootPolls).toHaveLength(0);
    expect(await discovered(harness, root)).toBe(false);
    const readiness = await harness.service.readiness();
    expect(readiness.pollHealthy).toBe(false);
    expect(readiness.protocolReady).toBe(false);

    const repair = new DatabaseSync(path);
    repair
      .prepare("UPDATE pact_provider_metadata SET value_json = ? WHERE key = 'agreement_poll_cursor'")
      .run(JSON.stringify({ version: 1, created_at: clock.now - 60 }));
    repair.close();
    await waitFor(() => discovered(harness, root), "the root after the cursor was repaired");
    expect(harness.relay.rootPolls[0].since).toBe(clock.now - 60 - OVERLAP);
  });
});

describe("Issue #59 polling idempotency across windows and restarts", () => {
  it("handles a root once across overlapping inclusive windows and duplicate deliveries", async () => {
    const path = storePath();
    const store = instrumented(path);
    const harness = createHarness({ path, store });
    const root = agreementRoot({ createdAt: harness.clock.now, label: "duplicate-delivery" });
    harness.relay.add(root);
    harness.relay.unfilteredRootPollEvents.push(root, root);
    await harness.service.start();
    await waitFor(() => discovered(harness, root), "the root");
    harness.clock.now += 5;
    await waitForPolls(harness.relay, 4);
    expect(store.reads.get(root.id)).toBe(1);
    expect(acceptedTransitions(harness.relay, root)).toBe(1);
  });

  it("recovers an in-flight record whose root is older than the persisted window", async () => {
    const relay = new StrfryLikeRelay();
    const clock = { now: Math.floor(Date.now() / 1000) };
    const path = storePath();
    const old = agreementRoot({ createdAt: clock.now - 400, label: "recover-received-outside-window" });
    relay.add(old);
    await seedStore(path, async (store) => {
      await store.write(operationRecord(old, "received"));
      await store.writePollCursor(clock.now);
    });
    const harness = createHarness({ relay, clock, path });
    await harness.service.start();
    await waitFor(() => acceptedTransitions(relay, old) === 1, "the in-flight agreement to be accepted");
    expect(relay.rootPolls[0].since).toBe(clock.now - OVERLAP);
    expect(relay.idQueries.some((filter) => filter.ids?.includes(old.id))).toBe(true);
    await waitForPolls(relay, 2);
    expect(acceptedTransitions(relay, old)).toBe(1);
    expect((await harness.store.read(old.id))?.state).toBe("waiting_for_funding");
  });

  it("does not handle a root twice when it is both in the restart sweep and the poll window", async () => {
    const relay = new StrfryLikeRelay();
    const clock = { now: Math.floor(Date.now() / 1000) };
    const path = storePath();
    const root = agreementRoot({ createdAt: clock.now - 10, label: "sweep-and-window" });
    relay.add(root);
    await seedStore(path, (store) => store.write(operationRecord(root, "received")));
    const store = instrumented(path);
    const harness = createHarness({ relay, clock, path, store });
    await harness.service.start();
    await waitForPolls(relay, 2);
    expect(store.reads.get(root.id)).toBe(1);
    expect(acceptedTransitions(relay, root)).toBe(1);
  });

  it("does not re-execute or re-publish after a restart in processing or result_published", async () => {
    const relay = new StrfryLikeRelay();
    const clock = { now: Math.floor(Date.now() / 1000) };
    const path = storePath();
    const processing = agreementRoot({ createdAt: clock.now - 300, label: "restart-processing" });
    const published = agreementRoot({ createdAt: clock.now - 300, label: "restart-result-published" });
    const complete = agreementRoot({ createdAt: clock.now - 300, label: "restart-complete" });
    for (const event of [processing, published, complete]) relay.add(event);
    await seedStore(path, async (store) => {
      await store.write(operationRecord(processing, "processing"));
      await store.write(operationRecord(published, "result_published"));
      await store.write(operationRecord(complete, "complete"));
      await store.writePollCursor(clock.now);
    });
    const store = instrumented(path);
    const harness = createHarness({ relay, clock, path, store });
    await harness.service.start();
    await waitFor(() => (store.reads.get(published.id) ?? 0) > 0, "the sweep to reach the records");
    await waitForPolls(relay, 2);
    expect(store.reads.get(processing.id)).toBe(1);
    expect(store.reads.get(published.id)).toBe(1);
    // Complete records are not part of the restart sweep.
    expect(store.reads.get(complete.id)).toBeUndefined();
    expect(giftWraps(relay)).toBe(0);
    for (const event of [processing, published, complete]) expect(acceptedTransitions(relay, event)).toBe(0);
  });
});

describe("Issue #59 polling reliability", () => {
  it("does not poll or move the cursor while the relay is disconnected, then catches up", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    await harness.service.start();
    await waitForPolls(harness.relay, 1);
    harness.relay.reconnectFails = true;
    // Let any poll already in flight finish before counting.
    await sleep(200);
    const polls = harness.relay.rootPolls.length;
    harness.clock.now += 30;
    const root = agreementRoot({ createdAt: harness.clock.now, label: "during-disconnect" });
    harness.relay.add(root);
    await sleep(400);
    expect(harness.relay.rootPolls.length).toBe(polls);
    expect((await harness.service.readiness()).pollHealthy).toBe(false);
    expect(await harness.store.readPollCursor()).toBe(now);

    harness.relay.reconnectFails = false;
    await waitFor(() => discovered(harness, root), "the root after reconnection");
  });

  it("keeps the cursor on a query timeout and processes the root once the relay answers", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    harness.relay.failRootPolls = 3;
    harness.relay.failRootPollsWith = "timeout";
    const root = agreementRoot({ createdAt: now, label: "after-timeout" });
    harness.relay.add(root);
    await harness.service.start();
    await waitFor(() => discovered(harness, root), "the root after timeouts");
    expect(harness.relay.rootPolls.slice(0, 4).every((filter) => filter.since === now - OVERLAP)).toBe(true);
  });

  it("keeps the cursor still when polls return nothing", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    await harness.service.start();
    await waitForPolls(harness.relay, 1);
    harness.clock.now += 1_000;
    await waitForPolls(harness.relay, 2);
    expect(await harness.store.readPollCursor()).toBe(now);
    expect(harness.relay.rootPolls.at(-1)!.since).toBe(now - OVERLAP);
  });

  it("ignores malformed events and invalid signatures without losing a legitimate root", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    const legitimate = agreementRoot({ createdAt: now, label: "beside-malformed" });
    const victim = agreementRoot({ createdAt: now + 1, label: "tampered" });
    const tampered = { ...victim, content: victim.content.replace("350", "999") } as SignedNostrEvent;
    harness.relay.add(legitimate);
    harness.relay.malformedRootPollEvents.push(null, 42, { id: "x".repeat(64) }, { ...legitimate, sig: "00" });
    harness.relay.unfilteredRootPollEvents.push(tampered);
    await harness.service.start();
    await waitFor(() => discovered(harness, legitimate), "the legitimate root");
    await waitForPolls(harness.relay, 1);
    expect(await discovered(harness, tampered)).toBe(false);
    expect(acceptedTransitions(harness.relay, legitimate)).toBe(1);
    expect(await harness.store.readPollCursor()).toBe(now);
  });

  it("processes a burst of legitimate roots exactly once each", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    const burst = Array.from({ length: 6 }, (_, index) =>
      agreementRoot({ createdAt: now - 5 + index, label: `burst-${index}` }),
    );
    await harness.service.start();
    for (const event of burst) harness.relay.add(event);
    for (const event of burst) await waitFor(() => discovered(harness, event), `burst root ${event.created_at}`);
    harness.clock.now += 5;
    await waitForPolls(harness.relay, 2);
    for (const event of burst) expect(acceptedTransitions(harness.relay, event)).toBe(1);
  });

  it("holds the cursor and retries a root whose requester definition fetch failed transiently", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    await harness.service.start();
    await waitForPolls(harness.relay, 1);

    harness.clock.now += 50;
    const root = agreementRoot({ createdAt: harness.clock.now, label: "transient-definition" });
    harness.relay.failDefinitionQueries = 2;
    harness.relay.add(root);
    await waitFor(() => harness.relay.failDefinitionQueries === 0, "the transient failures to be consumed");
    // While the root is retrying, the cursor may not pass it.
    expect((await harness.store.readPollCursor())!).toBeLessThanOrEqual(root.created_at);
    await waitFor(() => discovered(harness, root), "the retried root");
    await waitForPolls(harness.relay, 1);
    expect(acceptedTransitions(harness.relay, root)).toBe(1);
    expect(await harness.store.readPollCursor()).toBe(now + 50);
  });

  it("stops letting a root that keeps failing hold the cursor after the retry budget", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    await harness.service.start();
    await waitForPolls(harness.relay, 1);

    harness.clock.now += 50;
    // An author-provoked failure: every fetch of its requester definition fails.
    const stuck = agreementRoot({ createdAt: harness.clock.now, label: "always-failing-definition" });
    harness.relay.failDefinitionQueries = 1_000;
    const log = vi.spyOn(console, "log");
    harness.relay.add(stuck);
    await waitFor(
      () => log.mock.calls.some(([line]) => String(line).includes("provider_agreement_retry_exhausted")),
      "the retry budget to be exhausted",
    );
    const remaining = harness.relay.failDefinitionQueries;
    await waitForPolls(harness.relay, 2);
    log.mockRestore();
    // Three attempts, then no more fetches and the cursor moves past it.
    expect(1_000 - remaining).toBe(3);
    expect(harness.relay.failDefinitionQueries).toBe(remaining);
    expect(await harness.store.readPollCursor()).toBe(now + 50);
  });

  it("holds the cursor without a retry budget while the local store is failing", async () => {
    const path = storePath();
    const store = instrumented(path);
    const harness = createHarness({ path, store });
    const now = harness.clock.now;
    await harness.service.start();
    await waitForPolls(harness.relay, 1);

    harness.clock.now += 50;
    const root = agreementRoot({ createdAt: harness.clock.now, label: "store-outage" });
    store.failReads = true;
    harness.relay.add(root);
    await waitFor(() => (store.reads.get(root.id) ?? 0) >= 5, "several attempts during the outage");
    expect(await store.readPollCursor()).toBe(now);
    store.failReads = false;
    await waitFor(() => discovered(harness, root), "the root after the store recovered");
    expect(acceptedTransitions(harness.relay, root)).toBe(1);
  });

  it("persists the starting cursor before the first scan, so an outage then a restart loses nothing", async () => {
    const relay = new StrfryLikeRelay();
    const clock = { now: Math.floor(Date.now() / 1000) };
    const start = clock.now;
    const path = storePath();
    relay.failRootPolls = 1_000;
    const first = createHarness({ relay, clock, path });
    await first.service.start();
    await waitForPolls(relay, 2);
    expect(await first.store.readPollCursor()).toBe(start);
    await stopHarness(first);

    clock.now += 600;
    relay.failRootPolls = 0;
    const duringOutage = agreementRoot({ createdAt: start + 30, label: "published-during-outage" });
    relay.add(duringOutage);
    const second = createHarness({ relay, clock, path });
    const pollsBefore = relay.rootPolls.length;
    await second.service.start();
    await waitFor(() => discovered(second, duringOutage), "the root published during the outage");
    expect(relay.rootPolls[pollsBefore].since).toBe(start - OVERLAP);
  });
});

describe("Issue #59 cursor advancement", () => {
  const SECOND_REQUESTER_SEED = 66;

  it("advances a previously persisted cursor as trusted time moves forward", async () => {
    const clock = { now: Math.floor(Date.now() / 1000) };
    const start = clock.now;
    const persisted = start - 600;
    const path = storePath();
    await seedStore(path, (store) => store.writePollCursor(persisted));
    const store = instrumented(path);
    const harness = createHarness({ clock, path, store });
    const older = agreementRoot({ createdAt: start - 300, label: "advance-older" });
    const newer = agreementRoot({ createdAt: start - 5, label: "advance-newer" });
    harness.relay.add(older);
    harness.relay.add(newer);
    await harness.service.start();
    await waitFor(() => store.cursorWrites.length === 1, "the first advance");
    // The first scan read the persisted window, then moved to the newest root.
    expect(harness.relay.rootPolls[0].since).toBe(persisted - OVERLAP);
    expect(store.cursorWrites).toEqual([start - 5]);
    expect(await discovered(harness, older)).toBe(true);
    await waitForPolls(harness.relay, 1);
    expect(harness.relay.rootPolls.at(-1)!.since).toBe(start - 5 - OVERLAP);

    // Trusted time moves forward and a newer root arrives.
    clock.now = start + 100;
    const later = agreementRoot({ createdAt: start + 90, label: "advance-later" });
    harness.relay.add(later);
    await waitFor(() => store.cursorWrites.length === 2, "the second advance");
    expect(store.cursorWrites).toEqual([start - 5, start + 90]);
    await waitForPolls(harness.relay, 1);
    expect(harness.relay.rootPolls.at(-1)!.since).toBe(start + 90 - OVERLAP);

    // Without new roots the cursor stays at the newest root seen (the issue's
    // min(now, maxAcceptedCreatedAt)); it does not jump to wall-clock time.
    clock.now = start + 5_000;
    await waitForPolls(harness.relay, 3);
    expect(store.cursorWrites).toEqual([start - 5, start + 90]);
    for (const event of [older, newer, later]) expect(acceptedTransitions(harness.relay, event)).toBe(1);
  });

  it("writes nothing until the last page of a scan that spans several polls", async () => {
    const clock = { now: Math.floor(Date.now() / 1000) };
    const now = clock.now;
    const path = storePath();
    await seedStore(path, (store) => store.writePollCursor(now - 200));
    const store = instrumented(path);
    const harness = createHarness({ clock, path, store });
    const rootPollsAtWrite: number[] = [];
    store.onCursorWrite = () => rootPollsAtWrite.push(harness.relay.rootPolls.length);
    const legitimate = agreementRoot({ createdAt: now - 115, label: "advance-after-long-scan" });
    harness.relay.add(legitimate);
    for (let index = 0; index < 1_050; index += 1) harness.relay.add(spamRoot(now - 110 + (index % 110), index));
    await harness.service.start();
    await waitFor(() => store.cursorWrites.length === 1, "the cursor write after the scan", 60_000);
    // 1,051 roots need 11 pages; one poll fetches 10, so the write follows page 11.
    expect(rootPollsAtWrite[0]).toBeGreaterThanOrEqual(11);
    expect(store.cursorWrites).toEqual([now - 1]);
    expect(await discovered(harness, legitimate)).toBe(true);
  }, 90_000);

  it("keeps the cursor below an older root that is still retrying while a newer root succeeds", async () => {
    const clock = { now: Math.floor(Date.now() / 1000) };
    const now = clock.now;
    const path = storePath();
    await seedStore(path, (store) => store.writePollCursor(now - 60));
    const store = instrumented(path);
    const harness = createHarness({ clock, path, store });
    harness.relay.add(requesterDefinitionEvent(now - 3_600, SECOND_REQUESTER_SEED));
    const retrying = agreementRoot({
      createdAt: now - 30,
      label: "advance-retrying",
      requesterSeed: SECOND_REQUESTER_SEED,
    });
    const succeeding = agreementRoot({ createdAt: now - 10, label: "advance-succeeding" });
    harness.relay.add(retrying);
    harness.relay.add(succeeding);
    harness.relay.failDefinitionAuthor = retrying.pubkey;
    harness.relay.failDefinitionQueries = 1;
    await harness.service.start();
    await waitFor(() => store.cursorWrites.length === 2, "both advances");
    // First scan: the newer root was handled but the older one must be retried.
    expect(store.cursorWrites).toEqual([now - 30, now - 10]);
    expect(acceptedTransitions(harness.relay, retrying)).toBe(1);
    expect(acceptedTransitions(harness.relay, succeeding)).toBe(1);
  });

  it("retries a failed page with the same bounds and only advances once the scan completes", async () => {
    const clock = { now: Math.floor(Date.now() / 1000) };
    const now = clock.now;
    const path = storePath();
    await seedStore(path, (store) => store.writePollCursor(now - 200));
    const store = instrumented(path);
    const harness = createHarness({ clock, path, store });
    const legitimate = agreementRoot({ createdAt: now - 100, label: "advance-after-page-error" });
    harness.relay.add(legitimate);
    for (let index = 0; index < 150; index += 1) harness.relay.add(spamRoot(now - 90 + (index % 90), index));
    harness.relay.failRootPollIndex = 1;
    const rootPollsAtWrite: number[] = [];
    store.onCursorWrite = () => rootPollsAtWrite.push(harness.relay.rootPolls.length);
    await harness.service.start();
    await waitFor(() => store.cursorWrites.length === 1, "the advance after the retried page");
    const [first, failed, retried] = harness.relay.rootPolls;
    expect(failed.until).toBeLessThan(first.until!);
    expect(retried.since).toBe(failed.since);
    expect(retried.until).toBe(failed.until);
    expect(rootPollsAtWrite[0]).toBe(3);
    expect(store.cursorWrites).toEqual([now - 1]);
    expect(await discovered(harness, legitimate)).toBe(true);
  });

  it("re-scanning an idle window repeats a bounded query and never re-handles roots", async () => {
    const harness = createHarness();
    const now = harness.clock.now;
    for (let index = 0; index < 150; index += 1) harness.relay.add(spamRoot(now - 90 + (index % 90), index));
    await harness.service.start();
    await waitForPolls(harness.relay, 4);
    const definitionQueries = harness.relay.definitionQueries;
    expect(definitionQueries).toBe(150);

    const pollsBefore = harness.relay.rootPolls.length;
    for (let step = 1; step <= 5; step += 1) {
      harness.clock.now = now + step * 10_000;
      await waitForPolls(harness.relay, 2);
    }
    const idlePolls = harness.relay.rootPolls.slice(pollsBefore);
    // A scan's first page asks up to now + skew; the 150-root window always
    // needs exactly two pages, however long the provider has been idle.
    const scanStarts = idlePolls.filter((filter, index) =>
      index > 0 && filter.until! > idlePolls[index - 1].until!,
    ).length;
    expect(scanStarts).toBeGreaterThanOrEqual(4);
    expect(idlePolls.length).toBeLessThanOrEqual(2 * (scanStarts + 1));
    expect(new Set(idlePolls.map((filter) => filter.since)).size).toBe(1);
    // No root was handled again: no further requester-definition lookups.
    expect(harness.relay.definitionQueries).toBe(definitionQueries);

    // After a long idle period a new root is still found in the next scan.
    const fresh = agreementRoot({ createdAt: harness.clock.now, label: "after-idle" });
    harness.relay.add(fresh);
    await waitFor(() => discovered(harness, fresh), "a root after a long idle period");
  });
});
