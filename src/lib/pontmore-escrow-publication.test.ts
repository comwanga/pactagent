import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  createNostrIdentity,
  nostrPublicKey,
  verifySignedNostrEvent,
  type NostrSigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "../domain/nostr";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  escrowDescriptorFilter,
  Pip01PublicationError,
  publishSignedCashuEscrowDescriptor,
  retrieveCashuEscrowDescriptor,
  signAndPublishCashuEscrowDescriptor,
  signCashuEscrowDescriptor,
} from "./pontmore-escrow-publication";
import type {
  NostrFilter,
  NostrRelayAdapter,
  NostrRelayPublishOptions,
} from "./nostr-relay";

const TEST_TIMESTAMP = 1_788_853_200;

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

  async publish(
    event: SignedNostrEvent,
    options?: NostrRelayPublishOptions,
  ): Promise<void> {
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

function createSignedDescriptorFixture() {
  const { publicKey, signer } = createTestSigner(7);
  const identity = createNostrIdentity(publicKey, ["wss://relay.example"]);
  const descriptor = createCashuEscrowDescriptor({
    identity,
    identifier: "cashu-document-summary",
    updatedAt: TEST_TIMESTAMP,
    referenceFormat: "opaque_service_reference",
    timeoutSeconds: 900,
  });
  return { descriptor, identity, signer };
}

describe("PIP-01 Cashu descriptor signing and relay flow", () => {
  it("signs kind 30361 only through NostrSigner and verifies the result", async () => {
    const { descriptor, signer } = createSignedDescriptorFixture();
    const signed = await signCashuEscrowDescriptor(descriptor, signer);

    expect(signed.kind).toBe(30361);
    expect(signed.content).toBe(descriptor.event.content);
    expect(signed.tags).toEqual(descriptor.event.tags);
    expect(() => verifySignedNostrEvent(signed)).not.toThrow();
    expect(signed).not.toHaveProperty("privateKey");
  });

  it("publishes the verified signed event through the relay abstraction", async () => {
    const { descriptor, signer } = createSignedDescriptorFixture();
    const relay = new MemoryNostrRelay();
    const signed = await signAndPublishCashuEscrowDescriptor(descriptor, signer, relay);

    expect(relay.published).toEqual([signed]);
    expect(relay.lastOptions?.timeoutMs).toBe(10_000);
  });

  it("queries, verifies, and parses the published addressable descriptor", async () => {
    const { descriptor, signer } = createSignedDescriptorFixture();
    const relay = new MemoryNostrRelay();
    const signed = await signAndPublishCashuEscrowDescriptor(descriptor, signer, relay);
    const retrieved = await retrieveCashuEscrowDescriptor(descriptor.address, relay);

    expect(retrieved.event).toEqual(signed);
    expect(retrieved.content).toEqual(descriptor.content);
    expect(relay.lastFilter).toEqual({
      kinds: [30361],
      authors: [descriptor.event.pubkey],
      tags: { d: [descriptor.identifier] },
      limit: 10,
    });
  });

  it("selects the newest signed event for the same addressable descriptor", async () => {
    const { descriptor, identity, signer } = createSignedDescriptorFixture();
    const updatedDescriptor = createCashuEscrowDescriptor({
      identity,
      identifier: descriptor.identifier,
      updatedAt: TEST_TIMESTAMP + 1,
      referenceFormat: "opaque_service_reference",
      timeoutSeconds: 1_200,
    });
    const relay = new MemoryNostrRelay();
    await signAndPublishCashuEscrowDescriptor(descriptor, signer, relay);
    await signAndPublishCashuEscrowDescriptor(updatedDescriptor, signer, relay);

    const retrieved = await retrieveCashuEscrowDescriptor(descriptor.address, relay);
    expect(retrieved.content.updated_at).toBe(TEST_TIMESTAMP + 1);
    expect(retrieved.content.dispute_rules.timeout.duration_seconds).toBe(1_200);
  });

  it("rejects a retrieved event whose content was changed after signing", async () => {
    const { descriptor, signer } = createSignedDescriptorFixture();
    const relay = new MemoryNostrRelay();
    const signed = await signCashuEscrowDescriptor(descriptor, signer);
    relay.published.push({ ...signed, content: `${signed.content} ` });

    await expect(retrieveCashuEscrowDescriptor(descriptor.address, relay)).rejects.toMatchObject({
      code: "invalid_signature",
    });
  });

  it("surfaces malformed signed relay data at the requested address as a typed NIP-01 failure", async () => {
    const { descriptor, signer } = createSignedDescriptorFixture();
    const signed = await signCashuEscrowDescriptor(descriptor, signer);
    const relay: NostrRelayAdapter = {
      url: "wss://relay.example",
      async connect() {},
      async disconnect() {},
      async publish() {},
      async queryEvents() {
        return [{ ...signed, sig: "malformed" }];
      },
    };

    await expect(retrieveCashuEscrowDescriptor(descriptor.address, relay)).rejects.toMatchObject({
      code: "invalid_nip01",
    });
  });

  it("still resolves the valid descriptor when a malformed event for the same address is returned", async () => {
    const { descriptor, signer } = createSignedDescriptorFixture();
    const signed = await signCashuEscrowDescriptor(descriptor, signer);
    const relay: NostrRelayAdapter = {
      url: "wss://relay.example",
      async connect() {},
      async disconnect() {},
      async publish() {},
      async queryEvents() {
        return [{ ...signed, sig: "malformed" }, signed];
      },
    };

    const retrieved = await retrieveCashuEscrowDescriptor(descriptor.address, relay);
    expect(retrieved.address).toBe(descriptor.address);
    expect(retrieved.event.id).toBe(signed.id);
  });

  it("ignores a forged newer event and returns the authentic descriptor", async () => {
    const { descriptor, signer } = createSignedDescriptorFixture();
    const relay = new MemoryNostrRelay();
    const valid = await signAndPublishCashuEscrowDescriptor(descriptor, signer, relay);
    const forgedNewer = { ...valid, content: `${valid.content} `, created_at: valid.created_at + 1 };
    relay.published.push(forgedNewer);
    const retrieved = await retrieveCashuEscrowDescriptor(descriptor.address, relay);
    expect(retrieved.content.updated_at).toBe(descriptor.content.updated_at);
    expect(retrieved.event.id).toBe(valid.id);
  });

  it("falls back from an authentic malformed replacement to the newest valid descriptor", async () => {
    const { descriptor, signer } = createSignedDescriptorFixture();
    const relay = new MemoryNostrRelay();
    const valid = await signAndPublishCashuEscrowDescriptor(descriptor, signer, relay);
    const content = JSON.parse(descriptor.event.content) as Record<string, unknown>;
    const malformedReplacement = await signer.sign({
      ...descriptor.event,
      created_at: descriptor.event.created_at + 1,
      content: JSON.stringify({
        ...content,
        version: 2,
        updated_at: descriptor.event.created_at + 1,
      }),
    });
    relay.published.push(malformedReplacement);

    await expect(retrieveCashuEscrowDescriptor(descriptor.address, relay)).resolves.toMatchObject({
      event: { id: valid.id },
    });
  });

  it("skips malformed unrelated relay events and still resolves the valid descriptor", async () => {
    const { descriptor, signer } = createSignedDescriptorFixture();
    const signed = await signCashuEscrowDescriptor(descriptor, signer);
    const relay: NostrRelayAdapter = {
      url: "wss://relay.example",
      async connect() {},
      async disconnect() {},
      async publish() {},
      async queryEvents() {
        return [{ ...signed, kind: 1, sig: "malformed", id: "ff".repeat(32) }, signed];
      },
    };

    const retrieved = await retrieveCashuEscrowDescriptor(descriptor.address, relay);
    expect(retrieved.address).toBe(descriptor.address);
  });

  it("rejects a signer that changes descriptor data", async () => {
    const { descriptor, signer } = createSignedDescriptorFixture();
    const mutatingSigner: NostrSigner = {
      publicKey: signer.publicKey,
      async sign(event) {
        return signer.sign({ ...event, content: "{}" });
      },
    };
    await expect(signCashuEscrowDescriptor(descriptor, mutatingSigner)).rejects.toMatchObject({
      code: "invalid_nostr_event",
    });
  });

  it("distinguishes not-found, mismatched, publication, retrieval, and timeout failures", async () => {
    const { descriptor, signer } = createSignedDescriptorFixture();
    const signed = await signCashuEscrowDescriptor(descriptor, signer);
    const emptyRelay = new MemoryNostrRelay();
    await expect(retrieveCashuEscrowDescriptor(descriptor.address, emptyRelay)).rejects.toMatchObject({
      code: "descriptor_not_found",
    });

    const mismatchRelay: NostrRelayAdapter = {
      url: "wss://relay.example",
      async connect() {},
      async disconnect() {},
      async publish() {},
      async queryEvents() {
        return [{ ...signed, tags: [["d", "different"], ["network", "cashu"]] }];
      },
    };
    await expect(retrieveCashuEscrowDescriptor(descriptor.address, mismatchRelay)).rejects.toMatchObject({
      code: "descriptor_agent_mismatch",
    });

    const failingRelay: NostrRelayAdapter = {
      url: "wss://relay.example",
      async connect() {},
      async disconnect() {},
      async publish() {
        throw Object.assign(new Error("synthetic private transport detail"), { code: "rejected" });
      },
      async queryEvents() {
        throw Object.assign(new Error("synthetic private transport detail"), { code: "query_timeout" });
      },
    };
    await expect(publishSignedCashuEscrowDescriptor(signed, failingRelay)).rejects.toEqual(
      new Pip01PublicationError("publication_failure", "PIP-01 descriptor publication failed"),
    );
    await expect(retrieveCashuEscrowDescriptor(descriptor.address, failingRelay)).rejects.toMatchObject({
      code: "timeout",
      message: "PIP-01 descriptor retrieval timed out",
    });

    const retrievalFailureRelay: NostrRelayAdapter = {
      url: "wss://relay.example",
      async connect() {},
      async disconnect() {},
      async publish() {
        throw Object.assign(new Error("synthetic transport detail"), { code: "publish_timeout" });
      },
      async queryEvents() {
        throw new Error("synthetic transport detail");
      },
    };
    await expect(
      publishSignedCashuEscrowDescriptor(signed, retrievalFailureRelay),
    ).rejects.toMatchObject({ code: "timeout" });
    await expect(
      retrieveCashuEscrowDescriptor(descriptor.address, retrievalFailureRelay),
    ).rejects.toMatchObject({
      code: "retrieval_failure",
      message: "PIP-01 descriptor retrieval failed",
    });
  });

  it("rejects malformed descriptor references before querying", () => {
    expect(() => escrowDescriptorFilter("30361:not-a-pubkey:descriptor")).toThrowError(
      expect.objectContaining({ code: "malformed_descriptor_reference" }),
    );
  });
});
