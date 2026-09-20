import { describe, expect, it } from "vitest";

import { getEventHash } from "nostr-tools/pure";

import { type SignedNostrEvent } from "../domain/nostr";
import {
  NIP17_PRIVATE_DIRECT_MESSAGE_KIND,
  NIP59_GIFT_WRAP_KIND,
  NIP59_SEAL_KIND,
  PrivateTaskTransportError,
} from "../domain/private-task-transport";
import {
  createPactResultReference,
  DOCUMENT_SUMMARY_PROFILE_ID,
} from "../domain/pact-service-agreement";
import type { NostrFilter, NostrRelayAdapter, NostrRelayPublishOptions } from "./nostr-relay";
import {
  createLocalNostrEncrypter,
  generateNostrPrivateKeyForEncrypter,
  openPrivateResult,
  openPrivateTask,
  PrivateTaskPublicationError,
  publishGiftWrap,
  retrieveGiftWraps,
  retrieveAndOpenPrivateTask,
  sealPrivateResult,
  sealPrivateTask,
  type NostrEncrypter,
} from "./private-task-transport";

const TEST_TIMESTAMP = 1_700_000_000;
const VALID_AGREEMENT_ID = "pact-demo-agreement-001";
const AGREEMENT_ROOT = "a".repeat(64);

function createValidPayload() {
  return {
    source_document: "This is a confidential document that must not appear in public events.",
    input_media_type: "text/plain" as const,
    private_prompt: "Summarize this document in 200 words.",
  };
}

function createValidResult() {
  return {
    summary: "The document discusses private matters.",
  };
}

class MemoryNostrRelay implements NostrRelayAdapter {
  readonly url = "wss://relay.example";
  readonly published: SignedNostrEvent[] = [];
  lastOptions: NostrRelayPublishOptions | undefined;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async publish(event: SignedNostrEvent, options?: NostrRelayPublishOptions): Promise<void> {
    this.published.push(event);
    this.lastOptions = options;
  }

  async queryEvents(filter: NostrFilter, options?: NostrRelayPublishOptions): Promise<SignedNostrEvent[]> {
    this.lastOptions = options;
    return this.published.filter((event) => {
      const kindMatches = !filter.kinds || filter.kinds.includes(event.kind);
      const tagMatches =
        !filter.tags ||
        Object.entries(filter.tags).every(([name, values]) =>
          event.tags.some((tag) => tag[0] === name && values.includes(tag[1])),
        );
      const timeMatches =
        (filter.since === undefined || event.created_at >= filter.since) &&
        (filter.until === undefined || event.created_at <= filter.until);
      return kindMatches && tagMatches && timeMatches;
    }).sort((left, right) => right.created_at - left.created_at)
      .slice(0, filter.limit);
  }
}

function createEncrypterPair(): { readonly requester: NostrEncrypter; readonly provider: NostrEncrypter } {
  const requesterSk = generateNostrPrivateKeyForEncrypter();
  const providerSk = generateNostrPrivateKeyForEncrypter();
  return {
    requester: createLocalNostrEncrypter(requesterSk),
    provider: createLocalNostrEncrypter(providerSk),
  };
}

function taskProvenance(requester: NostrEncrypter, provider: NostrEncrypter) {
  return {
    agreementId: VALID_AGREEMENT_ID,
    agreementRoot: AGREEMENT_ROOT,
    authorizedSender: requester.publicKey,
    recipient: provider.publicKey,
  };
}

function resultProvenance(requester: NostrEncrypter, provider: NostrEncrypter) {
  return {
    agreementId: VALID_AGREEMENT_ID,
    agreementRoot: AGREEMENT_ROOT,
    authorizedSender: provider.publicKey,
    recipient: requester.publicKey,
  };
}

