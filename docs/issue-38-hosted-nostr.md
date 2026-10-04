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
4. Polls for new agreement root events where it is the provider
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
  are reconciled against relay state
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
