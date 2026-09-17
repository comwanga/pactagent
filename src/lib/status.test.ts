import { describe, expect, it } from "vitest";

import { getProjectStatus } from "./status";

describe("PactAgent status", () => {
  it("reports implemented components without claiming end-to-end runtime wiring", () => {
    expect(getProjectStatus()).toEqual({
      application: "foundation_ready",
      project: "PactAgent",
      phase: "pre_e2e_composition",
      nostr: "network_capable_not_composed",
      cashu: "test_mint_capable_not_composed",
      ai: "bounded_decision_no_hosted_adapter",
    });
  });
});