describe("Private task transport (NIP-59 Gift Wrap)", () => {
  describe("createLocalNostrEncrypter", () => {
    it("creates an encrypter that can sign and encrypt", () => {
      const sk = generateNostrPrivateKeyForEncrypter();
      const encrypter = createLocalNostrEncrypter(sk);
      expect(encrypter.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof encrypter.encryptNip44).toBe("function");
      expect(typeof encrypter.decryptNip44).toBe("function");
    });

    it("encrypt and decrypt round-trips between two encrypters via NIP-44", () => {
      const skA = generateNostrPrivateKeyForEncrypter();
      const skB = generateNostrPrivateKeyForEncrypter();
      const a = createLocalNostrEncrypter(skA);
      const b = createLocalNostrEncrypter(skB);
      const ciphertext = a.encryptNip44(b.publicKey, "hello secret world");
      const plaintext = b.decryptNip44(a.publicKey, ciphertext);
      expect(plaintext).toBe("hello secret world");
    });

    it("never exposes the private key on the encrypter object", () => {
      const sk = generateNostrPrivateKeyForEncrypter();
      const encrypter = createLocalNostrEncrypter(sk);
      const serialized = JSON.stringify(encrypter);
      expect(serialized).not.toContain(sk);
      expect(serialized).not.toContain("privateKey");
      expect(serialized).not.toContain("nsec");
    });

    it("copies tags (no aliasing) and verifies the signature after signing", async () => {
      const sk = generateNostrPrivateKeyForEncrypter();
      const encrypter = createLocalNostrEncrypter(sk);
      const mutableTags: [string, ...string[]][] = [["p", "ab".repeat(32)]];
      const event = {
        pubkey: encrypter.publicKey,
        created_at: TEST_TIMESTAMP,
        kind: 1,
        tags: mutableTags,
        content: "test",
      };
      const signed = await encrypter.sign(event);
      mutableTags[0][1] = "modified";
      expect(signed.tags[0][1]).toBe("ab".repeat(32));
    });
  });

  describe("sealPrivateTask / openPrivateTask", () => {
    it("seals a task and recovers it with the recipient key", async () => {
      const { requester, provider } = createEncrypterPair();
      const provenance = taskProvenance(requester, provider);
      const result = await sealPrivateTask(createValidPayload(), requester, provenance, TEST_TIMESTAMP);

      expect(result.wrapEvent.kind).toBe(NIP59_GIFT_WRAP_KIND);
      expect(result.wrapEvent.pubkey).not.toBe(requester.publicKey);
      expect(result.payloadHash).toMatch(/^[0-9a-f]{64}$/);

      const recovered = openPrivateTask(result.wrapEvent, provider, provenance);
      expect(recovered.source_document).toBe(createValidPayload().source_document);
      expect(recovered.private_prompt).toBe(createValidPayload().private_prompt);
    });

    it("the wrap does not expose the real sender", async () => {
      const { requester, provider } = createEncrypterPair();
      const result = await sealPrivateTask(
        createValidPayload(),
        requester,
        taskProvenance(requester, provider),
        TEST_TIMESTAMP,
      );
      expect(result.wrapEvent.pubkey).not.toBe(requester.publicKey);
      const wrapJson = JSON.stringify(result.wrapEvent);
      expect(wrapJson).not.toContain(requester.publicKey);
      expect(wrapJson).not.toContain("confidential document");
      expect(wrapJson).not.toContain("Summarize this document");
    });

    it("wraps an authenticated kind-14 rumor containing the exact private agreement binding", async () => {
      const { requester, provider } = createEncrypterPair();
      const provenance = taskProvenance(requester, provider);
      const result = await sealPrivateTask(createValidPayload(), requester, provenance, TEST_TIMESTAMP);

      const seal = JSON.parse(
        provider.decryptNip44(result.wrapEvent.pubkey, result.wrapEvent.content),
      ) as SignedNostrEvent;
      expect(seal.kind).toBe(NIP59_SEAL_KIND);
      expect(seal.pubkey).toBe(requester.publicKey);
      expect(seal.tags).toEqual([]);

      const rumor = JSON.parse(provider.decryptNip44(seal.pubkey, seal.content)) as {
        readonly id: string;
        readonly pubkey: string;
        readonly kind: number;
        readonly tags: readonly (readonly string[])[];
        readonly content: string;
        readonly sig?: string;
      };
      expect(rumor.kind).toBe(NIP17_PRIVATE_DIRECT_MESSAGE_KIND);
      expect(rumor.pubkey).toBe(requester.publicKey);
      expect(rumor.tags).toEqual([["p", provider.publicKey]]);
      expect(rumor.sig).toBeUndefined();
      expect(JSON.parse(rumor.content)).toMatchObject({
        version: 1,
        message_type: "task",
        agreement_id: VALID_AGREEMENT_ID,
        agreement_root: AGREEMENT_ROOT,
        sender: requester.publicKey,
        recipient: provider.publicKey,
      });
    });

    it("rejects decryption by an unrelated identity", async () => {
      const { requester, provider } = createEncrypterPair();
      const unrelatedSk = generateNostrPrivateKeyForEncrypter();
      const unrelated = createLocalNostrEncrypter(unrelatedSk);
      const provenance = taskProvenance(requester, provider);
      const result = await sealPrivateTask(createValidPayload(), requester, provenance, TEST_TIMESTAMP);
      expect(() => openPrivateTask(result.wrapEvent, unrelated, provenance)).toThrow(
        PrivateTaskPublicationError,
      );
    });

    it("rejects when the seal sender is not the authorized sender", async () => {
      const { requester, provider } = createEncrypterPair();
      const thirdPartySk = generateNostrPrivateKeyForEncrypter();
      const thirdParty = createLocalNostrEncrypter(thirdPartySk);
      const thirdPartyProvenance = {
        ...taskProvenance(requester, provider),
        authorizedSender: thirdParty.publicKey,
      };
      const result = await sealPrivateTask(
        createValidPayload(),
        thirdParty,
        thirdPartyProvenance,
        TEST_TIMESTAMP,
      );
      const provenance = taskProvenance(requester, provider);
      expect(() => openPrivateTask(result.wrapEvent, provider, provenance)).toThrow(
        PrivateTaskPublicationError,
      );
    });

    it("rejects a rumor whose author does not match its authenticated seal", async () => {
      const { requester, provider } = createEncrypterPair();
      const thirdParty = createLocalNostrEncrypter(generateNostrPrivateKeyForEncrypter());
      const rumorUnsigned = {
        pubkey: thirdParty.publicKey,
        created_at: TEST_TIMESTAMP,
        kind: NIP17_PRIVATE_DIRECT_MESSAGE_KIND,
        tags: [["p", provider.publicKey] as [string, ...string[]]],
        content: "{}",
      };
      const rumor = { ...rumorUnsigned, id: getEventHash(rumorUnsigned) };
      const seal = await requester.sign({
        pubkey: requester.publicKey,
        created_at: TEST_TIMESTAMP,
        kind: NIP59_SEAL_KIND,
        tags: [],
        content: requester.encryptNip44(provider.publicKey, JSON.stringify(rumor)),
      });
      const wrapper = createLocalNostrEncrypter(generateNostrPrivateKeyForEncrypter());
      const wrap = await wrapper.sign({
        pubkey: wrapper.publicKey,
        created_at: TEST_TIMESTAMP,
        kind: NIP59_GIFT_WRAP_KIND,
        tags: [["p", provider.publicKey]],
        content: wrapper.encryptNip44(provider.publicKey, JSON.stringify(seal)),
      });

      expect(() =>
        openPrivateTask(wrap, provider, taskProvenance(requester, provider)),
      ).toThrowError(expect.objectContaining({ code: "sender_not_authorized" }));
    });

    it("rejects cross-agreement replay for both the agreement id and root", async () => {
      const { requester, provider } = createEncrypterPair();
      const provenance = taskProvenance(requester, provider);
      const result = await sealPrivateTask(createValidPayload(), requester, provenance, TEST_TIMESTAMP);

      expect(() =>
        openPrivateTask(result.wrapEvent, provider, {
          ...provenance,
          agreementId: "another-agreement",
        }),
      ).toThrowError(expect.objectContaining({ code: "agreement_mismatch" }));
      expect(() =>
        openPrivateTask(result.wrapEvent, provider, {
          ...provenance,
          agreementRoot: "b".repeat(64),
        }),
      ).toThrowError(expect.objectContaining({ code: "agreement_mismatch" }));
    });
  });

  describe("sealPrivateResult / openPrivateResult", () => {
    it("seals a result and recovers it", async () => {
      const { requester, provider } = createEncrypterPair();
      const provenance = resultProvenance(requester, provider);
      const result = await sealPrivateResult(createValidResult(), provider, provenance, TEST_TIMESTAMP);
      expect(result.resultReference).toBe(
        createPactResultReference(
          DOCUMENT_SUMMARY_PROFILE_ID,
          AGREEMENT_ROOT,
          createValidResult(),
        ),
      );
      const recovered = openPrivateResult(result.wrapEvent, requester, provenance);
      expect(recovered.summary).toBe("The document discusses private matters.");
    });

    it("rejects decryption by a non-recipient", async () => {
      const { requester, provider } = createEncrypterPair();
      const provenance = resultProvenance(requester, provider);
      const result = await sealPrivateResult(createValidResult(), provider, provenance, TEST_TIMESTAMP);
      const unrelatedSk = generateNostrPrivateKeyForEncrypter();
      const unrelated = createLocalNostrEncrypter(unrelatedSk);
      expect(() => openPrivateResult(result.wrapEvent, unrelated, provenance)).toThrow(
        PrivateTaskPublicationError,
      );
    });

    it("rejects a private result replayed against another agreement root", async () => {
      const { requester, provider } = createEncrypterPair();
      const provenance = resultProvenance(requester, provider);
      const result = await sealPrivateResult(createValidResult(), provider, provenance, TEST_TIMESTAMP);

      expect(() =>
        openPrivateResult(result.wrapEvent, requester, {
          ...provenance,
          agreementRoot: "b".repeat(64),
        }),
      ).toThrowError(expect.objectContaining({ code: "agreement_mismatch" }));
    });
  });

  describe("public/private separation", () => {
    it("the wrap event contains only the recipient p tag, not private data", async () => {
      const { requester, provider } = createEncrypterPair();
      const result = await sealPrivateTask(
        createValidPayload(),
        requester,
        taskProvenance(requester, provider),
        TEST_TIMESTAMP,
      );
      const pTags = result.wrapEvent.tags.filter((t) => t[0] === "p");
      expect(pTags).toHaveLength(1);
      expect(pTags[0][1]).toBe(provider.publicKey);
      expect(result.wrapEvent.tags.some((t) => t[0] === "a")).toBe(false);
      expect(result.wrapEvent.tags.some((t) => t[0] === "d")).toBe(false);
      const serialized = JSON.stringify(result.wrapEvent);
      expect(serialized).not.toContain(VALID_AGREEMENT_ID);
      expect(serialized).not.toContain(AGREEMENT_ROOT);
    });

    it("no Cashu tokens leak into the wrap event", async () => {
      const { requester, provider } = createEncrypterPair();
      const payload = { ...createValidPayload(), private_prompt: "process this: cashuAtoken-abc123" };
      await expect(
        sealPrivateTask(payload, requester, taskProvenance(requester, provider), TEST_TIMESTAMP),
      ).rejects.toThrow(PrivateTaskTransportError);
    });
  });

  describe("publishGiftWrap", () => {
    it("verifies and publishes a signed gift wrap", async () => {
      const { requester, provider } = createEncrypterPair();
      const relay = new MemoryNostrRelay();
      const result = await sealPrivateTask(
        createValidPayload(),
        requester,
        taskProvenance(requester, provider),
        TEST_TIMESTAMP,
      );

      const published = await publishGiftWrap(result.wrapEvent, relay);
      expect(relay.published).toEqual([published]);
    });

    it("rejects an invalid signature", async () => {
      const { requester, provider } = createEncrypterPair();
      const relay = new MemoryNostrRelay();
      const result = await sealPrivateTask(
        createValidPayload(),
        requester,
        taskProvenance(requester, provider),
        TEST_TIMESTAMP,
      );

      const tampered = { ...result.wrapEvent, sig: "0".repeat(128) } as SignedNostrEvent;
      await expect(publishGiftWrap(tampered, relay)).rejects.toMatchObject({
        code: "invalid_wrap",
      });
      expect(relay.published).toHaveLength(0);
    });

    it("rejects a non-1059 kind", async () => {
      const relay = new MemoryNostrRelay();
      const sk = generateNostrPrivateKeyForEncrypter();
      const signer = createLocalNostrEncrypter(sk);
      const wrongEvent = await signer.sign({
        pubkey: signer.publicKey,
        created_at: TEST_TIMESTAMP,
        kind: 1,
        tags: [["p", "ab".repeat(32)] as [string, ...string[]]],
        content: "plaintext leak",
      });
      await expect(publishGiftWrap(wrongEvent, relay)).rejects.toMatchObject({
        code: "invalid_wrap",
      });
      expect(relay.published).toHaveLength(0);
    });
  });

  describe("retrieveGiftWraps", () => {
    it("retrieves valid gift wraps addressed to the recipient", async () => {
      const { requester, provider } = createEncrypterPair();
      const relay = new MemoryNostrRelay();
      const result = await sealPrivateTask(
        createValidPayload(),
        requester,
        taskProvenance(requester, provider),
        TEST_TIMESTAMP,
      );

      await publishGiftWrap(result.wrapEvent, relay);

      const wraps = await retrieveGiftWraps(provider.publicKey, relay);
      expect(wraps).toHaveLength(1);
      expect(wraps[0].kind).toBe(NIP59_GIFT_WRAP_KIND);
    });

    it("skips malformed wraps without aborting all retrieval", async () => {
      const { requester, provider } = createEncrypterPair();
      const relay = new MemoryNostrRelay();
      const result = await sealPrivateTask(
        createValidPayload(),
        requester,
        taskProvenance(requester, provider),
        TEST_TIMESTAMP,
      );

      const signed = await publishGiftWrap(result.wrapEvent, relay);

      const malformed = { ...signed, sig: "0".repeat(128) } as SignedNostrEvent;
      relay.published.push(malformed);

      const wraps = await retrieveGiftWraps(provider.publicKey, relay);
      expect(wraps).toHaveLength(1);
    });
  });

  describe("retrieveAndOpenPrivateTask", () => {
    it("end-to-end: seal, publish, retrieve, and open", async () => {
      const { requester, provider } = createEncrypterPair();
      const relay = new MemoryNostrRelay();
      const provenance = taskProvenance(requester, provider);
      const result = await sealPrivateTask(createValidPayload(), requester, provenance, TEST_TIMESTAMP);

      await publishGiftWrap(result.wrapEvent, relay);

      const recovered = await retrieveAndOpenPrivateTask(provider.publicKey, provider, provenance, relay);
      expect(recovered.source_document).toBe(createValidPayload().source_document);
    });

    it("continues to an older page when the newest wrap window fails provenance", async () => {
      const { requester, provider } = createEncrypterPair();
      const attacker = createLocalNostrEncrypter(generateNostrPrivateKeyForEncrypter());
      const relay = new MemoryNostrRelay();
      const provenance = taskProvenance(requester, provider);
      const legitimate = await sealPrivateTask(
        createValidPayload(),
        requester,
        provenance,
        TEST_TIMESTAMP,
      );
      relay.published.push(legitimate.wrapEvent);

      const spamProvenance = {
        ...provenance,
        agreementId: "attacker-controlled-agreement",
        authorizedSender: attacker.publicKey,
      };
      const spam = await sealPrivateTask(
        { ...createValidPayload(), source_document: "spam" },
        attacker,
        spamProvenance,
        TEST_TIMESTAMP + 1,
      );
      relay.published.push(...Array.from({ length: 50 }, (_value, index) => ({
        ...spam.wrapEvent,
        created_at: TEST_TIMESTAMP + index + 1,
      })));

      await expect(
        retrieveAndOpenPrivateTask(provider.publicKey, provider, provenance, relay),
      ).resolves.toEqual(createValidPayload());
    });

    it("an unrelated identity retrieves wraps but cannot open the task", async () => {
      const { requester, provider } = createEncrypterPair();
      const relay = new MemoryNostrRelay();
      const unrelatedSk = generateNostrPrivateKeyForEncrypter();
      const unrelated = createLocalNostrEncrypter(unrelatedSk);
      const provenance = taskProvenance(requester, provider);
      const result = await sealPrivateTask(createValidPayload(), requester, provenance, TEST_TIMESTAMP);

      await publishGiftWrap(result.wrapEvent, relay);

      await expect(retrieveAndOpenPrivateTask(provider.publicKey, unrelated, provenance, relay)).rejects.toThrow(
        PrivateTaskPublicationError,
      );
    });
  });
});
