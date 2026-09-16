import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
  DOCUMENT_SUMMARY_MAXIMUM_EXECUTION_SECONDS,
  DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES,
  DOCUMENT_SUMMARY_PROFILE_ID,
  canonicalizePactJson,
} from "./pact-service-agreement";
import {
  __setDocumentSummaryClockForTesting,
  DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS,
  summarizeDocument,
  type DocumentSummaryOutcome,
  type DocumentSummarySuccess,
} from "./document-summary-service";

const AGREEMENT_ROOT = "0".repeat(64);

function buildPdfFixture(lines: readonly string[], flate = true): string {
  const content = lines
    .map((line) => `BT /F1 12 Tf 72 720 Td (${line.replace(/[\\()]/g, "\\$&")}) Tj ET`)
    .join("\n");
  let body = content;
  let filter = "";
  if (flate) {
    body = deflateSync(Buffer.from(content, "latin1")).toString("binary");
    filter = "/Filter /FlateDecode ";
  }
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< ${filter}/Length ${Buffer.byteLength(body, "binary")} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1").toString("base64");
}

function expectSuccess(outcome: DocumentSummaryOutcome): DocumentSummarySuccess {
  expect(outcome.status).toBe("completed");
  return outcome as DocumentSummarySuccess;
}

function canonicalResultHash(summary: string): string {
  const bytes = canonicalizePactJson({
    capability_profile: DOCUMENT_SUMMARY_PROFILE_ID,
    result: { summary },
  });
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalResultReference(agreementRoot: string, summary: string): string {
  const bytes = canonicalizePactJson({
    agreement_root: agreementRoot,
    capability_profile: DOCUMENT_SUMMARY_PROFILE_ID,
    result: { summary },
  });
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

afterEach(() => {
  __setDocumentSummaryClockForTesting(null);
});

describe("document-summary service", () => {
  describe("valid text documents", () => {
    it("summarizes a short plain-text document", () => {
      const outcome = summarizeDocument({
        source_document: "The quick brown fox jumps over the lazy dog.",
        input_media_type: "text/plain",
      });
      const success = expectSuccess(outcome);
      expect(success.mediaType).toBe("text/plain");
      expect(success.summary.length).toBeGreaterThan(0);
      expect(success.resultHash).toBe(canonicalResultHash(success.summary));
    });

    it("returns the full text when it fits within the summary bound", () => {
      const text = "PactAgent settles agreements over open Bitcoin protocols.";
      const outcome = summarizeDocument({ source_document: text, input_media_type: "text/plain" });
      const success = expectSuccess(outcome);
      expect(success.summary).toBe(text);
      expect(success.extractedChars).toBe(text.length);
    });

    it("produces a deterministic summary for the same input", () => {
      const document = [
        "Bitcoin enables decentralized settlement.",
        "Nostr carries signed events between independent agents.",
        "Cashu ecash provides privacy-preserving escrow.",
        "PactAgent binds these protocols into a bounded service agreement.",
        "The document-summary capability is the first real service.",
        "P002 provides the service while P001 requests it.",
        "Pricing is bounded to a 350-sat PoC amount.",
        "Execution is bounded to a five-minute maximum.",
        "Input is bounded to one megabyte of text or PDF.",
        "Result references commit to a SHA-256 hash.",
      ].join(" ");
      const first = summarizeDocument({ source_document: document, input_media_type: "text/plain" });
      const second = summarizeDocument({ source_document: document, input_media_type: "text/plain" });
      expect(second).toEqual(first);
    });

    it("truncates long documents to the maximum summary length", () => {
      const sentence =
        "PactAgent agents negotiate narrow service agreements over Nostr and settle through Cashu ecash escrow. ";
      const document = sentence.repeat(120);
      const outcome = summarizeDocument({ source_document: document, input_media_type: "text/plain" });
      const success = expectSuccess(outcome);
      expect(success.summary.length).toBeLessThanOrEqual(DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS);
    });
  });

  describe("result hash and reference", () => {
    it("generates a SHA-256 result hash", () => {
      const outcome = summarizeDocument({
        source_document: "Hash reference generation is required.",
        input_media_type: "text/plain",
      });
      const success = expectSuccess(outcome);
      expect(success.resultHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(success.resultHash).toBe(canonicalResultHash(success.summary));
    });

    it("generates an agreement-bound result reference when an agreement root is supplied", () => {
      const outcome = summarizeDocument({
        source_document: "Reference generation must match the capability profile.",
        input_media_type: "text/plain",
        agreementRoot: AGREEMENT_ROOT,
      });
      const success = expectSuccess(outcome);
      expect(success.resultReference).toBe(canonicalResultReference(AGREEMENT_ROOT, success.summary));
    });

    it("does not emit a result reference when no agreement root is supplied", () => {
      const outcome = summarizeDocument({
        source_document: "No agreement root means no bound reference.",
        input_media_type: "text/plain",
      });
      const success = expectSuccess(outcome);
      expect(success.resultReference).toBeUndefined();
    });
  });

  describe("oversized input", () => {
    it("rejects input exceeding the maximum document size", () => {
      const oversized = "x".repeat(DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES + 1);
      const outcome = summarizeDocument({
        source_document: oversized,
        input_media_type: "text/plain",
      });
      expect(outcome.status).toBe("failed");
      expect((outcome as { errorCode: string }).errorCode).toBe("input_too_large");
    });

    it("accepts input exactly at the maximum document size", () => {
      const atLimit = "a".repeat(DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES);
      const outcome = summarizeDocument({
        source_document: atLimit,
        input_media_type: "text/plain",
      });
      expect(outcome.status).toBe("completed");
    });
  });

  describe("unsupported types", () => {
    it("rejects an unsupported media type", () => {
      expect(() =>
        summarizeDocument({ source_document: "x", input_media_type: "text/html" as never }),
      ).toThrow(/Unsupported document media type/);
    });

    it("rejects an empty media type", () => {
      expect(() => summarizeDocument({ source_document: "x", input_media_type: "" as never })).toThrow(
        /not supported/,
      );
    });
  });

  describe("empty documents", () => {
    it("rejects an empty plain-text document", () => {
      const outcome = summarizeDocument({ source_document: "", input_media_type: "text/plain" });
      expect(outcome.status).toBe("failed");
      expect((outcome as { errorCode: string }).errorCode).toBe("empty_document");
    });

    it("rejects a whitespace-only plain-text document", () => {
      const outcome = summarizeDocument({ source_document: "   \n\t  ", input_media_type: "text/plain" });
      expect(outcome.status).toBe("failed");
      expect((outcome as { errorCode: string }).errorCode).toBe("empty_document");
    });
  });

  describe("execution bounding", () => {
    it("rejects a summary when the deadline elapses during execution", () => {
      const steppingClock = (() => {
        let step = 0;
        return () => {
          const value = 1_000_000 + step;
          step += 10_000;
          return value;
        };
      })();
      __setDocumentSummaryClockForTesting(steppingClock);
      const outcome = summarizeDocument({
        source_document: "This document must be summarized before the deadline.",
        input_media_type: "text/plain",
        deadlineSeconds: 1,
      });
      expect(outcome.status).toBe("failed");
      expect((outcome as { errorCode: string }).errorCode).toBe("execution_deadline_exceeded");
    });

    it("completes when execution stays within the configured deadline", () => {
      __setDocumentSummaryClockForTesting(() => 5_000_000);
      const outcome = summarizeDocument({
        source_document: "A bounded deadline must be respected when execution is fast.",
        input_media_type: "text/plain",
        deadlineSeconds: 1,
      });
      expect(outcome.status).toBe("completed");
    });

    it("completes exactly one millisecond before the deadline boundary", () => {
      const start = 2_000_000;
      let ticks = 0;
      __setDocumentSummaryClockForTesting(() => start + ticks++);
      const outcome = summarizeDocument({
        source_document: "Execution finishing just before the deadline succeeds.",
        input_media_type: "text/plain",
        deadlineSeconds: 1,
      });
      expect(outcome.status).toBe("completed");
    });

    it("fails exactly at the deadline boundary (expiry is inclusive)", () => {
      let ticks = 0;
      const start = 3_000_000;
      __setDocumentSummaryClockForTesting(() => {
        const value = start + ticks * 1_000;
        ticks += 1;
        return value;
      });
      const outcome = summarizeDocument({
        source_document: "Execution reaching the exact deadline fails.",
        input_media_type: "text/plain",
        deadlineSeconds: 1,
      });
      expect(outcome.status).toBe("failed");
      expect((outcome as { errorCode: string }).errorCode).toBe("execution_deadline_exceeded");
    });

    it("rejects deadlineSeconds exceeding the profile maximum", () => {
      expect(() =>
        summarizeDocument({
          source_document: "x",
          input_media_type: "text/plain",
          deadlineSeconds: DOCUMENT_SUMMARY_MAXIMUM_EXECUTION_SECONDS + 1,
        }),
      ).toThrow(/capability profile maximum/);
    });

    it("accepts deadlineSeconds exactly at the profile maximum", () => {
      __setDocumentSummaryClockForTesting(() => 7_000_000);
      const outcome = summarizeDocument({
        source_document: "The profile maximum deadline is acceptable.",
        input_media_type: "text/plain",
        deadlineSeconds: DOCUMENT_SUMMARY_MAXIMUM_EXECUTION_SECONDS,
      });
      expect(outcome.status).toBe("completed");
    });
  });

  describe("PDF documents", () => {
    it("summarizes a supported PDF document", () => {
      const pdf = buildPdfFixture([
        "PactAgent summarizes documents through a bounded service.",
        "The provider extracts text and returns a deterministic summary.",
      ]);
      const outcome = summarizeDocument({
        source_document: pdf,
        input_media_type: "application/pdf",
      });
      const success = expectSuccess(outcome);
      expect(success.mediaType).toBe("application/pdf");
      expect(success.summary).toContain("PactAgent summarizes documents");
      expect(success.resultHash).toBe(canonicalResultHash(success.summary));
    });

    it("rejects a PDF with no extractable text", () => {
      const pdf = buildPdfFixture(["   "]);
      const outcome = summarizeDocument({
        source_document: pdf,
        input_media_type: "application/pdf",
      });
      expect(outcome.status).toBe("failed");
      expect((outcome as { errorCode: string }).errorCode).toBe("empty_document");
    });
  });

  describe("private_prompt", () => {
    it("accepts a private_prompt without altering the deterministic output", () => {
      const document = "PactAgent provides a bounded document-summary service.";
      const withoutPrompt = summarizeDocument({ source_document: document, input_media_type: "text/plain" });
      const withPrompt = summarizeDocument({
        source_document: document,
        input_media_type: "text/plain",
        private_prompt: "Summarize this in 200 words.",
      });
      expect(withPrompt).toEqual(withoutPrompt);
    });
  });

  describe("provider failure representation", () => {
    it("represents an unsupported PDF as a clean failure outcome", () => {
      const outcome = summarizeDocument({
        source_document: "not-a-pdf",
        input_media_type: "application/pdf",
      });
      expect(outcome.status).toBe("failed");
      expect((outcome as { errorCode: string }).errorCode).toBe("unsupported_pdf");
    });

    it("represents an invalid base64 PDF as a clean failure outcome", () => {
      const outcome = summarizeDocument({
        source_document: "!!!not-base64!!!",
        input_media_type: "application/pdf",
      });
      expect(outcome.status).toBe("failed");
      const code = (outcome as { errorCode: string }).errorCode;
      expect(["unsupported_pdf", "pdf_extraction_failed"]).toContain(code);
    });
  });
});
