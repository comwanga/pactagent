# PactAgent architecture

PactAgent uses Nostr, Cashu, and historical Pontmore wire conventions. Current
Pontmore specifications are the comparison target, not a claim that the existing
PactAgent formats conform to them. Application roles, policies, and the
`document-summary` lifecycle vocabulary are not new PIPs.

```text
Human intent
     |
     v
bounded requester recommendation
 (deterministic or model-backed)
     |
     v
P001 Requester ---------------- P002 Provider
     |                                |
     +-------- deterministic policy --+
                       |
                       v
                unsigned action
                       |
                 NostrSigner port           #6 IMPLEMENTED BOUNDARY
                       |
              +--------+--------+
              |                 |
        NostrRelayAdapter      Cashu test-mint adapter
              |                 |
              +---- Pontmore ---+
                  public state
```

## Protocol boundary

The comparison is pinned to
[`pontmore/protocol@edcf1370e7e646574021709cc9b186d96377280a`](https://github.com/pontmore/protocol/tree/edcf1370e7e646574021709cc9b186d96377280a),
verified on 2026-11-15. Its active draft specifications are:

- [PIP-00](https://github.com/pontmore/protocol/blob/edcf1370e7e646574021709cc9b186d96377280a/PIP-00-agent-definition.md): kind `30360`, a capability array of versioned identifiers with matching capability tags.
- [PIP-01](https://github.com/pontmore/protocol/blob/edcf1370e7e646574021709cc9b186d96377280a/PIP-01-escrow-descriptor.md): kind `30361`, an expiring escrow compatibility descriptor with an optional service-schema reference.
- [PIP-02 v2](https://github.com/pontmore/protocol/blob/edcf1370e7e646574021709cc9b186d96377280a/PIP-02-coordination-event-chains.md): kind `7300` coordination roots and kind `7301` linked actions, with lifecycle semantics supplied by a pinned profile. This draft remains experimental.

The old swap-specific PIP-02 and PIP-03 were
[removed upstream on 2026-09-14](https://github.com/pontmore/protocol/commit/d9a1eb3e8a24e2101f5a4024df1ce85a8d934f75).
PactAgent still implements its older PIP-00 capability object and older PIP-01
descriptor fields (`funding_rules`, `dispute_rules.policy="pip03"`,
`reference_format`, and `updated_at`, without current PIP-01 `expires_at`).
The literal `pip03` value is a legacy wire identifier, not a current specification.
Alignment is tracked separately in #74–#76; this documentation does not change
signed records or protocol formats.

`PontmoreSwapRequestContent` and kinds 7300–7304/30362 are historical swap
declarations, not the current PIP-02 kernel. The document-summary path never
synthesizes those swap events. Instead, PactAgent owns a
generic agreement kernel plus the exact `document-summary@1` capability profile.
Its immutable roots, transitions, and escrow-authority records use provisional
regular kind `3921`. NIP-01 classifies kinds 1000–9999 as regular stored events.
Kind `3921` is an unregistered PactAgent application convention, not a Pontmore
PIP, not a Nostr standard, and not a new protocol. This work makes no registry
proposal.

The older Pontmore PoCs are implementation references only. Their behavior does
not establish conformance to the pinned current specifications.

## Public and private data

Public protocol candidates include agent capabilities, escrow compatibility, agreement references, amounts, lifecycle states, result hashes/references, and settlement outcomes.

Private data includes uploaded documents, raw prompts, complete provider results,
sensitive evidence, raw Cashu tokens and proofs, witnesses, blinded outputs,
mint credentials, preimages, payout instructions, commitment salts, Cashu
spending keys, and Nostr private keys. None are accepted by the public agreement
serializers. The issue #12 adapter confines Cashu material to private wrappers
and an injected durable private store. NIP-59 Gift Wrap task/result transport is
implemented as its own private boundary and remains outside issue #10.

## Authority separation

```text
AI proposal -> deterministic policy -> isolated signer -> protocol action
```

PIP-01 event construction stops at an unsigned draft and hands that draft to
`NostrSigner`; the descriptor layer never accepts or retrieves a private key. A
signed event is checked against the original draft and its NIP-01 id and Schnorr
signature are verified before publication. Retrieval repeats signature and
descriptor validation before returning domain data. The repository provides an
isolated local signer used by runtime compositions as well as tests. Signer API
separation does not imply independent operator custody. The requester-decision
adapter has no signing or wallet authority.

The PIP-01 workflow uses issue #4's `NostrRelayAdapter` and its typed
`publish(event)` and `queryEvents(filter)` operations directly. Connection
lifecycle and bounded WebSocket behavior belong to that adapter, not to the
escrow domain.

The PactAgent agreement workflow uses the same signer and relay ports. Root and
transition drafts are deterministically validated before signing; signer output
must preserve the draft and have a valid NIP-01 signature. Authorization is
resolved from the root's requester/provider keys and an explicit agreement-scoped
escrow-authority application binding. That binding is accepted only from a valid
kind-3921 authority record signed by the selected descriptor owner and referencing
the exact agreement, descriptor, Cashu network, and authority key. Neither
`actor_role` nor merely authoring PIP-01 grants settlement authority.

The profile validates the committed private task and exact submitted private
result before producing a secret-free completion decision. `result_verified`
requires that decision, and `release_authorized` requires the validated
verification in its predecessor chain. No dispute transition is available
because this repository has neither a service-schema dispute authority nor an
application dispute-authority record.

## Custody and economic guarantees

The requester runtime loads the escrow-authority Nostr signer and both Cashu
NUT-11 spending keys: the normal-spend key and the refund key. Hosted provider
signing is separate, but the escrow keys are still controlled by the requester
runtime's operator (`pactagent-runtime.live.ts`, `economic-environment.ts`).
Distinct keys and deterministic software checks do not stop that operator from
using its key material outside this software. The provider therefore trusts the
operator's custody, release/refund decisions, private stores, and configured mint.
This is not trust-minimized escrow or a production fairness guarantee. The future
custody/fairness decision belongs to #73, not this documentation correction.

The recovery design targets **at-most-once economic effect per persisted Cashu
operation**, using stable operation identities, the exact prepared swap, durable
state, and the mint's spent-once behavior. For the escrow coordinator's
`escrow_funded`, `settled`, and `refunded` transitions, `pendingTransition` persists
the signed event before publication and reuses it for **at-least-once publication
attempts on recovery**. Requester transitions `result_verified` and
`release_authorized` may be constructed and signed anew when their methods are
invoked again. Identical signed-event identity or publication deduplication is
not guaranteed across every lifecycle retry, nor is eventual relay delivery.
Private beneficiary callbacks receive
an **idempotent delivery identity** and must deduplicate it: a callback can run
again if it completed before its delivery record was durably updated. There is
no atomic commit across SQLite, the mint, the relay, and an arbitrary recipient,
and no distributed exactly-once delivery guarantee.

An ambiguous Cashu submission remains subject to inspection/reconciliation, not
a fresh blind submission. ALL-UNSPENT is a point-in-time observation, not a
cancellation fence; see [durable recovery](pactagent-runtime.md#durable-recovery-state).
These properties depend on retained durable state and mint behavior, not just
passing tests. The NUT-11 spending conditions are defined in
[Cashu NUT-11](https://github.com/cashubtc/nuts/blob/1363de413294e2ef3a57b16950f9506af38fffc2/11.md);
they do not attest to the operator's independence or trustworthiness.

## Implemented components and composition boundary

Relay-backed publication/discovery, bounded requester decision policy, PactAgent
agreements, NIP-59 private transport, deterministic document-summary execution,
and durable Cashu settlement coordination are implemented as separate reusable
components. The Cashu layer can inspect and swap against one configured HTTPS
test mint and can privately import already-acquired proofs and deliver confirmed
outputs. Deterministic suites use fixtures; the separate #62 CI lane also exercises
disposable relay and FakeWallet mint services without production credentials.

Issue #33 provides the application composition, long-lived requester/provider
runtime, and authenticated transaction HTTP API. A requester-facing UI remains
separate. The live requester-decision boundary supports a deterministic adapter
and an optional OpenAI Responses API adapter. The latter receives only the bounded
instruction and safe verified-candidate projection. In both modes deterministic
policy remains the economic authorization boundary. The model may decline the
already-selected offer (a veto); it cannot choose a different provider or price,
and a recommendation cannot bypass deterministic validation. Completion checks
bind the private terms and result reference and require a non-empty summary;
they do not prove the summary's factual correctness or provider fairness.
This is not a production wallet:
Lightning mint-quote acquisition, generic accounts, multi-mint routing, and
production custody operations remain out of scope. No generic marketplace,
reputation, bidding, or dispute adjudication is provided.
