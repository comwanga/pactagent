# PactAgent long-lived runtime

Issue #33 wraps the corrected #16 workflow in a long-lived runtime with an
HTTP transaction surface, durable recovery state, and an opt-in live bootstrap.
It does not re-implement any #9–#15 boundary: discovery, decision, agreement,
private transport, Cashu, and settlement are composed as-is. The runtime is a
thin shell — application code, not a Pontmore PIP, a Nostr standard, or a Cashu
protocol extension.

## Components

| Component | File | Role |
|---|---|---|
| Runtime | `src/lib/pactagent-runtime.ts` | `start`/`shutdown`, durable `acceptTransaction`, `status`, `report`, `privateResult`, `resume`, `reconcile`, `bootstrap` |
| Singleton | `src/lib/pactagent-runtime-singleton.ts` | process-wide runtime + bearer auth + redacted errors |
| Live wiring | `src/lib/pactagent-runtime.live.ts` | env config → identities/stores/relay/cashu → bootstrap → runtime |
| HTTP routes | `src/app/api/transactions/**`, `src/app/api/runtime/bootstrap` | route handlers delegating to the singleton |

The runtime creates an isolated `PactAgentWorkflow` per transaction, sharing
only the long-lived dependencies (relay, clock, deterministic policy,
requester-decision adapter, Cashu port, private delivery, settlement store,
spend keys).

## HTTP surface

All transaction endpoints require `Authorization: Bearer <token>` (the
`PACTAGENT_RUNTIME_API_TOKEN`), return `Cache-Control: no-store`, and project
allowlisted DTOs. Errors are redacted to `{ error, code }` — never a raw cause
or stack.

```
POST   /api/transactions                 (Idempotency-Key header) → 202 + Location + { transactionId }
GET    /api/transactions/:id             → safe status DTO
GET    /api/transactions/:id/report      → safe terminal report (terminal only)
GET    /api/transactions/:id/result      → { summary } (authorized requester only)
POST   /api/transactions/:id/resume      → resume non-economic progress
POST   /api/transactions/:id/reconcile   → inspect + resume economic state
POST   /api/runtime/bootstrap            → { mintUrl, unit: "sat", ready: true }
```

`POST /api/transactions` validates the body (`privateDocument`,
`mediaType: "text/plain" | "application/pdf"`, optional `privatePrompt`,
`maximumBudgetSats`, and opaque `fundingReference`) and derives a stable transaction id from the idempotency
key (`txn_<sha256(key)[:32]>`). The initial private transaction record is committed
before the route returns `202`; server-owned execution then continues inside the
long-lived runtime. The id is immediately pollable, and any later failure is
reported through the safe status projection. Repeated keys return the existing
transaction and never schedule a second agreement or economic attempt.

Raw request bytes, document bytes (including encoded PDF input), and prompt
bytes are bounded before workflow invocation. Raw Cashu tokens are rejected by
the ordinary transaction API.

### Safe transaction status

`GET /api/transactions/:id` returns the authoritative allowlisted projection:

```ts
{
  transactionId: string;
  kind: "successful" | "refund";
  phase: string;
  operationalState:
    | "active"
    | "failed"
    | "reconciliation_required"
    | "resolved_not_funded"
    | "refunded"
    | "settled";
  agreementId: string;
  selectedOffer: {
    providerPublicKey: string;
    providerDefinitionReference: string;
    offerReference: string;
    escrowDescriptorReference: string;
    amountSats: string;
    unit: "sat";
  };
  requesterDecision?: {
    source: "deterministic" | "model";
    recommendation: {
      action: "recommend";
      providerPublicKey: string;
      offerReference: string;
      amountSats: string;
    };
    policy: {
      selectedProviderMatchesDiscovery: true;
      stableReferencesMatch: true;
      withinRequesterBudget: true;
      cashuCompatible: true;
      priceAllowed: true;
      executionDurationAllowed: true;
    };
    authorized: true;
  };
  availableActions: { resume: boolean; reconcile: boolean };
  resultAvailable: boolean;
  reportAvailable: boolean;
  failureCode?: "transaction_failed";
  // Safe agreement, escrow, result, settlement, and reconciliation references
  // appear only when they exist.
}
```

The selected-offer projection is available from durable acceptance onward. The
requester-decision projection appears after the recommendation has passed
deterministic policy and is restart-stable. `source` describes only the
recommendation adapter; it never changes the deterministic authorization
boundary. Deterministic mode emits `source: "deterministic"`; configured model
mode emits `source: "model"`. The source is runtime-owned and persisted with the
safe projection rather than inferred by the client.

`availableActions` is computed by the runtime, including expiry and existing
economic-operation recovery rules. Clients must not infer recovery actions from
phase names. `resultAvailable` and `reportAvailable` let clients avoid probing
private or terminal resources. An unavailable result or report returns a safe
typed `409` response (`result_not_available` or `report_not_available`), not a
generic internal error. A missing transaction remains `404 transaction_not_found`.

## Durable recovery state

The minimum private recovery state is persisted in the existing chmod-0600
`CashuPrivateStore` under scope `transaction`, keyed by the derived transaction
id. The record (version 1) holds `transactionId`, `idempotencyKey`, `kind`
(`"successful" | "refund"`), `phase`, `agreementId`, `agreementRootEventId`,
the safe selected-offer and requester-decision projections, `privateTerms`,
`privateSaltHex`, and the reconstructable references
(`escrowReference`, `escrowVersion`, `resultReference`, `settlementReference`,
`refundReference`). Branded context, completion decision, and funding are
reconstructed on resume from the relay and durable stores — never persisted
duplicated.

