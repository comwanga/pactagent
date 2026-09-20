# PactAgent End-to-End Workflow (Issue #16)

The `pactagent-workflow` module composes the existing boundaries from
Issues #4–#15 into the smallest executable transaction sequence required to
complete a `document-summary@1` service agreement through Nostr, NIP-59
private transport, and Cashu escrow settlement.

It does not implement a new protocol, lifecycle engine, discovery system,
settlement engine, authority model, wallet, or generic orchestration
framework. Every capability is consumed from its existing boundary.

## Component ownership

| Boundary | Issue | Responsibility |
|----------|-------|----------------|
| Nostr relay transport | #4/#5 | `WebSocketNostrRelayAdapter`, `NostrRelayAdapter` |
| Isolated Nostr signing | #6 | `createLocalNostrSigner`, `NostrSigner` |
| PIP-00 agent definitions | #7 | `createPontmoreAgentDefinition` |
| PIP-01 Cashu escrow descriptor | #8 | `createCashuEscrowDescriptor` |
| Relay-backed discovery | #9 | `discoverProviders`, `DiscoveryResult` |
| Service-agreement lifecycle | #10 | `createPactServiceAgreementRoot`, transitions, completion |
| NIP-59 private transport | #11 | `sealPrivateTask`, `sealPrivateResult`, Gift Wrap |
| Cashu test-mint adapter | #12 | `CashuTestMintPort`, private spending keys |
| Cashu escrow settlement | #13 | `PactCashuEscrowSettlementCoordinator` |
| `document-summary@1` execution | #14 | `summarizeDocument` |
| Requester model recommendation | #15 | `runRequesterDecision`, deterministic policy |

## Workflow sequence

### Successful path

```text
human intent + private document
  ↓
#9 validated discovery → deterministic provider selection
  ↓
#15 bounded model recommendation → deterministic requester policy
  ↓
#10 requester-signed proposal (proposed)
  ↓
#10 provider-signed acceptance (accepted)
  ↓
#13 prepare + fund escrow → escrow_funded
  ↓
#11 private task delivery (NIP-59 Gift Wrap)
  ↓
#10 provider task_delivered transition
  ↓
#14 document-summary execution
  ↓
#11 private result delivery
  ↓
#10 result_submitted (safe result reference only)
  ↓
#10 completion verification → result_verified
  ↓
#10 requester release_authorized
  ↓
#13 Cashu release → settled
```

### Recovery path (timeout/refund)

```text
accepted → escrow_funded → locktime reached → refund_authorized → Cashu refund → refunded
```

## Clean-machine setup

### Requirements

- Node.js 22 or newer
- npm

### Install

```sh
npm install
```

No credentials, network, mint, or funds are needed for the deterministic
verification lane.

## Commands

### Deterministic verification (required CI lane)

