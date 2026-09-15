import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  createNostrIdentity,
  nostrPublicKey,
  type NostrSigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "../domain/nostr";
import { btcToSats, type Sats } from "../domain/money";
import type { RequesterPolicy } from "../domain/pact-agents";
import {
  createPontmoreAgentDefinition,
  PIP00_AGENT_DEFINITION_KIND,
} from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  createPactServiceOffer,
  PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
  PACTAGENT_SERVICE_OFFER_KIND,
} from "../domain/pact-service-offer";
import type { NostrFilter, NostrRelayAdapter, NostrRelayPublishOptions } from "./nostr-relay";
import {
  signAndPublishPactServiceOffer,
} from "./pact-service-offer-publication";
import { discoverProviders, DiscoveryError, type ProviderConstraints } from "./provider-discovery";
import {
  signAgentDefinition,
  signAndPublishAgentDefinition,
} from "./pontmore-agent-publication";
import {
  signAndPublishCashuEscrowDescriptor,
} from "./pontmore-escrow-publication";
import { runRequesterDecision, type RequesterDecisionModel } from "./requester-decision";

const FIXTURE_TIME = 1_788_853_200;
const RELAYS = ["wss://relay.example"] as const;

function createTestSigner(seed: number): { readonly publicKey: string; readonly signer: NostrSigner } {
  const secretKey = new Uint8Array(32);
  secretKey[31] = seed;
  const publicKey = getPublicKey(secretKey);
  const signer: NostrSigner = {
    publicKey: nostrPublicKey(publicKey),
    async sign(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
      if (event.pubkey !== publicKey) throw new Error("test signer identity mismatch");
      const signed = finalizeEvent(
        {
          created_at: event.created_at,
          kind: event.kind,
          tags: event.tags.map((tag) => [...tag]),
          content: event.content,
        },
        secretKey,
      );
      return {
        ...signed,
        pubkey: nostrPublicKey(signed.pubkey),
        tags: event.tags,
      };
    },
  };
  return { publicKey, signer };
}

class MemoryNostrRelay implements NostrRelayAdapter {
  readonly url = "wss://relay.example";
  readonly published: SignedNostrEvent[] = [];
  lastFilter: NostrFilter | undefined;
  readonly filters: NostrFilter[] = [];
  lastOptions: NostrRelayPublishOptions | undefined;
  queryOverride: ((filter: NostrFilter) => SignedNostrEvent[] | undefined) | undefined;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async publish(event: SignedNostrEvent, options?: NostrRelayPublishOptions): Promise<void> {
    this.published.push(event);
    this.lastOptions = options;
  }

  async queryEvents(filter: NostrFilter, options?: NostrRelayPublishOptions): Promise<SignedNostrEvent[]> {
    this.lastFilter = filter;
    this.filters.push(filter);
    this.lastOptions = options;
    if (this.queryOverride) {
      const overridden = this.queryOverride(filter);
      if (overridden !== undefined) return overridden;
    }
    return this.published.filter((event) => {
      const kindMatches = !filter.kinds || filter.kinds.includes(event.kind);
      const authorMatches = !filter.authors || filter.authors.includes(event.pubkey);
      const tagMatches =
        !filter.tags ||
        Object.entries(filter.tags).every(([name, values]) =>
          event.tags.some((tag) => tag[0] === name && values.includes(tag[1])),
        );
      return kindMatches && authorMatches && tagMatches;
    });
  }
}

const REQUESTER_POLICY: RequesterPolicy = {
  maxBudgetSats: btcToSats("0.00000500"),
  allowedCapabilities: ["document-summary"],
  maximumEscrowDurationSeconds: 15 * 60,
  maximumProviderPriceSats: btcToSats("0.00000450"),
  allowedSettlementNetworks: ["cashu"],
  autoRelease: "deterministic_checks_only",
};

interface ProviderBundle {
  readonly publicKey: string;
  readonly signer: NostrSigner;
  readonly identity: ReturnType<typeof createNostrIdentity>;
  readonly escrowDescriptor: ReturnType<typeof createCashuEscrowDescriptor>;
  readonly offer: ReturnType<typeof createPactServiceOffer>;
  readonly definition: ReturnType<typeof createPontmoreAgentDefinition>;
}

