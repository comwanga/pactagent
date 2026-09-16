import { createHash } from "node:crypto";

import { InvalidDomainInputError } from "./errors";
import { extractPdfText, PdfTextExtractError } from "./pdf-text-extract";
import {
  canonicalizePactJson,
  createPactResultReference,
  DOCUMENT_SUMMARY_INPUT_MEDIA_TYPES,
  DOCUMENT_SUMMARY_MAXIMUM_EXECUTION_SECONDS,
  DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES,
  DOCUMENT_SUMMARY_PROFILE_ID,
} from "./pact-service-agreement";

export type DocumentSummaryMediaType = (typeof DOCUMENT_SUMMARY_INPUT_MEDIA_TYPES)[number];

export const DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS = 800;
export const DOCUMENT_SUMMARY_DEFAULT_DEADLINE_SECONDS = DOCUMENT_SUMMARY_MAXIMUM_EXECUTION_SECONDS;

export type DocumentSummaryServiceErrorCode =
  | "input_too_large"
  | "unsupported_media_type"
  | "empty_document"
  | "unsupported_pdf"
  | "pdf_extraction_failed"
  | "execution_deadline_exceeded"
  | "provider_error";

export class DocumentSummaryServiceError extends InvalidDomainInputError {
  readonly code: DocumentSummaryServiceErrorCode;

  constructor(code: DocumentSummaryServiceErrorCode, message: string) {
    super(message);
    this.name = "DocumentSummaryServiceError";
    this.code = code;
  }
}

export interface DocumentSummaryRequest {
  readonly source_document: string;
  readonly input_media_type: DocumentSummaryMediaType;
  readonly private_prompt?: string;
  readonly agreementRoot?: string;
  readonly deadlineSeconds?: number;
}

export interface DocumentSummarySuccess {
  readonly status: "completed";
  readonly summary: string;
  readonly mediaType: DocumentSummaryMediaType;
  readonly extractedChars: number;
  readonly resultHash: string;
  readonly resultReference?: string;
}

export interface DocumentSummaryFailure {
  readonly status: "failed";
  readonly errorCode: DocumentSummaryServiceErrorCode;
  readonly message: string;
}

export type DocumentSummaryOutcome = DocumentSummarySuccess | DocumentSummaryFailure;

export interface ExecutionDeadline {
  readonly startedAt: number;
  readonly deadlineMs: number;
  exhausted(now: () => number): boolean;
}

function createDeadline(startedAt: number, deadlineMs: number): ExecutionDeadline {
  return {
    startedAt,
    deadlineMs,
    exhausted(now) {
      return now() - startedAt > deadlineMs;
    },
  };
}

let clock: () => number = () => Date.now();

/** Test-only hook to make the execution deadline deterministically testable. */
export function __setDocumentSummaryClockForTesting(replacement: (() => number) | null): void {
  clock = replacement ?? (() => Date.now());
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "he", "in", "is", "it", "its", "of", "on", "that", "the", "to", "was", "were",
  "will", "with", "this", "these", "those", "but", "or", "not", "they", "their",
  "we", "you", "your", "our", "i", "she", "his", "her", "than", "then", "so",
  "if", "into", "about", "which", "who", "whom", "when", "where", "why", "how",
  "all", "any", "both", "each", "few", "more", "most", "other", "some", "such",
  "no", "nor", "only", "own", "same", "very", "can", "do", "does", "did", "should",
  "would", "could", "may", "might", "must", "shall", "also", "been", "being",
  "had", "having", "them", "there", "here", "what", "whilst", "per", "via",
]);

