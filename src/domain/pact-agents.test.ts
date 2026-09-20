import { describe, expect, it } from "vitest";

import { btcToSats } from "./money";
import { discoverCompatibleProviders, evaluateServiceOffer } from "./pact-agents";
import { createPactDemoFixtures } from "../lib/pact-fixtures";

describe("local agent discovery and bounded policy", () => {
  it("discovers P002 for P001's allowed document-summary capability", () => {
    const { requester, provider } = createPactDemoFixtures();
    expect(discoverCompatibleProviders(requester, [provider], "document-summary")).toEqual([provider]);
  });

  it("authorizes the deterministic 350-sat offer", () => {
    const { requester, provider, offer, escrowDescriptor } = createPactDemoFixtures();
    expect(evaluateServiceOffer({ requester, provider, offer, escrowDescriptor })).toEqual({
      authorized: true,
      reasons: [],
    });
  });

  it("enforces requester budget and provider price limits", () => {
    const { requester, provider, offer, escrowDescriptor } = createPactDemoFixtures();
    const result = evaluateServiceOffer({
      requester,
      provider,
      offer: { ...offer, priceSats: btcToSats("0.00000501") },
      escrowDescriptor,
    });
    expect(result.authorized).toBe(false);
    expect(result.reasons).toEqual(["budget_exceeded", "provider_price_limit_exceeded"]);
  });

  it("enforces the provider minimum price", () => {
    const { requester, provider, offer, escrowDescriptor } = createPactDemoFixtures();
    const result = evaluateServiceOffer({
      requester,
      provider,
      offer: { ...offer, priceSats: btcToSats("0.00000199") },
      escrowDescriptor,
    });
    expect(result.reasons).toContain("below_provider_minimum");
  });

  it("rejects an offer pointing at a different escrow reference", () => {
    const { requester, provider, offer, escrowDescriptor } = createPactDemoFixtures();
    const result = evaluateServiceOffer({
      requester,
      provider,
      offer: { ...offer, escrowDescriptorReference: "30361:other:escrow" },
      escrowDescriptor,
    });
    expect(result.reasons).toContain("escrow_incompatible");
  });

  it("binds the descriptor timeout to the requester escrow-duration policy", () => {
    const { requester, provider, offer, escrowDescriptor } = createPactDemoFixtures();
    const oversizedDescriptor = {
      ...escrowDescriptor,
      content: {
        ...escrowDescriptor.content,
        dispute_rules: {
          ...escrowDescriptor.content.dispute_rules,
          timeout: {
            ...escrowDescriptor.content.dispute_rules.timeout,
            duration_seconds: requester.policy.maximumEscrowDurationSeconds + 1,
          },
        },
      },
    };
    const result = evaluateServiceOffer({
      requester,
      provider,
      offer,
      escrowDescriptor: oversizedDescriptor,
    });
    expect(result.reasons).toContain("requester_escrow_duration_exceeded");
  });
});
