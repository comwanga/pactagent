# PactAgent architecture

PactAgent is an application built on Pontmore. The canonical Pontmore PIPs remain the protocol source of truth; application roles, policies, and the `document-summary` lifecycle vocabulary are not new PIPs.

```text
Human intent
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

The implementation follows the current draft PIPs from [`pontmore/protocol`](https://github.com/pontmore/protocol):

- **PIP-00, kind 30360:** an addressable agent-definition event with `d`, `t=agent`, `relay`, and default-escrow `a` tags. PactAgent uses a documented v1 shape inside the PIP's open `capabilities` field; the detailed P001/P002 policies remain separate application data.
- **PIP-01, kind 30361:** a public escrow compatibility descriptor. The Cashu fixture declares `escrow_type=cashu_escrow`, canonical `networks=[cashu]`, 1-of-1 funding, `pip03` dispute policy with a recoverable refund-trigger timeout, and an opaque reference format. It contains no token, proof, preimage, credential, or private payment payload. Because draft PIP-01 requires an explicit timeout fallback but does not yet name its JSON fields, the nested `dispute_rules.timeout` shape is documented as a PactAgent v1 convention rather than a Pontmore standard.
- **PIP-02, kinds 7300–7304 and 30362:** remains swap-specific. The existing swap draft types are not used to represent the `document-summary` service agreement.
- **PIP-03:** operator-governed dispute and timeout rules. PactAgent models the canonical refund-trigger timeout with a non-mutual fallback of cancelling and refunding. AI cannot create resolution modes.

`PontmoreSwapRequestContent` records PIP-02's required kind-7300 fields, but the
document-summary path never synthesizes that event. Instead, PactAgent owns a
generic agreement kernel plus the exact `document-summary@1` capability profile.
Its immutable roots, transitions, and escrow-authority records use provisional
regular kind `3921`. NIP-01 classifies kinds 1000–9999 as regular stored events.
Kind `3921` is an unregistered PactAgent application convention, not a Pontmore
PIP, not a Nostr standard, and not a new protocol. This work makes no registry
proposal.

The older Pontmore PoCs were inspected as implementation references only. Where they differ from current PIPs—particularly older PIP-01 service fields—the canonical PIPs win.

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
isolated local signer for development and tests; deployment-specific key custody
is not claimed. The requester model has no signing or wallet authority.

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

## Implemented components and composition boundary

Relay-backed publication/discovery, bounded requester decision policy, PactAgent
agreements, NIP-59 private transport, deterministic document-summary execution,
and durable Cashu settlement coordination are implemented as separate reusable
components. The Cashu layer can inspect and swap against one configured HTTPS
test mint and can privately import already-acquired proofs and deliver confirmed
outputs. Required tests remain deterministic and offline.

Issue #16 application composition, requester/provider runtime hosting, a hosted
model adapter, and a live transaction frontend/API remain pending. This is not a
production wallet: Lightning mint-quote acquisition, generic accounts,
multi-mint routing, and production custody operations remain out of scope. No
generic marketplace, reputation, bidding, or dispute adjudication is provided.
