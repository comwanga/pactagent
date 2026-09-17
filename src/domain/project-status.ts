/** Public status contains no keys, tokens, private payloads, or claimed connectivity. */
export interface ProjectStatus {
  readonly application: "foundation_ready";
  readonly project: "PactAgent";
  readonly phase: "pre_e2e_composition";
  readonly nostr: "network_capable_not_composed";
  readonly cashu: "test_mint_capable_not_composed";
  readonly ai: "bounded_decision_no_hosted_adapter";
}
