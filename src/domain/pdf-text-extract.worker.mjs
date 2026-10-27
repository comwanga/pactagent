/*
 * Issue #61: isolated PDF text extraction worker.
 *
 * pdf.js runs here, in a worker thread, never on the application's event loop.
 * This file is plain JavaScript and imports only `node:worker_threads` and
 * `unpdf`, so the same file runs unchanged under Vitest, tsx (the standalone
 * provider) and the Next.js production server, on Node 22 and 24, without a
 * TypeScript loader or a bundler.
 *
 * Bounds enforced here (the parent enforces the wall-clock deadline, the V8
 * heap limit and concurrency):
 *   - page count: checked before any page is read;
 *   - extracted text: read incrementally and stopped once the cap is reached;
 *   - decoded stream bytes: pdf.js grows every decoded stream through
 *     `new Uint8Array(n)`, which is counted here. Native DecompressionStream is
 *     removed so pdf.js uses those bounded decoders instead of buffering a
 *     whole native inflate first. V8 heap limits do not cover this memory.
 */
import { parentPort, workerData } from "node:worker_threads";

export const PDF_WORKER_KIND = "pactagent-pdf-text-extract";
/** Exit code the worker uses when the decoded-bytes budget is exceeded. */
export const DECODE_BUDGET_EXIT_CODE = 86;

/**
 * Streaming equivalent of the previous extraction pipeline:
 *   unpdf `normalizeMergedText(pages.join("\n"))`, then `.slice(0, maxChars)`,
 *   then the application's whitespace normalization and `trim()`.
 * Every maximal whitespace run maps to " " when it holds no newline, or to one
 * or two newlines otherwise, so output can be emitted as input arrives and
 * reading can stop once `maxChars` characters are final.
 */
export function createTextAccumulator(maxChars) {
  const parts = [];
  let length = 0;
  let inRun = false;
  let runNewlines = 0;

  const emit = (value) => {
    parts.push(value);
    length += value.length;
  };
  const flushRun = () => {
    if (!inRun) return;
    emit(runNewlines === 0 ? " " : runNewlines === 1 ? "\n" : "\n\n");
    inRun = false;
    runNewlines = 0;
  };

  return {
    get full() {
      return length >= maxChars;
    },
    push(text) {
      if (length >= maxChars) return;
      for (const match of text.matchAll(/(\s+)|(\S+)/g)) {
        if (match[1] !== undefined) {
          inRun = true;
          for (const character of match[1]) if (character === "\n") runNewlines += 1;
        } else {
          flushRun();
          emit(match[2]);
          if (length >= maxChars) return;
        }
      }
    },
    finish() {
      if (length < maxChars) flushRun();
      return parts.join("").slice(0, maxChars).trim();
    },
  };
}

/**
 * Counts bytes allocated through `scope.Uint8Array` and calls `onExceeded`
 * once the total passes `maxBytes`. Views over an existing buffer allocate
 * nothing and are not counted. `instanceof`, static methods and subclassing
 * keep working because the constructor is wrapped, not replaced.
 */
export function installDecodeBudget(scope, maxBytes, onExceeded) {
  const Native = scope.Uint8Array;
  let allocated = 0;
  const proxy = new Proxy(Native, {
    construct(target, args, newTarget) {
      const [first] = args;
      let bytes = 0;
      if (typeof first === "number") bytes = first;
      else if (first !== null && typeof first === "object" && !(first instanceof ArrayBuffer) &&
        !(typeof SharedArrayBuffer !== "undefined" && first instanceof SharedArrayBuffer)) {
        bytes = typeof first.length === "number" ? first.length : 0;
      }
      allocated += bytes;
      if (allocated > maxBytes) onExceeded();
      return Reflect.construct(target, args, newTarget === proxy ? target : newTarget);
    },
  });
  scope.Uint8Array = proxy;
  return { get allocated() { return allocated; } };
}

