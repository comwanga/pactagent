# Issue #39 — Railway Deployment

Production-like Demo deployment of PactAgent on [Railway](https://railway.com).
This document describes the deployed architecture, trust boundaries, operations,
and acceptance procedures. It contains NO secret values — only variable names
and classifications.

## 1. Deployed architecture

```text
PUBLIC INTERNET
      |
      v
+---------------------------+        +--------------------------+
| pactagent-web (public)    |        | pactagent-relay (public) |
| Next.js 16.3.8            |        | Caddy WSS edge           |
| requester UI + BFF        |        | (platform TLS)           |
| PactAgent runtime         |        +------------+-------------+
| (hosted, external         |                     | private net
|  provider mode, demo      |                     v
|  economic mode)           |        +--------------------------+
+----------+----------------+        | pactagent-strfry (private)|
           | private net            | persistent Nostr relay    |
           |                        +------------+-------------+
           |                                     ^
           |                                     | private WSS
           v                                     | (via relay edge)
+---------------------------+        +-----------+-------------+
| pactagent-demo-mint       |        | pactagent-provider      |
| Nutshell 0.21.0           |        | standalone P002 provider|
| FakeWallet backend        |        | private key + durable   |
| (private)                 |        | idempotency store       |
+---------------------------+        +-------------------------+
```

Deployed flow (verified by the production acceptance):

```text
Browser → pactagent-web (public HTTPS)
  → same-origin requester BFF
  → PactAgentRuntime (hosted/external-provider, demo economic mode)
  → pactagent-relay (public wss://, trusted TLS, platform edge)
  → pactagent-strfry (persistent)
  → pactagent-provider (standalone, P002 discovery)
  → NIP-59 private task/result transport
  → pactagent-demo-mint (Demo Cashu, FakeWallet)
  → settlement
  → authoritative Demo wallet accounting
```

## 2. Railway services

| Service | Purpose | Exposure | Internal port | Health check | Volume |
|---|---|---|---|---|---|
| `pactagent-web` | Requester UI, BFF, runtime | Public HTTPS (generated domain) | 3000 | `GET /api/health` | `/data` |
| `pactagent-provider` | Standalone P002 provider service | Private | 3939 | `GET /health` | `/data` |
| `pactagent-strfry` | Persistent Nostr relay | Private | 7777 | `GET /` | `/app/strfry-db` |
| `pactagent-relay` | Caddy WSS edge (platform TLS termination) | Public WSS (generated domain) | 8080 | `GET /health` (upstream-aware readiness) | none |
| `pactagent-demo-mint` | Nutshell FakeWallet Demo Cashu mint | Private | 3338 | `GET /v1/info` | `/app/data` |

### Service-to-service paths (private network)

- `pactagent-web` → `pactagent-demo-mint.railway.internal:3338` (HTTP, explicit
  allowlist — see below)
- `pactagent-web` → `wss://pactagent-relay-production.up.railway.app` (public
  trusted WSS; the platform edge terminates TLS)
- `pactagent-provider` → same public WSS relay URL
- `pactagent-relay` → `pactagent-strfry.railway.internal:7777`

Strfry and the Demo mint have no public domains and no public DNS records.

## 3. Trust boundaries

1. The browser never receives runtime bearer credentials, provider private
   keys, Cashu proofs, or Demo spend/refund keys.
2. The provider private key exists ONLY in `pactagent-provider`.
3. The escrow authority private key exists ONLY in `pactagent-web`.
   `pactagent-provider` receives only the escrow authority PUBLIC key.
4. The requester private key, runtime API token, and Demo spend/refund keys
   exist ONLY in `pactagent-web`.
5. The mint master key (`MINT_PRIVATE_KEY`) exists ONLY in
   `pactagent-demo-mint`.
6. `PACTAGENT_RUNTIME_MODE=hosted` and `PACTAGENT_ECONOMIC_MODE=demo` are
   explicit; there is no fallback to a local/in-process provider.
7. Public browser traffic uses trusted HTTPS/WSS (Let's Encrypt via the
   Railway edge). No custom CA, no `NODE_TLS_REJECT_UNAUTHORIZED`.
8. Strfry events survive restarts/redeploys (Railway volume).
9. Provider idempotency/recovery state survives restarts (Railway volume).
10. Requester sessions and Demo wallet state survive restarts (Railway volume
    under `PACTAGENT_DEMO_STATE_DIRECTORY=/data`).

Strfry runs under a bounded PID 1 shutdown wrapper instead of the upstream
process-group broadcast. The wrapper forwards an intentional Railway SIGTERM
to the Strfry child, waits up to ten seconds for it to be fully reaped, and
returns a controlled retryable status instead of the signal-derived status 143.
The bounded `ON_FAILURE` policy then remounts the persistent volume once the
old process is gone. Unexpected Strfry exits still propagate their original
status to Railway. A normal Railway restart therefore starts the same deployment
without requiring a redeploy.

## 4. Persistence volumes

| Volume | Mount | Service | Data stored | Restart expectation |
|---|---|---|---|---|
| `pactagent-web-data` | `/data` | web | `cashu-private.sqlite`, `escrow-settlement.sqlite`, `requester-sessions.sqlite`, Demo wallet generations | Sessions, wallets, and settlement state survive restart/redeploy |
| `pactagent-provider-data` | `/data` | provider | `provider-operations.sqlite` idempotency store | Recovery/idempotency survive restart/redeploy |
| `pactagent-strfry-db` | `/app/strfry-db` | strfry | Strfry LMDB event database | Events survive restart/redeploy |
| `pactagent-demo-mint-data` | `/app/data` | demo-mint | Nutshell SQLite (keysets, proofs, quotes) | Mint state survives restart/redeploy |

Both application services run as the non-root `node` user (UID 1000); see
section 15. The `/data` mount is created node-owned in the image, so a FRESH
volume inherits node ownership and works without intervention. An EXISTING
volume that contains files written by the previous root-running image must be
migrated once before the hardened image can start (see section 15.6).

## 5. Variables (names only)

### pactagent-web

Public non-secret:

- `NODE_ENV`, `PORT`
- `PACTAGENT_RUNTIME_MODE` (`hosted`)
- `PACTAGENT_ECONOMIC_MODE` (`demo`)
- `PACTAGENT_RUNTIME_API_BASE`
- `PACTAGENT_REQUESTER_UI_ORIGIN`
- `PACTAGENT_REQUESTER_DECISION_MODE`
- `PACTAGENT_DEMO_CASHU_MINT_URL`
- `PACTAGENT_DEMO_MINT_PRIVATE_HOSTS`
- `PACTAGENT_DEMO_STATE_DIRECTORY`
- `PACTAGENT_DEMO_WALLET_INITIAL_BALANCE_SATS`
- `PACTAGENT_LIVE_RELAY_URL`
- `PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY` (public key)

Server secrets:

- `PACTAGENT_RUNTIME_API_TOKEN`
- `PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY`
- `PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY`
- `PACTAGENT_DEMO_NORMAL_SPEND_KEY`
- `PACTAGENT_DEMO_REFUND_SPEND_KEY`
- `PACTAGENT_DEMO_FUNDING_REFERENCE`

### pactagent-provider

Public non-secret:

- `NODE_ENV`, `PORT`
- `PACTAGENT_PROVIDER_MODE` (`hosted`)
- `PACTAGENT_PROVIDER_STATE_DIRECTORY`
- `PACTAGENT_PROVIDER_READINESS_HOST`, `PACTAGENT_PROVIDER_READINESS_PORT`
- `PACTAGENT_PROVIDER_OFFER_SATS` (350)
- `PACTAGENT_PROVIDER_MAX_EXECUTION_SECONDS`
- `PACTAGENT_PROVIDER_ESCROW_TIMEOUT_SECONDS`
- `PACTAGENT_PROVIDER_POLL_INTERVAL_MS`
- `PACTAGENT_PROVIDER_TRANSITION_TIMEOUT_MS`
- `PACTAGENT_PROVIDER_DEFINITION_ID`
- `PACTAGENT_PROVIDER_OFFER_ID`
- `PACTAGENT_PROVIDER_ESCROW_DESCRIPTOR_ID`
- `PACTAGENT_LIVE_RELAY_URL`
- `PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY` (public key)

Server secrets:

- `PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY`

### pactagent-strfry

- `PORT`
- `PACTAGENT_RELAY_PROVIDER_AUTHORS` (mandatory comma-separated provider public keys)
- `PACTAGENT_RELAY_REQUESTER_AUTHORS` (mandatory requester public keys, including independent clients)
- `PACTAGENT_RELAY_AUTHORITY_AUTHORS` (mandatory escrow authority public keys)
- `PACTAGENT_RELAY_LEGACY_GIFT_IDS` (optional, at most 32 exact pre-upgrade prepared wrap IDs)

These lists authorize **writes**, not reads: the public Caddy WSS endpoint
remains readable by anyone. The custom pinned Strfry image verifies its included
Python 3/SQLite runtime and installs the JSON-lines write-policy plugin; startup fails closed on
invalid configuration or unusable persistent accounting. NIP-42 is explicitly
disabled; an arbitrary authenticated key would not establish approval.
Before enabling the policy on an existing deployment, follow the
[Issue #62 migration and recovery procedure](issue-62-relay-write-policy.md).
In particular, enroll all existing requester/authority keys and recover or
explicitly enroll any prepared pre-upgrade gift wraps before rollout.

### pactagent-relay

- `PORT`
- `PACTAGENT_STRFRY_UPSTREAM`

### pactagent-demo-mint

Public non-secret:

- `PORT`
- `MINT_BACKEND_BOLT11_SAT` (`FakeWallet`)
- `MINT_LISTEN_HOST`, `MINT_LISTEN_PORT`
- `MINT_DATABASE`
- `TOR`
- `DEBUG` (`FALSE`)
- `LOG_LEVEL` (`INFO`)

Server secrets:

- `MINT_PRIVATE_KEY`

## 6. Demo mint private-network allowlist

The demo economic transport policy normally permits HTTP only for loopback
hosts. Railway private networking requires a non-loopback HTTP mint URL, so the
deployment sets `PACTAGENT_DEMO_MINT_PRIVATE_HOSTS` to the exact internal DNS
host (`pactagent-demo-mint.railway.internal`). Only plain DNS names are
accepted (no IPs, no wildcards, no ports); entries are validated fail-closed by
`normalizeDemoPrivateHostAllowlist`. HTTPS and HTTP loopback remain allowed
without listing, the live economic policy ignores the list entirely, and mint
requests still never follow cross-origin redirects (`redirect: "error"`).

## 7. Configuration as code

`.railway/railway.ts` (Railway IaC) declares the five services, their volumes,
builds, start commands, health checks, and non-secret variables. Secret
variables are declared with `preserve()` so the NAMES stay managed while the
VALUES live only in Railway.

Apply configuration:

```sh
railway config plan
railway config apply --yes
```

## 8. Deployment procedure

1. `npm install` (includes the `railway` IaC SDK as a devDependency).
2. Authenticate the Railway CLI (`railway login`), link or create the project
   (`railway init -n pactagent`).
3. `railway config plan` and `railway config apply --yes` to create services,
   volumes, and variable declarations.
4. Set every secret with `railway variable set` (values generated locally,
   never committed, never printed). Independent keys per semantic role.
5. Provision the generated public domains:
   `railway domain --service pactagent-web --port 3000` and
   `railway domain --service pactagent-relay --port 8080`.
6. Set the derived public variables (UI origin, relay URL, provider/escrow
   public keys).
7. Deploy in dependency order:

   ```sh
   railway up --service pactagent-demo-mint --detach
   railway up --service pactagent-strfry --detach
   railway up --service pactagent-relay --detach
   railway up --service pactagent-provider --detach
   railway up --service pactagent-web --detach
   ```

8. Run the doctor: `npm run railway:doctor`.
9. Run the production acceptance: `npm run railway:acceptance`.

### Redeploying

- `railway redeploy --service <name> --yes` — redeploy the latest image
  without rebuilding.
- `railway up --service <name> --detach` — rebuild and deploy from the
  repository tree.
- `railway restart --service <name> --yes` — restart the running container
  without a rebuild.

## 9. Doctor

`npm run railway:doctor` (`scripts/railway-doctor.mjs`) validates the real
deployed system READ ONLY — no economic mutation:

- public HTTPS reachability + trusted certificate (system store);
- `GET /api/health`;
- WSS relay `REQ/EOSE`;
- upstream-aware relay readiness (`GET /health` fails when Strfry is not
  serving, even if Caddy itself is alive);
- verified P002 artifacts (provider definition, offer, escrow descriptor);
- runtime composition (`hosted`, `externalProvider`) via the bearer surface;
- requester surfaces session-gated.

Configuration is read from the linked Railway project at runtime; secret
values stay in memory and are never printed.

## 10. Production acceptance

`npm run railway:acceptance` (`scripts/run-railway-acceptance.mjs` +
`e2e-live/railway-production.spec.ts`) drives the PUBLIC deployment through the
judge flow in a real browser and then runs a relay privacy scan:

- Start Demo → 1000 Demo sats wallet;
- synthetic document + prompt (original document limit: 1 MiB inclusive), budget 500;
- 350-sat signed offer discovery;
- advisory deterministic recommendation + deterministic policy authorization;
- agreement → escrow → NIP-59 private transport → provider result →
  verification → release → settlement;
- terminal `settled`, authoritative balance 648 Demo sats,
  `accountingPending=false`;
- private result retrieval, safe report, reload recovery;
- session isolation (cross-session 404s, foreign reset cannot touch this
  wallet);
- no server variable names/secrets in page source or network bodies;
- relay privacy scan proves the synthetic private material never appeared in
  public relay events.

## 11. Restart/persistence procedure

1. Record a safe relay event id.
2. `railway restart --service pactagent-strfry --yes` and confirm public relay
   readiness fails while Strfry is unavailable, then recovers automatically.
   Confirm the event is still queryable; no redeploy should be required.
3. `railway redeploy --service pactagent-provider --yes` and confirm readiness
   + artifact publication + no recovery loops.
4. `railway redeploy --service pactagent-demo-mint --yes` and confirm
   `/v1/info` plus an existing wallet's balance.
5. `railway redeploy --service pactagent-web --yes` and confirm `/api/health`,
   runtime re-initialization, session recovery, and wallet balance.
6. Re-run the doctor.

The relay `/health` contract is readiness, not Caddy-only liveness: it proxies
a read-only HTTP probe to Strfry and becomes non-2xx whenever the upstream
relay is unavailable. It does not publish a Nostr event or mutate economic
state.

Nutshell 0.21.0's optional DEBUG settings dump replaces `mint_private_key`
with a fixed `********` marker before logging. Production additionally pins
`DEBUG=FALSE` and `LOG_LEVEL=INFO`, so the settings dump is not emitted. Mint
startup logs must never contain an unredacted private key, seed, token,
macaroon, rune, Demo spend/refund key, runtime bearer, or provider key.

## 12. Judge flow

1. Open the public PactAgent URL.
2. Click **Start Demo** — an isolated Demo wallet with 1000 clearly labelled
   non-monetary Demo sats is created.
3. Click **New transaction**, upload/enter a synthetic document, optionally a
   private prompt, keep the 500-sat budget.
4. **Review request** → **Submit transaction**.
5. Watch the runtime-authoritative lifecycle progress (discovery → signed
   350-sat offer → advisory recommendation → deterministic policy
   authorization → escrow → private transport → result → verification →
   release → settled).
6. **Load private result** and **Load safe transaction report**.
7. **Close transaction** to see the authoritative remaining Demo balance.
8. Reload the page at any point to recover the same session transaction.
9. **Reset Demo** when safe to get a fresh wallet generation.

## 13. Rollback

- Services deploy from the repository tree. To roll back:
  `git checkout <known-good-sha>` and
  `railway up --service <name> --detach` per affected service.
- Railway volumes are conservative: configuration applies never delete volumes
  implicitly.

## 14. Known Demo limitations

- Demo sats have no monetary value; the mint uses the FakeWallet backend.
- Railway health checks validate deploy-time readiness only; continuous
  monitoring is the doctor's job.
- One provider, one fixed 350-sat offer, single relay — marketplace,
  reputation, and multi-provider bidding remain out of scope (#41/#42).
- Requester sessions are PoC browser-cookie ownership, not production
  authentication.
- The generated `*.up.railway.app` domains are Railway-assigned.

## 15. Container image hardening (Issue #69)

The shared `deploy/web.Dockerfile` image (used by `pactagent-web` and
`pactagent-provider`) is hardened against three findings from the Issue #69
audit: an unpinned base image, root execution, and development dependencies
shipped to production because the provider ran TypeScript through `tsx`.

### 15.1 Base image pinning

Every stage (`deps`, `build`, `runner`) uses the same digest-pinned Node.js
image:

```
node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
```

The digest is the multi-arch OCI image index (amd64 + arm64), obtained from
the authoritative registry. The existing Dependabot `/deploy` docker ecosystem
entry (`.github/dependabot.yml`) keeps the digest current.

### 15.2 Non-root runtime identity

The runner stage ends with `USER node` (the base image's `node` user,
UID/GID 1000). Both `next start` (web) and the provider process therefore run
as UID 1000; PID 1 is not root. Runtime writes are confined to:

- `/data` — Railway persistent volume (SQLite stores); node-owned in the image.
- `/app/.next` — Next.js data/route cache; node-owned via `COPY --chown`.

`node_modules`, `public`, `dist`, `next.config.ts` and the worker are
root-owned and world-readable (read-only at runtime).

### 15.3 Provider compilation

The provider is compiled ahead of time during the build stage:

```
npm run build:provider   # scripts/build-provider.mjs -> esbuild
```

esbuild (a transitive dependency of the devDependency `tsx`) bundles
`scripts/provider-start.mjs` and every local TypeScript module it imports into
`dist/provider-start.mjs`. All `node_modules` imports are kept external so the
runtime resolves them from the production `node_modules` with the same
`--conditions=react-server` flag the previous `tsx` runtime used. `tsx` is no
longer present or executed at runtime.

The Railway provider start command is therefore:

```
node --conditions=react-server dist/provider-start.mjs
```

The PDF text-extraction worker (`src/domain/pdf-text-extract.worker.mjs`) is
plain JavaScript loaded by path at runtime
(`resolve(process.cwd(), "src", "domain", "pdf-text-extract.worker.mjs")`); it
is copied into the image at that path and imports `unpdf` from `node_modules`
inside the worker thread. No other `src/` TypeScript is required at runtime.

### 15.4 Production dependencies

The runner installs with `npm ci --omit=dev`, which excludes every top-level
devDependency: `tsx`, `vitest`, `typescript` (as a direct devDependency),
`eslint`, `eslint-config-next`, `@types/*`, `@testing-library/*`,
`@playwright/test`, `jsdom`, `railway`, `@next/swc-wasm-nodejs`, and
`@playwright/test`. The platform-native SWC binary (`@next/swc-linux-x64-gnu`
on linux/amd64) is an optionalDependency of `next` and is retained.

Two peer dependencies of production packages are auto-installed by npm and
remain: `typescript` (a peer of `nostr-tools`, used only for type-checking)
and `@playwright/test` (an optional peer of `next`, used only for testing).
Neither is executed at runtime — the provider is pre-compiled and `next start`
uses the native SWC, not `tsc` or Playwright.

### 15.5 Required writable directories

| Path | Owner | Purpose |
|---|---|---|
| `/data` | node (1000) | SQLite stores (provider idempotency; web cashu/escrow/sessions) |
| `/app/.next` | node (1000) | Next.js data/route cache |

### 15.6 Existing-volume migration

A non-root process cannot write to files created by the previous root-running
container. A fresh Railway volume works without intervention (the image's
node-owned `/data` is copied into the empty volume). An EXISTING volume that
already contains root-owned SQLite files requires a one-time ownership fix
before the hardened image can start. The provider fails closed
(`store_unavailable`) rather than silently losing durability.

This applies to both application volumes: `pactagent-web-data` (`/data` on
`pactagent-web`) and `pactagent-provider-data` (`/data` on `pactagent-provider`).

Safe migration procedure (per volume, as an explicit operator action — NOT
baked into the image entrypoint):

1. **Stop the service.** The service must not hold SQLite files open during
   the ownership change. On Railway: `railway stop --service <name> --yes`.
   A clean stop lets SQLite checkpoint the WAL (`-wal` → main `.sqlite`).
2. **Back up the volume** (optional but recommended). Railway volumes can be
   snapshotted; alternatively copy the SQLite files aside. The migration below
   changes ownership only and does not read, alter, or delete database
   contents, but a backup protects against operator error.
3. **Fix ownership** to the non-root user (UID/GID 1000):

   ```sh
   docker run --rm --user 0 -v <volume>:/data <image> \
     chown -R 1000:1000 /data
   ```

   `-R` covers every file in `/data`, including the WAL sidecar files
   (`*.sqlite-wal`, `*.sqlite-shm`) that must accompany each main `.sqlite`
   database. Do NOT delete the `-wal` or `-shm` files — they may hold
   uncheckpointed durable state. `chown` preserves the existing restrictive
   mode bits (e.g. `-rw-------` on `provider-operations.sqlite`).

4. **Start the service.** On Railway: `railway up --service <name> --detach`.
   The non-root process opens the now-node-owned SQLite files and resumes
   normally.

On Railway, if a privileged `chown` job is unavailable, reformat the volume
(fresh volumes inherit node ownership automatically) — but this loses existing
state, so back up first and use it only when the volume has no durable state
worth preserving.

**Recovery if migration fails:** the `chown` is reversible — re-run it with
`0:0` to restore root ownership, then restart the previous (pre-hardening)
image. If a backup was taken, restore the volume from it. The migration does
not modify database contents, so a failed or partial `chown` leaves the data
intact; only the ownership is intermediate.

### 15.7 Local verification

```sh
# Build the hardened image
docker build -f deploy/web.Dockerfile -t pactagent-web:69 .

# Non-root UID (must be 1000)
docker run --rm pactagent-web:69 id

# Dev dependencies absent; native SWC present
docker run --rm pactagent-web:69 ls node_modules/@next
docker run --rm pactagent-web:69 ls node_modules/tsx   # No such file
docker run --rm pactagent-web:69 ls node_modules/unpdf # present

# Web health (start the container, then probe /api/health)
docker run -d --name web -p 3000:3000 pactagent-web:69
docker exec web node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(console.log)"

# Provider (needs a wss:// relay; reuse compose.local.yml caddy + CA)
docker compose -f compose.local.yml up -d caddy
node --conditions=react-server dist/provider-start.mjs  # with PACTAGENT_* env
```

The production acceptance (`npm run railway:acceptance`) and doctor
(`npm run railway:doctor`) remain the authoritative deployed-system checks.
