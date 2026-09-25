import { describe, expect, it } from "vitest";

import { createModelBackedRequesterDecisionModel } from "./model-requester-decision";
import { createPactAgentRuntime } from "./pactagent-runtime";
import { RequesterDecisionModelFailure } from "./requester-decision";
import {
  FakeCashuPort,
  MemoryRelay,
  buildFixture,
  buildRuntimeConfig,
  sharedStores,
  startInput,
} from "./pactagent-runtime-test-fixture";

describe("model-backed requester runtime", () => {
  it("persists a truthful model projection and continues through deterministic authorization", async () => {
    const fixture = buildFixture();
    const stores = sharedStores();
    const decisionModel = createModelBackedRequesterDecisionModel({
      async complete(request) {
        const candidate = request.candidates[0];
        return {
          action: "recommend",
          providerPublicKey: candidate.providerPublicKey,
          providerDefinitionReference: candidate.providerDefinitionReference,
          offerReference: candidate.offerReference,
          escrowDescriptorReference: candidate.escrowDescriptorReference,
          proposedAmountSats: candidate.amountSats,
          rationale: "The exact verified candidate satisfies the supplied constraints.",
        };
      },
    });
    const first = buildRuntimeConfig(fixture, stores, {
      decisionModel,
      requesterDecisionSource: "model",
    });
    const runtime = createPactAgentRuntime(first.config);
    await runtime.start();
    const started = await runtime.startTransaction(startInput("model-backed-runtime"));
    const before = await runtime.status(started.transactionId);
    expect(before.phase).toBe("settled");
    expect(before.requesterDecision).toMatchObject({
      source: "model",
      recommendation: {
        action: "recommend",
        providerPublicKey: fixture.selectedReferences.providerPublicKey,
        offerReference: fixture.selectedReferences.offerReference,
        amountSats: "350",
      },
      policy: {
        selectedProviderMatchesDiscovery: true,
        stableReferencesMatch: true,
        withinRequesterBudget: true,
        cashuCompatible: true,
        priceAllowed: true,
        executionDurationAllowed: true,
      },
      authorized: true,
    });
    expect(first.cashu.prepareCalls).toBe(1);
    expect(first.cashu.spendCalls).toBe(1);
    await runtime.shutdown();

    const relay = new MemoryRelay();
    relay.events.push(...first.relay.events);
    const restartCashu = new FakeCashuPort();
    const restartedConfig = buildRuntimeConfig(fixture, stores, {
      relay,
      cashu: restartCashu,
      decisionModel,
      requesterDecisionSource: "model",
    });
    const restarted = createPactAgentRuntime(restartedConfig.config);
    await restarted.start();
    const after = await restarted.status(started.transactionId);
    expect(after.requesterDecision).toEqual(before.requesterDecision);
    expect(after.phase).toBe("settled");
    expect(restartCashu.prepareCalls).toBe(0);
    expect(restartCashu.spendCalls).toBe(0);
    await restarted.shutdown();
  }, 30_000);

  it.each([
    ["decline", async () => ({ action: "decline", rationale: "No suitable offer." })],
    ["malformed output", async () => ({ action: "recommend", amount: 350 })],
    ["provider unavailable", async () => { throw new RequesterDecisionModelFailure("unavailable"); }],
    ["timeout", () => new Promise<never>(() => undefined)],
  ])("creates no agreement or economic operation after model %s", async (_label, complete) => {
    const fixture = buildFixture();
    fixture.decisionBounds = { ...fixture.decisionBounds, modelTimeoutMilliseconds: 5 };
    const stores = sharedStores();
    const decisionModel = createModelBackedRequesterDecisionModel({ complete });
    const built = buildRuntimeConfig(fixture, stores, {
      decisionModel,
      requesterDecisionSource: "model",
    });
    const runtime = createPactAgentRuntime(built.config);
    await runtime.start();
    await expect(runtime.startTransaction(startInput(`model-rejected-${_label}`))).rejects.toBeDefined();
    expect(built.relay.events).toHaveLength(fixture.referenceEvents.length);
    expect(built.cashu.prepareCalls).toBe(0);
    expect(built.cashu.spendCalls).toBe(0);
    await runtime.shutdown();
  }, 10_000);
});
