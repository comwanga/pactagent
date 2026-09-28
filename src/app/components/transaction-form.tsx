"use client";

import { useState } from "react";

import { generateIdempotencyKey, type RuntimeBootstrap } from "@/lib/pactagent-api-client";

const MAX_DOCUMENT_BYTES = 1_048_576;
const MAX_PROMPT_BYTES = 2_048;
const DEFAULT_BUDGET = "500";

const SAMPLE_DOCUMENT = `SERVICE LEVEL AGREEMENT — DATA SUMMARIZATION

1. Parties
This Service Level Agreement ("Agreement") is entered into between the Requester
("Customer") and the Provider ("Service Provider") for the provision of
automated document summarization services.

2. Scope of Services
The Service Provider shall provide automated summarization of text and PDF
documents supplied by the Customer. Each summary shall be bounded by the
private prompt accompanying the request and delivered through an encrypted
private transport channel.

3. Service Levels
3.1 Turnaround: Each summary shall be returned within 120 seconds of task
    delivery.
3.2 Availability: The service targets 99.5% monthly availability, excluding
    scheduled maintenance.
3.3 Accuracy: Summaries shall preserve all materially significant commitments
    and numeric values present in the source document.

4. Fees and Payment
4.1 Fees are denominated in sats and settled via Cashu ecrow.
4.2 The Customer funds an escrow before task delivery; release occurs on
    verified completion.
4.3 Refunds are authorized automatically if the service level is not met.

5. Confidentiality
Source documents and prompts are transmitted over encrypted private channels
and are never published to public event logs.

6. Term and Termination
This Agreement is effective for the duration of a single transaction and
expires automatically upon settlement or refund.`;

