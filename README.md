# PactAgent

**Bounded economic agents contracting and settling over open Bitcoin protocols.**

PactAgent is an open-source framework for bounded economic agents that discover each other through
Nostr, form service agreements, exchange private work, and settle using Cashu. It builds on open
protocols and Pontmore concepts; PactAgent is not itself the Pontmore protocol.

<img width="1877" height="880" alt="image" src="https://github.com/user-attachments/assets/8d647cbf-ef6d-4a14-bbe3-ec244703c12a" />

## What PactAgent currently does

The integrated runtime executes the `document-summary@1` path end to end:

```text
Requester
  → Nostr provider discovery
  → signed 350-sat service offer
  → deterministic selection and optional model review
  → deterministic requester authorization
  → service agreement
  → Cashu escrow funding
  → NIP-59 private task/result exchange
  → completion verification
  → release authorization
  → Cashu settlement
```

The requester-decision adapter is configurable: deterministic mode remains the default for local
development and CI. In model mode, a configured OpenAI model reviews the already-selected offer
and can decline it, acting as a veto. A recommendation must preserve that provider, its references,
and its price; it cannot select another offer or override deterministic policy. The bounded
requester instruction is sent to the configured model provider. The model cannot sign, fund,
release, reconcile, or authorize. Deterministic policy decides whether an economic action is
authorized, and the runtime remains authoritative for lifecycle and recovery.
Public agreement events and API projections are separated from private task, result, Cashu, key,
and credential material.

PactAgent now includes the Issue #34 requester PoC as a thin client over the authenticated Issue #33
HTTP API. It supports in-memory submission, authoritative status/recovery actions, private-result and
safe-report retrieval, and same-browser reload recovery through an opaque server-owned session. This
is not production authentication or a multi-user deployment.

## Verified proof of operation

The local integration has been exercised end to end with a local Strfry relay, a local Caddy WSS
proxy, the Testnut Cashu test mint, and durable SQLite state. The verified proof-of-concept uses an
exact 350-sat service offer and demonstrates:

- funding and release coordinated through stable persisted operation identities;
- a final `settled` lifecycle;
- authorized private-result retrieval and safe terminal reporting;
- durable restart and reload recovery from persisted transaction state.

Testnut is test infrastructure and bearer test ecash is still single-use. It is not a production
mint or production-money environment.

