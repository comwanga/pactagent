# PIP-01 Cashu escrow descriptor flow

PactAgent publishes public compatibility metadata for its Cashu escrow mechanism
as a Nostr addressable event of kind `30361`. The descriptor tells another agent
whether the mechanism is compatible; it does not hold or move funds.

## Public wire shape

The following is PactAgent's implemented **legacy v1 wire shape**, not the
current Pontmore PIP-01 schema. The protocol comparison is pinned in
[Architecture](architecture.md#protocol-boundary). Current PIP-01 requires
`expires_at` and places service behavior in a referenced schema or coordination
profile. This implementation instead retains the fields below; alignment is
tracked in #76. No wire-format migration is performed here.

```json
{
  "version": 1,
  "escrow_type": "cashu_escrow",
  "networks": ["cashu"],
  "funding_rules": {
    "funding_threshold": 1,
    "participant_count": 1
  },
  "dispute_rules": {
    "policy": "pip03",
    "timeout": {
      "class": "refund-trigger timeout",
      "duration_seconds": 900,
      "fallback_resolution": "cancelling and refunding"
    }
  },
  "reference_format": "opaque_service_reference",
  "updated_at": 1788853200
}
```

The event has one stable `d` tag and a `network` index tag:

```text
["d", "cashu-document-summary"]
["network", "cashu"]
```

The `pip03` policy identifier, funding cardinality, `updated_at`,
`reference_format`, `network` tag, and nested `dispute_rules.timeout` above belong
to the implemented legacy format. PIP-03 has been removed upstream. These values
describe PactAgent's supported compatibility and timeout conventions; they do
not establish conformance to current PIP-01 or provide a dispute adjudicator.

PactAgent currently supports one Cashu network entry, 1-of-1 funding, the `pip03`
policy identifier, a refund-trigger timeout, and `opaque_service_reference`. This
descriptor has no `service.schema` pointer. Cashu settlement is implemented as an
internal application boundary, not as a current PIP-01-advertised service API.

## PIP-00 reference and resolution

The descriptor's Nostr address is:

```text
30361:<descriptor-author-pubkey>:<d-tag-value>
```

The implemented legacy PIP-00 definition stores that address in both
`content.escrow` and its `a` tag; current PIP-00 does not use that content shape.
Resolution parses the address, queries the relay with kind `30361`, the referenced
author, and the referenced `d` value, then validates the current matching event.
The relationship therefore survives serialization and relay transport and is not
an in-memory object link.

## Signing and relay boundaries

The flow is:

```text
Cashu descriptor model
  -> unsigned kind 30361 event
  -> NostrSigner
  -> verify unchanged draft, event id, and Schnorr signature
  -> relay publish
  -> query by address
  -> verify signature and strict descriptor parse
  -> resolve from PIP-00 reference
```

Descriptor code receives only an unsigned event and a `NostrSigner`; it has no API
for fetching or returning secret keys. The relay receives only signed events. The
publication flow uses the `NostrRelayAdapter` delivered by issue #4 directly,
while the production signer remains the responsibility of issue #6. Tests use a
synthetic key held inside a local test signer and an in-memory relay, so CI does
not need public infrastructure or credentials.

The caller owns the adapter lifecycle: connect before publish or retrieval and
disconnect after the bounded operation. PIP-01 orchestration does not create a
background relay connection.

## Public/private boundary

Construction and parsing use allowlisted public fields and explicitly reject
Cashu token strings, proofs, mint or API credentials, private or Nostr secret keys,
preimages, payout instructions, private routing data, custody identifiers, private
settlement metadata and secrets, and private notes. Errors expose typed categories
and do not include rejected payloads or transport internals.

The public descriptor contains no token creation, redemption, swapping, proof
storage, funding, release, refund, wallet, mint connection, private task transport,
or dispute adjudication behavior. Settlement and private transport are separate
implemented components; the descriptor itself grants no economic authority.