export interface TransactionFormInput {
  readonly idempotencyKey: string;
  readonly document: string;
  readonly mediaType: "text/plain" | "application/pdf";
  readonly prompt?: string;
  readonly budgetSats: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice = bytes.subarray(offset, offset + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

export function TransactionForm({
  bootstrap,
  submitting,
  onSubmit,
  error,
}: {
  bootstrap: RuntimeBootstrap;
  submitting: boolean;
  onSubmit: (input: TransactionFormInput) => void;
  error?: string;
}): React.ReactElement {
  const [document, setDocument] = useState("");
  const [mediaType, setMediaType] = useState<"text/plain" | "application/pdf">("text/plain");
  const [inputMode, setInputMode] = useState<"text" | "file">("text");
  const [prompt, setPrompt] = useState("");
  const [budget, setBudget] = useState(DEFAULT_BUDGET);
  const [docError, setDocError] = useState<string | undefined>();
  const [promptError, setPromptError] = useState<string | undefined>();
  const [budgetError, setBudgetError] = useState<string | undefined>();
  const [idempotencyKey] = useState(() => generateIdempotencyKey());
  const [fileName, setFileName] = useState<string | undefined>();
  const [reviewing, setReviewing] = useState(false);

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setDocError("Only PDF files are supported in upload mode. Paste text instead.");
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setDocError(`Document exceeds ${formatBytes(MAX_DOCUMENT_BYTES)} limit`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const bytes =
        typeof reader.result === "string"
          ? new TextEncoder().encode(reader.result)
          : new Uint8Array(reader.result as ArrayBuffer);
      const base64 = bytesToBase64(bytes);
      const encodedSize = new Blob([base64]).size;
      if (encodedSize > MAX_DOCUMENT_BYTES) {
        setDocError(
          `PDF encodes to ${formatBytes(encodedSize)} after base64 — exceeds ${formatBytes(MAX_DOCUMENT_BYTES)} request limit.`,
        );
        return;
      }
      setDocument(base64);
      setMediaType("application/pdf");
      setFileName(file.name);
      setDocError(undefined);
    };
    reader.onerror = () => setDocError("Failed to read file");
    reader.readAsArrayBuffer(file);
  }

  function loadSample(): void {
    setDocument(SAMPLE_DOCUMENT);
    setMediaType("text/plain");
    setInputMode("text");
    setFileName(undefined);
    setDocError(undefined);
  }

  function validate(): boolean {
    let valid = true;
    if (!document) {
      setDocError("Document is required");
      valid = false;
    } else if (new Blob([document]).size > MAX_DOCUMENT_BYTES) {
      setDocError(`Document exceeds ${formatBytes(MAX_DOCUMENT_BYTES)} limit`);
      valid = false;
    } else {
      setDocError(undefined);
    }
    if (prompt && new Blob([prompt]).size > MAX_PROMPT_BYTES) {
      setPromptError(`Prompt exceeds ${formatBytes(MAX_PROMPT_BYTES)} limit`);
      valid = false;
    } else {
      setPromptError(undefined);
    }
    const budgetNum = Number(budget);
    if (!Number.isInteger(budgetNum) || budgetNum < 1) {
      setBudgetError("Budget must be a positive whole number of sats");
      valid = false;
    } else {
      setBudgetError(undefined);
    }
    return valid;
  }

  function handleReview(e: React.FormEvent): void {
    e.preventDefault();
    if (validate()) setReviewing(true);
  }

  function handleConfirmSubmit(): void {
    onSubmit({
      idempotencyKey,
      document,
      mediaType,
      ...(prompt ? { prompt } : {}),
      budgetSats: budget,
    });
  }

  const documentBytes = document ? new Blob([document]).size : 0;

  return (
    <section className="section" aria-labelledby="form-heading">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow dark">New transaction</p>
          <h2 id="form-heading">Summarize a document for ≤ {budget} sats</h2>
        </div>
        <p className="sectionNote">
          Cashu test mint: <code>{bootstrap.mintUrl}</code> · unit: <code>{bootstrap.unit}</code> · test ecash only
        </p>
      </div>

      <form onSubmit={handleReview} className="txnForm">
        <fieldset>
          <legend>Private document</legend>

          <div className="mediaToggle" role="radiogroup" aria-label="Input method">
            <label className={inputMode === "text" ? "active" : ""}>
              <input
                type="radio"
                name="inputMode"
                value="text"
                checked={inputMode === "text"}
                onChange={() => {
                  setInputMode("text");
                  setDocument("");
                  setMediaType("text/plain");
                  setFileName(undefined);
                  setDocError(undefined);
                }}
              />
              Paste text
            </label>
            <label className={inputMode === "file" ? "active" : ""}>
              <input
                type="radio"
                name="inputMode"
                value="file"
                checked={inputMode === "file"}
                onChange={() => {
                  setInputMode("file");
                  setDocument("");
                  setMediaType("text/plain");
                  setFileName(undefined);
                  setDocError(undefined);
                }}
              />
              Upload PDF
            </label>
            <button type="button" className="sampleBtn" onClick={loadSample}>
              Load sample contract
            </button>
          </div>

          {inputMode === "file" ? (
            <>
              <label htmlFor="doc-upload">Upload PDF (max {formatBytes(MAX_DOCUMENT_BYTES)})</label>
              <input
                id="doc-upload"
                type="file"
                accept="application/pdf,.pdf"
                onChange={handleFileUpload}
                aria-describedby="doc-status"
              />
              <small id="doc-status" className="inputHelp">
                {fileName
                  ? `Loaded ${fileName} (${formatBytes(documentBytes)} encoded)`
                  : "No PDF loaded"}
              </small>
            </>
          ) : (
            <>
              <label htmlFor="doc-text">Paste document text</label>
              <textarea
                id="doc-text"
                value={document}
                onChange={(e) => {
                  setDocument(e.target.value);
                  setMediaType("text/plain");
                }}
                rows={8}
                placeholder="Paste your document here, or load the sample contract…"
                aria-describedby="doc-status"
              />
              <small id="doc-status" className="inputHelp">
                {document ? `${formatBytes(documentBytes)} · ${document.length} characters` : "No document entered"}
              </small>
            </>
          )}
          {docError && <p role="alert" className="errorText">{docError}</p>}
        </fieldset>

        <fieldset>
          <legend>Request parameters</legend>
          <label htmlFor="budget">Maximum budget (sats)</label>
          <input
            id="budget"
            type="number"
            min={1}
            step={1}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            required
            aria-describedby="budget-help"
          />
          <small id="budget-help" className="inputHelp">
            Whole sats only. Default: 500.
          </small>
          {budgetError && <p role="alert" className="errorText">{budgetError}</p>}

          <label htmlFor="prompt">Private prompt (optional, max {formatBytes(MAX_PROMPT_BYTES)})</label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            placeholder="e.g. Summarize concisely"
            aria-describedby="prompt-help"
          />
          <small id="prompt-help" className="inputHelp">
            Bounded instruction sent privately to the provider.
          </small>
          {promptError && <p role="alert" className="errorText">{promptError}</p>}
        </fieldset>

        {error && <p role="alert" className="errorText">{error}</p>}

        {reviewing ? (
          <div className="reviewPanel" role="region" aria-label="Review request before submission">
            <h3 className="reviewHeading">Review your request</h3>
            <p className="inputHelp">
              Confirm the details below. Submission uses one stable idempotency key, so retrying the
              same request will not create a duplicate agreement.
            </p>
            <dl className="reviewGrid">
              <div><dt>Document</dt><dd>{mediaType === "application/pdf" ? `PDF · ${fileName ?? "uploaded"} · ${formatBytes(documentBytes)}` : `Text · ${formatBytes(documentBytes)} · ${document.length} characters`}</dd></div>
              <div><dt>Media type</dt><dd>{mediaType}</dd></div>
              <div><dt>Maximum budget</dt><dd>{budget} sats</dd></div>
              <div><dt>Private prompt</dt><dd>{prompt ? `${prompt.length} characters` : "None"}</dd></div>
              <div><dt>Idempotency key</dt><dd><code>{idempotencyKey.slice(0, 16)}…</code></dd></div>
            </dl>
            <div className="reviewActions">
              <button
                type="button"
                className="primaryBtn"
                disabled={submitting}
                onClick={handleConfirmSubmit}
              >
                {submitting ? "Submitting…" : "Confirm and submit"}
              </button>
              <button
                type="button"
                className="closeBtn"
                disabled={submitting}
                onClick={() => setReviewing(false)}
              >
                Back to edit
              </button>
            </div>
          </div>
        ) : (
          <button type="submit" className="primaryBtn" disabled={submitting || !document}>
            Review request
          </button>
        )}
      </form>
    </section>
  );
}