Resume reconstructs the agreement from the persisted root event id plus the
relay history, then re-invokes the workflow resume path, which delegates all
economic operations to the #13 coordinator's idempotent operations. Economic
work is therefore executed exactly once across restarts; an ambiguous mint
outcome stays `reconciliation_required` and is reconciled, never blindly
retried.

If NUT-07 proves every input UNSPENT, reconciliation resolves the attempt as
not submitted, removes prepared material, releases exposure, and returns the
current authoritative non-funded transaction status. It does not create a new
funding attempt. Existing submitted operations remain recoverable after expiry,
while genuinely fresh preparation stays prohibited.

## Bootstrap and live configuration

The live lane is opt-in and reads explicit environment variables. Missing
configuration raises a typed `invalid_configuration` error — never a fallback
to production or an arbitrary mint/relay.

| Variable | Purpose |
|---|---|
| `PACTAGENT_LIVE_RELAY_URL` | WebSocket Nostr relay |
| `PACTAGENT_CASHU_TEST_MINT_URL` | the single configured Cashu test mint |
| `PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY` | requester identity |
| `PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY` | provider identity |
| `PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY` | escrow authority identity |
| `PACTAGENT_LIVE_NORMAL_SPEND_KEY` | NUT-11 spend key (release) |
| `PACTAGENT_LIVE_REFUND_SPEND_KEY` | NUT-11 spend key (refund) |
| `PACTAGENT_LIVE_FUNDING_TOKEN` | pre-acquired test ecash (Cashu token) |
| `PACTAGENT_LIVE_FUNDING_REFERENCE` | opaque transaction reference authorized in private storage |
| `PACTAGENT_LIVE_STATE_DIRECTORY` | durable SQLite state directory |
| `PACTAGENT_RUNTIME_API_TOKEN` | bearer token for the API |
| `PACTAGENT_REQUESTER_DECISION_MODE` | `deterministic` (default) or `model` |
| `PACTAGENT_REQUESTER_MODEL_PROVIDER` | model provider; currently `openai` |
| `PACTAGENT_REQUESTER_MODEL_NAME` | model name required in model mode |
| `PACTAGENT_REQUESTER_MODEL_API_KEY` | provider credential required in model mode |

The local startup wrapper additionally reads `PACTAGENT_RUNTIME_API_BASE` and
`PACTAGENT_LOCAL_CA_PATH`. It supplies the resolved CA as `NODE_EXTRA_CA_CERTS`
when spawning Node; the application does not weaken TLS verification or mutate
Node's trust configuration after startup.

Bootstrap publishes or verifies the P001 requester definition, the P002
provider definition, the exact 350-sat `document-summary@1` offer, and the
PIP-01 Cashu escrow descriptor, then inspects the mint and enforces a literal
`sat` unit, and imports the funding token through the private import boundary.

Funding is single-use: each funded transaction consumes its token. Restart
recovery re-imports the token (a fingerprint-only operation) and resumes
without re-spending — a fresh token is required to fund a new transaction.

SIGTERM and SIGINT invoke the bounded singleton shutdown path exactly once,
disconnecting the relay before closing the SQLite stores.

## Operator commands

```sh
npm run runtime:bootstrap   # drive bootstrap over HTTP and print safe readiness
npm run runtime:start       # next start (requires a prior next build)
npm run runtime:start:local # production-like runtime with the local Caddy CA injected before Node starts
npm run local:doctor        # read-only Docker/TLS/relay/Testnut/SQLite preflight
npm run requester:model:doctor # one bounded non-economic model request
```

`runtime:bootstrap` is a thin Node wrapper (`scripts/runtime-bootstrap.mjs`)
that POSTs to `/api/runtime/bootstrap` against a running `runtime:start`
server.

The complete reproducible Strfry/Caddy/Testnut workflow is documented in
[`docs/local-development.md`](./local-development.md). Economic acceptance remains separate as
`npm run test:local:testnut` and is never part of `npm test` or `npm run test:process`.

## Verification lanes

- **Deterministic (CI-safe):** `npm test` drives the runtime and routes with an
  in-memory relay, deterministic clock, and fake Cashu port. No network,
  credentials, mint, or funds.
- **Process/recovery:** `npm run test:process` launches separate child processes
  and durable fixture stores to cover crash, restart, reconciliation, privacy,
  and signal behavior without external economic activity.
- **Local Testnut acceptance:** `npm run test:local:testnut` runs the doctor,
  starts the built HTTP runtime, attempts exactly one guarded 350-sat test
  transaction, scans public surfaces, and verifies durable reload. It is
  explicitly opt-in and consumes Testnut ecash.

## Privacy invariants

The status and report DTOs are explicit allowlists. Status includes lifecycle and
operational classification, the safe selected-offer/requester-decision projection,
runtime-owned action and resource availability, and safe references. The report adds
`workflowVersion`, participant public keys, `selectedReferences`, `amountSats`,
`unit`, and `lifecycle`). The private document, prompt, salt, summary, proofs,
tokens, and keys never appear in a public DTO, event, log, or response. The
private summary is retrievable only by the authorized requester through the
NIP-59 result boundary.

In model mode, the configured provider receives the bounded requester instruction,
capability profile, maximum budget, and safe verified-candidate facts (provider
public key, stable provider/offer/descriptor references, price, settlement network,
and maximum duration). It does not receive the source document, complete result,
funding reference, Cashu material, keys, API bearer token, settlement store, or
database content. Provider errors and response bodies are reduced to existing safe
requester-decision failure codes and never enter public DTOs or reports.
The OpenAI request sets `store: false`, so PactAgent requests no stored response
state and does not persist the provider response itself. Provider-side processing
or retention remains governed by the configured provider and account data controls.
