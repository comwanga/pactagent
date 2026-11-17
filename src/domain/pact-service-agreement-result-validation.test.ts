import { describe, it, expect } from "vitest";

import {
  DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS,
  DOCUMENT_SUMMARY_MINIMUM_SUMMARY_CHARS,
  DOCUMENT_SUMMARY_PROFILE_ID,
  createPactResultReference,
  validatePactResultAcceptance,
  type DocumentSummaryPrivateTerms,
} from "./pact-service-agreement";

const AGREEMENT_ROOT = "000000000000000000000000000000000000000000000000000000000000000a";

function terms(sourceDocument: string, mediaType: "text/plain" | "application/pdf" = "text/plain"): DocumentSummaryPrivateTerms {
  return {
    source_document: sourceDocument,
    input_media_type: mediaType,
  };
}

function expectResultRejects(result: unknown): void {
  expect(() => createPactResultReference(DOCUMENT_SUMMARY_PROFILE_ID, AGREEMENT_ROOT, result)).toThrow();
}

function expectReferenceAccepts(summary: string): void {
  expect(() => createPactResultReference(DOCUMENT_SUMMARY_PROFILE_ID, AGREEMENT_ROOT, { summary })).not.toThrow();
}

function expectReferenceRejects(summary: string): void {
  expect(() => createPactResultReference(DOCUMENT_SUMMARY_PROFILE_ID, AGREEMENT_ROOT, { summary })).toThrow();
}

function expectAcceptanceAccepts(source: string, summary: string): void {
  expect(() => validatePactResultAcceptance(DOCUMENT_SUMMARY_PROFILE_ID, terms(source), { summary })).not.toThrow();
}

function expectAcceptanceRejects(source: string, summary: string): void {
  expect(() => validatePactResultAcceptance(DOCUMENT_SUMMARY_PROFILE_ID, terms(source), { summary })).toThrow();
}

/*
 * Issue #68: the document-summary@1 profile applies deterministic
 * result-acceptance checks. These tests establish the validation boundaries
 * directly through the profile entry points (createPactResultReference applies
 * validatePrivateResult; validatePactResultAcceptance adds the input-relative
 * length bound). They verify structure, length, character-class, and
 * distinct-token behavior, and they document the inherent limitation: a string
 * can satisfy every check and still be an incorrect summary.
 */
