import { resolve } from "node:path";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

import { InvalidDomainInputError } from "./errors";
import { DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES } from "./pact-service-agreement";

/**
 * PDF text extraction backed by the pdf.js engine (via unpdf). pdf.js resolves
 * font encodings and ToUnicode CMaps, so text from real-world PDFs that subset
 * their fonts (Word, Chrome, LibreOffice, LaTeX) is recovered correctly rather
 * than as glyph-code gibberish. Extraction is deterministic for a given input
 * and engine version, so the requester preflight and the provider reach the
 * same extractable/not-extractable decision.
 *
 * That holds for the text itself. The resource limits below are read by each
 * service from its own environment, and the deadline and heap limit depend on
 * the machine, so a provider can still reject a document that passed preflight
 * (docs/document-summary-pdf-limits.md).
 *
 * Issue #61: pdf.js runs in a worker thread (`pdf-text-extract.worker.mjs`),
 * never on this event loop, and every extraction is bounded in pages,
 * extracted text, decoded stream bytes, V8 heap, wall-clock time and
 * concurrency. A bound that is hit fails with `resource_limit`, which the
 * document-summary service reports as `pdf_extraction_failed`. There is no
 * fallback to extracting on the main thread.
 */

export type PdfTextExtractErrorCode = "invalid_pdf" | "no_text" | "resource_limit";

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

export interface PdfExtractionLimits {
  /** Documents with more pages are rejected before any page is read. */
  readonly maxPages: number;
  /** Wall-clock budget per extraction, from worker start; the worker is then terminated. */
  readonly timeoutMs: number;
  /** V8 old-generation heap for the worker. Does not cover ArrayBuffer memory. */
  readonly maxHeapMb: number;
  /** Total bytes pdf.js may allocate for decoded streams (covers ArrayBuffer memory). */
  readonly maxDecodedBytes: number;
  /** Extracted characters kept; reading stops once this many are final. */
  readonly maxTextChars: number;
  /** Extraction workers running at once. */
  readonly maxConcurrentWorkers: number;
  /** Extractions waiting for a worker; further requests fail immediately. */
  readonly maxQueuedExtractions: number;
}

const MIB = 1024 * 1024;

/**
 * Defaults, chosen from measured worker behavior (docs/document-summary-pdf-limits.md):
 * a 500-page document extracts in about 1.6 s; the slowest accepted fixture
 * takes about 3.2 s, uses at most 38 MB of heap and decodes at most 8 MiB.
 */
export const DEFAULT_PDF_EXTRACTION_LIMITS: PdfExtractionLimits = Object.freeze({
  maxPages: 500,
  timeoutMs: 15_000,
  maxHeapMb: 128,
  maxDecodedBytes: 64 * MIB,
  maxTextChars: DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES,
  maxConcurrentWorkers: 2,
  maxQueuedExtractions: 8,
});

/** Accepted range for each limit; anything else is a configuration error. */
const LIMIT_RANGES: Readonly<Record<keyof PdfExtractionLimits, readonly [number, number]>> = {
  maxPages: [1, 10_000],
  // The deadline includes worker start-up and loading pdf.js (about 0.3–0.5 s
  // measured), so shorter deadlines could never succeed.
  timeoutMs: [1_000, 120_000],
  maxHeapMb: [16, 1_024],
  maxDecodedBytes: [MIB, 1_024 * MIB],
  maxTextChars: [1, DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES],
  maxConcurrentWorkers: [1, 16],
  maxQueuedExtractions: [0, 256],
};

const ENVIRONMENT_VARIABLES: Readonly<Record<keyof PdfExtractionLimits, { readonly name: string; readonly scale: number }>> = {
  maxPages: { name: "PACTAGENT_PDF_MAX_PAGES", scale: 1 },
  timeoutMs: { name: "PACTAGENT_PDF_TIMEOUT_MS", scale: 1 },
  maxHeapMb: { name: "PACTAGENT_PDF_WORKER_HEAP_MB", scale: 1 },
  maxDecodedBytes: { name: "PACTAGENT_PDF_MAX_DECODED_MB", scale: MIB },
  maxTextChars: { name: "PACTAGENT_PDF_MAX_TEXT_CHARS", scale: 1 },
  maxConcurrentWorkers: { name: "PACTAGENT_PDF_MAX_WORKERS", scale: 1 },
  maxQueuedExtractions: { name: "PACTAGENT_PDF_MAX_QUEUED", scale: 1 },
};

