import { describe, expect, it } from "vitest";
import { verifyEvent } from "nostr-tools/pure";

import type { NostrTag, SignedNostrEvent, UnsignedNostrEvent } from "../domain/nostr";
import { createNostrIdentity, parseSignedNostrEvent, verifySignedNostrEvent } from "../domain/nostr";
import {
  createPontmoreAgentDefinition,
  parsePontmoreAgentDefinitionEvent,
  PIP00_AGENT_DEFINITION_KIND,
  PontmoreAgentDefinitionError,
  validatePip00AgentEnvelope,
} from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import { createLocalNostrSigner } from "./nostr-signer";
import {
  signAndPublishCashuEscrowDescriptor,
  signCashuEscrowDescriptor,
} from "./pontmore-escrow-publication";
import {
  agentDefinitionFilter,
  Pip00PublicationError,
  publishSignedAgentDefinition,
  resolveAgentDefinitionEscrow,
  retrieveAgentDefinition,
  signAgentDefinition,
  signAndPublishAgentDefinition,
} from "./pontmore-agent-publication";
import type {
  NostrFilter,
  NostrRelayAdapter,
  NostrRelayPublishOptions,
} from "./nostr-relay";

const TEST_TIMESTAMP = 1_788_853_200;
const RELAYS = ["wss://relay.example"] as const;

const P001_PRIVATE_KEY = "11".repeat(32);
const P002_PRIVATE_KEY = "22".repeat(32);
const OTHER_ESCROW_REFERENCE = `30361:${"ab".repeat(32)}:other-escrow`;

class MemoryNostrRelay implements NostrRelayAdapter {
  readonly url = "wss://relay.example";
  readonly published: SignedNostrEvent[] = [];
  lastFilter: NostrFilter | undefined;
  lastOptions: NostrRelayPublishOptions | undefined;

  async connect(): Promise<void> {}

  async reconnect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async publish(event: SignedNostrEvent, options?: NostrRelayPublishOptions): Promise<void> {
    this.published.push(event);
    this.lastOptions = options;
  }

