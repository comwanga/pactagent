import type { ProjectStatus } from "../domain/project-status";

export function getProjectStatus(): ProjectStatus {
  return {
    application: "ready",
    project: "PactAgent",
    phase: "open_protocol_foundation",
    nostr: "modeled_not_connected",
    cashu: "modeled_not_connected",
    ai: "not_implemented",
  };
}
