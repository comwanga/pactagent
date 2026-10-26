import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it, vi } from "vitest";

import {
  createPdfTextExtractor,
  DEFAULT_PDF_EXTRACTION_LIMITS,
  pdfExtractionLimitsFromEnv,
  PdfTextExtractError,
  validatePdfExtractionLimits,
  type PdfExtractionLimits,
} from "./pdf-text-extract";
import {
  createTextAccumulator,
  disableNativeDecompression,
  installDecodeBudget,
} from "./pdf-text-extract.worker.mjs";
import { summarizeDocument } from "./document-summary-service";

/*
 * Issue #61: PDF extraction runs in a bounded worker. These tests check that
 * accepted documents extract exactly as before, that every bound fails closed
 * with `resource_limit` (`pdf_extraction_failed` at the service boundary), and
 * that the application event loop stays responsive while pdf.js works.
 * Fixtures are generated here and kept small; adversarial ones are capped by
 * strict test limits so they cannot exhaust the host.
 */

const MAX_TEXT = 1_048_576;

/** The previous implementation (main@d1bb971), used as the compatibility reference. */
async function previousExtract(input: Buffer, maxText = MAX_TEXT): Promise<{ text: string; pageCount: number } | string> {
  let raw: string;
  let totalPages: number;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(input));
    const extracted = await extractText(pdf, { mergePages: true });
    totalPages = extracted.totalPages;
    raw = Array.isArray(extracted.text) ? extracted.text.join("\n") : extracted.text;
  } catch {
    return "invalid_pdf";
  }
  const bounded = raw.length > maxText ? raw.slice(0, maxText) : raw;
  const text = bounded.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length === 0) return "no_text";
  return { text, pageCount: Math.max(totalPages, 1) };
}

async function currentExtract(input: Buffer, limits?: Partial<PdfExtractionLimits>) {
  try {
    return await createPdfTextExtractor({ ...DEFAULT_PDF_EXTRACTION_LIMITS, ...limits }).extract(input);
  } catch (error) {
    if (error instanceof PdfTextExtractError) return error.code;
    throw error;
  }
}

interface FixtureOptions {
  readonly flate?: boolean;
  readonly indirectLength?: boolean;
  /** Font dictionary used as /F1, plus extra objects it references. */
  readonly font?: (add: (body: string | { dict: string; data: Buffer }) => number) => string;
}

