import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createNostrIdentity,
  nostrPublicKey,
  type NostrPublicKey,
  type NostrSigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "../domain/nostr";
import { sats, type Sats } from "../domain/money";
import type { RequesterPolicy } from "../domain/pact-agents";
import { createPontmoreAgentDefinition } from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  createPactServiceOffer,
  PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
} from "../domain/pact-service-offer";
import type { NostrFilter, NostrRelayAdapter } from "./nostr-relay";
import { signAndPublishPactServiceOffer } from "./pact-service-offer-publication";
import { signAndPublishAgentDefinition } from "./pontmore-agent-publication";
import { signAndPublishCashuEscrowDescriptor } from "./pontmore-escrow-publication";
import { discoverProviders, DiscoveryError } from "./provider-discovery";
import { publishRuntimeBootstrapArtifacts } from "./pactagent-runtime.live";
import {
  createRuntimeRequesterPolicy,
  type PactAgentHostedRuntimeConfig,
  type PactAgentLiveDemoConfig,
} from "./pactagent-workflow.live";

/*
 * Issue #60: the requester workflow executes against one configured provider
 * identity, so discovery must only select providers the requester's trusted
 * configuration allows. A cheaper or faster provider that is not allowed must
 * never be selected, and its signed artifacts must not be treated as
 * authorization.
 */

const NOW = 1_900_000_000;
const RELAY_URL = "wss://relay.example";

