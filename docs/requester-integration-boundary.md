# Requester UI integration boundary (Issue #34)

Phases 1 through 4 implement the secure requester HTTP boundary, the in-memory
transaction UI, terminal/recovery controls, and same-browser reload recovery.
Issue #33 remains the sole workflow and economic authority; no runtime behavior
has moved into the browser.

## Contract audit

Issue #33 remains authoritative. Its status DTO currently exposes the following
allowlisted fields:

- `transactionId`, `kind`, `phase`, `operationalState`, and `agreementId`;
- `selectedOffer` with the provider identity, stable P002/PIP-01 references,
  amount, and unit;
- the optional safe `requesterDecision` recommendation and deterministic policy
  outcome;
- runtime-computed `availableActions`;
- `resultAvailable`, `reportAvailable`, and the redacted `failureCode`;
- `finalOutcome` and the available safe agreement, result, escrow, settlement,
  and refund references; and
- `reconciliationRequired` and `reconciliationState` when applicable.

The existing Issue #33 operations are unchanged:

```text
POST /api/transactions
GET  /api/transactions/:id
GET  /api/transactions/:id/result
GET  /api/transactions/:id/report
POST /api/transactions/:id/resume
POST /api/transactions/:id/reconcile
```

The frontend boundary models these responses with explicit types and strict
runtime parsers in `src/lib/requester-api-contracts.ts`. Unknown fields, unknown
enum values, malformed nested objects, and non-JSON success responses fail
closed.

## Authorization architecture

```text
browser requester client
  -> same-origin /api/requester/transactions/** (no runtime bearer)
  -> server-only RequesterRuntimeTransport
  -> /api/transactions/** (Authorization: Bearer <runtime token>)
  -> Issue #33 runtime
```

The BFF is not a generic proxy. It implements only the six transaction
operations above. It accepts only an explicitly configured UI origin, rejects
cross-site browser requests, uses fixed upstream paths and methods, rejects
redirects, and returns `Cache-Control: no-store`.

Set these server-only values:

```text
PACTAGENT_REQUESTER_UI_ORIGIN=http://localhost:3000
PACTAGENT_RUNTIME_API_BASE=http://localhost:3000
PACTAGENT_RUNTIME_API_TOKEN=<server-only bearer>
PACTAGENT_LIVE_FUNDING_REFERENCE=<server-only opaque reference>
```

`PACTAGENT_RUNTIME_API_TOKEN` is read only by the `.server.ts` transport. The
module uses Next's `server-only` marker. It is never accepted from the browser,
serialized into a response, placed in a URL, or imported by the browser client.
The opaque funding reference is also injected into the Issue #33 creation body
by the server and is not part of the browser contract.

The origin check remains a CSRF/deployment boundary, not requester identity.
Phase 4 adds the narrowly scoped requester-session ownership boundary described
below. It is sufficient for the integrated single-requester PoC, but it is not
production authentication and must not be represented as a multi-user account
system.

## Idempotency and private data

`RequesterApiClient.createSubmission` creates one idempotency key when a logical
in-memory submission is created. Concurrent duplicate calls share the same
in-flight request. A retry after failure reuses the same key, and a successful
submission is returned from memory without resubmission. Starting a new logical
submission creates a new key.

The submission object holds the document, optional prompt, key, and accepted
transaction ID only in memory. No document, prompt, summary, funding reference,
credential, or transaction ID is written to `localStorage`, `sessionStorage`,
IndexedDB, service-worker storage, URLs, logs, analytics, telemetry, or page
metadata. Private values are sent only in JSON request/response bodies over the
same-origin BFF. The private result and safe report have separate contracts and
endpoints.

All browser and server transport requests use explicit methods and `no-store`.
Runtime errors are parsed as allowlisted DTOs and replaced with fixed browser-
safe messages; raw upstream error text is never forwarded.

## Phase 2 requester UI

The root page now implements the first functional requester flow without adding
new runtime authority:

```text
New transaction -> review safe metadata -> submit once -> authoritative status
```

The client accepts only `text/plain` and `application/pdf`. Text is read as the
API's UTF-8 string input. PDF bytes are base64-encoded for the existing #33
contract; the browser does not parse, inspect, upload, or OCR the PDF. The
runtime-aligned limits are 1 MiB of original text/PDF bytes for the document
and 65,536 UTF-8 bytes for the optional prompt. The BFF's larger
wire limit only accommodates worst-case JSON escaping and does not change those
input limits.

Review shows filename, media type, source-file size, budget, and prompt presence
only. The prepared document and prompt remain in memory until acceptance. One
Phase 1 submission object is created before review and survives back navigation,
duplicate clicks, and an explicit in-memory retry. Acceptance clears the private
draft and submission closure before status polling begins.

Polling calls only `RequesterApiClient.status`. Timers trigger a new GET but do
not mutate phase or operational state; rendered lifecycle, selected offer,
requester-decision checks, outcome, and reconciliation state always come from
the latest successfully parsed #33 status DTO. Phase 2 intentionally has no
private-result, report, resume, reconcile, reload-persistence, or live-recording
surface.

## Phase 3 terminal resources and recovery

