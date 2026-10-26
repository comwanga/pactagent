# Document-summary PDF extraction limits (#61)

`document-summary@1` accepts PDFs up to 1 MiB. Text is extracted with pdf.js
6.1.200, bundled in `unpdf` 1.8.1 (pinned exactly). Requester preflight and
provider execution both call `summarizeDocument`, which calls the same
`extractPdfText`, so both sides parse PDFs with the same code. Each service
reads its own limits; see
[Requester and provider limits can disagree](#requester-and-provider-limits-can-disagree).

## Isolation

pdf.js never runs on the application event loop. Each extraction starts a fresh
`node:worker_threads` worker from `src/domain/pdf-text-extract.worker.mjs`:

- The parent validates the `%PDF-` header, transfers the bytes to the worker,
  and owns the wall-clock deadline. A worker that misses its deadline is
  terminated. The parent's concurrency slot is released only after the worker
  has exited.
- The worker replies on a dedicated message channel. When the deadline fires,
  the parent first checks that channel synchronously, so a result the worker
  produced in time is kept even if the parent's event loop was too busy to
  receive it before the deadline.
- The worker gets its own V8 heap limit, no inherited loader flags
  (`execArgv: []`), and an empty environment, so application secrets are not
  visible to pdf.js. It does not log; pdf.js warnings can quote document
  structure.
- There is no fallback to extracting on the main thread.

In the adversarial tests, application event-loop latency stayed below 100 ms
(about 20–65 ms measured on Windows/Node 24). The previous in-process extractor
stalled the loop for the whole extraction: 13.3 s for a 4,000-page document
and 12.3 s for a 62 KiB compressed text stream.

## Limits

| Limit | Default | Environment variable | Accepted range |
|---|---|---|---|
| Pages | 500 | `PACTAGENT_PDF_MAX_PAGES` | 1–10,000 |
| Deadline per extraction, from worker start | 15,000 ms | `PACTAGENT_PDF_TIMEOUT_MS` | 1,000–120,000 ms |
| Worker V8 heap (old generation) | 128 MB | `PACTAGENT_PDF_WORKER_HEAP_MB` | 16–1,024 MB |
| Decoded stream bytes | 64 MiB | `PACTAGENT_PDF_MAX_DECODED_MB` | 1–1,024 MiB |
| Extracted characters | 1,048,576 | `PACTAGENT_PDF_MAX_TEXT_CHARS` | 1–1,048,576 |
| Workers running at once | 2 | `PACTAGENT_PDF_MAX_WORKERS` | 1–16 |
| Extractions waiting for a worker | 8 | `PACTAGENT_PDF_MAX_QUEUED` | 0–256 |

A variable that is set but invalid (not a plain integer, or out of range) is
never ignored: every PDF extraction in that process then fails closed with
`pdf_extraction_failed`.

How the defaults were chosen (worker measurements on Windows, Node 24):

- **Pages:** a 500-page document extracts in about 1.6 s; legitimate 1 MiB text
  PDFs rarely exceed a few hundred pages. The count is checked before any page
  is read, so a 4,000-page document is rejected in about 0.5 s.
- **Deadline:** the slowest accepted fixture took about 3.2 s. The deadline
  includes worker start-up and loading pdf.js (about 0.3–0.5 s), which is why
  values under 1 s are rejected.
- **Heap:** the largest accepted fixture peaked at 38 MB.
- **Decoded bytes:** the largest accepted fixture decoded 8 MiB.
- **Extracted characters:** unchanged from before (the 1 MiB source limit).

### Requester and provider limits can disagree

Preflight does not guarantee that the provider will accept the document. The
requester service (preflight, before funding) and the provider service
(execution, after funding) each read their own `PACTAGENT_PDF_*` values, and
nothing checks that they are compatible. A provider can therefore reject a PDF
after the escrow is funded, in two ways:

- **Different configuration.** If the provider's limits are stricter than the
  requester's, a document can pass preflight and then fail at the provider. No
  deployment config sets these variables today, so both services use the
  defaults above.
- **Machine-dependent limits.** The deadline and the heap limit depend on the
  machine running the worker. Even with identical values, a document that
  extracts just within the deadline during preflight can exceed it on a slower
  or busier provider. The defaults leave a wide margin (15 s against 3.2 s for
  the slowest accepted fixture), which makes this unlikely but not impossible.

When this happens the provider records `execution_failed` and publishes
nothing, so the agreement stays at `escrow_funded`. No funds are lost: the
requester runtime refunds the escrow automatically once its locktime passes
(900 s by default). The requester's value is locked until then, and the
transaction fails.

### Decoded bytes and memory

V8 heap limits do not cover `ArrayBuffer` memory, which is where pdf.js keeps
decoded streams. A crafted 64 KiB PDF can inflate to 64 MiB or more. The worker
therefore:

- removes native `DecompressionStream`, so pdf.js uses its own decoders.
  pdf.js already falls back to them for corrupt streams, and they give the
  same bytes for valid ones. Brotli-compressed streams, a recent PDF 2.0
  addition, are then not decoded.
- counts every `new Uint8Array(n)` made while extracting. Every pdf.js stream
  decoder (Flate, LZW, RunLength, ASCII85/Hex, predictors, decryption) grows
  its output this way. The worker stops before an allocation that would pass
  the limit.

Together with the heap limit, this bounds the worker's memory. It is not an
operating-system limit: native memory outside these paths, such as Node's own
buffers, is not counted.

## Extracted text

Pages are read one at a time, and text is normalized as it is read. Reading
stops once the character limit is reached. The result is identical to the
previous behavior: extract all text, normalize it, cut it at the limit, then
trim. This was checked byte for byte against the previous implementation on
generated fixtures (multi-page, hex strings, indirect `/Length`, Flate, a
subsetted Type0 font with ToUnicode, empty and whitespace-only pages) and on
Chromium-generated PDFs (subsetted TrueType fonts, ToUnicode, CJK text,
ligatures, tables, 10 pages). Each document is destroyed after extraction.

## Failure codes

| Situation | `summarizeDocument` error |
|---|---|
| Not a PDF, malformed, encrypted or unreadable | `unsupported_pdf` (unchanged) |
| Valid PDF with no extractable text | `empty_document` (unchanged) |
| Too many pages, deadline missed, decoded-bytes or heap limit, worker crash or unexpected exit, too many extractions waiting, misconfigured limits | `pdf_extraction_failed` |

Error messages are fixed strings. They contain no document text, prompts,
paths, stack traces or worker details.

A PDF that fails during requester preflight stops the transaction with
`execution_failed` before any escrow is prepared or funded. The provider
enforces its own configured limits again before executing; it does not rely on
the requester's preflight.

## Deployment

The worker entry is plain JavaScript that imports only `node:worker_threads`
and `unpdf`. It is resolved at run time from the project root (`process.cwd()`)
as `src/domain/pdf-text-extract.worker.mjs`, so neither webpack nor Turbopack
rewrites it. Every supported start command runs from the project root: the
Railway web service (`next start` in `/app`), the provider service, the local
scripts and Vitest. The production image copies `src/` and `node_modules/`. A
missing worker file fails closed with `pdf_extraction_failed`.
