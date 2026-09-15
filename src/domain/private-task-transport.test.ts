import { describe, expect, it } from "vitest";

import {
  PrivateTaskTransportError,
  validatePrivateResultPayload,
  validatePrivateTaskPayload,
  validateProvenance,
  NIP59_SEAL_KIND,
  NIP59_GIFT_WRAP_KIND,
  type PrivateResultPayload,
  type PrivateTaskPayload,
} from "./private-task-transport";
import { nostrPublicKey } from "./nostr";

const PROVIDER_PUBKEY = nostrPublicKey("22".repeat(32));
const REQUESTER_PUBKEY = nostrPublicKey("11".repeat(32));

function createValidPayload(overrides?: Partial<PrivateTaskPayload>): PrivateTaskPayload {
  return {
    source_document: "This is a confidential document that must not appear in public events.",
    input_media_type: "text/plain",
    private_prompt: "Summarize this document in 200 words.",
    ...overrides,
  };
}

function createValidResult(overrides?: Partial<PrivateResultPayload>): PrivateResultPayload {
  return {
    summary: "The document discusses private matters.",
    ...overrides,
  };
}

function createValidProvenance() {
  return {
    agreementId: "pact-demo-agreement-001",
    agreementRoot: "a".repeat(64),
    authorizedSender: REQUESTER_PUBKEY,
    recipient: PROVIDER_PUBKEY,
  };
}

describe("Private task transport domain", () => {
  describe("validatePrivateTaskPayload", () => {
    it("accepts a valid payload with a prompt", () => {
      const payload = createValidPayload();
      const validated = validatePrivateTaskPayload(payload);
      expect(validated).toEqual(payload);
    });

    it("accepts a valid payload without a prompt", () => {
      const payload = createValidPayload({ private_prompt: undefined });
      const validated = validatePrivateTaskPayload(payload);
      expect(validated.private_prompt).toBeUndefined();
    });

    it("rejects unsupported fields", () => {
      expect(() =>
        validatePrivateTaskPayload({ ...createValidPayload(), extra: true } as unknown),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects an empty source_document", () => {
      expect(() =>
        validatePrivateTaskPayload({ ...createValidPayload(), source_document: "" }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects an unsupported media type", () => {
      expect(() =>
        validatePrivateTaskPayload({ ...createValidPayload(), input_media_type: "image/png" }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects a payload containing a Cashu token", () => {
      expect(() =>
        validatePrivateTaskPayload({ ...createValidPayload(), private_prompt: "cashuAtoken-leak" }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects a payload containing an nsec1 string", () => {
      expect(() =>
        validatePrivateTaskPayload({ ...createValidPayload(), source_document: "nsec1secret-key" }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects a document exceeding the maximum size", () => {
      const oversized = "x".repeat(1_000_001);
      expect(() =>
        validatePrivateTaskPayload({ ...createValidPayload(), source_document: oversized }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("accepts application/pdf media type", () => {
      const payload = createValidPayload({ input_media_type: "application/pdf" });
      expect(() => validatePrivateTaskPayload(payload)).not.toThrow();
    });
  });

  describe("validatePrivateResultPayload", () => {
    it("accepts a valid result", () => {
      const result = createValidResult();
      const validated = validatePrivateResultPayload(result);
      expect(validated).toEqual(result);
    });

    it("rejects unsupported fields", () => {
      expect(() =>
        validatePrivateResultPayload({ ...createValidResult(), evidence: "extra" } as unknown),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects an empty summary", () => {
      expect(() =>
        validatePrivateResultPayload({ ...createValidResult(), summary: "  " }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects a result containing a Cashu token", () => {
      expect(() =>
        validatePrivateResultPayload({ ...createValidResult(), summary: "cashuAtoken-leak" }),
      ).toThrow(PrivateTaskTransportError);
    });
  });

  describe("validateProvenance", () => {
    it("accepts valid provenance", () => {
      const provenance = createValidProvenance();
      const validated = validateProvenance(provenance);
      expect(validated).toEqual(provenance);
    });

    it("rejects when sender and recipient are the same", () => {
      expect(() =>
        validateProvenance({ ...createValidProvenance(), recipient: REQUESTER_PUBKEY }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects an invalid authorizedSender", () => {
      expect(() =>
        validateProvenance({ ...createValidProvenance(), authorizedSender: "not-a-pubkey" }),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects unsupported fields", () => {
      expect(() =>
        validateProvenance({ ...createValidProvenance(), extra: true } as unknown),
      ).toThrow(PrivateTaskTransportError);
    });

    it("rejects an empty agreementId", () => {
      expect(() =>
        validateProvenance({ ...createValidProvenance(), agreementId: "" }),
      ).toThrow(PrivateTaskTransportError);
    });
  });

  describe("NIP-59 constants", () => {
    it("uses standard Nostr kinds, not invented PactAgent kinds", () => {
      expect(NIP59_SEAL_KIND).toBe(13);
      expect(NIP59_GIFT_WRAP_KIND).toBe(1059);
    });
  });
});
