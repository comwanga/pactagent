import { describe, expect, it } from "vitest";

import {
  type SignedNostrEvent,
} from "../domain/nostr";
import { InvalidDomainInputError } from "../domain/errors";
import { PrivateTaskTransportError } from "../domain/private-task-transport";
import type { NostrFilter, NostrRelayAdapter, NostrRelayPublishOptions } from "./nostr-relay";
import {
  createLocalNostrEncrypter,
  generateNostrPrivateKeyForEncrypter,
  openPrivateResult,
  openPrivateTask,
  PrivateTaskTransportPublicationError,
  PACTAGENT_PRIVATE_TASK_RELAY_TIMEOUT_MS,
  retrievePrivateTaskEvent,
  sealPrivateResult,
  sealPrivateTask,
  signAndPublishPrivateTaskEvent,
  type NostrEncrypter,
} from "./private-task-transport";

const TEST_TIMESTAMP = 1_700_000_000;
const VALID_AGREEMENT_ID = "pact-demo-agreement-001";
const AGREEMENT_ROOT = "3921:11abcdef:demo-root";

function createValidPayload() {
  return {
    version: 1 as const,
    agreement_id: VALID_AGREEMENT_ID,
    source_document: "This is a confidential document that must not appear in public events.",
    input_media_type: "text/plain",
    private_prompt: "Summarize this document in 200 words.",
  };
}

