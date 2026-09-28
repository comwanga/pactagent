# PactAgent Requester UI (Issue #34)

The PactAgent requester UI is a thin client over the #33 runtime HTTP API.
It allows an authorized requester to submit a private document, follow
authoritative lifecycle progress, retrieve the private summary, and inspect
the safe terminal report without importing workflow, relay, signer, Cashu,
or settlement modules.

## Local frontend and runtime startup

### Requirements

- Node.js 22 or newer
- npm

### Install

```sh
npm install
```

### Build

```sh
npm run build
```

### Start the runtime

The runtime serves both the HTTP API and the frontend:

```sh
npm run runtime:start
```

Or for local test-mint development:

```sh
npm run runtime:start:local
```

### Development mode

```sh
npm run dev
```

## Required runtime/API configuration

The runtime reads these environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `PACTAGENT_RUNTIME_API_TOKEN` | Yes | Bearer token for API authorization (server-side only) |
| `PACTAGENT_LIVE_RELAY_URL` | Live only | WebSocket Nostr relay URL |
| `PACTAGENT_CASHU_TEST_MINT_URL` | Live only | Cashu test mint URL |
| `PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY` | Live only | Requester Nostr private key (hex) |
| `PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY` | Live only | Provider Nostr private key (hex) |
| `PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY` | Live only | Escrow authority Nostr private key (hex) |
| `PACTAGENT_LIVE_NORMAL_SPEND_KEY` | Live only | Cashu normal spending key (hex) |
| `PACTAGENT_LIVE_REFUND_SPEND_KEY` | Live only | Cashu refund spending key (hex) |
| `PACTAGENT_LIVE_FUNDING_TOKEN` | Live only | Pre-acquired test ecash token |
| `PACTAGENT_LIVE_FUNDING_REFERENCE` | Live only | Opaque reference to the test ecash |
| `PACTAGENT_LIVE_STATE_DIRECTORY` | Live only | Durable state directory path |
| `PACTAGENT_DEMO_MODE` | Demo only | Set to `1` to enable one-click demo sessions |
| `PACTAGENT_DEMO_CODE` | Demo only | Optional short code required for demo sessions |

Missing live configuration causes a clean error — never a fallback to
production or an arbitrary mint/relay.

## Supported document types and size limits

- **Text/plain**: up to 1 MB (1,048,576 bytes)
- **Application/pdf**: up to 1 MB raw; base64-encoded size must also fit
  within the 1 MB request body limit (so effective raw limit is ~750 KB)
- Private prompt: up to 2 KB (2,048 bytes)

## Authentication expectations

The UI never holds the runtime API token in JavaScript. Authentication works
in two modes:

1. **Demo mode** (`PACTAGENT_DEMO_MODE=1`): a one-click "Enter demo" button
   calls `POST /api/session`, which mints an `HttpOnly; Secure;
   SameSite=Strict` cookie from `PACTAGENT_RUNTIME_API_TOKEN`. The token is
  written only to the cookie — never to the response body or client JS. The
  configured funding reference is also kept only in an httpOnly cookie.
2. **Token mode**: the requester enters their runtime API token. It is sent
   to `POST /api/session`, verified server-side, and exchanged for the same
   httpOnly cookie. The token is then discarded from client memory.

The funding reference is stored in a separate httpOnly cookie
(`pactagent_funding_ref`) so it survives reload without entering
JS-accessible storage or session responses. On every subsequent API request,
the browser attaches the cookie automatically (`credentials: same-origin`),
and the transaction route resolves it server-side.

No private keys, proofs, or credentials are handled in the browser.

## Safe status versus private result behavior

The UI separates two information surfaces:

- **Safe status** — public lifecycle state, selected offer, references, and
  operational state. This is the default view and contains no private
  material.
- **Private summary** — the complete document summary, retrieved only through
  the authorized `/api/transactions/{id}/result` endpoint. It is fetched
  on-demand, displayed in a separate section, and never persisted to browser
  storage.

## Transaction reload recovery

Only the transaction ID and the client-generated idempotency key (a random
hex value, not private material) are retained in `sessionStorage` — never in
`localStorage`. On reload, the UI probes `GET /api/session` to restore the
httpOnly cookie session, then fetches authoritative state from the runtime.
It does not resubmit the document or create a new transaction.

When the requester signs out or closes the transaction, all in-memory private
state (document, prompt, summary) is cleared, the session and funding
cookies are deleted via `DELETE /api/session`, and the retained transaction
ID + idempotency key are removed from `sessionStorage`.

## Resume and reconciliation UX

- **Resume** — shown only when the runtime reports `availableActions.resume`
  as true. Calls `POST /api/transactions/{id}/resume`. No confirmation
  required (resume is non-economic).
- **Reconcile** — shown only when the runtime reports
  `availableActions.reconcile` as true. Requires **explicit confirmation**:
  clicking "Reconcile…" reveals a "Confirm reconcile" / "Cancel" pair before
  the endpoint is called. Calls `POST /api/transactions/{id}/reconcile`.
- Both actions are disabled while a request is in flight.
- Neither action triggers blind client-side retry loops.
- After either action, the UI re-fetches authoritative state from the
  runtime and resumes polling.

## Deterministic browser verification

