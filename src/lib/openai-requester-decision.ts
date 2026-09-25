import {
  RequesterDecisionModelFailure,
  type RequesterDecisionModelContext,
} from "./requester-decision";
import type {
  RequesterRecommendationRequest,
  RequesterRecommendationTransport,
} from "./model-requester-decision";

const DEFAULT_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 64 * 1024;

export interface OpenAIRequesterDecisionConfiguration {
  readonly apiKey: string;
  readonly modelName: string;
  readonly endpoint?: string;
  readonly maximumResponseBytes?: number;
  readonly fetchImplementation?: typeof fetch;
}

export type RequesterDecisionModeConfiguration =
  | Readonly<{ mode: "deterministic" }>
  | Readonly<{
      mode: "model";
      provider: "openai";
      modelName: string;
      apiKey: string;
    }>;

export class RequesterModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequesterModelConfigurationError";
  }
}

function requiredEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new RequesterModelConfigurationError(`${name} is required in model mode`);
  return value;
}

export function readRequesterDecisionModeConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RequesterDecisionModeConfiguration {
  const mode = environment.PACTAGENT_REQUESTER_DECISION_MODE?.trim() || "deterministic";
  if (mode === "deterministic") return Object.freeze({ mode });
  if (mode !== "model") {
    throw new RequesterModelConfigurationError(
      "PACTAGENT_REQUESTER_DECISION_MODE must be deterministic or model",
    );
  }
  const provider = requiredEnvironmentValue(environment, "PACTAGENT_REQUESTER_MODEL_PROVIDER");
  if (provider !== "openai") {
    throw new RequesterModelConfigurationError(
      "PACTAGENT_REQUESTER_MODEL_PROVIDER must be openai",
    );
  }
  return Object.freeze({
    mode,
    provider,
    modelName: requiredEnvironmentValue(environment, "PACTAGENT_REQUESTER_MODEL_NAME"),
    apiKey: requiredEnvironmentValue(environment, "PACTAGENT_REQUESTER_MODEL_API_KEY"),
  });
}

const RECOMMENDATION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["recommend", "decline"] },
    providerPublicKey: { type: ["string", "null"] },
    providerDefinitionReference: { type: ["string", "null"] },
    offerReference: { type: ["string", "null"] },
    escrowDescriptorReference: { type: ["string", "null"] },
    proposedAmountSats: { type: ["string", "null"], pattern: "^[1-9][0-9]*$" },
    rationale: { type: "string", maxLength: 500 },
  },
  required: [
    "action",
    "providerPublicKey",
    "providerDefinitionReference",
    "offerReference",
    "escrowDescriptorReference",
    "proposedAmountSats",
    "rationale",
  ],
});

function buildRequestBody(modelName: string, request: RequesterRecommendationRequest): unknown {
  return {
    model: modelName,
    store: false,
    instructions: [
      "You are a requester recommendation component, not an economic authority.",
      "Evaluate only the supplied verified candidates and bounded requester instruction.",
      "Recommend exactly one supplied candidate without changing any identifier or price, or decline.",
      "The surrounding deterministic policy independently decides whether any recommendation is authorized.",
      "For recommend, populate every candidate field exactly. For decline, set candidate fields to null.",
    ].join(" "),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(request),
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "pactagent_requester_recommendation",
        strict: true,
        schema: RECOMMENDATION_SCHEMA,
      },
    },
    max_output_tokens: 700,
  };
}

function extractOutputText(envelope: unknown): string | undefined {
  if (typeof envelope !== "object" || envelope === null) return undefined;
  const output = (envelope as { output?: unknown }).output;
  if (!Array.isArray(output)) return undefined;
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "output_text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
    }
  }
  return undefined;
}

function normalizeStructuredOutput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  if (candidate.action === "decline") {
    const keys = Object.keys(candidate);
    if (
      keys.length === 7 &&
      keys.every((key) => [
        "action",
        "providerPublicKey",
        "providerDefinitionReference",
        "offerReference",
        "escrowDescriptorReference",
        "proposedAmountSats",
        "rationale",
      ].includes(key)) &&
      candidate.providerPublicKey === null &&
      candidate.providerDefinitionReference === null &&
      candidate.offerReference === null &&
      candidate.escrowDescriptorReference === null &&
      candidate.proposedAmountSats === null &&
      typeof candidate.rationale === "string"
    ) {
      return { action: "decline", rationale: candidate.rationale };
    }
    return value;
  }
  return value;
}

export function createOpenAIRequesterRecommendationTransport(
  configuration: OpenAIRequesterDecisionConfiguration,
): RequesterRecommendationTransport {
  const apiKey = configuration.apiKey.trim();
  const modelName = configuration.modelName.trim();
  if (!apiKey) throw new RequesterModelConfigurationError("OpenAI requester model API key is required");
  if (!modelName) throw new RequesterModelConfigurationError("OpenAI requester model name is required");
  const endpoint = configuration.endpoint ?? DEFAULT_RESPONSES_ENDPOINT;
  const maximumResponseBytes =
    configuration.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
  const fetchImplementation = configuration.fetchImplementation ?? fetch;

  return Object.freeze({
    async complete(
      request: RequesterRecommendationRequest,
      context: RequesterDecisionModelContext,
    ): Promise<unknown> {
      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(buildRequestBody(modelName, request)),
          signal: context.signal,
        });
      } catch {
        throw new RequesterDecisionModelFailure(
          context.signal.aborted ? "timeout" : "unavailable",
        );
      }
      if (!response.ok) throw new RequesterDecisionModelFailure("unavailable");
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maximumResponseBytes) {
        throw new RequesterDecisionModelFailure("unavailable");
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new RequesterDecisionModelFailure("unavailable");
      }
      if (new TextEncoder().encode(text).byteLength > maximumResponseBytes) {
        throw new RequesterDecisionModelFailure("unavailable");
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new RequesterDecisionModelFailure("unavailable");
      }
      if (
        typeof envelope === "object" &&
        envelope !== null &&
        (envelope as { status?: unknown }).status === "incomplete"
      ) {
        throw new RequesterDecisionModelFailure("unavailable");
      }
      const outputText = extractOutputText(envelope);
      if (outputText === undefined) throw new RequesterDecisionModelFailure("unavailable");
      try {
        return normalizeStructuredOutput(JSON.parse(outputText));
      } catch {
        // Let PactAgent's existing strict output parser classify malformed model output.
        return undefined;
      }
    },
  });
}