function secretKey(seed: number): Uint8Array {
  const value = new Uint8Array(32);
  value[31] = seed;
  return value;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function testSigner(seed: number): NostrSigner {
  const secret = secretKey(seed);
  const publicKey = getPublicKey(secret);
  return {
    publicKey: nostrPublicKey(publicKey),
    async sign(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
      if (event.pubkey !== publicKey) throw new Error("test signer identity mismatch");
      const signed = finalizeEvent(
        { created_at: event.created_at, kind: event.kind, tags: event.tags.map((tag) => [...tag]), content: event.content },
        secret,
      );
      return { ...signed, pubkey: nostrPublicKey(signed.pubkey), tags: event.tags };
    },
  };
}

class MemoryRelay implements NostrRelayAdapter {
  readonly url = RELAY_URL;
  readonly published: SignedNostrEvent[] = [];
  readonly filters: NostrFilter[] = [];
  /** A misbehaving relay that ignores the `authors` filter on provider-profile discovery. */
  ignoreAuthors = false;

  async connect(): Promise<void> {}
  async reconnect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async publish(event: SignedNostrEvent): Promise<void> {
    this.published.push(event);
  }
  async queryEvents(filter: NostrFilter): Promise<SignedNostrEvent[]> {
    this.filters.push(filter);
    const profileDiscovery = filter.kinds?.includes(30360) === true && filter.tags?.t !== undefined;
    const ignoreAuthors = this.ignoreAuthors && profileDiscovery;
    const matches = this.published
      .filter((event) => {
        if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
        if (!ignoreAuthors && filter.authors && !filter.authors.includes(event.pubkey)) return false;
        if (filter.ids && !filter.ids.includes(event.id)) return false;
        if (filter.since !== undefined && event.created_at < filter.since) return false;
        if (filter.until !== undefined && event.created_at > filter.until) return false;
        return !filter.tags || Object.entries(filter.tags).every(([name, values]) =>
          event.tags.some((tag) => tag[0] === name && values.includes(tag[1])),
        );
      })
      .sort((left, right) => right.created_at - left.created_at);
    return filter.limit === undefined ? matches : matches.slice(0, filter.limit);
  }
}

interface ProviderOptions {
  readonly amountSats?: Sats;
  readonly maximumExecutionSeconds?: number;
  /** Points the signed definition at another provider's offer. */
  readonly pricingPolicyReference?: string;
}

/** Publishes a complete, validly signed provider: escrow descriptor, offer, definition. */
async function publishProvider(relay: MemoryRelay, seed: number, options: ProviderOptions = {}): Promise<NostrPublicKey> {
  const signer = testSigner(seed);
  const identity = createNostrIdentity(signer.publicKey, [RELAY_URL]);
  const descriptor = createCashuEscrowDescriptor({
    identity,
    identifier: "allowlist-escrow",
    updatedAt: NOW - 60,
    referenceFormat: "opaque_service_reference",
    timeoutSeconds: 900,
  });
  const offer = createPactServiceOffer({
    identity,
    identifier: "allowlist-offer",
    capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
    amountSats: options.amountSats ?? sats(350n),
    settlementNetwork: "cashu",
    escrowDescriptorReference: descriptor.address,
    maximumExecutionSeconds: options.maximumExecutionSeconds ?? 120,
    validFrom: NOW - 60,
    expiresAt: NOW + 3_600,
    updatedAt: NOW - 60,
  });
  const definition = createPontmoreAgentDefinition({
    identity,
    identifier: "allowlist-provider",
    name: "Provider",
    about: "Provides the bounded document-summary service.",
    capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
    pricingPolicyReference: options.pricingPolicyReference ?? offer.address,
    escrowDescriptorReference: descriptor.address,
    updatedAt: NOW - 60,
  });
  await signAndPublishCashuEscrowDescriptor(descriptor, signer, relay);
  await signAndPublishPactServiceOffer(offer, signer, relay);
  await signAndPublishAgentDefinition(definition, signer, relay);
  return signer.publicKey;
}

const PROVIDER_A_SEED = 2;
const PROVIDER_B_SEED = 5;
const providerA = testSigner(PROVIDER_A_SEED).publicKey;

function policy(allowedProviders: readonly string[]): RequesterPolicy {
  return {
    maxBudgetSats: sats(500n),
    allowedCapabilities: ["document-summary"],
    maximumEscrowDurationSeconds: 15 * 60,
    maximumProviderPriceSats: sats(450n),
    allowedSettlementNetworks: ["cashu"],
    autoRelease: "deterministic_checks_only",
    allowedProviders: allowedProviders as readonly NostrPublicKey[],
  };
}

describe("Issue #60 reproduction: discovery selects only allowed providers", () => {
  it("selects the allowed provider over a cheaper, faster provider that is not allowed", async () => {
    const relay = new MemoryRelay();
    await publishProvider(relay, PROVIDER_A_SEED);
    const providerB = await publishProvider(relay, PROVIDER_B_SEED, {
      amountSats: sats(300n),
      maximumExecutionSeconds: 60,
    });
    const result = await discoverProviders({
      requesterPolicy: policy([providerA]),
      capability: "document-summary",
      relay,
      now: NOW,
    });
    expect(result.selected?.selected.providerPublicKey).toBe(providerA);
    expect(result.candidates.map((candidate) => candidate.providerPublicKey)).toEqual([providerA]);
    expect(result.candidates.some((candidate) => candidate.providerPublicKey === providerB)).toBe(false);
  });

  it("hosted bootstrap selects the configured provider when a cheaper provider is also published", async () => {
    const relay = new MemoryRelay();
    await publishProvider(relay, PROVIDER_A_SEED);
    await publishProvider(relay, PROVIDER_B_SEED, { amountSats: sats(300n), maximumExecutionSeconds: 60 });
    const config: PactAgentHostedRuntimeConfig = {
      economicMode: "live",
      relayUrl: RELAY_URL,
      requesterPrivateKeyHex: hex(secretKey(31)),
      providerPublicKeyHex: providerA,
      escrowAuthorityPrivateKeyHex: hex(secretKey(33)),
      externalProvider: true,
      economicConfig: {
        mintUrl: "https://testmint.example/cashu",
        stateDirectory: ".not-used",
        normalSpendKeyHex: hex(secretKey(21)),
        refundSpendKeyHex: hex(secretKey(22)),
        fundingToken: "cashuA_not-used-by-bootstrap",
        fundingReference: "funding-reference-allowlist",
      },
    };
    const published = await publishRuntimeBootstrapArtifacts(config, relay, NOW);
    expect(published.selectedReferences.providerPublicKey).toBe(providerA);
  });
});

const PROVIDER_C_SEED = 7;

function discover(relay: MemoryRelay, allowed: readonly string[], bounds?: { maxResolutions?: number }) {
  return discoverProviders({
    requesterPolicy: policy(allowed),
    capability: "document-summary",
    relay,
    now: NOW,
    ...(bounds === undefined ? {} : { bounds }),
  });
}

/** Offer and descriptor lookups the relay saw for one provider (resolution work). */
function resolutionQueries(relay: MemoryRelay, provider: string): number {
  return relay.filters.filter((filter) =>
    filter.kinds?.some((kind) => kind !== 30360) && (filter.authors ?? []).includes(provider),
  ).length;
}

describe("Issue #60 discovery allowlist", () => {
  it("selects the allowed provider normally when it is the only one", async () => {
    const relay = new MemoryRelay();
    await publishProvider(relay, PROVIDER_A_SEED);
    const result = await discover(relay, [providerA]);
    expect(result.selected?.selected.providerPublicKey).toBe(providerA);
    expect(result.selected?.selected.offerReference).toBe(`30400:${providerA}:allowlist-offer`);
  });

  it("asks the relay only for allowed authors", async () => {
    const relay = new MemoryRelay();
    await publishProvider(relay, PROVIDER_A_SEED);
    await discover(relay, [providerA]);
    const profileQueries = relay.filters.filter((filter) => filter.kinds?.includes(30360) && filter.tags?.t);
    expect(profileQueries.length).toBeGreaterThan(0);
    for (const filter of profileQueries) expect(filter.authors).toEqual([providerA]);
  });

  it.each([
    ["cheaper", { amountSats: sats(300n) }],
    ["faster", { maximumExecutionSeconds: 30 }],
    ["cheaper and faster", { amountSats: sats(300n), maximumExecutionSeconds: 30 }],
  ] as const)("rejects a %s provider that is not allowed, even from a relay that ignores the author filter", async (_label, options) => {
    const relay = new MemoryRelay();
    relay.ignoreAuthors = true;
    await publishProvider(relay, PROVIDER_A_SEED);
    const providerB = await publishProvider(relay, PROVIDER_B_SEED, options);
    const result = await discover(relay, [providerA]);
    expect(result.selected?.selected.providerPublicKey).toBe(providerA);
    expect(result.candidates.map((candidate) => candidate.providerPublicKey)).toEqual([providerA]);
    expect(result.rejections).toContainEqual(expect.objectContaining({
      providerPublicKey: providerB,
      category: "provider_not_allowed",
    }));
    // Its validly signed offer and descriptor are never even fetched.
    expect(resolutionQueries(relay, providerB)).toBe(0);
  });

  it("returns no selection, and no fallback, when only providers that are not allowed exist", async () => {
    const relay = new MemoryRelay();
    relay.ignoreAuthors = true;
    await publishProvider(relay, PROVIDER_B_SEED, { amountSats: sats(300n) });
    await publishProvider(relay, PROVIDER_C_SEED, { amountSats: sats(320n) });
    const result = await discover(relay, [providerA]);
    expect(result.selected).toBeUndefined();
    expect(result.candidates).toEqual([]);
    expect(result.rejections.filter((entry) => entry.category === "provider_not_allowed")).toHaveLength(2);
  });

  it("ranks several allowed providers by the unchanged price, duration and key order", async () => {
    const relay = new MemoryRelay();
    await publishProvider(relay, PROVIDER_A_SEED, { amountSats: sats(350n) });
    const providerC = await publishProvider(relay, PROVIDER_C_SEED, { amountSats: sats(340n) });
    await publishProvider(relay, PROVIDER_B_SEED, { amountSats: sats(300n) });
    const result = await discover(relay, [providerA, providerC]);
    expect(result.selected?.selected.providerPublicKey).toBe(providerC);
    expect(result.candidates.map((candidate) => candidate.providerPublicKey)).toEqual([providerC, providerA]);
    // The same inputs always rank the same way.
    const again = await discover(relay, [providerC, providerA]);
    expect(again.candidates.map((candidate) => candidate.providerPublicKey)).toEqual([providerC, providerA]);
  });

  it("treats duplicate allowlist entries exactly like one entry", async () => {
    const relay = new MemoryRelay();
    await publishProvider(relay, PROVIDER_A_SEED);
    await publishProvider(relay, PROVIDER_B_SEED, { amountSats: sats(300n) });
    const single = await discover(relay, [providerA]);
    const duplicated = await discover(relay, [providerA, providerA, providerA]);
    expect(duplicated.candidates.map((candidate) => candidate.providerPublicKey))
      .toEqual(single.candidates.map((candidate) => candidate.providerPublicKey));
    expect(duplicated.selected?.selected).toEqual(single.selected?.selected);
  });

  it.each([
    ["an empty list", []],
    ["a non-hex key", ["not-a-key"]],
    ["an upper-case key", [providerA.toUpperCase()]],
    ["a short key", [providerA.slice(2)]],
    ["a valid key next to a malformed one", [providerA, "zz".repeat(32)]],
  ] as const)("fails closed before any relay query on %s", async (_label, allowed) => {
    const relay = new MemoryRelay();
    await publishProvider(relay, PROVIDER_A_SEED);
    await expect(discover(relay, allowed)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(discover(relay, allowed)).rejects.toBeInstanceOf(DiscoveryError);
    expect(relay.filters).toHaveLength(0);
  });

  it.each([
    ["a missing allowlist", undefined],
    ["a non-array allowlist", providerA],
    ["a non-string entry", [42]],
  ] as const)("fails closed on %s", async (_label, allowed) => {
    const relay = new MemoryRelay();
    await publishProvider(relay, PROVIDER_A_SEED);
    const unsafePolicy = { ...policy([providerA]), allowedProviders: allowed } as unknown as RequesterPolicy;
    await expect(discoverProviders({
      requesterPolicy: unsafePolicy,
      capability: "document-summary",
      relay,
      now: NOW,
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(relay.filters).toHaveLength(0);
  });

  it("does not select an allowed provider whose signed definition points at another provider's offer", async () => {
    const relay = new MemoryRelay();
    const providerB = await publishProvider(relay, PROVIDER_B_SEED);
    await publishProvider(relay, PROVIDER_A_SEED, { pricingPolicyReference: `30400:${providerB}:allowlist-offer` });
    const result = await discover(relay, [providerA, providerB]);
    expect(result.candidates.map((candidate) => candidate.providerPublicKey)).toEqual([providerB]);
    expect(result.rejections).toContainEqual(expect.objectContaining({
      providerPublicKey: providerA,
      category: "missing_offer",
    }));
  });

  it("does not let many providers that are not allowed use up the resolution budget", async () => {
    const relay = new MemoryRelay();
    relay.ignoreAuthors = true;
    for (let seed = 40; seed < 70; seed += 1) await publishProvider(relay, seed, { amountSats: sats(300n) });
    await publishProvider(relay, PROVIDER_A_SEED);
    // Two resolutions: exactly one offer and one descriptor lookup.
    const result = await discover(relay, [providerA], { maxResolutions: 2 });
    expect(result.selected?.selected.providerPublicKey).toBe(providerA);
    expect(result.rejections.filter((entry) => entry.category === "provider_not_allowed")).toHaveLength(30);
    expect(result.rejections.some((entry) => entry.category === "discovery_truncated")).toBe(false);
  });
});

describe("Issue #60 runtime requester policy", () => {
  const economicConfig = {
    mintUrl: "https://testmint.example/cashu",
    stateDirectory: ".not-used",
    normalSpendKeyHex: hex(secretKey(21)),
    refundSpendKeyHex: hex(secretKey(22)),
    fundingToken: "cashuA_not-used",
    fundingReference: "funding-reference-allowlist",
  };
  const hostedConfig = (providerPublicKeyHex: string): PactAgentHostedRuntimeConfig => ({
    economicMode: "live",
    relayUrl: RELAY_URL,
    requesterPrivateKeyHex: hex(secretKey(31)),
    providerPublicKeyHex,
    escrowAuthorityPrivateKeyHex: hex(secretKey(33)),
    externalProvider: true,
    economicConfig,
  });
  const localConfig: PactAgentLiveDemoConfig = {
    economicMode: "live",
    relayUrl: RELAY_URL,
    requesterPrivateKeyHex: hex(secretKey(31)),
    providerPrivateKeyHex: hex(secretKey(PROVIDER_A_SEED)),
    escrowAuthorityPrivateKeyHex: hex(secretKey(33)),
    economicConfig,
  };

  it("allows exactly the configured provider key in hosted mode", () => {
    const requesterPolicy = createRuntimeRequesterPolicy(hostedConfig(providerA));
    expect(requesterPolicy.allowedProviders).toEqual([providerA]);
    expect(Object.isFrozen(requesterPolicy.allowedProviders)).toBe(true);
  });

  it("allows exactly the configured provider signer's key in local mode", () => {
    expect(createRuntimeRequesterPolicy(localConfig).allowedProviders).toEqual([providerA]);
  });

  it("keeps the existing budget, capability, settlement and duration constraints", () => {
    const requesterPolicy = createRuntimeRequesterPolicy(localConfig);
    expect(requesterPolicy).toEqual({
      maxBudgetSats: sats(500n),
      allowedCapabilities: ["document-summary"],
      maximumEscrowDurationSeconds: 15 * 60,
      maximumProviderPriceSats: sats(450n),
      allowedSettlementNetworks: ["cashu"],
      autoRelease: "deterministic_checks_only",
      allowedProviders: [providerA],
    });
  });

  it.each([
    ["empty", ""],
    ["upper-case", providerA.toUpperCase()],
    ["short", providerA.slice(1)],
    ["non-hex", "g".repeat(64)],
  ])("rejects a %s hosted provider key instead of widening the allowlist", (_label, key) => {
    expect(() => createRuntimeRequesterPolicy(hostedConfig(key))).toThrow();
  });

  it("is the only requester policy the runtime and live workflow build", () => {
    for (const file of ["src/lib/pactagent-runtime.live.ts", "src/lib/pactagent-workflow.live.ts"]) {
      const source = readFileSync(file, "utf8");
      // No inline RequesterPolicy literal is left outside the constructor.
      expect(source.match(/maximumProviderPriceSats:/g) ?? []).toHaveLength(
        file.endsWith("workflow.live.ts") ? 1 : 0,
      );
    }
    const runtime = readFileSync("src/lib/pactagent-runtime.live.ts", "utf8");
    // Hosted bootstrap discovery and transaction wiring share the constructor.
    expect(runtime.match(/createRuntimeRequesterPolicy\(config\)/g)).toHaveLength(2);
  });

  it("hosted bootstrap fails closed when only a provider other than the configured one is published", async () => {
    const relay = new MemoryRelay();
    relay.ignoreAuthors = true;
    await publishProvider(relay, PROVIDER_B_SEED, { amountSats: sats(300n) });
    await expect(publishRuntimeBootstrapArtifacts(hostedConfig(providerA), relay, NOW))
      .rejects.toMatchObject({ code: "invalid_configuration" });
    // Nothing is published on the requester's behalf when bootstrap fails.
    expect(relay.published.filter((event) => event.pubkey === testSigner(31).publicKey)).toHaveLength(0);
  });
});