Phase 3 completes the in-memory transaction experience without expanding the
browser's authority. `resultAvailable`, `reportAvailable`, and
`availableActions` are the only gates for private-result, safe-report, resume,
and reconcile controls. Result and report content are fetched only after an
explicit requester action and are never polled.

The audited #33 operation responses are:

- `GET .../result`: `200 { summary }`; unavailable is a redacted `409`
  `result_not_available`;
- `GET .../report`: `200` with the safe report; unavailable is a redacted `409`
  `report_not_available`;
- `POST .../resume`: `200` with the safe report; and
- `POST .../reconcile`: `200` with either the safe report or the current safe
  status projection.

All four also use the existing redacted `404` not-found, `409` in-progress,
authorization, configuration, and internal-error behavior from #33 and the
Phase 1 BFF.

The private result is rendered as ordinary React text in its own private
surface. The terminal report is fetched independently and renders only the
allowlisted #33 report DTO, including `expired`, `rejected`, and `disputed`
history entries without reinterpreting them. Neither resource is persisted.

Resume and reconciliation POST only to their exact requester BFF endpoints.
Their returned DTOs are not used to advance the displayed lifecycle; the UI
performs a separate status GET and displays that authoritative response.
Reconciliation additionally requires an accessible confirmation explaining
that the runtime will inspect existing state. No browser-side economic retry or
automatic recovery loop exists.

Polling continues only while the latest status says `operationalState` is
`active`. Terminal, failed, resolved-not-funded, and reconciliation-required
states stop timers. Recovery is always an explicit operation followed by an
explicit status refetch. Closing a transaction clears its ID, status, loaded
result, report, errors, action state, and remaining private draft from browser
memory.

### PDF representation audit

For `application/pdf`, `privateDocument` and the private-task
`source_document` field explicitly mean standard base64-encoded PDF bytes. The
#33 runtime persists that string without normalization, the workflow sends it
unchanged through the NIP-59 private-task payload, and the document-summary
provider performs the base64 decode immediately before PDF extraction. A
runtime HTTP regression test now submits a base64 PDF and retrieves its private
summary, covering the API, runtime, workflow, private transport, and provider
boundary end to end.

## Phase 4 requester session and reload recovery

The browser receives a cryptographically random 256-bit opaque session value in
the `pactagent_requester_session` cookie. The cookie is `HttpOnly`,
`SameSite=Strict`, `Secure` in production, and scoped to `/api/requester`. It is
never readable by client JavaScript and contains no runtime bearer, transaction
payload, result, funding reference, Cashu material, key, or salt. A missing,
expired, malformed, or removed cookie creates a new empty requester session only
when the browser calls the current-session capability; it never inherits or
creates a transaction.

The server stores only the SHA-256 digest of that opaque value in the dedicated
`requester-sessions.sqlite` database. The database defaults to
`PACTAGENT_LIVE_STATE_DIRECTORY` and may be separately placed with
`PACTAGENT_REQUESTER_SESSION_DATABASE`. It contains session creation/expiry
times, transaction ownership rows, and one nullable current-transaction pointer.
It deliberately contains no workflow/private material. Expired sessions are
removed opportunistically on access; operators remain responsible for normal
state-directory backup, permissions, and retention policy.

Successful `POST /api/requester/transactions` processing binds the returned
transaction ID to the requester session before the browser receives `202`.
Status, result, report, resume, and reconcile routes verify that binding before
constructing or invoking the #33 transport. An unowned ID returns the same
redacted `404 transaction_not_found` shape without asking #33 whether the ID
exists.

Two exact session operations complete the reload boundary:

```text
GET    /api/requester/session/current-transaction
DELETE /api/requester/session/current-transaction
```

GET establishes or reads the opaque session and returns only its current owned
transaction ID (or `null`). The page then fetches fresh authoritative status
through the existing requester client. It never reloads result/report content
automatically. DELETE clears only the recovery pointer. Historical ownership is
retained for that session, while the #33 transaction and all economic state are
left untouched. Close clears browser memory only after DELETE succeeds, so a
failed server-side close is never presented as complete.

This design limits guessing/cross-session disclosure and makes same-browser
reload recovery durable across application process restarts. It does not defend
against host compromise, stolen browser cookies, or an attacker controlling the
server-side session database, and it does not provide account identity,
revocation UI, device synchronization, or multi-user production authentication.

## Deterministic browser acceptance

Install Playwright's Chromium once, then run the isolated suite:

```sh
npx playwright install chromium
npm run test:e2e:requester
npm run audit:client-bundle
```

The Playwright configuration starts the real Next.js application and a separate
test-only HTTP process implementing the strict #33 DTO/endpoint contract. The
fixture is never imported by production code and has no production fallback. It
covers settlement, reconciliation, resume, refund, failure, cross-session
denial, and unavailable result/report behavior without a live relay, mint,
model, credential, or economic operation. Browser artifacts disable traces,
screenshots, and video so synthetic private values are not snapshotted.

The deterministic suite is not evidence of live Nostr/Cashu behavior. The
Issue #34 live smoke run, safe runbook, and reviewed recording remain separate,
explicitly configured manual work.