function createProviderBundle(seed: number, overrides?: {
  readonly amountSats?: Sats;
  readonly maximumExecutionSeconds?: number;
  readonly validFrom?: number;
  readonly expiresAt?: number;
  readonly capabilityNames?: readonly string[];
  readonly settlementNetworks?: readonly string[];
  readonly pricingPolicyReference?: string;
}): ProviderBundle {
  const { publicKey, signer } = createTestSigner(seed);
  const identity = createNostrIdentity(publicKey, RELAYS);
  const escrowDescriptor = createCashuEscrowDescriptor({
    identity,
    identifier: "cashu-document-summary",
    updatedAt: FIXTURE_TIME,
    referenceFormat: "opaque_service_reference",
  });
  const offer = createPactServiceOffer({
    identity,
    identifier: "document-summary-offer",
    capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
    amountSats: overrides?.amountSats ?? btcToSats("0.00000350"),
    settlementNetwork: "cashu",
    escrowDescriptorReference: escrowDescriptor.address,
    maximumExecutionSeconds: overrides?.maximumExecutionSeconds ?? 120,
    validFrom: overrides?.validFrom ?? FIXTURE_TIME,
    expiresAt: overrides?.expiresAt ?? FIXTURE_TIME + 3_600,
    updatedAt: FIXTURE_TIME,
  });
  const definition = createPontmoreAgentDefinition({
    identity,
    identifier: "agent",
    name: "Provider",
    about: "Provides the bounded document-summary service.",
    capabilities: {
      names: overrides?.capabilityNames ?? ["document-summary"],
      settlement_networks: overrides?.settlementNetworks ?? ["cashu"],
    },
    pricingPolicyReference: overrides?.pricingPolicyReference ?? offer.address,
    escrowDescriptorReference: escrowDescriptor.address,
    updatedAt: FIXTURE_TIME,
  });
  return { publicKey, signer, identity, escrowDescriptor, offer, definition };
}

async function publishBundle(bundle: ProviderBundle, relay: NostrRelayAdapter): Promise<void> {
  await signAndPublishCashuEscrowDescriptor(bundle.escrowDescriptor, bundle.signer, relay);
  await signAndPublishPactServiceOffer(bundle.offer, bundle.signer, relay);
  await signAndPublishAgentDefinition(bundle.definition, bundle.signer, relay);
}