```sh
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

Run only the end-to-end workflow integration tests:

```sh
npx vitest run src/lib/pactagent-workflow.test.ts
```

### Opt-in live demonstration

The live demonstration requires explicit configuration and skips cleanly
when configuration is missing:

```sh
PACTAGENT_LIVE_RELAY_URL=wss://relay.example \
PACTAGENT_CASHU_TEST_MINT_URL=https://testmint.example/cashu \
PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY=<hex> \
PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY=<hex> \
PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY=<hex> \
PACTAGENT_LIVE_NORMAL_SPEND_KEY=<hex> \
PACTAGENT_LIVE_REFUND_SPEND_KEY=<hex> \
PACTAGENT_LIVE_FUNDING_TOKEN=<cashuA...> \
PACTAGENT_LIVE_STATE_DIRECTORY=/private/path/pactagent-live-state \
npx vitest run src/lib/pactagent-workflow.live.test.ts
```

Missing live configuration causes a clean skip, never a fallback to
production or an arbitrary mint/relay.

## Test identity creation

For deterministic tests, identities are derived from fixed byte seeds:

```typescript
function key(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}
```

For the live demonstration, generate five independent 32-byte keys (requester,
provider, escrow authority, normal spend, and refund spend), for example by
running this command five times:

```sh
openssl rand -hex 32
```

Store the values and live-state directory securely. **Never commit private
keys, tokens, proofs, credentials, SQLite state, or payout material to the
repository.**

## Deterministic versus live verification

### Deterministic lane (required)

- Deterministic independent identities from fixed seeds
- In-memory relay implementing `NostrRelayAdapter`
- Deterministic fake `RequesterDecisionModel`
- Deterministic Cashu fixtures/backend (`FakeCashuPort`)
- In-memory settlement store
- Deterministic clock
- No network, credentials, live mint, or funds

### Live lane (opt-in)

- Existing `WebSocketNostrRelayAdapter`
- One explicitly configured Cashu test mint
- Unit `sat`
- Separately configured requester, provider, and escrow-authority identities
- Pre-acquired test ecash supplied as a Cashu token (`PACTAGENT_LIVE_FUNDING_TOKEN`)
- Durable private Cashu and escrow recovery state under `PACTAGENT_LIVE_STATE_DIRECTORY`
- Real signed PIP-00 provider definition, PactAgent service offer, and PIP-01 escrow descriptor published to and discovered from the configured relay
- Bounded operation timeouts
- Test ecash only; no production funds

Both lanes exercise the same `PactAgentWorkflow` application composition
and component boundaries.

## Public/private data boundaries

### Never in public events, logs, errors, or output

- Source document
- Private requester instruction or prompt
- Complete summary
- Terms-commitment salt/nonce
- Raw Cashu tokens or proofs
- Cashu secrets, witnesses, preimages, or blinded material
- Nostr or Cashu private keys
- Mint credentials
- Payout/redeem instructions
- Internal reconciliation material
- Sensitive escrow evidence

### Safe in public output

- Agreement ID and root event ID
- Participant public keys
- Selected stable references
- Public capability profile
- Public 350-sat amount and `sat` unit
- Public lifecycle states and event IDs
- Opaque escrow reference
- Safe result reference (SHA-256 hash)
- Safe settlement or refund reference
- Final public outcome

The integration tests scan public events, returned results, and captured
logs for synthetic secret markers (`PRIVATE-DOCUMENT`, `PRIVATE-PROMPT`,
`PRIVATE-RESULT`, `PRIVATE-PROOF`, etc.) to verify the boundary.

## Expected safe output

The workflow returns a `PactAgentWorkflowReport` containing only safe
public fields:

```typescript
{
  workflowVersion: 1,
  agreementId: "...",
  agreementRootEventId: "<64-char hex>",
  requesterPublicKey: "<64-char hex>",
  providerPublicKey: "<64-char hex>",
  escrowAuthorityPublicKey: "<64-char hex>",
  selectedReferences: {
    providerPublicKey: "...",
    providerDefinitionReference: "30360:...",
    offerReference: "30400:...",
    escrowDescriptorReference: "30361:...",
  },
  amountSats: "350",
  unit: "sat",
  lifecycle: [
    { state: "accepted", eventId: "..." },
    { state: "escrow_funded", eventId: "..." },
    { state: "task_delivered", eventId: "..." },
    { state: "result_submitted", eventId: "..." },
    { state: "result_verified", eventId: "..." },
    { state: "release_authorized", eventId: "..." },
    { state: "settled", eventId: "..." },
  ],
  escrowReference: "pactescrow_...",
  resultReference: "sha256:...",
  settlementReference: "pactsettlement_...",
  finalOutcome: "settled",
}
```

## Settlement reconciliation and publication retry

The workflow uses #13's existing idempotency and reconciliation behavior:

- Cashu release is not repeated after confirmed economic success.
- Cashu refund is not repeated after confirmed economic success.
- Publication failure is not treated as Cashu execution failure.
- Ambiguous mint operations retain `reconciliation_required` and do not
  advance the lifecycle.
- Stale, forked, malformed, unauthorized, or terminal history is rejected
  before Cashu execution.

## Reproducing the paths

### Successful path

```sh
npx vitest run src/lib/pactagent-workflow.test.ts -t "completes the full canonical"
```

### Refund path

```sh
npx vitest run src/lib/pactagent-workflow.test.ts -t "completes the timeout refund"
```

### Cross-boundary safety

```sh
npx vitest run src/lib/pactagent-workflow.test.ts -t "cross-boundary safety"
```

## AI/model boundary

The requester model is advisory only. It receives:

- Safe discovery projection (public keys, stable references, amount, duration)
- Private bounded instruction

It does NOT receive:

- Signer, relay, lifecycle, or Cashu capabilities
- Private keys, tokens, proofs, or secrets
- Signing, publication, lifecycle, or settlement authority

The deterministic CI lane uses an injected `FakeRequesterDecisionModel`.
A separately configured external model adapter may be used by the optional
live demonstration, but this issue does not introduce a model vendor, SDK,
credential management, model routing, or autonomous agent infrastructure.
