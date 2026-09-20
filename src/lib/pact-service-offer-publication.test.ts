import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  createNostrIdentity,
  nostrPublicKey,
  type NostrSigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "../domain/nostr";
import { btcToSats } from "../domain/money";
import {
  PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
  PACTAGENT_SERVICE_OFFER_KIND,
  createPactServiceOffer,
  parsePactServiceOfferEvent,
} from "../domain/pact-service-offer";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  PactServiceOfferPublicationError,
  pactServiceOfferFilter,
  publishSignedPactServiceOffer,
  retrievePactServiceOffer,
  signAndPublishPactServiceOffer,
  signPactServiceOffer,
} from "./pact-service-offer-publication";
import type { NostrFilter, NostrRelayAdapter, NostrRelayPublishOptions } from "./nostr-relay";

const TEST_TIMESTAMP = 1_788_853_200;
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
  lastOptions: NostrRelayPublishOptions | undefined;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async publish(event: SignedNostrEvent, options?: NostrRelayPublishOptions): Promise<void> {
    this.published.push(event);
    this.lastOptions = options;
  }

  async queryEvents(filter: NostrFilter, options?: NostrRelayPublishOptions): Promise<SignedNostrEvent[]> {
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

function createOfferFixture() {
  const { publicKey, signer } = createTestSigner(2);
  const identity = createNostrIdentity(publicKey, RELAYS);
  const escrowDescriptor = createCashuEscrowDescriptor({
    identity,
    identifier: "cashu-document-summary",
    updatedAt: TEST_TIMESTAMP,
    referenceFormat: "opaque_service_reference",
  });
  const offer = createPactServiceOffer({
    identity,
    identifier: "document-summary-offer",
    capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
    amountSats: btcToSats("0.00000350"),
    settlementNetwork: "cashu",
    escrowDescriptorReference: escrowDescriptor.address,
    maximumExecutionSeconds: 120,
    validFrom: TEST_TIMESTAMP,
    expiresAt: TEST_TIMESTAMP + 3_600,
    updatedAt: TEST_TIMESTAMP,
  });
  return { publicKey, signer, identity, escrowDescriptor, offer };
}

describe("PactAgent service-offer publication", () => {
  describe("signPactServiceOffer", () => {
    it("signs a valid service offer that verifies via the domain verifier", async () => {
      const { signer, offer } = createOfferFixture();
      const signed = await signPactServiceOffer(offer, signer);
      expect(signed.kind).toBe(PACTAGENT_SERVICE_OFFER_KIND);
      expect(() => parsePactServiceOfferEvent(signed)).not.toThrow();
    });

    it("rejects a signer whose identity does not match the offer provider", async () => {
      const { offer } = createOfferFixture();
      const { signer: otherSigner } = createTestSigner(3);
      await expect(signPactServiceOffer(offer, otherSigner)).rejects.toBeInstanceOf(
        PactServiceOfferPublicationError,
      );
    });

    it("rejects a signer that mutates event data after signing", async () => {
      const { signer, offer } = createOfferFixture();
      const mutatingSigner: NostrSigner = {
        publicKey: signer.publicKey,
        async sign(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
          return signer.sign({ ...event, content: "{}" });
        },
      };
      await expect(signPactServiceOffer(offer, mutatingSigner)).rejects.toThrow();
    });

    it("never places private key material on the signed event output", async () => {
      const { signer, offer } = createOfferFixture();
      const signed = await signPactServiceOffer(offer, signer);
      const serialized = JSON.stringify(signed);
      expect(serialized).not.toContain("privateKey");
      expect(serialized).not.toContain("nsec");
      expect(serialized).not.toContain("secretKey");
    });
  });

  describe("publishSignedPactServiceOffer", () => {
    it("publishes the verified signed event through the relay abstraction", async () => {
      const { signer, offer } = createOfferFixture();
      const relay = new MemoryNostrRelay();
      const signed = await signPactServiceOffer(offer, signer);
      await publishSignedPactServiceOffer(signed, relay);
      expect(relay.published).toEqual([signed]);
      expect(relay.lastOptions?.timeoutMs).toBe(10_000);
    });

    it("rejects a malformed signature before publishing", async () => {
      const { signer, offer } = createOfferFixture();
      const signed = await signPactServiceOffer(offer, signer);
      const malformed = { ...signed, sig: "malformed" };
      const relay = new MemoryNostrRelay();
      await expect(publishSignedPactServiceOffer(malformed as SignedNostrEvent, relay)).rejects.toThrow();
      expect(relay.published.length).toBe(0);
    });

    it("surfaces publication timeout as a distinct error", async () => {
      const { signer, offer } = createOfferFixture();
      const signed = await signPactServiceOffer(offer, signer);
      const timeoutRelay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async disconnect() {},
        async publish() {
          throw Object.assign(new Error("timeout"), { code: "publish_timeout" });
        },
        async queryEvents() {
          return [];
        },
      };
      await expect(publishSignedPactServiceOffer(signed, timeoutRelay)).rejects.toMatchObject({
        code: "timeout",
      });
    });

    it("surfaces publication failure as a distinct error", async () => {
      const { signer, offer } = createOfferFixture();
      const signed = await signPactServiceOffer(offer, signer);
      const failRelay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async disconnect() {},
        async publish() {
          throw Object.assign(new Error("rejected"), { code: "publish_rejected" });
        },
        async queryEvents() {
          return [];
        },
      };
      await expect(publishSignedPactServiceOffer(signed, failRelay)).rejects.toMatchObject({
        code: "publication_failure",
      });
    });
  });

  describe("signAndPublishPactServiceOffer", () => {
    it("signs and publishes in a single operation", async () => {
      const { signer, offer } = createOfferFixture();
      const relay = new MemoryNostrRelay();
      const signed = await signAndPublishPactServiceOffer(offer, signer, relay);
      expect(relay.published).toEqual([signed]);
    });
  });

  describe("retrievePactServiceOffer", () => {
    it("queries, verifies, and parses the published offer", async () => {
      const { signer, offer } = createOfferFixture();
      const relay = new MemoryNostrRelay();
      await signAndPublishPactServiceOffer(offer, signer, relay);
      const retrieved = await retrievePactServiceOffer(offer.address, relay);
      expect(retrieved.address).toBe(offer.address);
      expect(retrieved.amountSats).toBe(offer.amountSats);
      expect(retrieved.content.amount_sats).toBe("350");
    });

    it("uses the canonical address filter", async () => {
      const { signer, offer } = createOfferFixture();
      const relay = new MemoryNostrRelay();
      await signAndPublishPactServiceOffer(offer, signer, relay);
      await retrievePactServiceOffer(offer.address, relay);
      expect(relay.lastFilter?.kinds).toEqual([PACTAGENT_SERVICE_OFFER_KIND]);
      expect(relay.lastFilter?.tags).toEqual({ d: ["document-summary-offer"] });
    });

    it("selects the newest valid event by replacement ordering", async () => {
      const { signer, identity, escrowDescriptor, offer } = createOfferFixture();
      const relay = new MemoryNostrRelay();
      await signAndPublishPactServiceOffer(offer, signer, relay);
      const updated = createPactServiceOffer({
        identity,
        identifier: "document-summary-offer",
        capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
        amountSats: btcToSats("0.00000300"),
        settlementNetwork: "cashu",
        escrowDescriptorReference: escrowDescriptor.address,
        maximumExecutionSeconds: 90,
        validFrom: TEST_TIMESTAMP + 1,
        expiresAt: TEST_TIMESTAMP + 7_200,
        updatedAt: TEST_TIMESTAMP + 1,
      });
      const updatedSigned = await signPactServiceOffer(updated, signer);
      relay.published.push(updatedSigned);
      const retrieved = await retrievePactServiceOffer(offer.address, relay);
      expect(retrieved.event.created_at).toBe(TEST_TIMESTAMP + 1);
      expect(retrieved.amountSats).toBe(btcToSats("0.00000300"));
    });

    it("ignores a forged newer event and returns the authentic offer", async () => {
      const { signer, offer } = createOfferFixture();
      const relay = new MemoryNostrRelay();
      const valid = await signAndPublishPactServiceOffer(offer, signer, relay);
      const forgedNewer = { ...valid, content: `${valid.content} `, created_at: valid.created_at + 1 };
      relay.published.push(forgedNewer);

      const retrieved = await retrievePactServiceOffer(offer.address, relay);
      expect(retrieved.event.id).toBe(valid.id);
    });

    it("falls back from an authentic malformed replacement to the newest valid offer", async () => {
      const { signer, offer } = createOfferFixture();
      const relay = new MemoryNostrRelay();
      const valid = await signAndPublishPactServiceOffer(offer, signer, relay);
      const content = JSON.parse(offer.event.content) as Record<string, unknown>;
      const malformedReplacement = await signer.sign({
        ...offer.event,
        created_at: offer.event.created_at + 1,
        content: JSON.stringify({
          ...content,
          version: 2,
          updated_at: offer.event.created_at + 1,
        }),
      });
      relay.published.push(malformedReplacement);

      await expect(retrievePactServiceOffer(offer.address, relay)).resolves.toMatchObject({
        event: { id: valid.id },
      });
    });

    it("ignores an unrelated newer relay event", async () => {
      const { signer, offer } = createOfferFixture();
      const valid = await signPactServiceOffer(offer, signer);
      const unrelated = {
        ...valid,
        pubkey: nostrPublicKey("ab".repeat(32)),
        created_at: valid.created_at + 10,
      } as SignedNostrEvent;
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          return [unrelated, valid];
        },
      };

      const retrieved = await retrievePactServiceOffer(offer.address, relay);
      expect(retrieved.event.id).toBe(valid.id);
    });

    it("rejects not-found", async () => {
      const { offer } = createOfferFixture();
      const relay = new MemoryNostrRelay();
      await expect(retrievePactServiceOffer(offer.address, relay)).rejects.toMatchObject({
        code: "offer_not_found",
      });
    });

    it("rejects address mismatch when relay returns unrelated events", async () => {
      const { offer } = createOfferFixture();
      const otherSeed = createTestSigner(9);
      const otherIdentity = createNostrIdentity(otherSeed.publicKey, RELAYS);
      const otherEscrow = createCashuEscrowDescriptor({
        identity: otherIdentity,
        identifier: "cashu-other",
        updatedAt: TEST_TIMESTAMP,
        referenceFormat: "opaque_service_reference",
      });
      const otherOffer = createPactServiceOffer({
        identity: otherIdentity,
        identifier: "other-offer",
        capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
        amountSats: btcToSats("0.00000350"),
        settlementNetwork: "cashu",
        escrowDescriptorReference: otherEscrow.address,
        maximumExecutionSeconds: 120,
        validFrom: TEST_TIMESTAMP,
        expiresAt: TEST_TIMESTAMP + 3_600,
        updatedAt: TEST_TIMESTAMP,
      });
      const otherSigned = await signPactServiceOffer(otherOffer, otherSeed.signer);
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          return [otherSigned];
        },
      };
      await expect(retrievePactServiceOffer(offer.address, relay)).rejects.toMatchObject({
        code: "address_mismatch",
      });
    });

    it("rejects malformed NIP-01 events", async () => {
      const { signer, offer } = createOfferFixture();
      const signed = await signPactServiceOffer(offer, signer);
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          return [{ ...signed, sig: "malformed" }];
        },
      };
      await expect(retrievePactServiceOffer(offer.address, relay)).rejects.toMatchObject({
        code: "invalid_nip01",
      });
    });

    it("rejects an invalid signature", async () => {
      const { signer, offer } = createOfferFixture();
      const signed = await signPactServiceOffer(offer, signer);
      const tampered = { ...signed, content: `${signed.content} ` };
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          return [tampered];
        },
      };
      await expect(retrievePactServiceOffer(offer.address, relay)).rejects.toMatchObject({
        code: "invalid_signature",
      });
    });

    it("surfaces retrieval timeout as a distinct error", async () => {
      const { offer } = createOfferFixture();
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          throw Object.assign(new Error("timeout"), { code: "query_timeout" });
        },
      };
      await expect(retrievePactServiceOffer(offer.address, relay)).rejects.toMatchObject({
        code: "timeout",
      });
    });

    it("surfaces retrieval failure as a distinct error", async () => {
      const { offer } = createOfferFixture();
      const relay: NostrRelayAdapter = {
        url: "wss://relay.example",
        async connect() {},
        async disconnect() {},
        async publish() {},
        async queryEvents() {
          throw new Error("connection lost");
        },
      };
      await expect(retrievePactServiceOffer(offer.address, relay)).rejects.toMatchObject({
        code: "retrieval_failure",
      });
    });

    it("pactServiceOfferFilter returns the canonical kind, author, and d tag", () => {
      const { offer } = createOfferFixture();
      const filter = pactServiceOfferFilter(offer.address);
      expect(filter.kinds).toEqual([PACTAGENT_SERVICE_OFFER_KIND]);
      expect(filter.authors).toEqual([offer.event.pubkey]);
      expect(filter.tags).toEqual({ d: ["document-summary-offer"] });
    });
  });
});
