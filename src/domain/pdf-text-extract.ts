import { extractText, getDocumentProxy } from "unpdf";

import { InvalidDomainInputError } from "./errors";
import { DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES } from "./pact-service-agreement";

/**
 * PDF text extraction backed by the pdf.js engine (via unpdf). pdf.js resolves
 * font encodings and ToUnicode CMaps, so text from real-world PDFs that subset
 * their fonts (Word, Chrome, LibreOffice, LaTeX) is recovered correctly rather
 * than as glyph-code gibberish. Extraction is deterministic for a given input
 * and engine version, so the requester preflight and the provider reach the
 * same extractable/not-extractable decision.
 */

export type PdfTextExtractErrorCode = "invalid_pdf" | "no_text";

export class PdfTextExtractError extends InvalidDomainInputError {
  readonly code: PdfTextExtractErrorCode;

  constructor(code: PdfTextExtractErrorCode, message: string) {
    super(message);
    this.name = "PdfTextExtractError";
    this.code = code;
  }
}

export interface PdfExtractResult {
  readonly text: string;
  readonly pageCount: number;
}

const PDF_HEADER = Buffer.from("%PDF-");

export async function extractPdfText(input: Buffer): Promise<PdfExtractResult> {
  if (input.length < PDF_HEADER.length || input.subarray(0, PDF_HEADER.length).equals(PDF_HEADER) === false) {
    throw new PdfTextExtractError("invalid_pdf", "Input is not a valid PDF document");
  }

  let totalPages: number;
  let rawText: string;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(input));
    const extracted = await extractText(pdf, { mergePages: true });
    totalPages = extracted.totalPages;
    rawText = Array.isArray(extracted.text) ? extracted.text.join("\n") : extracted.text;
  } catch {
    // A malformed, encrypted, or otherwise unreadable PDF.
    throw new PdfTextExtractError("invalid_pdf", "PDF could not be parsed for text extraction");
  }

  // Bound the processed text so an enormous document cannot drive unbounded
  // downstream work; the source document itself is already size-capped.
  const bounded =
    rawText.length > DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES
      ? rawText.slice(0, DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES)
      : rawText;
  // Collapse runs of non-newline whitespace to single spaces and cap blank
  // lines, keeping the extracted word stream intact for summarisation.
  const normalized = bounded
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length === 0) {
    throw new PdfTextExtractError("no_text", "PDF does not expose extractable text in a supported encoding");
  }
  return { text: normalized, pageCount: Math.max(totalPages, 1) };
}