const SENTENCE_PATTERN = /[^.!?]+[.!?]+(?:["')\]]+)?|\S+$/g;

function fail(code: DocumentSummaryServiceErrorCode, message: string): DocumentSummaryFailure {
  return { status: "failed", errorCode: code, message };
}

function validateRequestShape(input: unknown): DocumentSummaryRequest {
  if (typeof input !== "object" || input === null) {
    throw new DocumentSummaryServiceError("provider_error", "Document-summary request must be an object");
  }
  const candidate = input as Record<string, unknown>;
  const allowedKeys = ["source_document", "input_media_type", "private_prompt", "agreementRoot", "deadlineSeconds"];
  if (Object.keys(candidate).some((key) => !allowedKeys.includes(key))) {
    throw new DocumentSummaryServiceError("provider_error", "Document-summary request contains unsupported fields");
  }
  if (typeof candidate.source_document !== "string") {
    throw new DocumentSummaryServiceError("provider_error", "Document-summary source_document must be a string");
  }
  if (!DOCUMENT_SUMMARY_INPUT_MEDIA_TYPES.includes(candidate.input_media_type as DocumentSummaryMediaType)) {
    return failShapeForMediaType(candidate.input_media_type);
  }
  if (
    candidate.private_prompt !== undefined &&
    (typeof candidate.private_prompt !== "string" || candidate.private_prompt.length === 0)
  ) {
    throw new DocumentSummaryServiceError("provider_error", "Document-summary private_prompt must be a non-empty string");
  }
  if (
    candidate.agreementRoot !== undefined &&
    (typeof candidate.agreementRoot !== "string" || !/^[0-9a-f]{64}$/.test(candidate.agreementRoot))
  ) {
    throw new DocumentSummaryServiceError("provider_error", "Document-summary agreementRoot must be a Nostr event id");
  }
  if (
    candidate.deadlineSeconds !== undefined &&
    (!Number.isInteger(candidate.deadlineSeconds) || (candidate.deadlineSeconds as number) < 1)
  ) {
    throw new DocumentSummaryServiceError("provider_error", "Document-summary deadlineSeconds must be a positive integer");
  }
  return candidate as unknown as DocumentSummaryRequest;
}

function failShapeForMediaType(value: unknown): never {
  if (typeof value === "string" && value.length > 0) {
    throw new DocumentSummaryServiceError("unsupported_media_type", `Unsupported document media type: ${value}`);
  }
  throw new DocumentSummaryServiceError("unsupported_media_type", "Document-summary input_media_type is not supported");
}

function checkSize(sourceDocument: string): DocumentSummaryFailure | undefined {
  if (Buffer.byteLength(sourceDocument, "utf8") > DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES) {
    return fail("input_too_large", "Document exceeds the maximum supported input size");
  }
  return undefined;
}

function extractPlainText(request: DocumentSummaryRequest): string | DocumentSummaryFailure {
  if (request.source_document.length === 0) {
    return fail("empty_document", "Document is empty");
  }
  if (request.input_media_type === "text/plain") {
    const trimmed = request.source_document.trim();
    if (trimmed.length === 0) return fail("empty_document", "Document contains no non-whitespace text");
    return request.source_document;
  }
  return extractPdfDocument(request.source_document);
}

function extractPdfDocument(source: string): string | DocumentSummaryFailure {
  const bytes = decodeBase64Pdf(source);
  if (typeof bytes === "string") return fail("unsupported_pdf", bytes);
  try {
    const result = extractPdfText(bytes);
    if (result.text.length === 0) return fail("empty_document", "PDF does not contain extractable text");
    return result.text;
  } catch (error) {
    if (error instanceof PdfTextExtractError) {
      if (error.code === "invalid_pdf") return fail("unsupported_pdf", error.message);
      if (error.code === "no_text") return fail("empty_document", error.message);
      return fail("pdf_extraction_failed", error.message);
    }
    return fail("pdf_extraction_failed", "PDF text extraction failed");
  }
}

function decodeBase64Pdf(source: string): Buffer | string {
  const trimmed = source.trim();
  if (trimmed.length === 0) return "PDF source is empty";
  const bytes = Buffer.from(trimmed, "base64");
  if (bytes.length < 5 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return "PDF source is not a valid base64-encoded PDF document";
  }
  return bytes;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}

function splitSentences(text: string): string[] {
  const matches = text.match(SENTENCE_PATTERN);
  if (matches === null) return [];
  return matches
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function tokenize(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function summarize(text: string, deadline: ExecutionDeadline): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS) {
    return clampSummary(normalized);
  }
  const sentences = splitSentences(normalized);
  if (sentences.length <= 1) {
    return clampSummary(normalized);
  }

  const termFrequencies = new Map<string, number>();
  const sentenceTokens: string[][] = [];
  for (let index = 0; index < sentences.length; index++) {
    const tokens = tokenize(sentences[index]);
    sentenceTokens.push(tokens);
    for (const token of tokens) {
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    }
    if ((index & 0x3f) === 0 && deadline.exhausted(clock)) {
      return clampSummary(sentences.slice(0, Math.max(1, Math.floor(sentences.length / 4))).join(" "));
    }
  }

  const maximumFrequency = Math.max(1, ...termFrequencies.values());
  const scored = sentences.map((sentence, index) => {
    const tokens = sentenceTokens[index];
    if (tokens.length === 0) {
      return { index, score: 0, sentence };
    }
    const frequencySum = tokens.reduce((sum, token) => sum + (termFrequencies.get(token) ?? 0) / maximumFrequency, 0);
    const positionBoost = index < 2 ? 0.15 : 0;
    const lengthPenalty = tokens.length > 40 ? 0.1 : 0;
    return { index, score: frequencySum / tokens.length + positionBoost - lengthPenalty, sentence };
  });

  const targetCount = clamp(Math.round(sentences.length * 0.25), 1, 5);
  const selected = [...scored]
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    })
    .slice(0, targetCount)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.sentence);

  return clampSummary(selected.join(" "));
}