The recovery design targets **at-most-once economic effect per persisted operation**,
**at-least-once publication attempts on recovery**, and an **idempotent delivery identity**
for recipient deduplication. These are not distributed exactly-once delivery or production
availability guarantees. Ambiguous mint submissions require reconciliation; ALL-UNSPENT alone
does not cancel an in-flight request or release its exposure. Durable state and correct mint
behavior remain assumptions; see [custody and guarantee limits](docs/architecture.md#custody-and-economic-guarantees).
Completion verification binds the private terms and result reference and checks the summary's
structure, not its factual accuracy or fairness to an independent provider.

## Live Demo deployment

The configured public demo endpoints are on Railway
([deployment documentation](docs/issue-39-railway-deployment.md)):

- Public PactAgent Demo: `https://pactagent-web-production.up.railway.app`
- Public relay (WSS): `wss://pactagent-relay-production.up.railway.app`

**Status (last verified: 2026-11-15 UTC):** the web root, `/api/health`, and relay
HTTPS root returned HTTP 200; a read-only WSS query completed with an event and EOSE.
The health response reported `runtimeInitialized: false` in the responding process.
These probes establish reachability and a working public relay read, not authenticated
runtime readiness, a verified deployed source revision, or successful economic execution.
The 2026-10-22 audit's 404 observation is historical, not the current status. Monitoring
and ongoing status maintenance are tracked in [#91](https://github.com/comwanga/pactagent/issues/91).

Demo sats have no monetary value. **Start Demo** is the intended demo entry point;
the dated reachability check did not run that flow. Operator diagnostics (requiring
access to the linked Railway project's configuration):

```sh
npm run railway:doctor
```

The full public acceptance is separately opt-in and creates demo economic activity;
it is not a read-only availability probe:

```sh
npm run railway:acceptance
```


## Architecture

```text
Requester UI -> explicit requester BFF -> authenticated HTTP API
        |
        v
PactAgent runtime
        |
        +-- Nostr -> configured WSS relay -> Strfry
        +-- private task/result -> NIP-59 boundary
        +-- Cashu -> configured mint (test/demo use only)
        +-- durable state -> SQLite
```

See the [architecture](docs/architecture.md), [runtime/API](docs/pactagent-runtime.md), and
[workflow](docs/pactagent-workflow.md) documentation for the detailed boundaries. The
[requester integration boundary](docs/requester-integration-boundary.md) documents the
Issue #34 browser-to-runtime contract, requester-session ownership, privacy model, and deterministic
browser acceptance suite.

## Requirements

- Node.js 22 or newer
- npm
- Docker Desktop or Docker Engine with Compose for the local relay stack
- fresh Testnut ecash only when running the opt-in economic acceptance

## Quick local development

```sh
npm install

# Copy .env.example to .env and supply local secrets and Testnut funding.
npm run local:up
npm run local:doctor
npm run runtime:start:local
```

Run the non-economic verification lanes separately:

```sh
npm test
npm run test:process
```

The Testnut acceptance is explicitly opt-in and economic:

```sh
npm run test:local:testnut
```

Shut down the local relay stack without deleting state:

```sh
npm run local:down
```

See [Local PactAgent development](docs/local-development.md) for setup, TLS, funding, doctor, and
state-reset details.

## Test lanes

GitHub Actions runs these on every pull request to `main`:
- `CI`: the deterministic lane, lint, type-check, the production build, the client-bundle privacy audit (`npm run audit:client-bundle`), and the #62 isolated Linux relay/FakeWallet hosted-protocol lane;
- `Acceptance`: the process lane and the requester browser lane.

The #62 lane exercises disposable containers without production credentials or
funds. Tests against configured external mints or hosted deployments remain
separately opt-in. Report test results per command, lane, and revision, including
skips; a combined count is not evidence that every live lane ran successfully.

### Deterministic

```sh
npm test
```

Uses in-memory/deterministic fixtures. It performs no relay or mint economic activity.

### Process and recovery

```sh
npm run test:process
```

Starts real child processes and durable fixture stores to exercise crashes, restarts,
reconciliation, privacy, and signal handling without external funds or mint submissions.

### Local Testnut acceptance

```sh
npm run test:local:testnut
```

Runs the doctor first, then attempts exactly one 350-sat golden-path transaction using Testnut test
ecash. It never blindly retries an ambiguous Cashu submission. This lane consumes Testnut ecash and
must not be treated as production-money testing.

### Requester browser acceptance

```sh
npm run test:e2e:requester
```

Runs deterministic Chromium acceptance against the test-only #33 HTTP fixture.
The separate economic live lane requires a prestarted configured runtime and is
explicitly opt-in:

```sh
npm run test:e2e:requester:live
```

Missing live configuration skips by category. Complete configuration with a
runtime/relay/mint failure fails without falling back to the fixture. See the
[requester live acceptance runbook](docs/requester-live-acceptance.md).

## Local developer commands

| Command | Purpose |
|---|---|
| `npm run local:up` | Start the Compose-owned Strfry and Caddy services and export the local CA root. |
| `npm run local:doctor` | Run zero-economic Docker, TLS, relay, Testnut, funding, and durable-state checks. |
| `npm run requester:model:doctor` | Make one bounded non-economic recommendation request to validate model configuration and structured output. |
| `npm run runtime:start:local` | Start the production-like Next.js runtime with the local CA injected before Node starts. |
| `npm test` | Run the deterministic, non-economic test suite. |
| `npm run test:process` | Run deterministic separate-process restart and recovery acceptance. |
| `npm run test:local:testnut` | Opt in to one guarded economic Testnut acceptance. |
| `npm run test:e2e:requester` | Run deterministic requester Chromium acceptance with the test-only fixture. |
| `npm run test:e2e:requester:live` | Opt in to one real requester-browser BOSS-stack test transaction. |
| `npm run local:down` | Remove only the Compose-owned local relay infrastructure while preserving data. |
| `npm run local:reset-state -- --force` | Archive safe project-local state and create a fresh directory; refuse risky state. |

## Environment

Copy [.env.example](.env.example) to `.env`. Configuration is grouped into:

- runtime API URL and bearer token;
- local relay, Testnut mint, state-directory, and CA paths;
- independent requester, provider, and escrow-authority Nostr keys;
- independent normal-spend and refund-spend Cashu keys;
- a Testnut funding token and opaque local funding reference.
- requester recommendation mode and, only for model mode, model provider, name, and API key.

Never commit `.env`, bearer ecash, proofs, private keys, SQLite files, or generated certificates.
Node reads extra CA roots during process initialization, so application code cannot safely set the
trust path after startup. `runtime:start:local` loads the configuration and supplies
`NODE_EXTRA_CA_CERTS` when it creates the actual Next.js child process.

## Safety and trust boundaries

- Signer and encryption boundaries retain private keys; the model receives no signing capability.
- Model mode sends the bounded requester instruction and safe verified-candidate projection to the
  configured provider; documents, results, wallet material, and runtime credentials are excluded.
- Cashu tokens, proofs, witnesses, preimages, and spending keys remain private.
- Public lifecycle/status/report objects are explicit allowlists.
- Private results are available only through the authorized private-result boundary.
- Ambiguous economic submissions enter reconciliation and are never blindly retried.
- The requester-decision recommendation is distinct from authorization; deterministic policy
  authorizes economic execution.

## Current limitations

PactAgent remains an integrated proof-of-concept and test environment, not production financial
software. Its configured mint path imports already-acquired ecash; there is no production wallet
or automatic Lightning acquisition. The existing economic mode named `live` is not production
approval or proof that configured ecash is valueless: operators must select and isolate test
mints and credentials. The requester runtime controls the escrow-authority signer and both
NUT-11 spending keys, so providers trust operator-controlled custody, not trust-minimized escrow.
See the [custody assumptions](docs/architecture.md#custody-and-economic-guarantees).
The requester-facing session boundary is
PoC transaction ownership rather than production authentication or a multi-user account system.
The initial optional model integration supports OpenAI's Responses API; generic provider routing,
local-model hosting, and production credential management remain out of scope.

## Documentation

- [Architecture](docs/architecture.md)
- [Local development](docs/local-development.md)
- [Requester live browser acceptance](docs/requester-live-acceptance.md)
- [Runtime and HTTP API](docs/pactagent-runtime.md)
- [End-to-end workflow](docs/pactagent-workflow.md)
- [Service agreements](docs/pact-service-agreements.md)
- [Cashu test-mint adapter](docs/cashu-test-mint-adapter.md)
- [Cashu escrow settlement](docs/cashu-escrow-settlement.md)
- [PIP-01 Cashu descriptor](docs/pip01-cashu-descriptor.md)
- [Private task/result transport boundaries](docs/pactagent-workflow.md#publicprivate-data-boundaries)
- [Railway deployment](docs/issue-39-railway-deployment.md)

## Collaboration

PactAgent is being developed in collaboration with
[Denver Mtange](https://github.com/mk-Denver).

## License

MIT