const LIMIT_KEYS = Object.keys(LIMIT_RANGES) as (keyof PdfExtractionLimits)[];

/** Validates limits; throws on any missing, non-integer or out-of-range value. */
export function validatePdfExtractionLimits(limits: PdfExtractionLimits): PdfExtractionLimits {
  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    const [minimum, maximum] = LIMIT_RANGES[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new InvalidDomainInputError(`PDF extraction limit ${key} is invalid`);
    }
  }
  return Object.freeze({ ...limits });
}

/**
 * Reads limit overrides from the environment. Unset variables keep their
 * defaults; a set but invalid value throws rather than disabling a limit.
 */
export function pdfExtractionLimitsFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
): PdfExtractionLimits {
  const limits: Record<string, number> = { ...DEFAULT_PDF_EXTRACTION_LIMITS };
  for (const key of LIMIT_KEYS) {
    const { name, scale } = ENVIRONMENT_VARIABLES[key];
    const raw = environment[name];
    if (raw === undefined) continue;
    if (!/^[0-9]+$/.test(raw.trim())) {
      throw new InvalidDomainInputError(`${name} must be a positive integer`);
    }
    limits[key] = Number(raw.trim()) * scale;
  }
  return validatePdfExtractionLimits(limits as unknown as PdfExtractionLimits);
}

/**
 * The worker entry is plain JavaScript resolved from the project root, the
 * directory every supported start command runs from (`next start`, the
 * provider service, Vitest). The path is built at run time so no bundler
 * rewrites it; a missing file fails closed.
 */
export function pdfTextExtractWorkerPath(): string {
  return resolve(process.cwd(), "src", "domain", "pdf-text-extract.worker.mjs");
}

const PDF_HEADER = Buffer.from("%PDF-");
const PDF_WORKER_KIND = "pactagent-pdf-text-extract";
const DECODE_BUDGET_EXIT_CODE = 86;

function resourceLimit(message: string): PdfTextExtractError {
  return new PdfTextExtractError("resource_limit", message);
}

type WorkerOutcome = PdfExtractResult | PdfTextExtractError;

/** Strictly checks the worker's reply; anything unexpected fails closed. */
function readWorkerMessage(message: unknown, limits: PdfExtractionLimits): WorkerOutcome {
  if (typeof message !== "object" || message === null) {
    return resourceLimit("PDF extraction returned an invalid result");
  }
  const { status, text, pageCount } = message as Record<string, unknown>;
  if (status === "invalid_pdf") {
    return new PdfTextExtractError("invalid_pdf", "PDF could not be parsed for text extraction");
  }
  if (status === "page_limit_exceeded") {
    return resourceLimit("PDF has more pages than the extraction limit");
  }
  if (
    status !== "ok" ||
    typeof text !== "string" ||
    text.length > limits.maxTextChars ||
    !Number.isSafeInteger(pageCount) ||
    (pageCount as number) < 0 ||
    (pageCount as number) > limits.maxPages
  ) {
    return resourceLimit("PDF extraction returned an invalid result");
  }
  if (text.length === 0) {
    return new PdfTextExtractError("no_text", "PDF does not expose extractable text in a supported encoding");
  }
  return { text, pageCount: Math.max(pageCount as number, 1) };
}