/**
 * Removes native DecompressionStream so pdf.js falls back to its own bounded
 * decoders. Returns false if it is still reachable, in which case the worker
 * refuses to extract rather than inflate streams outside the budget.
 */
export function disableNativeDecompression(scope) {
  try {
    delete scope.DecompressionStream;
  } catch {
    // Non-configurable on this runtime; try overwriting it below.
  }
  if (typeof scope.DecompressionStream !== "undefined") {
    try {
      scope.DecompressionStream = undefined;
    } catch {
      // Read-only as well.
    }
  }
  return typeof scope.DecompressionStream === "undefined";
}

function textOf(item) {
  return item.str + (item.hasEOL ? "\n" : "");
}

class PdfCleanupError extends Error {}

function extractionFailure(error) {
  // These are document errors from the pinned pdf.js engine. Unknown errors
  // (including runtime failures) are not evidence of an unsupported PDF.
  const invalidDocument = error instanceof Error &&
    ["InvalidPDFException", "PasswordException", "FormatError"].includes(error.name);
  return { status: invalidDocument ? "invalid_pdf" : "worker_error" };
}

/** Extracts bounded text from one document. Resolves to a status message. */
export async function extractBoundedText(data, limits) {
  const { getDocumentProxy } = await import("unpdf");
  let pdf;
  try {
    pdf = await getDocumentProxy(data);
  } catch (error) {
    return extractionFailure(error);
  }
  try {
    const pageCount = pdf.numPages;
    if (!Number.isSafeInteger(pageCount) || pageCount < 0) return { status: "invalid_pdf" };
    if (pageCount > limits.maxPages) return { status: "page_limit_exceeded" };
    const text = createTextAccumulator(limits.maxTextChars);
    for (let pageNumber = 1; pageNumber <= pageCount && !text.full; pageNumber += 1) {
      if (pageNumber > 1) text.push("\n");
      const page = await pdf.getPage(pageNumber);
      // Same items, in the same order, as page.getTextContent(), but read
      // incrementally so a huge page stops at the text cap.
      const reader = page.streamTextContent().getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (item.str == null) continue;
            text.push(textOf(item));
            if (text.full) break;
          }
          if (text.full) {
            // pdf.js requires an Error reason; a bare cancel() (as from
            // breaking a for-await loop) throws an uncaught assertion.
            try {
              await reader.cancel(new Error("Extracted text limit reached"));
            } catch {
              throw new PdfCleanupError();
            }
            break;
          }
        }
      } finally {
        try {
          page.cleanup();
        } catch {
          throw new PdfCleanupError();
        }
      }
    }
    return { status: "ok", text: text.finish(), pageCount };
  } catch (error) {
    return extractionFailure(error);
  } finally {
    // Releases the document's parsed objects, fonts and caches.
    try {
      await pdf.loadingTask.destroy();
    } catch {
      // Already torn down; nothing further to release.
    }
  }
}

async function runWorker() {
  const { data, limits, resultPort } = workerData;
  // pdf.js warnings can quote document structure; this worker never logs.
  for (const method of ["log", "info", "warn", "error", "debug"]) console[method] = () => undefined;
  if (!disableNativeDecompression(globalThis)) {
    resultPort.postMessage({ status: "worker_error" });
    return;
  }
  installDecodeBudget(globalThis, limits.maxDecodedBytes, () => process.exit(DECODE_BUDGET_EXIT_CODE));
  const result = await extractBoundedText(new Uint8Array(data), limits);
  // A dedicated port, so the parent can read a finished result synchronously
  // even when its own event loop was too busy to deliver it in time.
  resultPort.postMessage(result);
}

if (parentPort && workerData?.kind === PDF_WORKER_KIND) {
  // An unexpected failure is not evidence that the document is malformed.
  runWorker().catch(() => workerData.resultPort.postMessage({ status: "worker_error" }));
}
