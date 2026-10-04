# PactAgent service agreements

This document defines PactAgent application conventions implemented for issue
#10. They are not Pontmore PIPs. Pontmore PIP-00 remains the identity/discovery
source, PIP-01 remains the escrow compatibility surface, PIP-02 remains
swap-specific, and PIP-03 remains associated with Pontmore swap dispute/timeout
policy.

## Event kind and indexing

Immutable agreement roots, transitions, and agreement-scoped escrow-authority
records use provisional regular kind `3921`. NIP-01 classifies kinds 1000–9999 as
regular stored events. Kind `3921` is an unregistered PactAgent application
convention, not a Pontmore PIP, not a Nostr standard, and not a new protocol. No
registry submission is part of this work. PactAgent distinguishes its record types
with `t` tags and groups records by a safe opaque agreement ID with a `d` tag. The
default constructor generates a UUIDv4, while parsing does not impose UUID
semantics on the application field.

Root tags are exactly:

```text
["d", agreement_id]
["t", "pactagent/service-agreement-root@1"]
["t", "document-summary@1"]
["p", requester]
["p", provider]
["a", requester_definition]
["a", provider_definition]
["a", escrow_descriptor]
```

Transition tags are exactly:

```text
["d", agreement_id]
["t", "pactagent/service-agreement-transition@1"]
["t", state]
["e", agreement_root_event_id]
["e", immediate_predecessor_event_id]  # omitted for the first transition
["p", actor]
```

Parsers reject duplicates, extras, and tag/content disagreement.

## Root content

The requester signs one proposal with this public content:

```ts
interface PactServiceAgreementContent {
  version: 1;
  agreement_id: string;
  capability_profile: "document-summary@1";
  requester: string;
  provider: string;
  requester_definition: string;
  provider_definition: string;
  escrow_descriptor: string;
  amount_sats: string;
  settlement_network: "cashu";
  maximum_execution_seconds: number;
  expires_at: number;
  terms_commitment: string;
  terms_commitment_scheme: "sha256-salted-canonical-json-v1";
}
```

The three Pontmore references use canonical `kind:pubkey:d` addresses. Their
retrieved signed events are verified locally, participants must be independent,
the provider must advertise document-summary and Cashu, and both definitions must
bind the participant identities. The provider definition must reference the
selected compatible PIP-01 descriptor. The requester may retain a different
default escrow; that default does not override the descriptor selected by the
agreement.

The root is only a proposal. Bilateral acceptance begins with a separate valid
`accepted` transition signed by the exact provider named in the root.

## Provider-discovery integration

`createPactServiceAgreementRootFromDiscovery` is the narrow boundary from issue
#9 into this agreement flow. It accepts the requester's signed PIP-00 definition
and a validated `DiscoverySelection`, revalidates the selected signed offer and
its stable provider/PIP-00/PIP-01 references, and derives price and execution
duration from that authenticated offer. A selection whose references were
altered, or whose offer is no longer active when the agreement is created, is
rejected. The function returns only an unsigned requester proposal and its
validated reference set; it does not sign, publish, imply provider acceptance,
or authorize an economic transition.

## Commitment and private data

`sha256-salted-canonical-json-v1` hashes canonical JSON containing the exact
profile ID, scheme ID, a fresh private 32-byte salt, and validated private terms.
Object keys are sorted recursively. Reusing the same salt with equivalent input
produces the same bytes; production construction creates fresh random salt by
default.

The salt type blocks JSON serialization and exposes no raw-value getter. Root
construction copies only the public digest and scheme. Strict public constructors
and parsers reject extra fields, so documents, prompts, complete results, raw
Cashu tokens/proofs, preimages, credentials, payout instructions, and sensitive
evidence cannot enter public event content or tags. `result_submitted` accepts
only an opaque `sha256:<lowercase hex digest>` reference. The
`document-summary@1` profile accepts `text/plain` and `application/pdf` inputs up
to 1 MiB (1,048,576 original bytes), enforces the documented 300-second execution ceiling, and
requires a non-empty summary. No numeric summary-size limit is imposed because
the issue, repository policy, and fixtures do not define one.

The requester can create a completion decision only by reopening the committed
private terms with the private salt and validating the exact private result whose
profile-derived reference appears on `result_submitted`. The decision carries no
document or result text. It is bound to the agreement root, profile version,
submitted-transition event ID, and result reference. A `result_verified`
transition repeats that safe result reference and is rejected unless the local
validated decision matches it; consequently `release_authorized` can follow only
a previously validated verification.

## Lifecycle and authorization

```text
proposed -> accepted -> escrow_funded -> task_delivered -> result_submitted
         -> result_verified -> release_authorized -> settled

proposed/accepted -> expired
accepted/escrow_funded -> refund_authorized -> refunded
result_submitted -> rejected -> refund_authorized
```

The provider alone signs `accepted`, `task_delivered`, and `result_submitted`.
The requester alone signs `result_verified`, `rejected`, `release_authorized`,
and `refund_authorized`. Either participant may publish a time-valid `expired`
transition. Funding, settlement, and refund facts require an explicit settlement
authority. The binding source is a separately signed
`pactagent/escrow-authority@1` kind-3921 application record issued by the owner of
the selected signed descriptor; it names the exact agreement root, descriptor,
Cashu network, and designated authority. Signature, tags, references, issuer,
and designated identity are all validated before the binding is accepted.

The required `disputed` vocabulary remains reserved, but this implementation
does not expose a transition into it: the current descriptor intentionally has
no service schema and the repository defines no application dispute authority.
Either participant self-authorizing a dispute would invent authority not granted
by issue #10.

`actor_role` is checked for consistency but never grants authority. In
particular, signing the PIP-01 descriptor does not automatically make its author
the settlement authority; the descriptor owner only signs the separate record
that explicitly designates that authority.

## Reconstruction

The root represents `proposed`; the first transition has a null predecessor.
Every later transition names its immediate predecessor event ID. Reconstruction
verifies each signature and root reference, removes byte-identical repeated event
IDs, then follows the predecessor graph. Relay order and timestamps do not choose
history.

Two different children of the same predecessor produce an explicit `forked`
history containing sorted competing event IDs. A missing, cyclic, stale, or
wrong-root predecessor fails with a typed domain error. `settled`, `expired`,
`refunded`, and `disputed` are terminal and cannot advance.
