import { describe, expect, it } from "vitest";

import {
  createPrivateResultReference,
  createPrivateTaskReference,
  parsePrivateTaskEvent,
  PACTAGENT_PRIVATE_TASK_KIND,
  PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION,
  PrivateTaskTransportError,
  validatePrivateResultPayload,
  validatePrivateTaskPayload,
  validateSealedPrivateTask,
  type PrivateResultPayload,
  type PrivateTaskPayload,
} from "./private-task-transport";
import { nostrPublicKey, type NostrTag, type UnsignedNostrEvent } from "./nostr";

const VALID_AGREEMENT_ID = "pact-demo-agreement-001";
const PROVIDER_PUBKEY = nostrPublicKey("22".repeat(32));
const REQUESTER_PUBKEY = nostrPublicKey("11".repeat(32));

function createValidPayload(overrides?: Partial<PrivateTaskPayload>): PrivateTaskPayload {
  return {
    version: PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION,
    agreement_id: VALID_AGREEMENT_ID,
    source_document: "This is a confidential document that must not appear in public events.",
    input_media_type: "text/plain",
    private_prompt: "Summarize this document in 200 words without revealing sensitive details.",
    ...overrides,
  };
}

function createValidResult(overrides?: Partial<PrivateResultPayload>): PrivateResultPayload {
  return {
    version: PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION,
    agreement_id: VALID_AGREEMENT_ID,
    summary: "The document discusses private matters that are summarized here.",
    evidence: "Evidence hash chain proving the summary was derived from the source.",
    ...overrides,
  };
}