function createValidResult() {
  return {
    version: 1 as const,
    agreement_id: VALID_AGREEMENT_ID,
    summary: "The document discusses private matters.",
    evidence: "Evidence chain proving derivation.",
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

function createEncrypterPair(): { readonly requester: NostrEncrypter; readonly provider: NostrEncrypter } {
  const requesterSk = generateNostrPrivateKeyForEncrypter();
  const providerSk = generateNostrPrivateKeyForEncrypter();
  return {
    requester: createLocalNostrEncrypter(requesterSk),
    provider: createLocalNostrEncrypter(providerSk),
  };
}

describe("Private task transport (lib)", () => {
  describe("createLocalNostrEncrypter", () => {
    it("creates an encrypter that can sign and encrypt", () => {
      const sk = generateNostrPrivateKeyForEncrypter();
      const encrypter = createLocalNostrEncrypter(sk);
      expect(encrypter.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof encrypter.encrypt).toBe("function");
      expect(typeof encrypter.decrypt).toBe("function");
    });

    it("rejects an invalid private key", () => {
      expect(() => createLocalNostrEncrypter("invalid")).toThrow(InvalidDomainInputError);
    });

    it("encrypt and decrypt round-trips between two encrypters", () => {
      const skA = generateNostrPrivateKeyForEncrypter();
      const skB = generateNostrPrivateKeyForEncrypter();
      const a = createLocalNostrEncrypter(skA);
      const b = createLocalNostrEncrypter(skB);
      const ciphertext = a.encrypt(b.publicKey, "hello secret world");
      const plaintext = b.decrypt(a.publicKey, ciphertext);
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
  });

  describe("sealPrivateTask / openPrivateTask", () => {
    it("seals a task encrypted to the provider and recovers it with the provider key", () => {
      const { requester, provider } = createEncrypterPair();
      const result = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );

      expect(result.reference.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.reference.kind).toBe("task");
      expect(result.event.kind).toBe(30401);
      expect(result.event.pubkey).toBe(requester.publicKey);

      const recovered = openPrivateTask(result.sealed, provider);
      expect(recovered.source_document).toBe(createValidPayload().source_document);
      expect(recovered.private_prompt).toBe(createValidPayload().private_prompt);
    });

    it("rejects decryption by an unrelated identity", () => {
      const { requester, provider } = createEncrypterPair();
      const unrelatedSk = generateNostrPrivateKeyForEncrypter();
      const unrelated = createLocalNostrEncrypter(unrelatedSk);
      const result = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );
      expect(() => openPrivateTask(result.sealed, unrelated)).toThrow(PrivateTaskTransportPublicationError);
    });

    it("rejects when the encrypter is not the intended recipient", () => {
      const { requester, provider } = createEncrypterPair();
      const result = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );
      expect(() => openPrivateTask(result.sealed, requester)).toThrow(PrivateTaskTransportPublicationError);
    });

    it("the public reference hash is stable and does not reveal the document", () => {
      const { requester, provider } = createEncrypterPair();
      const result = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );
      const ref1 = result.reference.hash;
      const ref2 = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      ).reference.hash;
      expect(ref1).toBe(ref2);
      const serialized = JSON.stringify(result.reference);
      expect(serialized).not.toContain("confidential document");
    });

    it("the sealed envelope ciphertext does not contain the plaintext document", () => {
      const { requester, provider } = createEncrypterPair();
      const result = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );
      const serialized = JSON.stringify(result.sealed);
      expect(serialized).not.toContain("confidential document");
      expect(serialized).not.toContain("Summarize this document");
    });
  });

  describe("sealPrivateResult / openPrivateResult", () => {
    it("seals a result encrypted to the requester and recovers it", () => {
      const { requester, provider } = createEncrypterPair();
      const result = sealPrivateResult(
        createValidResult(),
        requester.publicKey,
        provider,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );

      expect(result.reference.kind).toBe("result");
      const recovered = openPrivateResult(result.sealed, requester);
      expect(recovered.summary).toBe("The document discusses private matters.");
      expect(recovered.evidence).toBe("Evidence chain proving derivation.");
    });

    it("rejects decryption by a non-recipient", () => {
      const { requester, provider } = createEncrypterPair();
      const result = sealPrivateResult(
        createValidResult(),
        requester.publicKey,
        provider,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );
      expect(() => openPrivateResult(result.sealed, provider)).toThrow(PrivateTaskTransportPublicationError);
    });
  });

  describe("public/private separation", () => {
    it("the public event contains only safe fields, not the document or prompt", () => {
      const { requester, provider } = createEncrypterPair();
      const result = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );
      const eventContent = JSON.parse(result.event.content) as Record<string, unknown>;
      expect(eventContent).not.toHaveProperty("source_document");
      expect(eventContent).not.toHaveProperty("private_prompt");
      expect(eventContent).toHaveProperty("ciphertext");
      expect(eventContent).toHaveProperty("payload_hash");
      expect(eventContent).toHaveProperty("agreement_id");
    });

    it("the result can be associated with the corresponding agreement", () => {
      const { requester, provider } = createEncrypterPair();
      const taskResult = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );
      const resultResult = sealPrivateResult(
        createValidResult(),
        requester.publicKey,
        provider,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP + 1,
      );
      expect(taskResult.sealed.agreement_id).toBe(VALID_AGREEMENT_ID);
      expect(resultResult.sealed.agreement_id).toBe(VALID_AGREEMENT_ID);
      expect(resultResult.event.tags.some((t) => t[0] === "a" && t[1] === AGREEMENT_ROOT)).toBe(true);
    });

    it("no Cashu tokens leak into public events", () => {
      const { requester, provider } = createEncrypterPair();
      const payload = {
        ...createValidPayload(),
        private_prompt: "process this: cashuAtoken-abc123",
      };
      expect(() =>
        sealPrivateTask(payload, provider.publicKey, requester, AGREEMENT_ROOT, TEST_TIMESTAMP),
      ).toThrow(PrivateTaskTransportError);
    });
  });

  describe("signAndPublishPrivateTaskEvent", () => {
    it("signs and publishes the private task companion event", async () => {
      const { requester, provider } = createEncrypterPair();
      const relay = new MemoryNostrRelay();
      const result = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );
      const signed = await signAndPublishPrivateTaskEvent(result.event, requester, relay);
      expect(relay.published).toEqual([signed]);
      expect(relay.lastOptions?.timeoutMs).toBe(PACTAGENT_PRIVATE_TASK_RELAY_TIMEOUT_MS);
    });

    it("rejects a signer that does not match the event pubkey", async () => {
      const { requester, provider } = createEncrypterPair();
      const relay = new MemoryNostrRelay();
      const result = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );
      await expect(signAndPublishPrivateTaskEvent(result.event, provider, relay)).rejects.toMatchObject({
        code: "signing_failure",
      });
    });
  });

  describe("retrievePrivateTaskEvent", () => {
    it("retrieves and parses the newest sealed task by agreement and recipient", async () => {
      const { requester, provider } = createEncrypterPair();
      const relay = new MemoryNostrRelay();
      const result = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );
      await signAndPublishPrivateTaskEvent(result.event, requester, relay);
      const sealed = await retrievePrivateTaskEvent(VALID_AGREEMENT_ID, provider.publicKey, relay);
      expect(sealed.agreement_id).toBe(VALID_AGREEMENT_ID);
      expect(sealed.recipient).toBe(provider.publicKey);
      expect(sealed.payload_hash).toBe(result.reference.hash);
    });

    it("rejects not-found", async () => {
      const { provider } = createEncrypterPair();
      const relay = new MemoryNostrRelay();
      await expect(
        retrievePrivateTaskEvent(VALID_AGREEMENT_ID, provider.publicKey, relay),
      ).rejects.toMatchObject({ code: "task_not_found" });
    });

    it("the intended recipient can open the retrieved task end-to-end", async () => {
      const { requester, provider } = createEncrypterPair();
      const relay = new MemoryNostrRelay();
      const result = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );
      await signAndPublishPrivateTaskEvent(result.event, requester, relay);
      const sealed = await retrievePrivateTaskEvent(VALID_AGREEMENT_ID, provider.publicKey, relay);
      const recovered = openPrivateTask(sealed, provider);
      expect(recovered.source_document).toBe(createValidPayload().source_document);
    });

    it("an unrelated identity retrieves the event but cannot decrypt it", async () => {
      const { requester, provider } = createEncrypterPair();
      const unrelatedSk = generateNostrPrivateKeyForEncrypter();
      const unrelated = createLocalNostrEncrypter(unrelatedSk);
      const relay = new MemoryNostrRelay();
      const result = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );
      await signAndPublishPrivateTaskEvent(result.event, requester, relay);
      const sealed = await retrievePrivateTaskEvent(VALID_AGREEMENT_ID, provider.publicKey, relay);
      expect(() => openPrivateTask(sealed, unrelated)).toThrow(PrivateTaskTransportPublicationError);
    });
  });

  describe("hash verification", () => {
    it("rejects a tampered ciphertext that produces a hash mismatch", () => {
      const { requester, provider } = createEncrypterPair();
      const result = sealPrivateTask(
        createValidPayload(),
        provider.publicKey,
        requester,
        AGREEMENT_ROOT,
        TEST_TIMESTAMP,
      );
      const tampered = {
        ...result.sealed,
        ciphertext: result.sealed.ciphertext + "x",
      };
      expect(() => openPrivateTask(tampered, provider)).toThrow(PrivateTaskTransportPublicationError);
    });
  });
});
