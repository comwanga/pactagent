# PactAgent domain model

## Retained primitives

The previous engineering phase established useful deterministic foundations. `Sats` remains a branded `bigint`, decimal BTC conversion still accepts strings, and domain validation continues to reject ambiguous or negative money. General strict TypeScript, error, testing, and UI foundations are retained.

## Protocol-facing models

`NostrIdentity` contains only a validated public key and public relay URLs. `UnsignedNostrEvent` deliberately excludes `id` and `sig`; `NostrSigner` defines a future signing boundary without accepting or exposing a private key.

`PontmoreAgentDefinition` models a PIP-00 kind-30360 draft and validates its required tags and minimum versioned content. PIP-00 currently names content fields without fixing their nested value schemas, so PactAgent v1 documents `capabilities.names`, `capabilities.settlement_networks`, string policy references, and string escrow references as application conventions. P001/P002 identifiers and detailed policies remain separate PactAgent fields—not PIP numbers or additions to the protocol.

`PontmoreEscrowDescriptor` models the current PIP-01 public compatibility object.
Its strict allowlisted constructor and parser reject unsupported fields and named
private settlement material. The public descriptor mirrors the existing
recoverable PIP-03 refund-trigger timeout; the remaining `CashuEscrowPlan` fields
are application funding/release/refund intent and have no execution method.

`signCashuEscrowDescriptor` accepts the existing `NostrSigner` interface, confirms
that the signer did not alter the draft, and verifies the resulting NIP-01
signature. `retrieveCashuEscrowDescriptor` queries by kind, author, and `d` tag,
selects the current addressable event, verifies it, and strictly parses it.
`resolveAgentCashuEscrowDescriptor` follows the protocol-visible address stored in
the PIP-00 content and `a` tag rather than relying on fixture identity.

`PontmoreSwapRequestContent` and the canonical PIP-02 event-kind registry remain
as swap-specific declarations. The repository does not attach document-summary
states or transition semantics to PIP-02.

`PactServiceAgreementRoot` is the immutable requester proposal. It binds the two
signed PIP-00 definitions, compatible signed PIP-01 descriptor, exact
`document-summary@1` profile, Cashu price, execution bound, expiry, and versioned
private-terms commitment. `PactAgreementTransition` records the root ID, immediate
predecessor ID, previous/current states, signer pubkey, declared role, and only
the safe reason/result reference allowed for that transition.

`PactCompletionDecision` is a secret-free, locally validated binding between the
exact result-submission event and the profile-derived result reference. It is
required before `result_verified`, so a requester signature alone cannot unlock
`release_authorized`. `PactEscrowAuthorityBinding` is similarly created only from
a valid descriptor-owner-signed application record tied to the selected escrow
configuration and agreement root.

`reconstructPactAgreementHistory` verifies signatures and authorization, removes
exact duplicates, follows predecessor IDs regardless of relay order, and returns
an explicit `forked` result for competing children. It never chooses a branch by
timestamp. The capability registry contains exactly one implementation,
`document-summary@1`; unsupported versions fail before signing or economic state
advancement.

## Application roles

- **P001 Requester:** allows only `document-summary`, has a 500-sat total budget, a 450-sat provider-price ceiling, a 15-minute escrow maximum, Cashu-only settlement, and auto-release only after deterministic completion checks.
- **P002 Provider:** advertises `document-summary`, requires at least 200 sats, accepts text/plain or PDF up to 1 MB, and limits execution to five minutes.

`discoverCompatibleProviders` performs local fixture discovery. `evaluateServiceOffer` applies deterministic capability, identity, price, budget, settlement-network, escrow-reference, and duration constraints. It returns a structured authorization result; it neither signs nor executes anything.

## Relay-backed provider discovery (#9)

`PactServiceOffer` is a PactAgent-owned, signed application record (application kind `30400`, outside the Pontmore PIP range 30360–30362) that carries the concrete current provider offer: amount in sats, settlement network, escrow descriptor reference, maximum execution duration, and a validity window. It is a PactAgent convention, NOT a PIP-00 field. A provider's PIP-00 `pricing_policy` references the current offer via its addressable Nostr reference (`30400:<pubkey>:<d>`); `resolveOfferAddressFromPricingPolicy` validates that the reference is canonical and owned by the same provider. Signature validation proves the offer's author; successful work and trustworthy execution require separate evidence.

