import type { ProjectStatus } from "../domain/project-status";

export function getProjectStatus(): ProjectStatus {
  return {
    application: "foundation_ready",
    project: "PactAgent",
    phase: "pre_e2e_composition",
    nostr: "network_capable_not_composed",
    cashu: "test_mint_capable_not_composed",
    ai: "bounded_decision_no_hosted_adapter",
  };
}
