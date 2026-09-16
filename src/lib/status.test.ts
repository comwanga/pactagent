import { describe, expect, it } from "vitest";

import { getProjectStatus } from "./status";

describe("PactAgent status", () => {
  it("reports the open-protocol foundation without claiming live functionality", () => {
    expect(getProjectStatus()).toEqual({
      application: "ready",
      project: "PactAgent",
      phase: "open_protocol_foundation",
      nostr: "modeled_not_connected",
      cashu: "modeled_not_connected",
      ai: "not_implemented",
    });
  });
});