describe("relay-backed provider discovery", () => {
  describe("acceptance: P001 discovers and selects P002", () => {
    it("discovers P002 from relay-backed PIP-00 data and selects the 350-sat offer", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);

      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });

      expect(result.candidates).toHaveLength(1);
      const candidate = result.candidates[0];
      expect(candidate.providerPublicKey).toBe(p002.publicKey);
      expect(candidate.offer.amountSats).toBe(btcToSats("0.00000350"));
      expect(candidate.offer.content.amount_sats).toBe("350");
      expect(result.selected).toBeDefined();
      expect(result.selected?.selected.providerPublicKey).toBe(p002.publicKey);
      expect(result.selected?.selected.offerReference).toBe(p002.offer.address);
      expect(result.selected?.selected.providerDefinitionReference).toBe(p002.definition.address);
      expect(result.selected?.selected.escrowDescriptorReference).toBe(p002.escrowDescriptor.address);
      expect(result.rejections).toEqual([]);
    });

    it("passes the actual Issue #9 selection and stable references into the bounded Issue #15 gate", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const discovery = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      const model: RequesterDecisionModel = {
        async recommend(input) {
          const candidate = input.candidates[0];
          if (!candidate) return { action: "decline" };
          return {
            action: "recommend",
            providerPublicKey: candidate.providerPublicKey,
            providerDefinitionReference: candidate.providerDefinitionReference,
            offerReference: candidate.offerReference,
            escrowDescriptorReference: candidate.escrowDescriptorReference,
            proposedAmountSats: candidate.amountSats,
          };
        },
      };

      const decision = await runRequesterDecision({
        intent: {
          capabilityProfile: "document-summary@1",
          maximumBudgetSats: REQUESTER_POLICY.maxBudgetSats,
          instruction: "Summarize the private document within the trusted budget.",
        },
        requesterPolicy: REQUESTER_POLICY,
        discovery,
        model,
        bounds: {
          maximumInstructionCharacters: 500,
          maximumRationaleCharacters: 500,
          modelTimeoutMilliseconds: 100,
        },
      });

      expect(decision).toEqual({
        status: "approved",
        reason: "approved",
        capabilityProfile: "document-summary@1",
        selection: discovery.selected!.selected,
        amountSats: "350",
      });
      expect(decision.status === "approved" && decision.selection.offerReference).toBe(p002.offer.address);
      expect(decision.status === "approved" && decision.selection.providerDefinitionReference).toBe(p002.definition.address);
      expect(decision.status === "approved" && decision.selection.escrowDescriptorReference).toBe(p002.escrowDescriptor.address);
    });

    it("validates retrieved PIP-00 definitions before policy evaluation", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.candidates[0].definition.event.kind).toBe(PIP00_AGENT_DEFINITION_KIND);
      expect(result.candidates[0].definition.content.capabilities.names).toContain("document-summary");
    });

    it("returns stable references suitable for PactAgent service-agreement integration #10", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      const selected = result.selected!.selected;
      expect(selected.providerDefinitionReference).toMatch(/^30360:[0-9a-f]{64}:agent$/);
      expect(selected.escrowDescriptorReference).toMatch(/^30361:[0-9a-f]{64}:cashu-document-summary$/);
      expect(selected.offerReference).toMatch(/^30400:[0-9a-f]{64}:document-summary-offer$/);
    });

    it("does not create a service agreement or imply provider acceptance", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.selected?.candidate).toBeDefined();
      const candidate = result.selected!.candidate;
      expect(candidate.offer.content).not.toHaveProperty("service_agreement");
      expect(candidate.offer.content).not.toHaveProperty("agreement_id");
      expect(candidate.definition.content).not.toHaveProperty("lifecycle_state");
    });
  });

  describe("deterministic policy authorization", () => {
    it("rejects an offer above the 500-sat budget", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2, { amountSats: btcToSats("0.00000501") });
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.candidates).toEqual([]);
      expect(result.rejections.map((r) => r.category)).toContain("budget_exceeded");
    });

    it("rejects an offer above the 450-sat provider-price ceiling", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2, { amountSats: btcToSats("0.00000451") });
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.rejections.map((r) => r.category)).toContain("provider_price_limit_exceeded");
    });

    it("rejects an offer whose execution duration exceeds the requester escrow duration", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2, { maximumExecutionSeconds: 16 * 60 });
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.rejections.map((r) => r.category)).toContain("duration_rejected");
    });

    it("AI is not required for authorization or final provider selection", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.selected).toBeDefined();
    });

    it("a rejected provider cannot be selected regardless of caller intent", async () => {
      const relay = new MemoryNostrRelay();
      const overBudget = createProviderBundle(2, { amountSats: btcToSats("0.00000501") });
      await publishBundle(overBudget, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.candidates).toEqual([]);
      expect(result.selected).toBeUndefined();
    });
  });

  describe("adversarial vectors", () => {
    it("rejects a malformed NIP-01 profile without aborting all discovery", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const validSigned = relay.published.find((e) => e.kind === PIP00_AGENT_DEFINITION_KIND)!;
      const forgedMalformed = {
        ...validSigned,
        pubkey: nostrPublicKey("cd".repeat(32)),
        sig: "malformed",
      } as SignedNostrEvent;
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(PIP00_AGENT_DEFINITION_KIND)) {
          return [forgedMalformed, validSigned];
        }
        return undefined;
      };
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.candidates.map((c) => c.providerPublicKey)).toContain(p002.publicKey);
      expect(result.rejections.map((r) => r.category)).toContain("invalid_nostr_event");
    });

    it("rejects an invalid PIP-00 profile and a later valid provider remains discoverable", async () => {
      const relay = new MemoryNostrRelay();
      const firstValid = createProviderBundle(2);
      const laterValid = createProviderBundle(4);
      await publishBundle(firstValid, relay);
      await publishBundle(laterValid, relay);
      const firstProfile = relay.published.find(
        (e) => e.kind === PIP00_AGENT_DEFINITION_KIND && e.pubkey === firstValid.publicKey,
      )!;
      const laterProfile = relay.published.find(
        (e) => e.kind === PIP00_AGENT_DEFINITION_KIND && e.pubkey === laterValid.publicKey,
      )!;
      const tampered = { ...firstProfile, content: `${firstProfile.content} ` };
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(PIP00_AGENT_DEFINITION_KIND)) {
          return [tampered, laterProfile];
        }
        return undefined;
      };
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.candidates.map((c) => c.providerPublicKey)).toContain(laterValid.publicKey);
      expect(result.rejections.some((r) => r.category === "invalid_pip00_profile" || r.category === "invalid_nostr_event")).toBe(true);
    });

    it("rejects a capability mismatch when provider does not advertise document-summary", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2, { capabilityNames: ["other-capability"] });
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.candidates).toEqual([]);
      expect(result.rejections.map((r) => r.category)).toContain("capability_mismatch");
    });

    it("rejects a provider advertising an unsupported settlement network", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2, { settlementNetworks: ["lightning"] });
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.rejections.map((r) => r.category)).toContain("settlement_network_not_allowed");
    });

    it("rejects when the offer is missing (pricing_policy does not resolve)", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2, { pricingPolicyReference: "pactagent:P002-policy:v1" });
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.rejections.map((r) => r.category)).toContain("missing_offer");
    });

    it("rejects an offer signed by a different identity than the provider", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      const other = createProviderBundle(9);
      await signAndPublishCashuEscrowDescriptor(p002.escrowDescriptor, p002.signer, relay);
      await signAndPublishPactServiceOffer(other.offer, other.signer, relay);
      await signAndPublishAgentDefinition(p002.definition, p002.signer, relay);
      const otherOfferEvent = relay.published.find(
        (e) => e.kind === PACTAGENT_SERVICE_OFFER_KIND && e.pubkey === other.publicKey,
      )!;
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(PACTAGENT_SERVICE_OFFER_KIND)) return [otherOfferEvent];
        return undefined;
      };
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      const categories = result.rejections.map((r) => r.category);
      expect(categories).toContain("offer_identity_mismatch");
    });

    it("rejects an offer content that claims P002 while the event author is another pubkey", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      const other = createTestSigner(9);
      await signAndPublishCashuEscrowDescriptor(p002.escrowDescriptor, p002.signer, relay);
      /*
       * Build an offer with P002's identity (so content.provider = P002) then
       * sign it with a different identity. The retrieval layer's hasOfferAddress
       * catches the pubkey mismatch before the parser's content check runs, so
       * discovery reports offer_identity_mismatch. The parser-level
       * content.provider !== event.pubkey guard is tested directly in
       * pact-service-offer.test.ts.
       */
      const offer = createPactServiceOffer({
        identity: p002.identity,
        identifier: "document-summary-offer",
        capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
        amountSats: btcToSats("0.00000350"),
        settlementNetwork: "cashu",
        escrowDescriptorReference: p002.escrowDescriptor.address,
        maximumExecutionSeconds: 120,
        validFrom: FIXTURE_TIME,
        expiresAt: FIXTURE_TIME + 3_600,
        updatedAt: FIXTURE_TIME,
      });
      const tamperedEvent = { ...offer.event, pubkey: nostrPublicKey(other.publicKey) };
      const signedByOther = await other.signer.sign(tamperedEvent);
      relay.published.push(signedByOther);
      await signAndPublishAgentDefinition(p002.definition, p002.signer, relay);
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(PACTAGENT_SERVICE_OFFER_KIND)) return [signedByOther];
        return undefined;
      };
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      const categories = result.rejections.map((r) => r.category);
      expect(categories).toContain("offer_identity_mismatch");
    });

    it("rejects an offer whose capability profile is not advertised by the provider definition", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2, { capabilityNames: ["document-summary"] });
      await signAndPublishCashuEscrowDescriptor(p002.escrowDescriptor, p002.signer, relay);
      await signAndPublishAgentDefinition(
        createPontmoreAgentDefinition({
          identity: p002.identity,
          identifier: "agent",
          name: "Provider",
          about: "Provides the bounded document-summary service.",
          capabilities: { names: ["other-capability"], settlement_networks: ["cashu"] },
          pricingPolicyReference: p002.offer.address,
          escrowDescriptorReference: p002.escrowDescriptor.address,
          updatedAt: FIXTURE_TIME,
        }),
        p002.signer,
        relay,
      );
      await signAndPublishPactServiceOffer(p002.offer, p002.signer, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      const categories = result.rejections.map((r) => r.category);
      expect(categories).toContain("capability_mismatch");
    });

    it("rejects when PIP-00 pricing_policy resolves to a different offer address owner", async () => {
      const relay = new MemoryNostrRelay();
      const other = createProviderBundle(9);
      await signAndPublishPactServiceOffer(other.offer, other.signer, relay);
      const p002 = createProviderBundle(2, { pricingPolicyReference: other.offer.address });
      await signAndPublishCashuEscrowDescriptor(p002.escrowDescriptor, p002.signer, relay);
      await signAndPublishPactServiceOffer(p002.offer, p002.signer, relay);
      await signAndPublishAgentDefinition(p002.definition, p002.signer, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      const categories = result.rejections.map((r) => r.category);
      expect(categories).toContain("missing_offer");
    });

    it("rejects an expired offer", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2, {
        validFrom: FIXTURE_TIME - 7_200,
        expiresAt: FIXTURE_TIME - 60,
      });
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME,
      });
      expect(result.rejections.map((r) => r.category)).toContain("offer_expired");
    });

    it("rejects a not-yet-valid offer", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2, {
        validFrom: FIXTURE_TIME + 3_600,
        expiresAt: FIXTURE_TIME + 7_200,
      });
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME,
      });
      expect(result.rejections.map((r) => r.category)).toContain("offer_not_active");
    });

    it("rejects a malformed amount in the offer", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const offerEvent = relay.published.find((e) => e.kind === PACTAGENT_SERVICE_OFFER_KIND)!;
      const content = JSON.parse(offerEvent.content);
      const tampered = { ...offerEvent, content: JSON.stringify({ ...content, amount_sats: "350.5" }) };
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(PACTAGENT_SERVICE_OFFER_KIND)) return [tampered];
        return undefined;
      };
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.rejections.map((r) => r.category)).toContain("invalid_offer");
    });

    it("rejects a negative amount in the offer", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const offerEvent = relay.published.find((e) => e.kind === PACTAGENT_SERVICE_OFFER_KIND)!;
      const content = JSON.parse(offerEvent.content);
      const tampered = { ...offerEvent, content: JSON.stringify({ ...content, amount_sats: "-350" }) };
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(PACTAGENT_SERVICE_OFFER_KIND)) return [tampered];
        return undefined;
      };
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.rejections.map((r) => r.category)).toContain("invalid_offer");
    });

    it("rejects when the offer escrow reference differs from the provider definition", async () => {
      const relay = new MemoryNostrRelay();
      const other = createProviderBundle(9);
      const p002 = createProviderBundle(2);
      await signAndPublishCashuEscrowDescriptor(p002.escrowDescriptor, p002.signer, relay);
      await signAndPublishCashuEscrowDescriptor(other.escrowDescriptor, other.signer, relay);
      const mismatchedOffer = createPactServiceOffer({
        identity: p002.identity,
        identifier: "document-summary-offer",
        capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
        amountSats: btcToSats("0.00000350"),
        settlementNetwork: "cashu",
        escrowDescriptorReference: other.escrowDescriptor.address,
        maximumExecutionSeconds: 120,
        validFrom: FIXTURE_TIME,
        expiresAt: FIXTURE_TIME + 3_600,
        updatedAt: FIXTURE_TIME,
      });
      await signAndPublishPactServiceOffer(mismatchedOffer, p002.signer, relay);
      await signAndPublishAgentDefinition(p002.definition, p002.signer, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      const categories = result.rejections.map((r) => r.category);
      expect(categories).toContain("offer_escrow_mismatch");
    });

    it("rejects when the descriptor is signed by a different author than the provider", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      const other = createProviderBundle(9);
      await signAndPublishCashuEscrowDescriptor(other.escrowDescriptor, other.signer, relay);
      await signAndPublishPactServiceOffer(p002.offer, p002.signer, relay);
      await signAndPublishAgentDefinition(p002.definition, p002.signer, relay);
      const otherDescriptorEvent = relay.published.find(
        (e) => e.kind === 30361 && e.pubkey === other.publicKey,
      )!;
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(30361)) return [otherDescriptorEvent];
        return undefined;
      };
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      const categories = result.rejections.map((r) => r.category);
      expect(categories).toContain("descriptor_identity_mismatch");
    });

    it("rejects when the offer declares Cashu but the descriptor resolves to a different address", async () => {
      const relay = new MemoryNostrRelay();
      const other = createProviderBundle(9);
      const p002 = createProviderBundle(2);
      await signAndPublishCashuEscrowDescriptor(other.escrowDescriptor, other.signer, relay);
      await signAndPublishPactServiceOffer(p002.offer, p002.signer, relay);
      await signAndPublishAgentDefinition(p002.definition, p002.signer, relay);
      const otherDescriptorEvent = relay.published.find(
        (e) => e.kind === 30361 && e.pubkey === other.publicKey,
      )!;
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(30361)) return [otherDescriptorEvent];
        return undefined;
      };
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      const categories = result.rejections.map((r) => r.category);
      expect(categories).toContain("descriptor_identity_mismatch");
    });

    it("processes forged, unrelated, duplicated, and out-of-order candidates and still selects P002", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const profileEvent = relay.published.find((e) => e.kind === PIP00_AGENT_DEFINITION_KIND)!;
      const unrelated = { ...profileEvent, pubkey: nostrPublicKey("ab".repeat(32)) } as SignedNostrEvent;
      const duplicated: SignedNostrEvent[] = [profileEvent, profileEvent, unrelated, profileEvent];
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(PIP00_AGENT_DEFINITION_KIND)) return duplicated;
        return undefined;
      };
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.candidates.map((c) => c.providerPublicKey)).toContain(p002.publicKey);
      expect(result.candidates.filter((c) => c.providerPublicKey === p002.publicKey)).toHaveLength(1);
      expect(result.selected?.selected.providerPublicKey).toBe(p002.publicKey);
    });

    it("does not let duplicate profiles crowd out a later distinct provider", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      const p003 = createProviderBundle(4);
      await publishBundle(p002, relay);
      await publishBundle(p003, relay);
      const p002Profile = relay.published.find(
        (e) => e.kind === PIP00_AGENT_DEFINITION_KIND && e.pubkey === p002.publicKey,
      )!;
      const p003Profile = relay.published.find(
        (e) => e.kind === PIP00_AGENT_DEFINITION_KIND && e.pubkey === p003.publicKey,
      )!;
      const crowded: SignedNostrEvent[] = [
        p002Profile, p002Profile, p002Profile, p002Profile,
        p003Profile,
      ];
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(PIP00_AGENT_DEFINITION_KIND)) return crowded;
        return undefined;
      };
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
        bounds: { maxProfiles: 2 },
      });
      const pubkeys = result.candidates.map((c) => c.providerPublicKey);
      expect(pubkeys).toContain(p002.publicKey);
      expect(pubkeys).toContain(p003.publicKey);
      expect(result.candidates).toHaveLength(2);
    });

    it("selects the newest valid profile when a provider has multiple versions", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const olderProfile = relay.published.find((e) => e.kind === PIP00_AGENT_DEFINITION_KIND)!;
      const updatedDefinition = createPontmoreAgentDefinition({
        identity: p002.identity,
        identifier: "agent",
        name: "P002 Provider v2",
        about: "Provides the bounded document-summary service.",
        capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
        pricingPolicyReference: p002.offer.address,
        escrowDescriptorReference: p002.escrowDescriptor.address,
        updatedAt: FIXTURE_TIME + 1,
      });
      const newerProfile = await signAgentDefinition(updatedDefinition, p002.signer);
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(PIP00_AGENT_DEFINITION_KIND)) return [olderProfile, newerProfile];
        return undefined;
      };
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].definition.content.name).toBe("P002 Provider v2");
      expect(result.candidates[0].definition.event.created_at).toBe(FIXTURE_TIME + 1);
    });

    it("ignores a forged newer profile at the same address", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const validProfile = relay.published.find((e) => e.kind === PIP00_AGENT_DEFINITION_KIND)!;
      const forgedNewer = { ...validProfile, content: `${validProfile.content} `, created_at: validProfile.created_at + 1 };
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(PIP00_AGENT_DEFINITION_KIND)) return [forgedNewer, validProfile];
        return undefined;
      };
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].definition.event.id).toBe(validProfile.id);
      expect(result.rejections.map((r) => r.category)).toContain("invalid_nostr_event");
    });

    it("rejects an authentic application-invalid profile replacement", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const validProfile = relay.published.find((e) => e.kind === PIP00_AGENT_DEFINITION_KIND)!;
      const content = JSON.parse(validProfile.content) as Record<string, unknown>;
      const malformedReplacement = await p002.signer.sign({
        pubkey: validProfile.pubkey,
        created_at: validProfile.created_at + 1,
        kind: validProfile.kind,
        tags: validProfile.tags.map((tag) => [...tag]),
        content: JSON.stringify({
          ...content,
          version: 2,
          updated_at: validProfile.created_at + 1,
        }),
      });
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(PIP00_AGENT_DEFINITION_KIND)) {
          return [malformedReplacement, validProfile];
        }
        return undefined;
      };

      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.candidates).toEqual([]);
      expect(result.rejections.map((r) => r.category)).toContain("invalid_pip00_profile");
    });
  });

  describe("deterministic tie-breaking", () => {
    it("selects the lowest price among authorized offers", async () => {
      const relay = new MemoryNostrRelay();
      const expensive = createProviderBundle(3, { amountSats: btcToSats("0.00000400") });
      const cheap = createProviderBundle(2, { amountSats: btcToSats("0.00000300") });
      await publishBundle(expensive, relay);
      await publishBundle(cheap, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.selected?.selected.providerPublicKey).toBe(cheap.publicKey);
      expect(result.selected?.candidate.offer.amountSats).toBe(btcToSats("0.00000300"));
    });

    it("breaks equal-price ties by shorter declared maximum execution time", async () => {
      const relay = new MemoryNostrRelay();
      const slow = createProviderBundle(3, {
        amountSats: btcToSats("0.00000350"),
        maximumExecutionSeconds: 180,
      });
      const fast = createProviderBundle(2, {
        amountSats: btcToSats("0.00000350"),
        maximumExecutionSeconds: 90,
      });
      await publishBundle(slow, relay);
      await publishBundle(fast, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.selected?.selected.providerPublicKey).toBe(fast.publicKey);
    });

    it("breaks equal price and duration ties by provider pubkey ascending", async () => {
      const relay = new MemoryNostrRelay();
      const a = createProviderBundle(2, {
        amountSats: btcToSats("0.00000350"),
        maximumExecutionSeconds: 120,
      });
      const b = createProviderBundle(3, {
        amountSats: btcToSats("0.00000350"),
        maximumExecutionSeconds: 120,
      });
      await publishBundle(a, relay);
      await publishBundle(b, relay);
      const expectedWinner = [a.publicKey, b.publicKey].sort()[0];
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.selected?.selected.providerPublicKey).toBe(expectedWinner);
    });

    it("produces the same deterministic winner regardless of relay order", async () => {
      const relayA = new MemoryNostrRelay();
      const relayB = new MemoryNostrRelay();
      const x = createProviderBundle(2, { amountSats: btcToSats("0.00000350") });
      const y = createProviderBundle(3, { amountSats: btcToSats("0.00000400") });
      await publishBundle(x, relayA);
      await publishBundle(y, relayA);
      await publishBundle(y, relayB);
      await publishBundle(x, relayB);
      const resultA = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay: relayA,
        now: FIXTURE_TIME + 60,
      });
      const resultB = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay: relayB,
        now: FIXTURE_TIME + 60,
      });
      expect(resultA.selected?.selected.providerPublicKey).toBe(resultB.selected?.selected.providerPublicKey);
      expect(resultA.selected?.selected.providerPublicKey).toBe(x.publicKey);
    });

    it("lowest price always wins regardless of relay order", async () => {
      const relay = new MemoryNostrRelay();
      const cheap = createProviderBundle(2, { amountSats: btcToSats("0.00000300") });
      const expensive = createProviderBundle(3, { amountSats: btcToSats("0.00000400") });
      await publishBundle(cheap, relay);
      await publishBundle(expensive, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.selected?.selected.providerPublicKey).toBe(cheap.publicKey);
    });

    it("equal-price, equal-duration ties are broken by provider pubkey ascending", async () => {
      const relay = new MemoryNostrRelay();
      const a = createProviderBundle(2, {
        amountSats: btcToSats("0.00000350"),
        maximumExecutionSeconds: 120,
      });
      const b = createProviderBundle(3, {
        amountSats: btcToSats("0.00000350"),
        maximumExecutionSeconds: 120,
      });
      await publishBundle(a, relay);
      await publishBundle(b, relay);
      const expectedWinner = [a.publicKey, b.publicKey].sort()[0];
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.selected?.selected.providerPublicKey).toBe(expectedWinner);
    });

    it("selects stable references when one provider has two equal definitions", async () => {
      const provider = createProviderBundle(2);
      const secondDescriptor = createCashuEscrowDescriptor({
        identity: provider.identity,
        identifier: "cashu-document-summary-b",
        updatedAt: FIXTURE_TIME,
        referenceFormat: "opaque_service_reference",
      });
      const secondOffer = createPactServiceOffer({
        identity: provider.identity,
        identifier: "document-summary-offer-b",
        capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
        amountSats: provider.offer.amountSats,
        settlementNetwork: "cashu",
        escrowDescriptorReference: secondDescriptor.address,
        maximumExecutionSeconds: provider.offer.content.maximum_execution_seconds,
        validFrom: FIXTURE_TIME,
        expiresAt: FIXTURE_TIME + 3_600,
        updatedAt: FIXTURE_TIME,
      });
      const secondDefinition = createPontmoreAgentDefinition({
        identity: provider.identity,
        identifier: "agent-b",
        name: "Provider B",
        about: "Second address for the bounded document-summary service.",
        capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
        pricingPolicyReference: secondOffer.address,
        escrowDescriptorReference: secondDescriptor.address,
        updatedAt: FIXTURE_TIME,
      });

      const publishSecond = async (relay: NostrRelayAdapter) => {
        await signAndPublishCashuEscrowDescriptor(secondDescriptor, provider.signer, relay);
        await signAndPublishPactServiceOffer(secondOffer, provider.signer, relay);
        await signAndPublishAgentDefinition(secondDefinition, provider.signer, relay);
      };
      const relayA = new MemoryNostrRelay();
      const relayB = new MemoryNostrRelay();
      await publishBundle(provider, relayA);
      await publishSecond(relayA);
      await publishSecond(relayB);
      await publishBundle(provider, relayB);

      const resultA = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay: relayA,
        now: FIXTURE_TIME + 60,
      });
      const resultB = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay: relayB,
        now: FIXTURE_TIME + 60,
      });
      const expectedDefinition = [provider.definition.address, secondDefinition.address].sort()[0];
      expect(resultA.selected?.selected.providerDefinitionReference).toBe(expectedDefinition);
      expect(resultB.selected?.selected).toEqual(resultA.selected?.selected);
    });
  });

  describe("bounds and failure handling", () => {
    it("rejects a NaN now timestamp", async () => {
      const relay = new MemoryNostrRelay();
      await expect(
        discoverProviders({
          requesterPolicy: REQUESTER_POLICY,
          capability: "document-summary",
          relay,
          now: Number.NaN,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("rejects a negative now timestamp", async () => {
      const relay = new MemoryNostrRelay();
      await expect(
        discoverProviders({
          requesterPolicy: REQUESTER_POLICY,
          capability: "document-summary",
          relay,
          now: -1,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("rejects a non-integer now timestamp", async () => {
      const relay = new MemoryNostrRelay();
      await expect(
        discoverProviders({
          requesterPolicy: REQUESTER_POLICY,
          capability: "document-summary",
          relay,
          now: 100.5,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("rejects an Infinity now timestamp", async () => {
      const relay = new MemoryNostrRelay();
      await expect(
        discoverProviders({
          requesterPolicy: REQUESTER_POLICY,
          capability: "document-summary",
          relay,
          now: Number.POSITIVE_INFINITY,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("bounds the number of profiles processed", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
        bounds: { maxProfiles: 1 },
      });
      expect(relay.filters[0]?.limit).toBe(1);
      expect(result.candidates).toHaveLength(1);
    });

    it("rejects a non-positive maxProfiles bound", async () => {
      const relay = new MemoryNostrRelay();
      await expect(
        discoverProviders({
          requesterPolicy: REQUESTER_POLICY,
          capability: "document-summary",
          relay,
          now: FIXTURE_TIME + 60,
          bounds: { maxProfiles: 0 },
        }),
      ).rejects.toBeInstanceOf(DiscoveryError);
    });

    it("rejects a negative maxResolutions bound", async () => {
      const relay = new MemoryNostrRelay();
      await expect(
        discoverProviders({
          requesterPolicy: REQUESTER_POLICY,
          capability: "document-summary",
          relay,
          now: FIXTURE_TIME + 60,
          bounds: { maxResolutions: -1 },
        }),
      ).rejects.toBeInstanceOf(DiscoveryError);
    });

    it("truncates discovery when the resolution budget is exhausted", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
        bounds: { maxResolutions: 0 },
      });
      expect(result.candidates).toEqual([]);
      expect(result.rejections.map((r) => r.category)).toContain("discovery_truncated");
    });

    it("truncates discovery after the first candidate exhausts the resolution budget", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      const p003 = createProviderBundle(4);
      await publishBundle(p002, relay);
      await publishBundle(p003, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
        bounds: { maxResolutions: 3 },
      });
      expect(result.candidates.map((c) => c.providerPublicKey)).toContain(p002.publicKey);
      expect(result.candidates).toHaveLength(1);
      expect(result.rejections.some((r) => r.category === "discovery_truncated")).toBe(true);
    });

    it("returns no candidates when the capability is not allowed by the requester policy", async () => {
      const relay = new MemoryNostrRelay();
      const result = await discoverProviders({
        requesterPolicy: { ...REQUESTER_POLICY, allowedCapabilities: [] },
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.candidates).toEqual([]);
      expect(result.selected).toBeUndefined();
      expect(result.rejections).toEqual([]);
    });

    it("surfaces a profile query timeout as a DiscoveryError", async () => {
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          throw Object.assign(new Error("timeout"), { code: "query_timeout" });
        },
      };
      await expect(
        discoverProviders({
          requesterPolicy: REQUESTER_POLICY,
          capability: "document-summary",
          relay,
          now: FIXTURE_TIME + 60,
        }),
      ).rejects.toMatchObject({ code: "profile_query_timeout" });
    });

    it("surfaces a profile query failure as a DiscoveryError", async () => {
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          throw new Error("connection lost");
        },
      };
      await expect(
        discoverProviders({
          requesterPolicy: REQUESTER_POLICY,
          capability: "document-summary",
          relay,
          now: FIXTURE_TIME + 60,
        }),
      ).rejects.toMatchObject({ code: "profile_query_failed" });
    });

    it("rejection diagnostics do not expose raw relay payloads or private material", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const profileEvent = relay.published.find((e) => e.kind === PIP00_AGENT_DEFINITION_KIND)!;
      const poisoned = { ...profileEvent, sig: "malformed" };
      relay.queryOverride = (filter) => {
        if (filter.kinds?.includes(PIP00_AGENT_DEFINITION_KIND)) return [poisoned];
        return undefined;
      };
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      for (const rejectionEntry of result.rejections) {
        expect(rejectionEntry.reason).not.toContain("nsec");
        expect(rejectionEntry.reason).not.toContain("cashuA");
        expect(rejectionEntry.reason).not.toContain("privateKey");
      }
    });
  });

  describe("provider-side constraints", () => {
    it("rejects an offer below the provider minimum price", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2, { amountSats: btcToSats("0.00000100") });
      await publishBundle(p002, relay);
      const constraints = new Map<string, ProviderConstraints>([
        [p002.publicKey, { minimumPriceSats: btcToSats("0.00000200"), maximumExecutionDurationSeconds: 5 * 60 }],
      ]);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
        providerConstraints: constraints,
      });
      expect(result.rejections.map((r) => r.category)).toContain("below_provider_minimum");
      expect(result.candidates).toEqual([]);
    });

    it("rejects an offer whose execution duration exceeds the provider execution limit", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2, { maximumExecutionSeconds: 6 * 60 });
      await publishBundle(p002, relay);
      const constraints = new Map<string, ProviderConstraints>([
        [p002.publicKey, { minimumPriceSats: btcToSats("0.00000200"), maximumExecutionDurationSeconds: 5 * 60 }],
      ]);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
        providerConstraints: constraints,
      });
      expect(result.rejections.map((r) => r.category)).toContain("provider_execution_limit_exceeded");
      expect(result.candidates).toEqual([]);
    });

    it("accepts an offer within both requester and provider constraints", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2, {
        amountSats: btcToSats("0.00000350"),
        maximumExecutionSeconds: 120,
      });
      await publishBundle(p002, relay);
      const constraints = new Map<string, ProviderConstraints>([
        [p002.publicKey, { minimumPriceSats: btcToSats("0.00000200"), maximumExecutionDurationSeconds: 5 * 60 }],
      ]);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
        providerConstraints: constraints,
      });
      expect(result.selected?.selected.providerPublicKey).toBe(p002.publicKey);
    });

    it("does not apply provider constraints when none are supplied for a provider", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2, { amountSats: btcToSats("0.00000100") });
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      expect(result.selected?.selected.providerPublicKey).toBe(p002.publicKey);
    });
  });

  describe("protocol boundary isolation", () => {
    it("does not represent PactAgent agreement/profile fields as PIP-00/PIP-01 fields", async () => {
      const relay = new MemoryNostrRelay();
      const p002 = createProviderBundle(2);
      await publishBundle(p002, relay);
      const result = await discoverProviders({
        requesterPolicy: REQUESTER_POLICY,
        capability: "document-summary",
        relay,
        now: FIXTURE_TIME + 60,
      });
      const candidate = result.candidates[0];
      expect(candidate.definition.content).not.toHaveProperty("service_agreement_terms");
      expect(candidate.definition.content).not.toHaveProperty("authorization_rules");
      expect(candidate.escrowDescriptor.content).not.toHaveProperty("document_summary_profile");
      expect(candidate.offer.content).not.toHaveProperty("lifecycle_state");
    });
  });
});