```sh
npm run lint && npm run typecheck && npm test
```

This runs the API client unit tests (type safety, idempotency key
generation, session storage helpers) and the full deterministic suite. The
browser acceptance test skips cleanly when live configuration is absent.

## Opt-in live browser smoke verification

The live browser acceptance test launches the built Next.js server and
drives the complete flow through the HTTP API — session cookie auth,
submission, lifecycle polling to `settled`, private summary retrieval, safe
report, reload recovery, unauthorized-access rejection, and private-material
leak scanning:

```sh
npm run build
npx vitest run --config vitest.live.config.ts --maxWorkers=1 src/lib/pactagent-browser-acceptance.test.ts
```

Requires the full `PACTAGENT_LIVE_*` environment. Missing configuration
skips the suite cleanly (never falls back to production).

## Browser privacy and storage guarantees

- The document, prompt, summary, funding reference, and API token are never
  placed in URLs or query strings.
- No private material is stored in `localStorage`, `sessionStorage`,
  `IndexedDB`, or service-worker caches.
- The runtime API token lives only in an httpOnly cookie — JavaScript cannot
  read it.
- The funding reference lives in a separate httpOnly cookie — JavaScript
  cannot read it.
- Only the transaction ID and the client-generated idempotency key (a random
  value, not private material) are retained in `sessionStorage` for reload
  recovery.
- All API responses use `Cache-Control: no-store`.
- Runtime errors are rendered through redacted, allowlisted UI messages.
- All server-returned strings are treated as untrusted content (no
  `dangerouslySetInnerHTML`); React escapes all output.
- The private summary is cleared from memory on sign-out or transaction
  close.
- No private material is sent to analytics, error reporting, tracing, or
  third-party services.

## Trust boundary view

The UI displays a trust-boundary section that distinguishes:

**Safe / public-shaped:**
- Provider identity and stable references
- Signed offer amount (350 sats)
- Lifecycle state
- Settlement / refund reference
- Opaque escrow reference

**Private:**
- Source document
- Requester prompt
- Complete summary
- Cashu proofs and secrets
- Signing and encryption keys
- Terms-commitment salt

This view is derived from runtime allowlisted metadata — it does not inspect
or expose private payloads to prove they are private.

## Requester decision view

The UI displays the requester decision as two clearly distinguished cards:

1. **AI recommendation** — the model's advisory recommendation for the
   selected 350-sat offer. Labeled as advisory only.
2. **Deterministic policy** — the six policy checks (provider match, price,
   budget, Cashu compatibility, references, execution duration) with
   pass/fail indicators, and the final authorization decision.

The frontend does not reproduce the requester-decision policy. It renders
the allowlisted projection returned by the runtime.

## Current integrated-PoC and test-mint limitations

- Only `document-summary@1` capability is supported.
- Only `text/plain` and `application/pdf` media types are accepted.
- Only one provider (P002) is discovered per transaction.
- The Cashu test mint uses test ecash only — no production funds.
- The model is deterministic (no external AI vendor integration).
- No multi-mint routing, multi-asset settlement, or marketplace features.

## Pre-submission review

Before submitting, the UI presents a review panel showing the document
size/type, media type, maximum budget, prompt length, and idempotency key.
The requester must click "Confirm and submit" to proceed. The same
idempotency key is preserved across the review step, so retrying the same
request (e.g. after a network error) never creates a duplicate agreement.

## Live demonstration runbook

This runbook produces the required BOSS Challenge recorded artifact. It must
be executed against a running #33 runtime with explicitly configured live
test relay and Cashu test mint.

### Preparation

1. Set all `PACTAGENT_LIVE_*` environment variables in `.env.local`.
2. For one-click demo, also set `PACTAGENT_DEMO_MODE=1`.
3. Build and start the runtime:

   ```sh
   npm run build
   npm run runtime:start
   ```

4. Open `http://localhost:3000` in a clean browser profile.

### Recording steps

1. Click "Enter demo" (or enter the runtime token + funding reference).
2. Click "Load sample contract" (or paste synthetic text).
3. Set the maximum budget to 500 sats.
4. Optionally enter a synthetic prompt.
5. Click "Review request" → "Confirm and submit".
6. Observe the lifecycle stepper advancing through discovery → acceptance →
   escrow funding → task delivery → result submission → verification →
   release → settled.
7. Observe the requester-decision cards (advisory model + deterministic
   policy).
8. Observe the trust-boundary view (safe/public vs private).
9. After `settled`, click "Retrieve private summary".
10. Click "Fetch safe report".
11. Reload the page — verify the same transaction is recovered.
12. Stop recording.

### Disclosure review checklist

Before publishing the recording, verify it does NOT show:

- Environment variables, `.env.local` contents, or terminal output
- Private keys (`nsec1`, hex keys)
- Cashu proofs, tokens (`cashuA`/`cashuB`), or spending secrets
- The runtime API token or authorization headers
- Funding-import material or database paths
- Browser DevTools containing sensitive values
- The actual private document content or summary in URLs/logs

Use synthetic document content and a synthetic prompt throughout.

### Recording link

> _Replace this line with the final published recording URL and date._

### Safe runbook reference

> _Replace this line with a link to the exact runbook used to produce the
> recording._