/** Runs one extraction in a fresh worker; always settles once and leaves no worker behind. */
function runInWorker(input: Buffer, limits: PdfExtractionLimits, workerPath: string): Promise<WorkerOutcome> {
  const data = new Uint8Array(input).buffer;
  // The worker replies on its own channel, which can be read synchronously.
  const { port1: results, port2: resultPort } = new MessageChannel();
  return new Promise((settle) => {
    let worker: Worker;
    try {
      worker = new Worker(workerPath, {
        name: "pactagent-pdf-text-extract",
        workerData: {
          kind: PDF_WORKER_KIND,
          data,
          limits: {
            maxPages: limits.maxPages,
            maxTextChars: limits.maxTextChars,
            maxDecodedBytes: limits.maxDecodedBytes,
          },
          resultPort,
        },
        transferList: [data, resultPort],
        resourceLimits: {
          maxOldGenerationSizeMb: limits.maxHeapMb,
          maxYoungGenerationSizeMb: Math.min(16, limits.maxHeapMb),
          stackSizeMb: 4,
        },
        // A plain isolate: no inherited loader flags and no application secrets.
        execArgv: [],
        env: {},
      });
    } catch {
      results.close();
      settle(resourceLimit("PDF extraction worker could not start"));
      return;
    }

    let outcome: WorkerOutcome | undefined;
    const accept = (message: unknown) => {
      outcome ??= readWorkerMessage(message, limits);
      void worker.terminate();
    };
    /** A reply the worker already sent but this event loop has not delivered yet. */
    const takeQueuedReply = (): boolean => {
      const queued = receiveMessageOnPort(results);
      if (queued === undefined) return false;
      accept(queued.message);
      return true;
    };
    const timer = setTimeout(() => {
      // After a stall on this thread, the timer can run before a reply that
      // arrived in time; that extraction finished and its result stands.
      if (takeQueuedReply()) return;
      outcome ??= resourceLimit("PDF extraction exceeded its time limit");
      void worker.terminate();
    }, limits.timeoutMs);

    results.once("message", accept);
    worker.once("error", () => {
      // Includes ERR_WORKER_OUT_OF_MEMORY and a missing or broken worker entry.
      outcome ??= resourceLimit("PDF extraction worker failed");
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (outcome === undefined) takeQueuedReply();
      results.close();
      if (outcome === undefined) {
        outcome = code === DECODE_BUDGET_EXIT_CODE
          ? resourceLimit("PDF decoded content exceeds the extraction limit")
          : resourceLimit("PDF extraction worker stopped unexpectedly");
      }
      // Settled only after the worker has exited, so a concurrency slot is
      // never released while its worker is still running.
      settle(outcome);
    });
  });
}

/** Bounds running and waiting extractions; excess requests fail immediately. */
class ExtractionScheduler {
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(private readonly limits: PdfExtractionLimits) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running >= this.limits.maxConcurrentWorkers) {
      if (this.#waiting.length >= this.limits.maxQueuedExtractions) {
        throw resourceLimit("Too many PDF extractions are in progress");
      }
      await new Promise<void>((resume) => this.#waiting.push(resume));
    } else {
      this.#running += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running -= 1;
    }
  }
}

export interface PdfTextExtractor {
  extract(input: Buffer): Promise<PdfExtractResult>;
}

/** Creates an extractor with its own limits and concurrency bounds. */
export function createPdfTextExtractor(
  limits: PdfExtractionLimits = DEFAULT_PDF_EXTRACTION_LIMITS,
  workerPath: string = pdfTextExtractWorkerPath(),
): PdfTextExtractor {
  const validated = validatePdfExtractionLimits(limits);
  const scheduler = new ExtractionScheduler(validated);
  return {
    async extract(input: Buffer): Promise<PdfExtractResult> {
      if (input.length < PDF_HEADER.length || input.subarray(0, PDF_HEADER.length).equals(PDF_HEADER) === false) {
        throw new PdfTextExtractError("invalid_pdf", "Input is not a valid PDF document");
      }
      const outcome = await scheduler.run(() => runInWorker(input, validated, workerPath));
      if (outcome instanceof PdfTextExtractError) throw outcome;
      return outcome;
    },
  };
}

let defaultExtractor: PdfTextExtractor | Error | undefined;

function getDefaultExtractor(): PdfTextExtractor {
  if (defaultExtractor === undefined) {
    try {
      defaultExtractor = createPdfTextExtractor(pdfExtractionLimitsFromEnv(process.env));
    } catch {
      defaultExtractor = new Error("invalid configuration");
    }
  }
  if (defaultExtractor instanceof Error) {
    // Misconfigured limits fail closed for every document; nothing is disabled.
    throw resourceLimit("PDF extraction limits are not configured correctly");
  }
  return defaultExtractor;
}

/** Extracts text with the limits configured for this process. */
export async function extractPdfText(input: Buffer): Promise<PdfExtractResult> {
  return getDefaultExtractor().extract(input);
}
