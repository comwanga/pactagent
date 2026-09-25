# Local PactAgent development

The local stack preserves the production boundaries while keeping infrastructure small:

```text
HTTP :3000
  → PactAgent production Next.js runtime
  → wss://localhost:8443
  → Caddy TLS proxy
  → Strfry :7777
  → Testnut Cashu test mint
  → project-local SQLite state
```

Testnut is testing infrastructure and does not use production money, but its ecash is still
single-use bearer value. Keep the live acceptance explicitly opt-in.

## Requirements

- Node.js 22 or newer
- npm
- Docker Desktop or Docker Engine with Compose
- locally generated test identities and API token
- fresh Testnut `sat` ecash only for the opt-in economic lane

## First setup

1. Copy `.env.example` to `.env`.
2. Generate separate local requester, provider, escrow-authority, normal-spend, and refund-spend
   keys. Set a strong local API bearer token.
3. Acquire a Testnut `sat` token and configure its opaque local funding reference. Never commit the
   token or keys.
4. Run `npm run local:up`. This starts only Strfry and Caddy, creates the ignored `.local`
   directories, and exports Caddy's root certificate to `.local/pactagent-ca/root.crt`.
5. Run `npm run local:doctor`. Resolve every `FAIL` before starting a transaction.
6. Run `npm run runtime:start:local`. The wrapper builds when needed and spawns the real Next.js
   runtime with `NODE_EXTRA_CA_CERTS` present at child-process creation.
7. Develop and run `npm test` plus `npm run test:process` normally.
8. Stop the runtime with Ctrl-C, then run `npm run local:down`.

Deterministic requester recommendations are the default. To opt into model mode,
set `PACTAGENT_REQUESTER_DECISION_MODE=model` plus the provider, model-name, and
API-key variables documented in `.env.example`, then run
`npm run requester:model:doctor`. The doctor makes one bounded recommendation
request but creates no transaction and performs no Nostr or Cashu operation.
The private requester instruction is sent to the configured provider in model
mode; the source document and economic credentials are not.

`local:down` removes only Compose containers and their network. It preserves `.env`, the local CA,
Strfry data, Testnut funding configuration, SQLite state, and diagnostic evidence.

The successful startup order is Strfry health → Caddy health and CA export → doctor → runtime.
The runtime initializes its relay/bootstrap/mint wiring lazily on the first authenticated API call;
`npm run runtime:bootstrap` can drive that initialization explicitly and returns only safe
readiness fields. A green doctor always ends with:

```text
PACTAGENT LOCAL ENVIRONMENT READY
```

## Verification lanes

| Command | Network/economic behavior |
|---|---|
| `npm test` | Deterministic and non-economic |
| `npm run test:process` | Deterministic separate-process recovery acceptance; non-economic |
| `npm run local:doctor` | Live but read-only: Docker, WSS, relay, Testnut NUT-07, and SQLite inspection |
| `npm run requester:model:doctor` | One bounded provider call; no PactAgent transaction or economic operation |
| `npm run test:local:testnut` | Explicitly opt-in; consumes Testnut ecash in exactly one golden-path transaction |

`test:local:testnut` must own port 3000, so stop a separately running local runtime first. It runs
the doctor, builds and starts a runtime child, bootstraps, attempts exactly one fresh transaction,
checks one funding and one release operation, scans public API/relay/runtime-log surfaces for its
private markers, restarts the runtime against the same SQLite state, and confirms `settled` after
reload. It never automatically retries an ambiguous submission.

Required configuration names and safe local defaults are maintained in `.env.example`. The
runtime API base and CA path are local-launcher settings; identity, API-token, spending-key,
funding-token, and funding-reference values are secrets and must be supplied locally.

## Doctor failures

The doctor prints only safe aggregate facts and configuration variable names. It never prints
tokens, keys, proofs, private documents, prompts, or authorization values. Typical actionable
failures include:

```text
FAIL: local CA — missing at ...
FAIL: funding proofs — 0/4 UNSPENT
FAIL: aggregate exposure — stale exposure 351 sats in configured state directory
FAIL: reconciliation state — 1 operation(s) require reconciliation
```

An active exposure, incomplete transaction, reconciliation-required operation, or expired
unresolved escrow must be handled by the existing recovery tooling or isolated in a deliberately
chosen state directory. Do not delete it to make the doctor green.

## Local state reset

The optional reset is intentionally explicit:

```sh
npm run local:reset-state -- --force
```

It works only for state inside the ignored project `.local` directory. It refuses any state with
active exposure, incomplete transactions, reconciliation requirements, ambiguity, or expired
unresolved escrows. Safe state is moved to `.local/state-archive` rather than deleted, then a fresh
directory is created.

## TLS details

Caddy generates a local CA in `.local/caddy-data`. `local:up` copies only its public root
certificate to `.local/pactagent-ca/root.crt`. Private CA material remains ignored under `.local`.
The runtime and doctor launchers resolve `PACTAGENT_LOCAL_CA_PATH` (or the default root path) and
set `NODE_EXTRA_CA_CERTS` in the child environment before Node starts. TLS verification remains
enabled; application code never changes Node's trust store after initialization.