describe("document-summary@1 deterministic result acceptance", () => {
  describe("structure", () => {
    it("rejects a non-object result", () => {
      expectResultRejects(null);
      expectResultRejects("a summary");
      expectResultRejects(42);
    });

    it("rejects a result with unsupported keys", () => {
      expectResultRejects({ summary: "ok", extra: 1 });
    });

    it("rejects a non-string summary", () => {
      expectResultRejects({ summary: 42 });
      expectResultRejects({ summary: null });
    });

    it("rejects an empty or whitespace-only summary", () => {
      expectReferenceRejects("");
      expectReferenceRejects("   ");
      expectReferenceRejects("\n\t");
    });
  });

  describe("length bounds", () => {
    it("rejects a summary longer than the documented maximum", () => {
      const overMaximum = "summary".repeat(DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS);
      expect(overMaximum.length).toBeGreaterThan(DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS);
      expectReferenceRejects(overMaximum);
    });

    it("accepts a summary exactly at the maximum length", () => {
      const atMaximum = "a".repeat(DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS);
      expect(atMaximum).toHaveLength(DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS);
      expectReferenceAccepts(atMaximum);
    });

    it("accepts an ordinary short summary whose source is at least as long", () => {
      const source = "PactAgent settles agreements over open Bitcoin protocols.";
      const summary = "PactAgent settles agreements over open Bitcoin protocols.";
      expectAcceptanceAccepts(source, summary);
    });
  });

  describe("input-relative minimum", () => {
    it("rejects an implausibly short summary of a larger document", () => {
      const source = "Bitcoin enables decentralized settlement over Nostr with Cashu ecash escrow.";
      expect(source.length).toBeGreaterThanOrEqual(DOCUMENT_SUMMARY_MINIMUM_SUMMARY_CHARS);
      expectAcceptanceRejects(source, "x");
      expectAcceptanceRejects(source, "ab");
    });

    it("does not reject a degenerate single-token document whose length matches its source", () => {
      expectAcceptanceAccepts("Hi.", "Hi.");
      expectAcceptanceAccepts("a", "a");
    });

    it("scales the floor down to the source's substantive length", () => {
      const shortSource = "Pay me.";
      expect(shortSource.replace(/\s/gu, "").length).toBeLessThan(DOCUMENT_SUMMARY_MINIMUM_SUMMARY_CHARS);
      expectAcceptanceAccepts(shortSource, "Pay me.");
    });

    it("accepts a maximum-supported input document whose summary is within the clamp", () => {
      const source = "a".repeat(DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS);
      const summary = "summary text with several distinct tokens over a large document";
      expectAcceptanceAccepts(source, summary);
    });
  });

  describe("character-class sanity", () => {
    it("rejects punctuation-only output", () => {
      expectAcceptanceRejects("source document text", "!!! ... ???");
    });

    it("rejects symbol-only output", () => {
      expectAcceptanceRejects("source document text", "### ### ###");
    });

    it("rejects control-character content", () => {
      expectAcceptanceRejects("source document text", "summary\u0000text");
    });

    it("accepts valid ordinary text", () => {
      expectAcceptanceAccepts("The document discusses private matters.", "The document discusses private matters.");
    });

    it("accepts valid non-English (CJK) text", () => {
      expectAcceptanceAccepts("比特币通过闪电网络进行去中心化结算。", "比特币通过闪电网络进行去中心化结算。");
    });

    it("accepts numbers and punctuation within a valid summary", () => {
      expectAcceptanceAccepts("The 2026 settlement report.", "The 2026 settlement report.");
    });
  });

  describe("distinct-token floor", () => {
    it("rejects repeated single-token filler for a larger document", () => {
      expectAcceptanceRejects("source document text", "aaaa aaaa aaaa");
    });

    it("rejects two repeated tokens for a larger document", () => {
      expectAcceptanceRejects("source document text", "ok ok");
    });

    it("does not reject a single-token result", () => {
      expectReferenceAccepts("hello");
    });

    it("accepts a two-distinct-token result", () => {
      expectReferenceAccepts("hello world");
    });
  });

  describe("Unicode behavior is deterministic", () => {
    it("tokenizes CJK text without ASCII assumptions", () => {
      // Two distinct CJK tokens satisfy the diversity floor.
      expectReferenceAccepts("比特币 结算");
    });

    it("rejects repeated CJK filler for a larger document", () => {
      expectAcceptanceRejects("比特币结算系统文档。", "比特币 比特币 比特币");
    });

    it("does not reject a single CJK token that equals its degenerate source", () => {
      expectAcceptanceAccepts("好", "好");
    });
  });

  describe("provider/requester parity", () => {
    it("createPactResultReference and validatePactResultAcceptance agree on a valid result", () => {
      const source = "PactAgent binds Nostr, Cashu, and Lightning into a bounded service agreement.";
      const summary = "PactAgent binds Nostr, Cashu, and Lightning into a bounded service agreement.";
      expectReferenceAccepts(summary);
      expectAcceptanceAccepts(source, summary);
    });

    it("an output the requester would reject is also rejected by the provider pre-check", () => {
      const source = "A long source document that should produce a meaningful summary rather than filler.";
      // Filler that passes structural createPactResultReference but fails acceptance.
      expect(() => createPactResultReference(DOCUMENT_SUMMARY_PROFILE_ID, AGREEMENT_ROOT, { summary: "aaaa aaaa aaaa" })).toThrow();
      expectAcceptanceRejects(source, "x");
      expectAcceptanceRejects(source, "aaaa aaaa aaaa");
    });

    it("a valid result passes both boundaries", () => {
      const source = "The document-summary capability is the first real PactAgent service.";
      const summary = "The document-summary capability is the first real PactAgent service.";
      const reference = createPactResultReference(DOCUMENT_SUMMARY_PROFILE_ID, AGREEMENT_ROOT, { summary });
      expect(reference).toMatch(/^sha256:[0-9a-f]{64}$/);
      expectAcceptanceAccepts(source, summary);
    });
  });

  describe("honest verification limits", () => {
    it("a meaningless but well-formed summary can still satisfy the deterministic checks", () => {
      // This is the documented limitation: structural and bounded-content
      // checks do not establish semantic correctness. A plausible-looking
      // but incorrect summary passes; it is not claimed to be verified correct.
      const source = "A substantial document with many sentences and detailed content throughout.";
      const plausible = "The quick brown fox jumps over the lazy dog today.";
      expectAcceptanceAccepts(source, plausible);
    });
  });
});