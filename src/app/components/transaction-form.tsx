"use client";

import { useMemo, useState } from "react";

import { generateIdempotencyKey, type RuntimeBootstrap } from "@/lib/pactagent-api-client";

const MAX_DOCUMENT_BYTES = 1_048_576;
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
3.1 Turnaround: Each summary shall be returned within 120 seconds of task delivery.
3.2 Availability: The service targets 99.5% monthly availability.
3.3 Accuracy: Summaries shall preserve all materially significant commitments and numeric values.

4. Fees and Payment
4.1 Fees are denominated in sats and settled via Cashu escrow.
4.2 The Customer funds an escrow before task delivery; release occurs on verified completion.
4.3 Refunds are authorized automatically if the service level is not met.

5. Confidentiality
Source documents and prompts are transmitted over encrypted private channels
and are never published to public event logs.

6. Term and Termination
This Agreement is effective for the duration of a single transaction and expires
automatically upon settlement or refund.`;

export interface TransactionFormInput {
  readonly idempotencyKey: string;
  readonly document: string;
  readonly mediaType: "text/plain" | "application/pdf";
  readonly prompt?: string;
  readonly budgetSats: string;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
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
  const [idempotencyKey] = useState(() => generateIdempotencyKey());
  const [fileName, setFileName] = useState<string | undefined>();
  const [docError, setDocError] = useState<string | undefined>();

  const documentBytes = useMemo(() => (document ? new Blob([document]).size : 0), [document]);

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
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      const base64 = bytesToBase64(bytes);
      const encodedSize = new Blob([base64]).size;
      if (encodedSize > MAX_DOCUMENT_BYTES) {
        setDocError(`PDF encodes to ${formatBytes(encodedSize)} after base64 — exceeds ${formatBytes(MAX_DOCUMENT_BYTES)} limit.`);
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

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (!document.trim()) return;
    onSubmit({
      idempotencyKey,
      document,
      mediaType,
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      budgetSats: budget,
    });
  }

  return (
    <div className="formView">
      <form onSubmit={handleSubmit} className="formCard">
        <h2>Submit a document for AI summarization</h2>
        <div className="mintInfo">
          <span className="dot" />
          <span>Mint: <code>{bootstrap.mintUrl}</code> · unit: <code>{bootstrap.unit}</code> · test ecash only</span>
        </div>

        <div className="docField">
          <div className="docModeToggle">
            <button
              type="button"
              className={inputMode === "text" ? "modeBtn active" : "modeBtn"}
              onClick={() => { setInputMode("text"); setDocument(""); setMediaType("text/plain"); setFileName(undefined); setDocError(undefined); }}
            >
              Paste text
            </button>
            <button
              type="button"
              className={inputMode === "file" ? "modeBtn active" : "modeBtn"}
              onClick={() => { setInputMode("file"); setDocument(""); setMediaType("text/plain"); setFileName(undefined); setDocError(undefined); }}
            >
              Upload PDF
            </button>
            <button type="button" className="sampleLink" onClick={() => { setDocument(SAMPLE_DOCUMENT); setMediaType("text/plain"); setInputMode("text"); setFileName(undefined); setDocError(undefined); }}>
              Load sample
            </button>
          </div>

          {inputMode === "file" ? (
            <>
              <label htmlFor="doc-upload" className="fileLabel">Upload PDF (max {formatBytes(MAX_DOCUMENT_BYTES)})</label>
              <input
                key={`file-${inputMode}`}
                id="doc-upload"
                type="file"
                accept="application/pdf,.pdf"
                onChange={handleFileUpload}
                aria-describedby="doc-meta"
              />
              <div className="docMeta" id="doc-meta">
                <span>{fileName ? `Loaded ${fileName} (${formatBytes(documentBytes)} encoded)` : "No PDF loaded"}</span>
              </div>
            </>
          ) : (
            <>
              <textarea
                id="doc-text"
                value={document}
                onChange={(e) => { setDocument(e.target.value); setMediaType("text/plain"); }}
                placeholder="Paste your document here, or load the sample contract…"
                aria-describedby="doc-meta"
              />
              <div className="docMeta" id="doc-meta">
                <span>{document ? `${formatBytes(documentBytes)} · ${document.length} chars` : "No document entered"}</span>
              </div>
            </>
          )}
          {docError && <p className="formError">{docError}</p>}
        </div>

        <div className="paramRow">
          <div className="paramField">
            <label htmlFor="budget">Max budget (sats)</label>
            <input id="budget" type="number" min={1} step={1} value={budget} onChange={(e) => setBudget(e.target.value)} required />
          </div>
          <div className="paramField">
            <label htmlFor="prompt">Private prompt (optional)</label>
            <input id="prompt" type="text" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Summarize concisely" />
          </div>
        </div>

        {error && <p className="formError">{error}</p>}

        <div className="submitRow">
          <button type="submit" className="submitBtn" disabled={submitting || !document.trim()}>
            {submitting ? "Submitting…" : "Start transaction"}
          </button>
        </div>
      </form>
    </div>
  );
}