function buildPdf(pages: readonly string[], options: FixtureOptions = {}): Buffer {
  const objects: (string | { dict: string; data: Buffer } | null)[] = [];
  const add = (body: string | { dict: string; data: Buffer }) => objects.push(body);
  const catalog = add("");
  const pagesObject = add("");
  const font = add(options.font ? options.font(add) : "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const content of pages) {
    const raw = Buffer.from(content, "latin1");
    const data = options.flate ? deflateSync(raw) : raw;
    const length = options.indirectLength ? `${add(`${data.length}`)} 0 R` : `${data.length}`;
    const stream = add({ dict: `<< /Length ${length}${options.flate ? " /Filter /FlateDecode" : ""} >>`, data });
    kids.push(add(
      `<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 612 792] /Contents ${stream} 0 R ` +
      `/Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    ));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObject} 0 R >>`;
  objects[pagesObject - 1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const parts = typeof body === "string"
      ? [Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1")]
      : [
          Buffer.from(`${index + 1} 0 obj\n${body!.dict}\nstream\n`, "latin1"),
          body!.data,
          Buffer.from("\nendstream\nendobj\n", "latin1"),
        ];
    for (const part of parts) {
      chunks.push(part);
      offset += part.length;
    }
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const value of offsets) xref += `${value.toString().padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF`;
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

const escape = (text: string) => text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const line = (text: string, y = 720) => `BT /F1 12 Tf 72 ${y} Td (${escape(text)}) Tj ET`;
const lines = (text: string, count: number) =>
  Array.from({ length: count }, (_, index) => line(`${text} ${index}`, 720 - (index % 60) * 12)).join("\n");

/** A subsetted Type0 font with Identity-H encoding whose text is recovered only through ToUnicode. */
function toUnicodeFixture(text: string): Buffer {
  const characters = [...new Set(text)];
  const code = (character: string) => (characters.indexOf(character) + 1).toString(16).padStart(4, "0").toUpperCase();
  const unicode = (character: string) => character.codePointAt(0)!.toString(16).padStart(4, "0").toUpperCase();
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    `${characters.length} beginbfchar`,
    ...characters.map((character) => `<${code(character)}> <${unicode(character)}>`),
    "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
  return buildPdf([`BT /F1 12 Tf 72 720 Td <${[...text].map(code).join("")}> Tj ET`], {
    flate: true,
    font: (add) => {
      const toUnicode = add({ dict: `<< /Length ${Buffer.byteLength(cmap, "latin1")} >>`, data: Buffer.from(cmap, "latin1") });
      const descriptor = add(
        "<< /Type /FontDescriptor /FontName /ABCDEF+FixtureSans /Flags 4 /FontBBox [0 -200 1000 900] " +
        "/ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>",
      );
      const descendant = add(
        "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+FixtureSans " +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 500 >>`,
      );
      return `<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+FixtureSans /Encoding /Identity-H ` +
        `/DescendantFonts [${descendant} 0 R] /ToUnicode ${toUnicode} 0 R >>`;
    },
  });
}

/** Writes a throwaway worker script, for failure modes pdf.js cannot be made to hit deterministically. */
function fakeWorker(source: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "pactagent-pdf-worker-")), "worker.mjs");
  writeFileSync(
    path,
    `import { parentPort, workerData } from "node:worker_threads";\n` +
    // Replies travel on the same dedicated result port the real worker uses.
    `const reply = (message) => workerData.resultPort.postMessage(message);\nvoid parentPort;\n${source}\n`,
  );
  return path;
}

const testLimits = (overrides: Partial<PdfExtractionLimits> = {}): PdfExtractionLimits => ({
  ...DEFAULT_PDF_EXTRACTION_LIMITS,
  ...overrides,
});

const VALID_PDF = buildPdf([line("A valid document.")]);

/**
 * Takes about 20 s to extract on the development machine and several seconds on
 * fast CI runners: 500 pages share one stream of 4,000 whitespace-only text
 * items, so the text cap never ends the reading early. Used to exceed a 1 s
 * deadline regardless of machine speed.
 */
function slowToExtractPdf(): Buffer {
  const content = Array.from({ length: 4_000 }, (_, index) => line("   ", 720 - (index % 60) * 12)).join("\n");
  const stream = deflateSync(Buffer.from(content, "latin1"));
  const objects: Buffer[] = [];
  const add = (body: string | Buffer) => objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  add(Buffer.concat([
    Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
    stream,
    Buffer.from("\nendstream", "latin1"),
  ]));
  const kids: string[] = [];
  for (let page = 0; page < 500; page += 1) {
    kids.push(`${add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>")} 0 R`);
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`, "latin1");
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    chunks.push(object);
    offset += object.length;
  });
  chunks.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((value) => `${value.toString().padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`,
    "latin1",
  ));
  return Buffer.concat(chunks);
}

/** A 1 s deadline with no other limit close enough to trip first. */
const DEADLINE_ONLY = { timeoutMs: 1_000, maxDecodedBytes: 1_024 * 1_024 * 1_024 } as const;
const TIMED_OUT = { code: "resource_limit", message: "PDF extraction exceeded its time limit" } as const;

describe("Issue #61 streaming text normalization", () => {
  /** The previous pipeline applied to already-extracted page texts. */
  const reference = (pages: readonly string[], maxChars: number) =>
    pages.join("\n").replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n")
      .slice(0, maxChars).replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  it("matches the previous pipeline on 3,000 generated inputs, including the text cap", () => {
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = ["a", "b", "Z", "é", "日", ".", " ", "  ", "\t", "\n", "\n\n\n", "\r", " ", " ", "﻿"];
    for (let round = 0; round < 3_000; round += 1) {
      const pages = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
        Array.from({ length: Math.floor(random() * 30) }, () => alphabet[Math.floor(random() * alphabet.length)]).join(""));
      const maxChars = 1 + Math.floor(random() * 60);
      const accumulator = createTextAccumulator(maxChars);
      pages.forEach((page, index) => {
        if (index > 0) accumulator.push("\n");
        // Feed in uneven pieces, as pdf.js text items arrive.
        for (let start = 0; start < page.length;) {
          const end = start + 1 + Math.floor(random() * 5);
          accumulator.push(page.slice(start, end));
          start = end;
        }
      });
      expect(accumulator.finish(), JSON.stringify({ pages, maxChars })).toBe(reference(pages, maxChars));
    }
  });
});

describe("Issue #61 decode budget", () => {
  it("counts allocations, not views, and keeps typed-array behavior intact", () => {
    let exceeded = 0;
    const scope = { Uint8Array };
    const budget = installDecodeBudget(scope, 100, () => { exceeded += 1; });
    const Counted = scope.Uint8Array;
    const allocated = new Counted(60);
    const view = new Counted(allocated.buffer);
    expect(budget.allocated).toBe(60);
    expect(allocated).toBeInstanceOf(Uint8Array);
    expect(new Uint8Array(4)).toBeInstanceOf(Counted);
    expect(view.byteLength).toBe(60);
    // from() allocates through the wrapped constructor, so it is counted.
    expect(Counted.from([1, 2]).length).toBe(2);
    new Counted([1, 2, 3]);
    expect(budget.allocated).toBe(65);
    expect(exceeded).toBe(0);
    new Counted(40);
    expect(exceeded).toBe(1);
  });
});

describe("Issue #61 native decompression is disabled in the worker", () => {
  it("reports whether native DecompressionStream could be removed", () => {
    const removable: { DecompressionStream?: unknown } = { DecompressionStream: class {} };
    expect(disableNativeDecompression(removable)).toBe(true);
    expect(removable.DecompressionStream).toBeUndefined();
    const locked = {};
    Object.defineProperty(locked, "DecompressionStream", { value: class {}, configurable: false, writable: false });
    expect(disableNativeDecompression(locked)).toBe(false);
  });

  it("removes the real global inside a worker thread on this Node version", async () => {
    // pdf.js would otherwise inflate streams natively, outside the decode budget.
    const helper = pathToFileURL(resolve("src/domain/pdf-text-extract.worker.mjs")).href;
    const result = await new Promise<{ before: string; disabled: boolean; after: string }>((settle, reject) => {
      const worker = new Worker(
        `import("${helper}").then(({ disableNativeDecompression }) => {
          const { parentPort } = require("node:worker_threads");
          const before = typeof globalThis.DecompressionStream;
          const disabled = disableNativeDecompression(globalThis);
          parentPort.postMessage({ before, disabled, after: typeof globalThis.DecompressionStream });
        });`,
        { eval: true },
      );
      worker.once("message", (message) => { settle(message); void worker.terminate(); });
      worker.once("error", reject);
    });
    expect(result).toEqual({ before: "function", disabled: true, after: "undefined" });
  });
});

describe("Issue #61 accepted documents extract exactly as before", () => {
  const fixtures: Record<string, Buffer> = {
    "one page": VALID_PDF,
    "multi-page": buildPdf([line("First page text."), line("Second page text."), line("Third page.")]),
    "hex strings": buildPdf(["BT /F1 12 Tf 72 720 Td <48656c6c6f206865782e> Tj ET"]),
    "indirect /Length": buildPdf([line("Indirect length."), line("Second.")], { indirectLength: true }),
    "compressed streams": buildPdf([lines("Compressed content line", 400), lines("More compressed content", 200)], { flate: true }),
    "subsetted font with ToUnicode": toUnicodeFixture("Héllo wörld, ToUnicode café 日本"),
    "whitespace runs across pages": buildPdf([line("Ends with spaces   "), "BT /F1 12 Tf 72 720 Td (   \t starts) Tj ET", line("x")]),
    "empty but structurally valid": buildPdf(["BT ET"]),
    "whitespace only": buildPdf([line("     ")]),
  };

  it.each(Object.entries(fixtures))("%s", async (_label, pdf) => {
    const expected = await previousExtract(pdf);
    expect(await currentExtract(pdf)).toEqual(expected);
  });

  it("recovers the text of a subsetted font through its ToUnicode map", async () => {
    expect(await currentExtract(toUnicodeFixture("Héllo wörld"))).toEqual({ text: "Héllo wörld", pageCount: 1 });
  });

  it("keeps the previous classification of non-PDF and malformed input", async () => {
    expect(await currentExtract(Buffer.from("not a pdf"))).toBe("invalid_pdf");
    const malformed = Buffer.from("%PDF-1.4\nthis is not a real pdf body", "latin1");
    expect(await currentExtract(malformed)).toBe(await previousExtract(malformed));
  });
});

describe("Issue #61 extraction limits", () => {
  it.each([[4, "accepted"], [5, "accepted"], [6, "resource_limit"]] as const)(
    "a %i-page document under a 5-page limit is %s",
    async (pageCount, outcome) => {
      const pdf = buildPdf(Array.from({ length: pageCount }, (_, index) => line(`Page ${index}`)));
      const result = await currentExtract(pdf, { maxPages: 5 });
      if (outcome === "accepted") {
        expect(result).toEqual(await previousExtract(pdf));
      } else {
        // Rejected by the pre-read page check, not after reading every page.
        await expect(createPdfTextExtractor(testLimits({ maxPages: 5 })).extract(pdf))
          .rejects.toMatchObject({ code: "resource_limit", message: "PDF has more pages than the extraction limit" });
      }
    },
  );

  it("rejects an excessive page count quickly, without reading the pages", async () => {
    const pdf = buildPdf(Array.from({ length: 2_000 }, () => line("x")));
    // The pre-read check names the page limit; a check after reading every
    // page would only see an invalid result.
    await expect(createPdfTextExtractor().extract(pdf))
      .rejects.toMatchObject({ code: "resource_limit", message: "PDF has more pages than the extraction limit" });
  }, 30_000);

  // 19 is exactly the limit, 20 is one over, 400 is far beyond it.
  it.each([19, 20, 400])(
    "truncates extracted text %i characters long to the 19-character limit exactly as before",
    async (length) => {
      const pdf = buildPdf([line("y".repeat(length))]);
      const result = await currentExtract(pdf, { maxTextChars: 19 });
      expect(result).toEqual({ text: "y".repeat(Math.min(length, 19)), pageCount: 1 });
    },
  );

  it("stops a highly compressed stream at the decoded-bytes limit", async () => {
    // About 32 KiB of source inflating to 32 MiB; the test budget is 4 MiB.
    const pdf = buildPdf([" ".repeat(32 * 1024 * 1024)], { flate: true });
    expect(pdf.length).toBeLessThan(64 * 1024);
    expect(await currentExtract(pdf, { maxDecodedBytes: 4 * 1024 * 1024 })).toBe("resource_limit");
  }, 30_000);

  it("stops compressed text at the text cap instead of extracting all of it", async () => {
    const pdf = buildPdf([lines("Compressed repeated text line here", 40_000)], { flate: true });
    const result = await currentExtract(pdf, { maxTextChars: 50_000 });
    // Identical to extracting everything and then cutting, as before.
    expect(result).toEqual(await previousExtract(pdf, 50_000));
  }, 30_000);

  it("stops reading once the text cap is reached", async () => {
    // Reading all 160,000 lines takes about 12 s; only an early stop fits the 5 s deadline.
    const pdf = buildPdf([lines("Compressed repeated text line here", 160_000)], { flate: true });
    const result = await currentExtract(pdf, { maxTextChars: 50_000, timeoutMs: 5_000 });
    expect(typeof result === "object" && result.text.length).toBeGreaterThan(49_000);
  }, 30_000);

  it("keeps a result the worker produced before a main-thread stall outlasted the deadline", async () => {
    // The worker finishes in well under a second while this thread is blocked
    // for 2.5 s. The deadline timer then fires before the queued reply is
    // delivered; it must use that reply instead of reporting a timeout.
    const extractor = createPdfTextExtractor(testLimits({ timeoutMs: 1_000 }));
    for (let trial = 0; trial < 3; trial += 1) {
      const pending = extractor.extract(VALID_PDF);
      const until = Date.now() + 2_500;
      while (Date.now() < until) {
        // Simulate an application event loop stalled past the deadline.
      }
      expect(await pending).toEqual({ text: "A valid document.", pageCount: 1 });
    }
  }, 30_000);

  it("terminates an extraction that exceeds its deadline", async () => {
    const started = performance.now();
    await expect(createPdfTextExtractor(testLimits(DEADLINE_ONLY)).extract(slowToExtractPdf())).rejects.toMatchObject(TIMED_OUT);
    expect(performance.now() - started).toBeLessThan(4_000);
  }, 30_000);
});

describe("Issue #61 worker failures fail closed", () => {
  const failures: Record<string, string> = {
    "exits without a result": "process.exit(1);",
    "throws during extraction": "throw new Error('worker crashed: /private/path SECRET-DOCUMENT');",
    "replies with a malformed result": "reply({ status: 'ok', text: 42 });",
    "replies with text over the cap": "reply({ status: 'ok', text: 'z'.repeat(64), pageCount: 1 });",
    "never replies": "setInterval(() => {}, 1000);",
    "spins forever": "for (;;) {}",
    "runs out of heap": "const hold = []; for (;;) hold.push(new Array(1e6).fill({ x: 1 }));",
  };

  it.each(Object.entries(failures))("a worker that %s", async (_label, source) => {
    const extractor = createPdfTextExtractor(testLimits({ timeoutMs: 1_000, maxHeapMb: 16, maxTextChars: 32 }), fakeWorker(source));
    const error = await extractor.extract(VALID_PDF).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PdfTextExtractError);
    expect(error).toMatchObject({ code: "resource_limit" });
    // No worker internals, paths or document content in the error.
    expect(String((error as Error).message)).not.toMatch(/SECRET|private|worker crashed|stack/i);
  }, 30_000);

  it("fails closed when the worker entry is missing", async () => {
    const extractor = createPdfTextExtractor(testLimits(), join(tmpdir(), "pactagent-missing-worker.mjs"));
    await expect(extractor.extract(VALID_PDF)).rejects.toMatchObject({ code: "resource_limit" });
  });
});

describe("Issue #61 concurrency and cleanup", () => {
  const slowWorker = fakeWorker("setTimeout(() => reply({ status: 'ok', text: 'done', pageCount: 1 }), 300);");

  it("runs simultaneous requests within the worker limit and completes them all", async () => {
    const extractor = createPdfTextExtractor(testLimits({ maxConcurrentWorkers: 2, maxQueuedExtractions: 8 }), slowWorker);
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: 6 }, () => extractor.extract(VALID_PDF)));
    const elapsed = performance.now() - started;
    expect(results.every((result) => result.text === "done")).toBe(true);
    // Six 300 ms jobs on two workers need at least three rounds.
    expect(elapsed).toBeGreaterThanOrEqual(850);
  }, 30_000);

  it("rejects requests beyond the waiting limit immediately and serves the rest", async () => {
    const extractor = createPdfTextExtractor(testLimits({ maxConcurrentWorkers: 1, maxQueuedExtractions: 1 }), slowWorker);
    const outcomes = await Promise.allSettled([1, 2, 3].map(() => extractor.extract(VALID_PDF)));
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect((outcomes[2] as PromiseRejectedResult).reason).toMatchObject({ code: "resource_limit" });
  }, 30_000);

  it("frees its single worker slot after repeated timeouts and crashes", async () => {
    // One extractor, one slot and no waiting room: each request can only start
    // if the previous worker has fully exited.
    const scripted = fakeWorker(`
      const request = Buffer.from(workerData.data).toString("latin1");
      if (request.includes("HANG")) for (;;) {}
      else if (request.includes("CRASH")) process.exit(3);
      else reply({ status: "ok", text: "served", pageCount: 1 });
    `);
    const extractor = createPdfTextExtractor(
      testLimits({ maxConcurrentWorkers: 1, maxQueuedExtractions: 0, timeoutMs: 1_000 }),
      scripted,
    );
    const request = (marker: string) => extractor.extract(Buffer.from(`%PDF-1.4 ${marker}`, "latin1"));
    for (let round = 0; round < 3; round += 1) {
      await expect(request("HANG")).rejects.toMatchObject({ code: "resource_limit" });
      await expect(request("CRASH")).rejects.toMatchObject({ code: "resource_limit" });
    }
    expect(await request("OK")).toEqual({ text: "served", pageCount: 1 });
  }, 30_000);

  it("keeps serving after repeated invalid PDFs and timeouts in the real worker", async () => {
    const extractor = createPdfTextExtractor(testLimits({ maxConcurrentWorkers: 1, maxQueuedExtractions: 0, ...DEADLINE_ONLY }));
    const slow = slowToExtractPdf();
    for (let round = 0; round < 3; round += 1) {
      await expect(extractor.extract(Buffer.from("%PDF-1.4\nbroken", "latin1"))).rejects.toMatchObject({ code: "invalid_pdf" });
    }
    for (let round = 0; round < 2; round += 1) {
      await expect(extractor.extract(slow)).rejects.toMatchObject(TIMED_OUT);
    }
    expect(await extractor.extract(VALID_PDF)).toEqual({ text: "A valid document.", pageCount: 1 });
  }, 60_000);

  it("leaves no timers behind after success and failure", async () => {
    const timersBefore = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
    await currentExtract(VALID_PDF);
    await currentExtract(buildPdf([" ".repeat(8 * 1024 * 1024)], { flate: true }), { maxDecodedBytes: 1024 * 1024 });
    await createPdfTextExtractor(testLimits({ timeoutMs: 1_000 }), fakeWorker("for (;;) {}")).extract(VALID_PDF).catch(() => undefined);
    const timersAfter = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
    expect(timersAfter).toBeLessThanOrEqual(timersBefore);
  }, 30_000);
});

describe("Issue #61 event-loop responsiveness", () => {
  it("keeps application event-loop latency under 100 ms while adversarial PDFs extract", async () => {
    const adversarial = [
      buildPdf(Array.from({ length: 4_000 }, () => line("x"))),
      buildPdf([lines("Compressed repeated text line here", 40_000)], { flate: true }),
      buildPdf([" ".repeat(64 * 1024 * 1024)], { flate: true }),
    ];
    let lastTick = performance.now();
    let maxGap = 0;
    const probe = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - lastTick);
      lastTick = now;
    }, 5);
    const started = performance.now();
    try {
      for (const pdf of adversarial) await currentExtract(pdf);
    } finally {
      maxGap = Math.max(maxGap, performance.now() - lastTick);
      clearInterval(probe);
    }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThan(500);
    expect(maxGap).toBeLessThan(100);
  }, 60_000);
});

describe("Issue #61 limit configuration", () => {
  it("documents conservative defaults", () => {
    expect(DEFAULT_PDF_EXTRACTION_LIMITS).toEqual({
      maxPages: 500,
      timeoutMs: 15_000,
      maxHeapMb: 128,
      maxDecodedBytes: 64 * 1024 * 1024,
      maxTextChars: 1_048_576,
      maxConcurrentWorkers: 2,
      maxQueuedExtractions: 8,
    });
  });

  it("reads overrides from the environment", () => {
    expect(pdfExtractionLimitsFromEnv({
      PACTAGENT_PDF_MAX_PAGES: "100",
      PACTAGENT_PDF_TIMEOUT_MS: "5000",
      PACTAGENT_PDF_WORKER_HEAP_MB: "64",
      PACTAGENT_PDF_MAX_DECODED_MB: "32",
      PACTAGENT_PDF_MAX_TEXT_CHARS: "1000",
      PACTAGENT_PDF_MAX_WORKERS: "1",
      PACTAGENT_PDF_MAX_QUEUED: "0",
    })).toEqual({
      maxPages: 100,
      timeoutMs: 5_000,
      maxHeapMb: 64,
      maxDecodedBytes: 32 * 1024 * 1024,
      maxTextChars: 1_000,
      maxConcurrentWorkers: 1,
      maxQueuedExtractions: 0,
    });
    expect(pdfExtractionLimitsFromEnv({})).toEqual(DEFAULT_PDF_EXTRACTION_LIMITS);
  });

  it.each([
    ["PACTAGENT_PDF_MAX_PAGES", "0"],
    ["PACTAGENT_PDF_MAX_PAGES", "-1"],
    ["PACTAGENT_PDF_MAX_PAGES", "1e3"],
    ["PACTAGENT_PDF_MAX_PAGES", "abc"],
    ["PACTAGENT_PDF_MAX_PAGES", ""],
    ["PACTAGENT_PDF_TIMEOUT_MS", "999999999"],
    ["PACTAGENT_PDF_TIMEOUT_MS", "500"],
    ["PACTAGENT_PDF_WORKER_HEAP_MB", "4"],
    ["PACTAGENT_PDF_MAX_TEXT_CHARS", "2000000"],
    ["PACTAGENT_PDF_MAX_WORKERS", "0"],
  ])("rejects %s=%j instead of disabling the limit", (name, value) => {
    expect(() => pdfExtractionLimitsFromEnv({ [name]: value })).toThrow();
  });

  it("rejects invalid limits passed in code", () => {
    expect(() => validatePdfExtractionLimits(testLimits({ maxPages: Number.NaN }))).toThrow();
    expect(() => createPdfTextExtractor(testLimits({ maxQueuedExtractions: -1 }))).toThrow();
  });

  it("fails every extraction closed when the environment is misconfigured", async () => {
    vi.resetModules();
    vi.stubEnv("PACTAGENT_PDF_MAX_PAGES", "lots");
    try {
      const extractModule = await import("./pdf-text-extract");
      await expect(extractModule.extractPdfText(VALID_PDF)).rejects.toMatchObject({ code: "resource_limit" });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("Issue #61 document-summary boundary", () => {
  const summarize = (pdf: Buffer) =>
    summarizeDocument({ source_document: pdf.toString("base64"), input_media_type: "application/pdf" });

  it("reports a document over the page limit as pdf_extraction_failed", async () => {
    const outcome = await summarize(buildPdf(Array.from({ length: 501 }, () => line("x"))));
    expect(outcome).toMatchObject({ status: "failed", errorCode: "pdf_extraction_failed" });
  }, 30_000);

  it("keeps unsupported_pdf and empty_document for malformed and textless PDFs", async () => {
    expect(await summarize(Buffer.from("%PDF-1.4\nbroken body", "latin1"))).toMatchObject({ errorCode: "unsupported_pdf" });
    expect(await summarize(buildPdf(["BT ET"]))).toMatchObject({ errorCode: "empty_document" });
  });

  it("produces the same summary and result hash on repeated extraction (requester and provider paths)", async () => {
    const pdf = buildPdf([lines("Requester and provider see the same text", 30)], { flate: true });
    const preflight = await summarize(pdf);
    const execution = await summarize(pdf);
    expect(preflight.status).toBe("completed");
    expect(execution).toEqual(preflight);
  }, 30_000);
});
