# PactAgent Cashu escrow settlement coordinator

Issue #13 composes three existing boundaries: the issue #10 PactAgent agreement
kernel, the issue #8 PIP-01 compatibility descriptor, and the issue #12 private
Cashu adapter. The coordinator is application code. It is not a Pontmore PIP, a
Nostr standard, or a Cashu protocol extension.

The versioned service contract is
[`pactagent/cashu-escrow-service@1`](pactagent-cashu-escrow-service-v1.openapi.json).
This repository has no stable HTTPS service/schema endpoint, so PIP-01 does not
advertise `service.schema`. Advertisement is deferred until such a URL exists.

## Boundary and API

`PactCashuEscrowSettlementCoordinator` exposes seven operations:

- prepare an escrow;
- fund it through the private Cashu port;
- inspect a safe status projection;
- consume a release authorization;
- execute release;
- consume a refund authorization; and
- execute refund.

The coordinator never accepts an `actor_role` as authority. It reconstructs the
signed #10 history for each action. The existing requester-signed
`release_authorized` and `refund_authorized` transitions are the authorization
sources; no second event type was invented. The result binding comes from the
validated `result_verified` predecessor. The escrow reference and expiry are
bound in durable service state. A durable agreement-root index permits exactly
one escrow instance for a root, so the signed agreement/root reference cannot be
replayed against a second escrow reference. The authorization's signed root,
predecessor, result reference, and identity combine with that unique index and
the deterministic locktime expiry to form the complete service authorization
binding. The existing explicitly validated #10 escrow
authority signs only the post-execution `escrow_funded`, `settled`, or `refunded`
fact. The current #10 architecture defines no separate release or refund
authority, so those authorizations remain requester-signed; the coordinator does
not invent one. Descriptor authorship alone grants no authority.

## Operational state and durable storage

Service-local operational state is separate from public agreement state. It
records preparation, an in-progress Cashu call, reconciliation, confirmed Cashu
success awaiting publication, and final publication. Public lifecycle states
remain exactly those defined by issue #10.

`PactCashuEscrowSettlementStore` supplies atomic insert, revision-based
compare-and-set, and an exclusive-key operation. The SQLite implementation uses
atomic row updates plus renewable process leases, and persists records and
pending signed publication events across process restarts. Its database path
must point to private application storage. The in-memory implementation remains
deterministic test support and is not durable storage. The store retains the #12 opaque Cashu handle, operation
fingerprints, confirmation facts, and any signed transition awaiting relay
publication. It must be deployed as private access-controlled application storage and
must never be exposed through a public serializer.

The #12 private store is a separate custody boundary. Its SQLite implementation
persists proofs, prepared restoration context, payer change, and aggregate mint
exposure across process restarts. The coordinator record durably retains the
opaque funding-change handle and the confirmed release/refund output handle;
none is added to `PactCashuEscrowStatus` or a public lifecycle event. A later
runtime may route those handles through a private participant channel, but this
coordinator does not invent payout authentication or expose bearer material.

Every mutation has an 8–64 character application idempotency key. The stored
SHA-256 fingerprint binds the escrow and agreement references, operation type,
expected operational state and revision, authorizing identity, 350-sat amount,
and result/authorization reference where applicable. Equal key and fingerprint
resumes the original operation; unequal reuse is an `idempotency_conflict`.
Per-escrow exclusion plus compare-and-set makes concurrent duplicates converge
and makes release/refund economic claims mutually exclusive.

## Binding and NUT-11 design

One escrow record binds the signed agreement root, requester, provider, validated
escrow authority/source, selected PIP-01 descriptor, configured HTTPS test mint,
`sat`, exactly 350 sats, `document-summary@1`, agreement expiry, descriptor
timeout policy, service version, and NUT-11 condition.

The purpose-specific normal key controls release and an authorized early
rejection refund. A distinct purpose-specific refund key becomes usable through
the NUT-11 refund path at locktime. Neither key is a Nostr signing key. The exact
locktime is:

```text
accepted transition created_at + PIP-01 refund-trigger timeout duration_seconds
```

The coordinator uses its injected integer Unix-seconds clock. Release is allowed
only while `now < locktime`; timeout refund is allowed when `now >= locktime`.
Consequently the refund side wins the boundary exactly at locktime. A one-second
clock-skew allowance permits a signed transition timestamp to be at most one
second ahead of the coordinator clock; it never shifts the economic boundary.

The #12 adapter validates the compressed on-curve keys and constructs the lock.
The service contract exposes no threshold or caller-selected NUT-11 condition;
the PoC is fixed to one normal key and one distinct time-gated refund key.
It reserves the receiver's future input fee. The coordinator checks integer-safe
accounting: input equals output plus change plus mint fee, the locked output is
the 350-sat amount plus the reported reserved spend fee, and release/refund nets
exactly 350 sats. Before funding, proofs are held by the private funding source;
while funded they remain behind the #12 opaque handle; after release/refund the
new private handle remains in #12 storage and its opaque reference is retained
in private coordinator state. Any payer change is stored under its own private
handle rather than discarded. No bearer material becomes lifecycle evidence.

## Authorization, recovery, and publication

Funding requires canonical `accepted` history and matching profile, amount,
network, descriptor, authority, configured mint, and unit. Cashu funding success
is persisted before the authority signs/publishes `escrow_funded`.

Release requires canonical `release_authorized` history whose immediate chain
contains the exact profile-validated result reference. The authorization expires
at locktime and is consumed once. Refund requires canonical
`refund_authorized` history and either a `rejected` predecessor or the
deterministic timeout boundary. Authorization and execution remain separate.

An ambiguous #12 result is persisted as `reconciliation_required`; the
coordinator calls #12 again with the same private operation id so that #12 uses
NUT-07/NUT-09 recovery rather than blind submission. After confirmed Cashu
success, the private outcome and a safe settlement/refund reference are persisted
before public signing. If signing or relay publication fails, only the same
signed public transition is retried. The Cashu operation is not repeated. This
also makes a durable-store-backed coordinator restart safe.

## Public/private boundary

Public status contains only the opaque escrow reference, agreement references,
safe operational state/revision, already-public amount/unit/result reference,
safe outcome reference, and public transition id. It never contains raw Cashu
tokens or proofs, witnesses, keys, blinded material, preimages, credentials,
payout instructions, private tasks/prompts/results, commitment salts, mint
responses, or reconciliation evidence. Errors have fixed redacted messages and
no external cause. Idempotency keys and URLs are rejected if they resemble
secret material. The coordinator has no model or AI input, signing-key access,
wallet API, discovery behavior, or lifecycle policy of its own.

The issue #12 capability-only live test remains the sole opt-in live-mint check.
Issue #13 required tests use deterministic Cashu and relay fakes and move no
funds.
