# Issue #38: Hosted Nostr / P002 Infrastructure

## Overview

Issue #38 moves the Nostr/P002 side of PactAgent from developer-local
infrastructure toward infrastructure suitable for a later public Railway
deployment (#39).

## Architecture

### Final Topology

```
PactAgent Requester Runtime
        │
        │ WSS
        ▼
    TLS / WSS edge (Caddy)
        │
        ▼
 Persistent Strfry (relay)
        │
        ├── P002 discovery / signed provider offers
        │
        └── NIP-59 encrypted private transport
                         │
                         ▼
                PactAgent Provider Service
                         │
                         ▼
                 Work / Result (document-summary@1)
                         │
                         ▼
                PactAgent Runtime
```

### Local Topology

```
Requester/Runtime (Next.js)
    → local Caddy (tls internal, :8443)
    → local Strfry (:7777)
    → local PactAgent Provider Service (Node.js)
    → local Demo Mint (FakeWallet, :3338)
```

### Hosted-Capable Topology

```
Requester/Runtime
    → configured WSS origin
    → TLS edge (Caddy, external TLS)
    → persistent Strfry (named volume)
    → hosted PactAgent Provider Service
```

## Services

### Strfry Relay

- **Image**: `dockurr/strfry@sha256:599ab3500dbfbe6cb78c668e1892cd9802c192d066df4660e8e3175034a8344d`
  (pinned Strfry 1.1.3)
- **Persistence**: Strfry LMDB database on a persistent volume
  - Local: `./.local/strfry-db:/app/strfry-db`
  - Hosted: named volume `strfry-db`
- **Limits** (two-limit contract):
  - `maxEventSize`: 4,194,304 bytes (normalized event JSON)
  - `maxWebsocketPayloadSize`: 4,194,560 bytes (complete `["EVENT", event]` frame)
  - The 256-byte envelope allowance is intentionally finite
- **Health**: HTTP 200 on `http://localhost:7777/`
- **Config files**:
  - `local/strfry.conf` — local acceptance
  - `local/strfry-hosted.conf` — hosted-capable

### Caddy TLS/WSS Edge

- **Image**: `caddy@sha256:14a9c00d4e833ebc2b65d36515b37bde3b73f0b323a2663aaafc88953d8c4e3f`
- **Local**: `tls internal`, self-signed CA, `:8443`
- **Hosted**: environment-driven hostname (`{$PACTAGENT_HOSTED_WSS_HOSTNAME}`),
  external TLS termination, no embedded domain
- **WebSocket**: `reverse_proxy` preserves WebSocket upgrade
- **Health**: `/health` endpoint returns 200
- **Config files**:
  - `local/Caddyfile` — local acceptance
  - `local/Caddyfile-hosted` — hosted-capable

### PactAgent Provider Service

The standalone long-running provider service (`pactagent-provider-service.ts`):

1. Establishes stable provider Nostr identity (server-side only)
2. Connects to the configured relay
3. Publishes P002 artifacts (definition, offer, escrow descriptor)
4. Polls for new agreement root events addressed to it (see
   [Agreement Polling](#agreement-polling-59))
5. For each new agreement:
   - Validates the agreement root
   - Creates and signs the escrow authority source
   - Accepts the agreement (publishes "accepted" transition)
   - Waits for "escrow_funded" transition
   - Retrieves NIP-59 gift wrap task
   - Decrypts and executes the document-summary@1 capability
   - Seals and publishes the result via NIP-59
   - Publishes "task_delivered" and "result_submitted" transitions
6. Handles relay reconnect (bounded polling, idempotent event processing)
7. Has health/readiness (process alive vs protocol ready)

### PactAgent Workflow (externalProvider mode)

The `PactAgentWorkflow` class supports an `externalProvider` flag:
- When `true`: the workflow publishes the agreement root, then **polls** the
  relay for provider transitions (accepted, result_submitted) instead of
  creating them inline
- When `false` (default): the original single-process behavior is preserved
- All #33–#37 economic/security invariants are preserved in both modes

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PACTAGENT_LIVE_RELAY_URL` | Yes | WSS relay URL (server-side only) |
| `PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY` | Yes | Provider Nostr private key (32-byte hex) |
| `PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY` | One escrow authority key required | Public key (64-hex), or configure the private-key counterpart for cryptographic derivation |
| `PACTAGENT_PROVIDER_MODE` | Yes | Explicitly `local` or `hosted`; missing or unknown values fail closed |
| `PACTAGENT_RUNTIME_MODE` | Yes | Explicitly `local` or `hosted`; missing or unknown values fail closed |
| `PACTAGENT_PROVIDER_OFFER_SATS` | No | Offer amount in sats (default: 350) |
| `PACTAGENT_PROVIDER_MAX_EXECUTION_SECONDS` | No | Max execution time (default: 120) |
| `PACTAGENT_PROVIDER_ESCROW_TIMEOUT_SECONDS` | No | Escrow timeout (default: 900) |
| `PACTAGENT_PROVIDER_POLL_INTERVAL_MS` | No | Poll interval (default: 3000) |
| `PACTAGENT_PROVIDER_STATE_DIRECTORY` | No | Provider state directory |
| `PACTAGENT_HOSTED_WSS_HOSTNAME` | Hosted Compose | Explicit hosted WSS hostname for Caddy; no localhost fallback |

`compose.hosted.yml` uses fail-closed `${PACTAGENT_HOSTED_WSS_HOSTNAME:?error}`
expansion. Local acceptance supplies `localhost` explicitly and uses its own
Caddyfile; production hosted configuration never inherits that value as a
default.

### Secret Boundaries

- Provider private key: server-side only, never in browser bundle
- Never returned through requester DTOs
- Never logged
- Never in `NEXT_PUBLIC_*`
- Hosted mode fails closed if identity is missing (no silent generation)
- Provider identity is stable across restart

## Transport-Size Contract

Two limits are enforced:

1. **Normalized signed Nostr event size** (`maxEventSize`): 4,194,304 bytes
2. **Full WebSocket EVENT frame size** (`maxWebsocketPayloadSize`): 4,194,560 bytes

Both are validated before an irreversible economic action. The application
limits and Strfry configuration agree. The doctor verifies this agreement.
Accepted task documents and prompts are base64-normalized inside the encrypted
private message, so JSON escaping cannot make one media type exceed the bound.
At the inclusive 1 MiB source limit with a maximum prompt, the measured
normalized event is 3,495,765 bytes and the complete WebSocket frame is
3,495,775 bytes, leaving a 698,539-byte normalized-event margin.

## Privacy Model

Private task/result content is never exposed in:
- Public Nostr event content
- Relay-readable outer event
- Requester safe DTO
- Browser URLs
- Logs
- Health endpoints
- Provider definition
- Public offer
- Error messages

NIP-59 gift wrap is used for all private transport. No plaintext HTTP.

## Resource/Abuse Controls

Strfry enforces:
- Maximum event size (4 MiB normalized)
- Maximum WebSocket payload (4 MiB + 256 bytes)
- No public relay access (internal network only in hosted mode)

Application enforces:
- Event/tag validation (malformed events rejected)
- Signature verification
- Provider identity check (wrong provider events ignored)
- Idempotent event processing (replayed events don't duplicate work)
- Bounded agreement polling: addressed roots only, no timestamp beyond trusted
  time plus clock skew, a fixed page budget per poll, and bounded retries
  (see [Agreement Polling](#agreement-polling-59))

## Health / Readiness / Doctor

### Provider Service Readiness

- `processAlive`: true if the Node.js process is running
- `protocolReady`: true only when artifacts are published, the relay is
  connected, polling is healthy, and the durable store is healthy
- `relayConnected`: derived from an actual relay reconnect/readiness check
- `artifactsPublished`: true if definition/offer/descriptor are published
- `pollHealthy`: false after a provider poll/query failure until a successful
  poll restores health
- `storeHealthy`: false if the durable idempotency store cannot be inspected
- `recoveryRequiredCount`: the number of durable records requiring explicit
  operator recovery

The standalone provider's `/ready` response is sourced from the running
`PactAgentProviderService` and exposes only safe operational state. Store or
poll failure makes `protocolReady` false.

### Doctor (`scripts/hosted-doctor.mjs`)

Checks:
1. Provider and runtime modes are present and are exactly `local` or `hosted`
2. Hosted compose and hosted-only Strfry/Caddy configuration are present
3. Strfry event and WebSocket limits match the application contract
4. Active hosted Caddy directives use automatic HTTPS, contain no
   `tls internal`, and require an explicit hostname without a localhost fallback
5. Relay URL and hosted hostname are configured
6. Provider and escrow identities are present without browser exposure
7. Docker and the hosted Strfry/Caddy containers are healthy
8. The internal Strfry listener and Caddy WSS port are reachable
9. A WSS Nostr handshake and read-only query succeed
10. Provider `/ready` is available and reports protocol, relay, poll, store,
    recovery, and artifact readiness
11. The provider's P002 definition, offer, and escrow descriptor are read and
    validated through the relay
12. The authenticated runtime readiness endpoint reports the actual hosted,
    external-provider composition
13. Provider SQLite and persistence paths are available
14. Relay configuration remains server-side

The doctor is economically read-only: it never creates Cashu activity,
spends proofs, exposes keys, or performs a real transaction.

## Restart/Recovery

### Relay Restart
- Strfry database persists across container restart
- Provider service reconnects and resumes polling
- Already-processed agreements are not re-accepted (idempotency)

### Provider Restart
- Provider identity is stable (same private key from env)
- Already-published artifacts are re-published (Strfry deduplicates)
- In-flight agreements resume from the durable SQLite idempotency state and
  are reconciled against relay state. Every incomplete record's root is
  fetched by id after a restart, so recovery does not depend on the root
  still being inside the poll window
- Polling resumes from the durable poll cursor and re-scans the overlap window
- Prepared results persist the exact signed NIP-59 result event before first
  publication so restart reuses the same event identity

### Requester/Runtime Restart
- Existing #33 recovery is preserved
- External provider mode is compatible with existing resume logic

## Replay/Idempotency

- Provider service stores agreement processing state durably in SQLite,
  including acceptance, funding wait, processing, prepared/published result,
  transition reconciliation, completion, and recovery-required states
- Replaying a valid relay event does not produce duplicate:
  - Agreements (same root event ID resumes or returns its durable state)
  - Provider execution (re-execution is allowed only for explicitly
    replay-safe capability work)
  - Result publication (the exact persisted signed event is reused)
  - Economic authorization (settlement coordinator idempotency keys)

## Agreement Polling (#59)

The provider discovers agreement roots by polling the relay. Relay output is
untrusted input: it decides what the provider looks at, never what the
provider accepts.

### Query

Each page asks for kind `3921` events tagged
`t=pactagent/service-agreement-root@1` **and** `p=<provider public key>`,
with `since` and `until` both inclusive and `limit: 100`. `until` starts at
`now + PACT_AGREEMENT_CLOCK_SKEW_SECONDS` (60 s), so the relay never returns
roots for other providers or roots dated beyond the permitted skew.

The provider still re-checks every event itself: signature, the scan window
against its own clock, the `t` tag, and the signed root content naming this
provider (`parsePactServiceAgreementRootEvent` requires the `p` tags to equal
the requester and provider in the content). Only then is the root validated
and processed as before. The `#p` filter only selects what to look at; it
grants nothing.

A full page means older roots may remain, so the next page uses `until` set
to the page's oldest timestamp. If one second holds a full page, the provider
steps one second below it and logs `provider_poll_page_saturated`. A poll
fetches at most 10 pages; a longer scan resumes on the next poll.

### Cursor

The cursor `W` is a Unix timestamp. A scan begins at trusted time `t0` and
covers the window `[since, t0 + 60]` with `since = max(0, W - 120)`; the
120 s overlap (`AGREEMENT_POLL_OVERLAP_SECONDS`, twice the protocol skew)
re-reads roots from requesters whose clocks trail by up to the skew, plus
publication delay.

Only after a scan has covered its whole window:

```
target = min(t0, newest addressed root seen, oldest root still retrying)
W'     = max(0, min(now, max(W, target)))
```

`t0` is the scan's start time, not the window's lower bound. The cursor
therefore advances whenever the scan saw an addressed root newer than `W`, up
to `t0`. With no newer root it stays put (the issue's
`min(now, maxAcceptedCreatedAt)`). It does not jump to wall-clock time, so a
provider clock running ahead of its requesters cannot push it past their roots.

- Events for other providers, malformed or unsigned events, and events outside
  the window never contribute.
- `W'` never exceeds trusted time, so a future-dated root cannot push it
  ahead. Roots up to `now + 60` are processed; later ones are deferred and
  picked up once the clock reaches them.
- If the clock moves backward, `W` is pulled back to `now` (more is re-read,
  nothing is skipped). A persisted cursor ahead of the clock is treated the
  same way at startup.
- A query failure, timeout, or disconnect leaves the scan and the cursor
  unchanged; the next poll retries the same page.

Roots re-read in the overlap are not handled twice: the in-memory processed-id
set skips them, and the durable operation record remains the authority across
restarts.

### Retries

A root whose handling fails before its outcome is durably decided holds the
cursor and is tried again on the next scan:

- A local store failure (read or initial record write) retries without limit
  and is not caused by the root.
- A relay failure fetching the requester definition, or an unexpected error,
  is retried at most 3 times in total. A root author can provoke this kind of
  failure, so after that the provider logs `provider_agreement_retry_exhausted`
  and lets the cursor move on. If the root already has a durable record, that
  record is still recovered after the next restart.

### Persistence

The cursor is stored in the provider SQLite database in a separate
`pact_provider_metadata` table (`key = agreement_poll_cursor`,
`{"version":1,"created_at":<unix>}`), never as an operation record. The
table is created on open, so pre-#59 databases open unchanged and keep their
records. A database without a cursor starts at the current time (the first
scan re-reads the overlap window) and persists that starting point
immediately.

A cursor write that fails is not adopted: the in-memory cursor keeps the last
persisted value, `pollHealthy` becomes false, and the next poll re-scans. A
crash before the write re-scans from the previous cursor; already-recorded
roots are recognised by their durable records and are not accepted again.

A corrupt or malformed cursor fails polling closed: `pollHealthy` and
`protocolReady` are false and no agreement is processed. Startup is not
blocked; the cursor is re-read on every poll. To recover, an operator can
either write a valid value (a timestamp at or before the last known-good poll)
or delete the `agreement_poll_cursor` row. Deleting it restarts polling from
the current time, so roots older than the overlap that have no durable record
are not re-discovered.

### Limits

- Discovery depends on the relay retaining roots for the scan window and
  returning the newest events first for a `limit` query (NIP-01; Strfry does).
- A root that reaches the relay more than the overlap (120 s) older than the
  cursor is not polled.
- NIP-01 filters cannot page within one second. Ordering inside such a
  second is up to the relay, so more than 100 addressed roots sharing one
  second can hide a root in that second.
- Anyone can publish a signed root addressed to the provider. Each one costs
  the provider a requester-definition lookup once per process lifetime (more
  if the in-memory set of 10,000 ids overflows). Relay write policy (#62) is
  the control for that volume.
- Roots are processed one at a time within a poll. An agreement waiting for
  funding blocks the loop for up to the transition wait timeout, as before
  #59.

## Deployment Handoff (#39)

#39 will need to:
1. Provision a public domain and DNS for the hosted WSS hostname
2. Set `PACTAGENT_HOSTED_WSS_HOSTNAME` to the public domain
3. Deploy the existing automatic-HTTPS hosted Caddy configuration; keep the
   separate `tls internal` Caddyfile limited to local acceptance
4. Deploy `compose.hosted.yml` services (Strfry, Caddy) to Railway
5. Deploy the provider service as a Railway worker process
6. Deploy the PactAgent runtime as a Railway web service
7. Configure persistent volumes for Strfry DB and provider state
8. Set all required environment variables in Railway
9. No code changes should be required — only configuration/composition

#38 does NOT perform the final Railway deployment.

## npm Scripts

```bash
# #38 hosted protocol acceptance (container-backed)
npm run test:hosted-nostr:live

# Provider service live tests (requires relay)
npm run test:provider:live

# Hosted protocol live tests (requires relay)
npm run test:hosted-protocol:live

# Hosted doctor/preflight
npm run hosted:doctor

# Start the provider service
npm run provider:start
```
