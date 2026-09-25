import { describe, expect, it, vi } from "vitest";

import { DOCUMENT_SUMMARY_PROFILE_ID } from "../domain/pact-service-agreement";
import { createNostrIdentity } from "../domain/nostr";
import { createLiveRequesterDecisionFromEnv } from "./pactagent-runtime.live";
import {
  createOpenAIRequesterRecommendationTransport,
  readRequesterDecisionModeConfiguration,
  RequesterModelConfigurationError,
} from "./openai-requester-decision";
import { RequesterDecisionModelFailure, type SafeRequesterDecisionInput } from "./requester-decision";
import type { RequesterRecommendationRequest } from "./model-requester-decision";

const API_KEY = "test-provider-credential-not-a-real-key";
const PROVIDER = createNostrIdentity("22".repeat(32), ["wss://relay.example"]).publicKey;
const REQUEST: RequesterRecommendationRequest = Object.freeze({
  instruction: "Summarize the requester document.",
  capabilityProfile: DOCUMENT_SUMMARY_PROFILE_ID,
  maximumBudgetSats: "500",
  candidates: Object.freeze([Object.freeze({
    providerPublicKey: PROVIDER,
    providerDefinitionReference: `30360:${PROVIDER}:provider`,
    offerReference: `30400:${PROVIDER}:summary`,
    escrowDescriptorReference: `30361:${PROVIDER}:cashu`,
    amountSats: "350",
    settlementNetwork: "cashu" as const,
    maximumExecutionSeconds: 120,
  })]),
});

function responseEnvelope(output: unknown): Response {
  return new Response(JSON.stringify({
    status: "completed",
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(output) }],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function recommendation() {
  const candidate = REQUEST.candidates[0];
  return {
    action: "recommend",
    providerPublicKey: candidate.providerPublicKey,
    providerDefinitionReference: candidate.providerDefinitionReference,
    offerReference: candidate.offerReference,
    escrowDescriptorReference: candidate.escrowDescriptorReference,
    proposedAmountSats: candidate.amountSats,
    rationale: "This verified offer satisfies the requester constraints.",
  };
}

describe("OpenAI requester recommendation transport", () => {
  it("uses the Responses API strict schema and returns the bounded recommendation", async () => {
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseEnvelope(recommendation());
    });
    const transport = createOpenAIRequesterRecommendationTransport({
      apiKey: API_KEY,
      modelName: "test-model",
      fetchImplementation,
    });
    const result = await transport.complete(REQUEST, { signal: new AbortController().signal });
    expect(result).toEqual(recommendation());
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(capturedHeaders).toEqual({
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    });
    expect(capturedBody).toMatchObject({ model: "test-model", store: false, max_output_tokens: 700 });
    expect(capturedBody?.text).toMatchObject({
        format: {
          type: "json_schema",
          name: "pactagent_requester_recommendation",
          strict: true,
        },
      });
    expect(JSON.stringify(capturedBody)).not.toContain(API_KEY);
    const input = capturedBody?.input as Array<{ content: Array<{ text: string }> }>;
    expect(JSON.parse(input[0].content[0].text)).toEqual(REQUEST);
  });

  it("normalizes a schema-valid decline to the existing bounded contract", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => responseEnvelope({
      action: "decline",
      providerPublicKey: null,
      providerDefinitionReference: null,
      offerReference: null,
      escrowDescriptorReference: null,
      proposedAmountSats: null,
      rationale: "No suitable candidate.",
    }));
    const transport = createOpenAIRequesterRecommendationTransport({
      apiKey: API_KEY,
      modelName: "test-model",
      fetchImplementation,
    });
    await expect(transport.complete(REQUEST, { signal: new AbortController().signal })).resolves.toEqual({
      action: "decline",
      rationale: "No suitable candidate.",
    });
  });

  it("does not sanitize unexpected provider fields past PactAgent's strict parser", async () => {
    const output = { ...recommendation(), releaseFunds: true };
    const fetchImplementation = vi.fn<typeof fetch>(async () => responseEnvelope(output));
    const transport = createOpenAIRequesterRecommendationTransport({
      apiKey: API_KEY,
      modelName: "test-model",
      fetchImplementation,
    });
    await expect(transport.complete(REQUEST, { signal: new AbortController().signal })).resolves.toEqual(output);
  });

  it("returns malformed output to the authoritative PactAgent parser without reflecting it", async () => {
    const secret = "external-provider-body-must-not-escape";
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: `{not-json:${secret}` }] }],
    }), { status: 200 }));
    const transport = createOpenAIRequesterRecommendationTransport({
      apiKey: API_KEY,
      modelName: "test-model",
      fetchImplementation,
    });
    await expect(transport.complete(REQUEST, { signal: new AbortController().signal })).resolves.toBeUndefined();
  });

  it.each([
    ["provider error", async () => new Response("private upstream body", { status: 503 })],
    ["malformed envelope", async () => new Response("not-json", { status: 200 })],
    ["missing structured output", async () => new Response(JSON.stringify({ output: [] }), { status: 200 })],
    ["incomplete response", async () => new Response(JSON.stringify({ status: "incomplete", output: [] }), { status: 200 })],
  ])("maps %s to one redacted unavailable failure", async (_label, implementation) => {
    const transport = createOpenAIRequesterRecommendationTransport({
      apiKey: API_KEY,
      modelName: "test-model",
      fetchImplementation: vi.fn<typeof fetch>(implementation),
    });
    await expect(transport.complete(REQUEST, { signal: new AbortController().signal })).rejects.toEqual(
      new RequesterDecisionModelFailure("unavailable"),
    );
  });

  it("maps an aborted provider call to the existing timeout failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = createOpenAIRequesterRecommendationTransport({
      apiKey: API_KEY,
      modelName: "test-model",
      fetchImplementation: vi.fn<typeof fetch>(async () => { throw new Error("private abort detail"); }),
    });
    await expect(transport.complete(REQUEST, { signal: controller.signal })).rejects.toEqual(
      new RequesterDecisionModelFailure("timeout"),
    );
  });
});

describe("requester model configuration", () => {
  it("defaults to deterministic mode and never silently falls back from model mode", () => {
    expect(readRequesterDecisionModeConfiguration({})).toEqual({ mode: "deterministic" });
    expect(() => readRequesterDecisionModeConfiguration({
      PACTAGENT_REQUESTER_DECISION_MODE: "model",
    })).toThrowError(new RequesterModelConfigurationError(
      "PACTAGENT_REQUESTER_MODEL_PROVIDER is required in model mode",
    ));
  });

  it("selects a real model-backed runtime adapter and owns the truthful source projection", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => responseEnvelope(recommendation()));
    const selected = createLiveRequesterDecisionFromEnv({
      PACTAGENT_REQUESTER_DECISION_MODE: "model",
      PACTAGENT_REQUESTER_MODEL_PROVIDER: "openai",
      PACTAGENT_REQUESTER_MODEL_NAME: "test-model",
      PACTAGENT_REQUESTER_MODEL_API_KEY: API_KEY,
    }, fetchImplementation);
    const safeInput = REQUEST as SafeRequesterDecisionInput;
    expect(selected.source).toBe("model");
    await expect(selected.model.recommend(safeInput, {
      signal: new AbortController().signal,
    })).resolves.toEqual(recommendation());
  });

  it("keeps deterministic mode available without model credentials", () => {
    const selected = createLiveRequesterDecisionFromEnv({
      PACTAGENT_REQUESTER_DECISION_MODE: "deterministic",
    });
    expect(selected.source).toBe("deterministic");
  });
});