`discoverProviders` runs the relay-backed pipeline:

```text
query kind 30360 profiles
  -> verify NIP-01 events
  -> select current PIP-00 definitions by address
  -> validate PactAgent capability profile
  -> resolve and verify current PactAgent offer
  -> resolve and verify referenced PIP-01 descriptor
  -> evaluate deterministic requester policy
  -> apply deterministic provider ordering
```

At each step it cross-validates bindings: the PIP-00 event author equals the candidate provider identity; the offer signer and `content.provider` equal that same identity; the offered capability/profile is advertised by the provider definition; the offer's escrow reference matches the declared PIP-01 descriptor; the descriptor is current, correctly signed, Cashu-compatible, and owned by the provider; the offer is active and unexpired; and price and execution duration satisfy both requester and provider constraints. A relay-supplied actor, capability name, or reference can never override the cryptographic authors and resolved addresses.

Discovery keeps three decisions distinct: (1) is this a valid signed Pontmore agent definition, (2) does it describe a provider compatible with the requested capability, and (3) does the requester's deterministic economic policy authorize the provider's current signed offer. Malformed candidates are rejected independently with structured rejection categories without aborting the whole query. Query sizes and follow-up resolutions are bounded. Profiles are grouped by their stable replaceable address (`<kind>:<pubkey>:<d>`), and replacement ordering is applied only among address-matching events with valid NIP-01 identities and signatures. Forged or unrelated events never supersede authentic events. Once the newest authentic profile, offer, or descriptor is selected, invalid application or PIP content rejects that address without falling back to an older authentic version. The deterministic ordering is: authorized offers only, lowest price, shortest declared maximum execution time, provider pubkey ascending, then definition address ascending when one provider publishes multiple equally acceptable definitions. AI is not involved in authorization or final provider selection; no advisory input is accepted into the authoritative ordering.

Successful discovery returns stable `SelectedProviderReferences` (provider definition, escrow descriptor, and offer addresses) suitable for the PactAgent service-agreement event integration (#10). Discovery does not create a service agreement, imply bilateral consent, advance lifecycle state, authorize settlement, or let AI output perform an economic action. PactAgent `document-summary@1` agreement/profile fields are not misrepresented as PIP-00/PIP-01 protocol fields.

## Bounded requester decision (#15)

`runRequesterDecision` consumes an already validated Issue #9 `DiscoveryResult`; it
does not query relays, reimplement discovery, or change the selected-provider
ordering. A narrow injected `RequesterDecisionModel` receives the private bounded
human instruction plus a frozen safe projection containing only public identity,
stable definition/offer/escrow references, amount, Cashu network, and execution
duration. Raw Nostr events and private document, result, key, Cashu, commitment,
and settlement material are excluded. The instruction is deliberately
non-enumerable to prevent accidental exposure through PactAgent's ordinary
enumeration and JSON serialization. The configured adapter must read the
`instruction` property explicitly, treat it as sensitive, and must not log,
persist, or expose it. Because the adapter intentionally receives the value,
non-enumerability is not a secrecy boundary against arbitrary injected code.

Model output is untrusted and strictly allowlisted. A recommendation must bind to
the current Issue #9 selection, its exact references, and the signed offer amount.
The deterministic gate reuses P001's existing requester policy, applies the lower
human budget, checks `document-summary@1` and Cashu compatibility, and returns a
safe approval or one stable rejection reason. Model rationale is discarded before
the application result is returned. Timeouts, unavailable models, exceptions,
malformed output, and contradictory recommendations fail closed.

This decision is advisory application data, not a Nostr event, Pontmore PIP,
agreement authorization, lifecycle transition, completion decision, or Cashu
settlement authorization. No signer, relay, publication, lifecycle, Cashu, tool,
or arbitrary runtime capability crosses the model interface. CI uses deterministic
fakes; deployment-specific model wiring remains outside this domain boundary.
