# PactAgent

**Bounded economic agents contracting and settling over open Bitcoin protocols.**

PactAgent is an open-source framework for bounded economic agents that discover each other through
Nostr, form service agreements, exchange private work, and settle using Cashu. It builds on open
protocols and Pontmore concepts; PactAgent is not itself the Pontmore protocol.

## What PactAgent currently does

The integrated runtime executes the `document-summary@1` path end to end:

```text
Requester
  → Nostr provider discovery
  → signed 350-sat service offer
  → deterministic or model-backed requester recommendation
  → deterministic requester authorization
  → service agreement
  → Cashu escrow funding
  → NIP-59 private task/result exchange
  → completion verification
  → release authorization
  → Cashu settlement
```

The requester-decision adapter is configurable: deterministic mode remains the default for local
development and CI, while model mode uses a configured OpenAI model for an advisory recommendation.
The bounded requester instruction is sent to that provider in model mode. The model cannot sign,
fund, release, reconcile, or authorize. Deterministic policy independently decides whether an
economic action is authorized, and the runtime remains authoritative for lifecycle and recovery.
Public agreement events and API projections are separated from private task, result, Cashu, key,
and credential material.

PactAgent currently exposes a runtime and authenticated HTTP API. A requester-facing UI is a future
layer and is not part of Issue #33.

## Verified proof of operation

The local integration has been exercised end to end with a local Strfry relay, a local Caddy WSS
proxy, the Testnut Cashu test mint, and durable SQLite state. The verified proof-of-concept uses an
exact 350-sat service offer and demonstrates:

- exactly-once funding and release;
- a final `settled` lifecycle;
- authorized private-result retrieval and safe terminal reporting;
- durable restart and reload without repeating economic work.

Testnut is test infrastructure and bearer test ecash is still single-use. It is not a production
mint or production-money environment.

## Architecture

```text
HTTP API / future requester UI
        │
        ▼
PactAgent runtime
        │
        ├── Nostr → local WSS relay → Strfry
        ├── private task/result → NIP-59 boundary
        ├── Cashu → configured test mint
        └── durable state → SQLite
```

See the [architecture](docs/architecture.md), [runtime/API](docs/pactagent-runtime.md), and
[workflow](docs/pactagent-workflow.md) documentation for the detailed boundaries.

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
software. The runtime uses one explicitly configured Cashu test mint, has no production wallet or
automatic Lightning acquisition of ecash, and has no real-sats/production mode. Developers provide
their own isolated test keys, API token, and Testnut ecash. The requester-facing UI is the next
application layer and is outside this runtime work. The initial optional model integration supports
OpenAI's Responses API; generic provider routing, local-model hosting, and production credential
management remain out of scope.

## Documentation

- [Architecture](docs/architecture.md)
- [Local development](docs/local-development.md)
- [Runtime and HTTP API](docs/pactagent-runtime.md)
- [End-to-end workflow](docs/pactagent-workflow.md)
- [Service agreements](docs/pact-service-agreements.md)
- [Cashu test-mint adapter](docs/cashu-test-mint-adapter.md)
- [Cashu escrow settlement](docs/cashu-escrow-settlement.md)
- [PIP-01 Cashu descriptor](docs/pip01-cashu-descriptor.md)
- [Private task/result transport boundaries](docs/pactagent-workflow.md#publicprivate-data-boundaries)

## Collaboration

PactAgent is being developed in collaboration with
[Denver Mtange](https://github.com/mk-Denver).

## License

MIT