function clampSummary(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS) return collapsed;
  const truncated = collapsed.slice(0, DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS - 1);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + "\u2026";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function computeResultHash(summary: string): string {
  const bytes = canonicalizePactJson({
    capability_profile: DOCUMENT_SUMMARY_PROFILE_ID,
    result: { summary },
  });
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function computeResultReference(agreementRoot: string, summary: string): string {
  return createPactResultReference(DOCUMENT_SUMMARY_PROFILE_ID, agreementRoot, { summary });
}

export function summarizeDocument(input: unknown): DocumentSummaryOutcome {
  const request = validateRequestShape(input);

  const oversized = checkSize(request.source_document);
  if (oversized !== undefined) return oversized;

  const deadlineSeconds = request.deadlineSeconds ?? DOCUMENT_SUMMARY_DEFAULT_DEADLINE_SECONDS;
  const startedAt = clock();
  const deadline = createDeadline(startedAt, deadlineSeconds * 1000);

  const extracted = extractPlainText(request);
  if (typeof extracted !== "string") return extracted;
  if (extracted.trim().length === 0) return fail("empty_document", "Document contains no extractable text");

  if (deadline.exhausted(clock)) {
    return fail("execution_deadline_exceeded", "Document summary exceeded the execution deadline");
  }

  let summary: string;
  try {
    summary = summarize(extracted, deadline);
  } catch (error) {
    if (deadline.exhausted(clock)) {
      return fail("execution_deadline_exceeded", "Document summary exceeded the execution deadline");
    }
    return fail("provider_error", error instanceof Error ? error.message : "Document summary failed");
  }
  if (deadline.exhausted(clock)) {
    return fail("execution_deadline_exceeded", "Document summary exceeded the execution deadline");
  }
  if (summary.trim().length === 0) {
    return fail("empty_document", "Document summary produced no content");
  }

  const success: DocumentSummarySuccess = {
    status: "completed",
    summary,
    mediaType: request.input_media_type,
    extractedChars: extracted.length,
    resultHash: computeResultHash(summary),
    ...(request.agreementRoot !== undefined
      ? { resultReference: computeResultReference(request.agreementRoot, summary) }
      : {}),
  };
  return success;
}
