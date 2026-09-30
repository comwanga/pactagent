import { DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS } from "../domain/document-summary-service";
import {
  DocumentSummaryModelFailure,
  type DocumentSummaryContext,
  type DocumentSummaryModel,
  type DocumentSummaryRequest,
} from "./document-summary-model";

export interface OpenAIDocumentSummaryConfiguration {
  readonly apiKey: string;
  readonly modelName: string;
  readonly endpoint?: string;
  readonly maximumResponseBytes?: number;
  readonly fetchImplementation?: typeof fetch;
}

export type DocumentSummaryModeConfiguration =
  | Readonly<{ mode: "local" }>
  | Readonly<{
      mode: "model";
      provider: "openai" | "openrouter";
      modelName: string;
      apiKey: string;
    }>;

export class DocumentSummaryModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentSummaryModelConfigurationError";
  }
}

function requiredEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new DocumentSummaryModelConfigurationError(`${name} is required in model mode`);
  return value;
}

export function readDocumentSummaryModeConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DocumentSummaryModeConfiguration {
  const mode = environment.PACTAGENT_PROVIDER_EXECUTION_MODE?.trim() || "local";
  if (mode === "local") return Object.freeze({ mode });
  if (mode !== "model") {
    throw new DocumentSummaryModelConfigurationError(
      "PACTAGENT_PROVIDER_EXECUTION_MODE must be local or model",
    );
  }
  const provider = requiredEnvironmentValue(environment, "PACTAGENT_PROVIDER_MODEL_PROVIDER");
  if (provider !== "openai" && provider !== "openrouter") {
    throw new DocumentSummaryModelConfigurationError(
      "PACTAGENT_PROVIDER_MODEL_PROVIDER must be openai or openrouter",
    );
  }
  return Object.freeze({
    mode,
    provider,
    modelName: requiredEnvironmentValue(environment, "PACTAGENT_PROVIDER_MODEL_NAME"),
    apiKey: requiredEnvironmentValue(environment, "PACTAGENT_PROVIDER_MODEL_API_KEY"),
  });
}

const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 64 * 1024;

function buildSystemPrompt(): string {
  return [
    "You are a document summarization service.",
    "Summarize the provided document concisely, preserving all materially significant commitments and numeric values.",
    "If a private prompt is provided, follow its instructions for the summary style and focus.",
    `The summary must not exceed ${DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS} characters.`,
    "Return only the summary text, no preamble or meta-commentary.",
  ].join(" ");
}

function buildUserMessage(request: DocumentSummaryRequest): string {
  const parts: string[] = [];
  if (request.private_prompt) {
    parts.push(`Private prompt: ${request.private_prompt}`, "");
  }
  parts.push("Document:", request.source_document);
  return parts.join("\n");
}

function extractSummaryText(envelope: unknown): string | undefined {
  if (typeof envelope !== "object" || envelope === null) return undefined;
  const choices = (envelope as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) return undefined;
  const message = (choice as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

export function createOpenAIDocumentSummaryModel(
  configuration: OpenAIDocumentSummaryConfiguration,
): DocumentSummaryModel {
  const apiKey = configuration.apiKey.trim();
  const modelName = configuration.modelName.trim();
  if (!apiKey) throw new DocumentSummaryModelConfigurationError("Document summary model API key is required");
  if (!modelName) throw new DocumentSummaryModelConfigurationError("Document summary model name is required");
  const endpoint = configuration.endpoint ?? DEFAULT_OPENAI_ENDPOINT;
  const maximumResponseBytes =
    configuration.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
  const fetchImplementation = configuration.fetchImplementation ?? fetch;

  return Object.freeze({
    async summarize(
      request: DocumentSummaryRequest,
      context: DocumentSummaryContext,
    ): Promise<import("../domain/document-summary-service").DocumentSummaryOutcome> {
      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              { role: "system", content: buildSystemPrompt() },
              { role: "user", content: buildUserMessage(request) },
            ],
            max_tokens: 4096,
            temperature: 0.3,
          }),
          signal: context.signal,
        });
      } catch {
        throw new DocumentSummaryModelFailure(
          context.signal.aborted ? "timeout" : "unavailable",
        );
      }
      if (!response.ok) throw new DocumentSummaryModelFailure("unavailable");
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maximumResponseBytes) {
        throw new DocumentSummaryModelFailure("unavailable");
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new DocumentSummaryModelFailure("unavailable");
      }
      if (new TextEncoder().encode(text).byteLength > maximumResponseBytes) {
        throw new DocumentSummaryModelFailure("unavailable");
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new DocumentSummaryModelFailure("unavailable");
      }
      const summary = extractSummaryText(envelope);
      if (summary === undefined || summary.trim().length === 0) {
        throw new DocumentSummaryModelFailure("unavailable");
      }
      const trimmed = summary.trim();
      const clamped =
        trimmed.length <= DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS
          ? trimmed
          : trimmed.slice(0, DOCUMENT_SUMMARY_MAXIMUM_SUMMARY_CHARS - 1) + "\u2026";
      return {
        status: "completed",
        summary: clamped,
        mediaType: request.input_media_type,
        extractedChars: request.source_document.length,
        resultHash: `sha256:${clamped}`,
      };
    },
  });
}