  async queryEvents(
    filter: NostrFilter,
    options?: NostrRelayPublishOptions,
  ): Promise<SignedNostrEvent[]> {
    this.lastFilter = filter;
    this.lastOptions = options;
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

function createTestFixture() {
  const p001Signer = createLocalNostrSigner(P001_PRIVATE_KEY);
  const p002Signer = createLocalNostrSigner(P002_PRIVATE_KEY);

  const p001Identity = createNostrIdentity(p001Signer.publicKey, RELAYS);
  const p002Identity = createNostrIdentity(p002Signer.publicKey, RELAYS);

  const escrowDescriptor = createCashuEscrowDescriptor({
    identity: p002Identity,
    identifier: "cashu-document-summary",
    updatedAt: TEST_TIMESTAMP,
    referenceFormat: "opaque_service_reference",
  });

  const p001Definition = createPontmoreAgentDefinition({
    identity: p001Identity,
    identifier: "agent",
    name: "P001 Requester",
    about: "Discovers and evaluates a bounded document-summary service.",
    capabilities: {
      names: ["service-discovery", "offer-evaluation", "task-verification"],
      settlement_networks: ["cashu"],
    },
    pricingPolicyReference: "pactagent:P001-requester-policy:v1",
    escrowDescriptorReference: escrowDescriptor.address,
    updatedAt: TEST_TIMESTAMP,
  });

  const p002Definition = createPontmoreAgentDefinition({
    identity: p002Identity,
    identifier: "agent",
    name: "P002 Provider",
    about: "Provides the bounded document-summary service.",
    capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent:P002-provider-policy:v1",
    escrowDescriptorReference: escrowDescriptor.address,
    updatedAt: TEST_TIMESTAMP,
  });

  return { p001Signer, p002Signer, p001Definition, p002Definition, escrowDescriptor, p001Identity, p002Identity };
}

function toWireEvent(event: SignedNostrEvent) {
  return {
    ...event,
    tags: event.tags.map((tag) => [...tag]),
  };
}

function tamperContent(signed: SignedNostrEvent, content: string): SignedNostrEvent {
  return { ...signed, content };
}

function tamperTags(signed: SignedNostrEvent, tags: readonly NostrTag[]): SignedNostrEvent {
  return { ...signed, tags };
}

describe("PIP-00 agent definition publication", () => {
  describe("independent P001 and P002 identities", () => {
    it("gives P001 and P002 independent signing identities with different public keys", () => {
      const { p001Signer, p002Signer } = createTestFixture();
      expect(p001Signer.publicKey).not.toBe(p002Signer.publicKey);
    });

    it("produces valid kind 30360 events signed by different authors", async () => {
      const { p001Signer, p002Signer, p001Definition, p002Definition } = createTestFixture();
      const p001Signed = await signAgentDefinition(p001Definition, p001Signer);
      const p002Signed = await signAgentDefinition(p002Definition, p002Signer);

      expect(p001Signed.kind).toBe(PIP00_AGENT_DEFINITION_KIND);
      expect(p002Signed.kind).toBe(PIP00_AGENT_DEFINITION_KIND);
      expect(p001Signed.pubkey).not.toBe(p002Signed.pubkey);
      expect(verifyEvent(toWireEvent(p001Signed))).toBe(true);
      expect(verifyEvent(toWireEvent(p002Signed))).toBe(true);
    });
  });

  describe("signAgentDefinition", () => {
    it("signs a valid PIP-00 event that verifies via the domain verifier", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);

      expect(() => verifySignedNostrEvent(signed)).not.toThrow();
    });

    it("rejects a signer whose identity does not match the definition pubkey", async () => {
      const { p001Signer, p002Definition } = createTestFixture();
      await expect(signAgentDefinition(p002Definition, p001Signer)).rejects.toBeInstanceOf(
        Pip00PublicationError,
      );
    });

    it("produces a signature that verifies via nostr-tools verifyEvent", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      expect(verifyEvent(toWireEvent(signed))).toBe(true);
    });

    it("rejects a signer that changes event data after signing", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const mutatingSigner = {
        publicKey: p001Signer.publicKey,
        async sign(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
          return p001Signer.sign({ ...event, content: "{}" });
        },
      };
      await expect(signAgentDefinition(p001Definition, mutatingSigner)).rejects.toThrow();
    });

    it("never places private key material on the signed event output", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const serialized = JSON.stringify(signed);
      expect(serialized).not.toContain(P001_PRIVATE_KEY);
      expect(serialized).not.toContain("privateKey");
      expect(serialized).not.toContain("nsec");
      expect(serialized).not.toContain("secretKey");
    });
  });

  describe("publishSignedAgentDefinition", () => {
    it("publishes the verified signed event through the relay abstraction", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const relay = new MemoryNostrRelay();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      await publishSignedAgentDefinition(signed, relay);

      expect(relay.published).toEqual([signed]);
      expect(relay.lastOptions?.timeoutMs).toBe(10_000);
    });

    it("rejects a signed event with a malformed signature before publishing", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const malformed = { ...signed, sig: "malformed" };
      const relay = new MemoryNostrRelay();
      await expect(publishSignedAgentDefinition(malformed as SignedNostrEvent, relay)).rejects.toThrow();
      expect(relay.published.length).toBe(0);
    });

    it("surfaces publication timeout as a distinct error", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const timeoutRelay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async reconnect() {},
        async disconnect() {},
        async publish() {
          throw Object.assign(new Error("timeout"), { code: "publish_timeout" });
        },
        async queryEvents() {
          return [];
        },
      };
      await expect(publishSignedAgentDefinition(signed, timeoutRelay)).rejects.toMatchObject({
        code: "timeout",
      });
    });

    it("surfaces publication failure as a distinct error", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const failRelay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async reconnect() {},
        async disconnect() {},
        async publish() {
          throw Object.assign(new Error("rejected"), { code: "publish_rejected" });
        },
        async queryEvents() {
          return [];
        },
      };
      await expect(publishSignedAgentDefinition(signed, failRelay)).rejects.toMatchObject({
        code: "publication_failure",
      });
    });
  });

  describe("signAndPublishAgentDefinition", () => {
    it("signs and publishes in a single operation", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const relay = new MemoryNostrRelay();
      const signed = await signAndPublishAgentDefinition(p001Definition, p001Signer, relay);
      expect(relay.published).toEqual([signed]);
    });
  });

  describe("retrieveAgentDefinition", () => {
    it("queries, verifies, and parses the published agent definition", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const relay = new MemoryNostrRelay();
      await signAndPublishAgentDefinition(p001Definition, p001Signer, relay);
      const retrieved = await retrieveAgentDefinition(p001Definition.address, relay);

      expect(retrieved.event.kind).toBe(PIP00_AGENT_DEFINITION_KIND);
      expect(retrieved.identifier).toBe(p001Definition.identifier);
      expect(retrieved.address).toBe(p001Definition.address);
    });

    it("preserves required Pontmore fields and tags through the full round trip", async () => {
      const { p002Signer, p002Definition } = createTestFixture();
      const relay = new MemoryNostrRelay();
      await signAndPublishAgentDefinition(p002Definition, p002Signer, relay);
      const retrieved = await retrieveAgentDefinition(p002Definition.address, relay);

      expect(retrieved.content.name).toBe(p002Definition.content.name);
      expect(retrieved.content.about).toBe(p002Definition.content.about);
      expect(retrieved.content.capabilities).toEqual(p002Definition.content.capabilities);
      expect(retrieved.content.pricing_policy).toBe(p002Definition.content.pricing_policy);
      expect(retrieved.content.escrow).toBe(p002Definition.content.escrow);
      expect(retrieved.content.updated_at).toBe(p002Definition.content.updated_at);
      expect(retrieved.event.tags).toContainEqual(["d", "agent"]);
      expect(retrieved.event.tags).toContainEqual(["t", "agent"]);
      expect(retrieved.event.tags).toContainEqual(["a", p002Definition.content.escrow]);
    });

    it("P002 advertises document-summary through the PIP-00 capability mechanism", async () => {
      const { p002Signer, p002Definition } = createTestFixture();
      const relay = new MemoryNostrRelay();
      await signAndPublishAgentDefinition(p002Definition, p002Signer, relay);
      const retrieved = await retrieveAgentDefinition(p002Definition.address, relay);
      expect(retrieved.content.capabilities.names).toContain("document-summary");
    });

    it("PIP-01 escrow reference survives publication and retrieval", async () => {
      const { p002Signer, p002Definition } = createTestFixture();
      const relay = new MemoryNostrRelay();
      await signAndPublishAgentDefinition(p002Definition, p002Signer, relay);
      const retrieved = await retrieveAgentDefinition(p002Definition.address, relay);
      const aTags = retrieved.event.tags.filter((tag) => tag[0] === "a");
      expect(aTags.length).toBe(1);
      expect(aTags[0][1]).toBe(retrieved.content.escrow);
    });

    it("stable PIP-00 address can be used for retrieval", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const relay = new MemoryNostrRelay();
      await signAndPublishAgentDefinition(p001Definition, p001Signer, relay);
      const filter = agentDefinitionFilter(p001Definition.address);
      expect(filter.kinds).toEqual([30360]);
      expect(filter.authors).toEqual([p001Definition.event.pubkey]);
      expect(filter.tags).toEqual({ d: ["agent"] });
      const retrieved = await retrieveAgentDefinition(p001Definition.address, relay);
      expect(retrieved.address).toBe(p001Definition.address);
    });

    it("rejects not-found", async () => {
      const { p001Definition } = createTestFixture();
      const relay = new MemoryNostrRelay();
      await expect(retrieveAgentDefinition(p001Definition.address, relay)).rejects.toMatchObject({
        code: "agent_not_found",
      });
    });

    it("rejects address mismatch when relay returns unrelated events", async () => {
      const { p001Definition, p002Signer, p002Definition } = createTestFixture();
      const p002Signed = await signAgentDefinition(p002Definition, p002Signer);
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async reconnect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          return [p002Signed];
        },
      };
      await expect(retrieveAgentDefinition(p001Definition.address, relay)).rejects.toMatchObject({
        code: "address_mismatch",
      });
    });

    it("rejects malformed NIP-01 events", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async reconnect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          return [{ ...signed, sig: "malformed" }];
        },
      };
      await expect(retrieveAgentDefinition(p001Definition.address, relay)).rejects.toMatchObject({
        code: "invalid_nip01",
      });
    });

    it("rejects invalid signatures", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const tampered = { ...signed, content: `${signed.content} ` };
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async reconnect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          return [tampered];
        },
      };
      await expect(retrieveAgentDefinition(p001Definition.address, relay)).rejects.toMatchObject({
        code: "invalid_signature",
      });
    });

    it("selects the newest valid event by replacement ordering", async () => {
      const { p002Signer, p002Identity, p002Definition } = createTestFixture();
      const relay = new MemoryNostrRelay();
      const older = await signAndPublishAgentDefinition(p002Definition, p002Signer, relay);
      const updatedDef = createPontmoreAgentDefinition({
        identity: p002Identity,
        identifier: "agent",
        name: "P002 Provider v2",
        about: "Provides the bounded document-summary service.",
        capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
        pricingPolicyReference: "pactagent:P002-provider-policy:v1",
        escrowDescriptorReference: p002Definition.content.escrow,
        updatedAt: TEST_TIMESTAMP + 1,
      });
      const newer = await signAgentDefinition(updatedDef, p002Signer);
      relay.published.push(newer);
      const retrieved = await retrieveAgentDefinition(p002Definition.address, relay);
      expect(retrieved.content.name).toBe("P002 Provider v2");
      expect(retrieved.event.created_at).toBe(TEST_TIMESTAMP + 1);
      expect(verifyEvent(toWireEvent(older))).toBe(true);
      expect(verifyEvent(toWireEvent(newer))).toBe(true);
    });

    it("does not let an invalid newer event erase the last valid profile", async () => {
      const { p002Signer, p002Definition } = createTestFixture();
      const relay = new MemoryNostrRelay();
      const valid = await signAndPublishAgentDefinition(p002Definition, p002Signer, relay);
      const invalidNewer = { ...valid, content: `${valid.content} `, created_at: valid.created_at + 1 };
      relay.published.push(invalidNewer);
      const retrieved = await retrieveAgentDefinition(p002Definition.address, relay);
      expect(retrieved.content.name).toBe(p002Definition.content.name);
    });

    it("handles equal timestamps deterministically by id", async () => {
      const { p002Signer, p002Identity, p002Definition } = createTestFixture();
      const relay = new MemoryNostrRelay();
      const def2 = createPontmoreAgentDefinition({
        identity: p002Identity,
        identifier: "agent",
        name: "P002 Provider alt",
        about: "Provides the bounded document-summary service.",
        capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
        pricingPolicyReference: "pactagent:P002-provider-policy:v1",
        escrowDescriptorReference: p002Definition.content.escrow,
        updatedAt: TEST_TIMESTAMP,
      });
      const signed1 = await signAgentDefinition(p002Definition, p002Signer);
      const signed2 = await signAgentDefinition(def2, p002Signer);
      relay.published.push(signed1, signed2);
      const retrieved = await retrieveAgentDefinition(p002Definition.address, relay);
      const expected = [signed1, signed2].sort((a, b) =>
        a.created_at === b.created_at ? a.id.localeCompare(b.id) : b.created_at - a.created_at,
      )[0];
      expect(retrieved.event.id).toBe(expected.id);
    });

    it("ignores unrelated authors, kinds, and d values even if a relay returns them", async () => {
      const { p001Signer, p001Definition, p002Signer, p002Definition } = createTestFixture();
      const relay = new MemoryNostrRelay();
      await signAndPublishAgentDefinition(p001Definition, p001Signer, relay);
      await signAndPublishAgentDefinition(p002Definition, p002Signer, relay);
      const retrieved = await retrieveAgentDefinition(p002Definition.address, relay);
      expect(retrieved.event.pubkey).toBe(p002Definition.event.pubkey);
    });

    it("surfaces retrieval timeout as a distinct error", async () => {
      const { p001Definition } = createTestFixture();
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async reconnect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          throw Object.assign(new Error("timeout"), { code: "query_timeout" });
        },
      };
      await expect(retrieveAgentDefinition(p001Definition.address, relay)).rejects.toMatchObject({
        code: "timeout",
      });
    });

    it("surfaces retrieval failure as a distinct error", async () => {
      const { p001Definition } = createTestFixture();
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async reconnect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          throw new Error("connection lost");
        },
      };
      await expect(retrieveAgentDefinition(p001Definition.address, relay)).rejects.toMatchObject({
        code: "retrieval_failure",
      });
    });
  });

  describe("PIP-00 envelope validation", () => {
    it("rejects missing d tag", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const noD = tamperTags(signed, signed.tags.filter((tag) => tag[0] !== "d"));
      expect(() => parsePontmoreAgentDefinitionEvent(noD)).toThrow(PontmoreAgentDefinitionError);
    });

    it("rejects duplicate d tag", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const dupD = tamperTags(signed, [...signed.tags, ["d", "agent"]]);
      expect(() => parsePontmoreAgentDefinitionEvent(dupD)).toThrow(PontmoreAgentDefinitionError);
    });

    it("rejects missing t tag", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const noT = tamperTags(signed, signed.tags.filter((tag) => tag[0] !== "t"));
      expect(() => parsePontmoreAgentDefinitionEvent(noT)).toThrow(PontmoreAgentDefinitionError);
    });

    it("rejects t tag that is not 'agent'", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const wrongT = tamperTags(
        signed,
        signed.tags.map((tag) => (tag[0] === "t" ? (["t", "bot"] as NostrTag) : tag)),
      );
      expect(() => parsePontmoreAgentDefinitionEvent(wrongT)).toThrow(PontmoreAgentDefinitionError);
    });

    it("rejects duplicate t tag", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const dupT = tamperTags(signed, [...signed.tags, ["t", "agent"]]);
      expect(() => parsePontmoreAgentDefinitionEvent(dupT)).toThrow(PontmoreAgentDefinitionError);
    });

    it("rejects missing relay tag", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const noRelay = tamperTags(signed, signed.tags.filter((tag) => tag[0] !== "relay"));
      expect(() => parsePontmoreAgentDefinitionEvent(noRelay)).toThrow(PontmoreAgentDefinitionError);
    });

    it("rejects invalid relay URL", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const badRelay = tamperTags(
        signed,
        signed.tags.map((tag) => (tag[0] === "relay" ? (["relay", "http://insecure"] as NostrTag) : tag)),
      );
      expect(() => parsePontmoreAgentDefinitionEvent(badRelay)).toThrow(PontmoreAgentDefinitionError);
    });

    it("normalizes duplicate relay values deterministically", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const dupRelay = tamperTags(signed, [...signed.tags, ["relay", RELAYS[0]] as NostrTag]);
      const envelope = validatePip00AgentEnvelope(dupRelay);
      expect(envelope.relays).toEqual([...RELAYS]);
    });

    it("rejects missing a tag", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const noA = tamperTags(signed, signed.tags.filter((tag) => tag[0] !== "a"));
      expect(() => parsePontmoreAgentDefinitionEvent(noA)).toThrow(PontmoreAgentDefinitionError);
    });

    it("rejects duplicate a tag", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const dupA = tamperTags(signed, [...signed.tags, ["a", signed.tags.find((t) => t[0] === "a")![1]]]);
      expect(() => parsePontmoreAgentDefinitionEvent(dupA)).toThrow(PontmoreAgentDefinitionError);
    });

    it("rejects malformed escrow address in a tag", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const badA = tamperTags(
        signed,
        signed.tags.map((tag) => (tag[0] === "a" ? (["a", "not-an-address"] as NostrTag) : tag)),
      );
      expect(() => parsePontmoreAgentDefinitionEvent(badA)).toThrow(PontmoreAgentDefinitionError);
    });

    it("rejects content.escrow that disagrees with the a tag", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const content = JSON.parse(signed.content);
      const mismatched = tamperContent(signed, JSON.stringify({ ...content, escrow: OTHER_ESCROW_REFERENCE }));
      expect(() => parsePontmoreAgentDefinitionEvent(mismatched)).toThrow(PontmoreAgentDefinitionError);
    });
  });

  describe("PactAgent profile validation", () => {
    it("rejects unsupported profile version", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const content = JSON.parse(signed.content);
      const badVersion = tamperContent(signed, JSON.stringify({ ...content, version: 2 }));
      expect(() => parsePontmoreAgentDefinitionEvent(badVersion)).toThrow(PontmoreAgentDefinitionError);
    });

    it("rejects content with unsupported fields", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const content = JSON.parse(signed.content);
      const extraField = tamperContent(signed, JSON.stringify({ ...content, lifecycle_state: "active" }));
      expect(() => parsePontmoreAgentDefinitionEvent(extraField)).toThrow(PontmoreAgentDefinitionError);
    });

    it("rejects malformed capabilities", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const content = JSON.parse(signed.content);
      const badCaps = tamperContent(signed, JSON.stringify({ ...content, capabilities: { names: "not-array" } }));
      expect(() => parsePontmoreAgentDefinitionEvent(badCaps)).toThrow(PontmoreAgentDefinitionError);
    });
  });

  describe("resolveAgentDefinitionEscrow", () => {
    it("resolves the PIP-01 escrow descriptor referenced by the agent definition", async () => {
      const { p002Signer, p002Definition, escrowDescriptor } = createTestFixture();
      const relay = new MemoryNostrRelay();
      await signAndPublishCashuEscrowDescriptor(escrowDescriptor, p002Signer, relay);
      await signAndPublishAgentDefinition(p002Definition, p002Signer, relay);
      const retrieved = await retrieveAgentDefinition(p002Definition.address, relay);
      const resolved = await resolveAgentDefinitionEscrow(retrieved, relay);
      expect(resolved.address).toBe(escrowDescriptor.address);
    });

    it("surfaces a descriptor address mismatch returned by the relay as escrow_reference_mismatch", async () => {
      const { p001Signer, p002Signer, p002Definition, p001Identity } = createTestFixture();
      const unrelatedDescriptor = createCashuEscrowDescriptor({
        identity: p001Identity,
        identifier: "unrelated-cashu",
        updatedAt: TEST_TIMESTAMP,
        referenceFormat: "opaque_service_reference",
      });
      const signedUnrelated = await signCashuEscrowDescriptor(unrelatedDescriptor, p001Signer);
      const signedP002 = await signAgentDefinition(p002Definition, p002Signer);
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async reconnect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          return [signedUnrelated, signedP002];
        },
      };
      const retrieved = await retrieveAgentDefinition(p002Definition.address, relay);
      await expect(resolveAgentDefinitionEscrow(retrieved, relay)).rejects.toMatchObject({
        code: "escrow_reference_mismatch",
      });
    });

    it("rejects when the referenced descriptor does not exist", async () => {
      const { p002Signer, p002Definition } = createTestFixture();
      const relay = new MemoryNostrRelay();
      await signAndPublishAgentDefinition(p002Definition, p002Signer, relay);
      const retrieved = await retrieveAgentDefinition(p002Definition.address, relay);
      await expect(resolveAgentDefinitionEscrow(retrieved, relay)).rejects.toMatchObject({
        code: "escrow_resolution_failure",
      });
    });

    it("rejects when the referenced descriptor is signed by a different author", async () => {
      const { p001Signer, p002Signer, p002Definition, p001Identity } = createTestFixture();
      const wrongDescriptor = createCashuEscrowDescriptor({
        identity: p001Identity,
        identifier: "cashu-document-summary",
        updatedAt: TEST_TIMESTAMP,
        referenceFormat: "opaque_service_reference",
      });
      const relay = new MemoryNostrRelay();
      await signAndPublishCashuEscrowDescriptor(wrongDescriptor, p001Signer, relay);
      await signAndPublishAgentDefinition(p002Definition, p002Signer, relay);
      const retrieved = await retrieveAgentDefinition(p002Definition.address, relay);
      await expect(resolveAgentDefinitionEscrow(retrieved, relay)).rejects.toMatchObject({
        code: "escrow_resolution_failure",
      });
    });

    it("surfaces malformed PIP-01 relay data as a typed escrow resolution failure", async () => {
      const { p002Signer, p002Definition, escrowDescriptor } = createTestFixture();
      const relay = new MemoryNostrRelay();
      await signAndPublishAgentDefinition(p002Definition, p002Signer, relay);
      const retrieved = await retrieveAgentDefinition(p002Definition.address, relay);
      const poisonedRelay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async reconnect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          return [
            {
              ...escrowDescriptor.event,
              id: "00".repeat(32),
              sig: "malformed",
            } as SignedNostrEvent,
          ];
        },
      };
      await expect(resolveAgentDefinitionEscrow(retrieved, poisonedRelay)).rejects.toMatchObject({
        code: "escrow_resolution_failure",
      });
    });
  });

  describe("secret boundary", () => {
    it("domain parsing rejects a signed event carrying private key fields", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const poisoned = { ...signed, privateKey: P001_PRIVATE_KEY };
      expect(() => parseSignedNostrEvent(poisoned)).toThrow();
    });

    it("PIP-00 envelope rejects application data containing private key material in content", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const content = JSON.parse(signed.content);
      const poisonedContent = tamperContent(signed, JSON.stringify({ ...content, privateKey: P001_PRIVATE_KEY }));
      expect(() => parsePontmoreAgentDefinitionEvent(poisonedContent)).toThrow(PontmoreAgentDefinitionError);
    });

    it("classifies forbidden credential fields as forbidden_public_field", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const content = JSON.parse(signed.content);
      const poisoned = tamperContent(signed, JSON.stringify({ ...content, api_key: "synthetic-api-key" }));
      expect(() => parsePontmoreAgentDefinitionEvent(poisoned)).toThrowError(
        expect.objectContaining({ code: "forbidden_public_field" }),
      );
    });

    it("classifies Cashu token material embedded in content values as forbidden_public_field", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const content = JSON.parse(signed.content);
      const poisoned = tamperContent(signed, JSON.stringify({ ...content, name: "cashuA-synthetic-token" }));
      expect(() => parsePontmoreAgentDefinitionEvent(poisoned)).toThrowError(
        expect.objectContaining({ code: "forbidden_public_field" }),
      );
    });
  });

  describe("PactAgent application policy isolation", () => {
    it("does not embed application policy as invented PIP-00 fields", async () => {
      const { p001Signer, p001Definition } = createTestFixture();
      const signed = await signAgentDefinition(p001Definition, p001Signer);
      const content = JSON.parse(signed.content);
      expect(content).not.toHaveProperty("lifecycle_state");
      expect(content).not.toHaveProperty("service_agreement_terms");
      expect(content).not.toHaveProperty("authorization_rules");
      expect(content).not.toHaveProperty("document_summary_profile");
      const retrieved = parsePontmoreAgentDefinitionEvent(signed);
      expect(Object.keys(retrieved.content).sort()).toEqual(
        ["about", "capabilities", "escrow", "name", "pricing_policy", "updated_at", "version"].sort(),
      );
    });
  });

  describe("full P001 and P002 publication flow", () => {
    it("publishes and retrieves both P001 and P002 definitions through the relay", async () => {
      const { p001Signer, p002Signer, p001Definition, p002Definition, escrowDescriptor } = createTestFixture();
      const relay = new MemoryNostrRelay();

      await signAndPublishCashuEscrowDescriptor(escrowDescriptor, p002Signer, relay);
      await signAndPublishAgentDefinition(p001Definition, p001Signer, relay);
      await signAndPublishAgentDefinition(p002Definition, p002Signer, relay);

      const p001Retrieved = await retrieveAgentDefinition(p001Definition.address, relay);
      const p002Retrieved = await retrieveAgentDefinition(p002Definition.address, relay);

      expect(p001Retrieved.event.pubkey).toBe(p001Definition.event.pubkey);
      expect(p002Retrieved.event.pubkey).toBe(p002Definition.event.pubkey);
      expect(p001Retrieved.event.pubkey).not.toBe(p002Retrieved.event.pubkey);
      expect(p002Retrieved.content.capabilities.names).toContain("document-summary");

      const p002Escrow = await resolveAgentDefinitionEscrow(p002Retrieved, relay);
      expect(p002Escrow.address).toBe(escrowDescriptor.address);
    });
  });
});
