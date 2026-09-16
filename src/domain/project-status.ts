/** Public status contains no keys, tokens, private payloads, or claimed connectivity. */
export interface ProjectStatus {
  readonly application: "ready";
  readonly project: "PactAgent";
  readonly phase: "open_protocol_foundation";
  readonly nostr: "modeled_not_connected";
  readonly cashu: "modeled_not_connected";
  readonly ai: "not_implemented";
}