describe("Private task transport domain", () => {
  describe("validatePrivateTaskPayload", () => {
    it("accepts a valid payload", () => {
      const payload = createValidPayload();
      const validated = validatePrivateTaskPayload(payload);
      expect(validated).toEqual(payload);
    });

    it("rejects a payload with unsupported fields", () => {
      expect(() =>
        validatePrivateTaskPayload({ ...createValidPayload(), extra: true } as unknown),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects a payload missing required fields", () => {
      const { source_document, ...rest } = createValidPayload();
      void source_document;
      expect(() => validatePrivateTaskPayload(rest)).toThrow(PrivateTaskTransportError);
    });

    it("rejects an unsupported version", () => {
      expect(() =>
        validatePrivateTaskPayload({ ...createValidPayload(), version: 2 }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects an empty source_document", () => {
      expect(() =>
        validatePrivateTaskPayload({ ...createValidPayload(), source_document: "" }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects a payload containing a Cashu token string", () => {
      expect(() =>
        validatePrivateTaskPayload({
          ...createValidPayload(),
          private_prompt: "cashuAsecret-token-here",
        }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects a payload containing an nsec1 string", () => {
      expect(() =>
        validatePrivateTaskPayload({
          ...createValidPayload(),
          source_document: "nsec1secret-key-material",
        }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects a malformed agreement_id", () => {
      expect(() =>
        validatePrivateTaskPayload({ ...createValidPayload(), agreement_id: "  " }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects a non-string agreement_id without crashing", () => {
      expect(() =>
        validatePrivateTaskPayload({ ...createValidPayload(), agreement_id: 123 } as unknown),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects a document exceeding the maximum size", () => {
      const oversized = "x".repeat(1_000_001);
      expect(() =>
        validatePrivateTaskPayload({ ...createValidPayload(), source_document: oversized }),
      ).toThrow(PrivateTaskTransportError);
    });
  });

  describe("validatePrivateResultPayload", () => {
    it("accepts a valid result", () => {
      const result = createValidResult();
      const validated = validatePrivateResultPayload(result);
      expect(validated).toEqual(result);
    });

    it("rejects a result with forbidden material", () => {
      expect(() =>
        validatePrivateResultPayload({
          ...createValidResult(),
          evidence: "cashuBtoken-material",
        }),
      ).toThrow(PrivateTaskTransportError);
    });
  });

  describe("createPrivateTaskReference", () => {
    it("produces a deterministic sha256 hash", () => {
      const payload = createValidPayload();
      const ref1 = createPrivateTaskReference(payload);
      const ref2 = createPrivateTaskReference(payload);
      expect(ref1.hash).toBe(ref2.hash);
      expect(ref1.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(ref1.scheme).toBe("sha256-hex-canonical-json-v1");
      expect(ref1.kind).toBe("task");
      expect(ref1.agreement_id).toBe(payload.agreement_id);
    });

    it("produces a different hash for different payloads", () => {
      const ref1 = createPrivateTaskReference(createValidPayload({ source_document: "doc A" }));
      const ref2 = createPrivateTaskReference(createValidPayload({ source_document: "doc B" }));
      expect(ref1.hash).not.toBe(ref2.hash);
    });
  });

  describe("createPrivateResultReference", () => {
    it("produces a deterministic sha256 hash for results", () => {
      const result = createValidResult();
      const ref = createPrivateResultReference(result);
      expect(ref.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(ref.kind).toBe("result");
    });
  });

  describe("validateSealedPrivateTask", () => {
    it("accepts a valid sealed envelope", () => {
      const sealed = {
        version: PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION,
        recipient: PROVIDER_PUBKEY,
        sender: REQUESTER_PUBKEY,
        ciphertext: "base64-encrypted-data",
        payload_hash: "a".repeat(64),
        agreement_id: VALID_AGREEMENT_ID,
      };
      const validated = validateSealedPrivateTask(sealed);
      expect(validated).toEqual(sealed);
    });

    it("rejects an envelope with unsupported fields", () => {
      expect(() =>
        validateSealedPrivateTask({
          version: PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION,
          recipient: PROVIDER_PUBKEY,
          sender: REQUESTER_PUBKEY,
          ciphertext: "data",
          payload_hash: "a".repeat(64),
          agreement_id: VALID_AGREEMENT_ID,
          extra: true,
        } as unknown),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects an envelope with an invalid recipient pubkey", () => {
      expect(() =>
        validateSealedPrivateTask({
          version: PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION,
          recipient: "not-a-pubkey",
          sender: REQUESTER_PUBKEY,
          ciphertext: "data",
          payload_hash: "a".repeat(64),
          agreement_id: VALID_AGREEMENT_ID,
        }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects an envelope with an invalid payload_hash", () => {
      expect(() =>
        validateSealedPrivateTask({
          version: PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION,
          recipient: PROVIDER_PUBKEY,
          sender: REQUESTER_PUBKEY,
          ciphertext: "data",
          payload_hash: "not-a-hash",
          agreement_id: VALID_AGREEMENT_ID,
        }),
      ).toThrow(PrivateTaskTransportError);
    });
  });

  describe("parsePrivateTaskEvent", () => {
    it("round-trips a sealed envelope through an unsigned event", () => {
      const sealed = {
        version: PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION,
        recipient: PROVIDER_PUBKEY,
        sender: REQUESTER_PUBKEY,
        ciphertext: "base64-encrypted-data",
        payload_hash: "a".repeat(64),
        agreement_id: VALID_AGREEMENT_ID,
      };
      const agreementRoot = "3921:abc:def";
      const event: UnsignedNostrEvent = {
        pubkey: REQUESTER_PUBKEY,
        created_at: 1000,
        kind: PACTAGENT_PRIVATE_TASK_KIND,
        tags: [
          ["d", VALID_AGREEMENT_ID],
          ["p", PROVIDER_PUBKEY],
          ["a", agreementRoot],
        ] as NostrTag[],
        content: JSON.stringify(sealed),
      };
      const parsed = parsePrivateTaskEvent(event);
      expect(parsed).toEqual(sealed);
    });

    it("rejects an event with the wrong kind", () => {
      const event: UnsignedNostrEvent = {
        pubkey: REQUESTER_PUBKEY,
        created_at: 1000,
        kind: 30360,
        tags: [["d", VALID_AGREEMENT_ID]] as NostrTag[],
        content: "{}",
      };
      expect(() => parsePrivateTaskEvent(event)).toThrow(PrivateTaskTransportError);
    });

    it("rejects an event where sender does not match pubkey", () => {
      const sealed = {
        version: PACTAGENT_PRIVATE_TASK_TRANSPORT_VERSION,
        recipient: PROVIDER_PUBKEY,
        sender: PROVIDER_PUBKEY,
        ciphertext: "data",
        payload_hash: "a".repeat(64),
        agreement_id: VALID_AGREEMENT_ID,
      };
      const event: UnsignedNostrEvent = {
        pubkey: REQUESTER_PUBKEY,
        created_at: 1000,
        kind: PACTAGENT_PRIVATE_TASK_KIND,
        tags: [
          ["d", VALID_AGREEMENT_ID],
          ["p", PROVIDER_PUBKEY],
          ["a", "3921:abc:def"],
        ] as NostrTag[],
        content: JSON.stringify(sealed),
      };
      expect(() => parsePrivateTaskEvent(event)).toThrow(PrivateTaskTransportError);
    });
  });
});
