# Requester admission controls

Issue #65 bounds public BFF requests, session creation, Demo wallet allocations,
and requester runtime execution. These controls do not authorize transactions or
change Cashu settlement, reconciliation, spending keys, or exposure accounting.

## Ingress trust boundary

The production Railway environment was inspected read-only on 2026-11-16. It
contained the five operator-controlled PactAgent services: web, provider, Strfry,
Caddy relay, and Demo mint. Only web and relay had public HTTP domains; web had
no TCP proxy and one active deployment with one configured replica. No active
Railway sandboxes were present in the environment. Caddy's
upstream is Strfry, not the BFF. The source configuration mounts web's durable
state at `/data` and starts one Next.js server.

Railway documents [project/environment isolation][private-network] and its
[public HTTP edge headers][edge-headers]. Its [support clarification][edge-trust]
states that the edge overwrites `X-Real-IP`; TCP proxy and private traffic can
bypass that overwrite. Accordingly, **every private-network caller in this
environment must remain trusted**. A header by itself is not authentication.
Origin checks remain CSRF controls, not caller authentication.

When the server has Railway's `RAILWAY_ENVIRONMENT_ID`, the BFF uses only a
single valid `X-Real-IP`, normalizes IPv6 spelling, and hashes the address for its
in-memory budget key. It ignores `X-Forwarded-For`, `Forwarded`, and other client
identity headers. Missing or malformed Railway identity returns a redacted 429
with `Retry-After`; it never receives an unrestricted budget.

Outside Railway, the documented local origins (`localhost`, loopback addresses,
and `pactagent.local`) share one bounded IP bucket; forwarded headers cannot
rotate it. Deterministic route fixtures use the same shared-bucket behavior.
Other non-Railway production origins fail configuration rather than trusting an
arbitrary header. Shared local accounting is not an assertion of individual
client IP identity.

Revalidate this boundary before adding an untrusted service or private-network
sandbox, another public ingress, TCP proxy, or another deployment platform.
Untrusted private callers would require authenticated or isolated ingress before
this header model could be used. These controls do not protect against a
compromised trusted service or project administrator. No networking changes or
deployment are performed by installing this implementation.

## Configuration and scope

All values below are positive decimal integers. Empty, zero, fractional,
negative, nonnumeric, or excessive values fail configuration. Settings are
server-only; no disable switch is provided.

| Variable | Default | Maximum | Enforcement |
| --- | ---: | ---: | --- |
| `PACTAGENT_BFF_IP_PER_MINUTE` | 240 | 10000 | Requests per client address per UTC minute, separately for ordinary and recovery traffic |
| `PACTAGENT_BFF_SESSION_PER_MINUTE` | 120 | 10000 | Requests per existing session digest per UTC minute, with the same separate lanes |
| `PACTAGENT_SESSIONS_PER_DAY` | 256 | 10000 | Global successful session creations per UTC day, in the requester session database |
| `PACTAGENT_WALLET_ALLOCATIONS_PER_DAY` | 64 | 1000 | Global fresh wallet allocation attempts per UTC day, including start and reset, in the economic environment's private store |
| `PACTAGENT_NEW_TRANSACTION_CAPACITY` | 2 | 32 | Concurrent new requester runtime operations in this Node process |
| `PACTAGENT_RECOVERY_CAPACITY` | 1 | 8 | Concurrent recovery operations, reserved independently of new work |

The UI normally polls status and wallet balance every 2.5 seconds, approximately
48 requests/minute while active. The session default leaves room for two tabs
and user actions; the IP default permits several such flows on a shared network.
These are fixed windows, so a burst can occur on either side of a minute boundary.
They are demo defaults, not measured production capacity guarantees.

The daily session default bounds churn even if cookies are repeatedly discarded.
The wallet default bounds initial/reset mint load to 64 fresh attempts/day; with
the configured 1,000-demo-sat allocation, successful attempts could allocate up
to 64,000 demo sats/day. It is separate from the existing outstanding-exposure
limits and does not retroactively count allocations before rollout. Two new
runtime operations fit the existing two-PDF-worker bound while leaving one
separate recovery slot. Operators should tune these limits to an explicit demo
resource budget and expected shared-network usage.

## Persistence, failure, and concurrency

Request budgets are process-wide, including across route bundles. Their shared
maps retain at most 4,096 keys per lane (8,192 total). Ordinary traffic cannot
fill recovery's map. At capacity each map prunes expired windows and rejects
new keys if all entries remain live; it never evicts a live budget to admit an
attacker's new identity. Per-session keys use the existing SHA-256 session digest,
not the cookie credential. IP digests remain in memory and are not logged or
persisted; hashing an address is not a claim of anonymization. Minute budgets
reset on restart. Daily accounting does not.

Session creation checks and counter updates run with the session insert in one
SQLite `BEGIN IMMEDIATE` transaction. A failed insert rolls back its counter.
Only two daily counter rows are retained. Existing valid sessions do not consume
another daily creation allowance, and session rotation cannot reset the global
daily allowance.

Start and reset share one durable wallet counter protected by the existing
private-store lease lock. Eligibility and provisioning idempotency checks happen
before charging; a fresh attempt is charged before requesting a mint quote.
Failed fresh attempts retain their charge to bound repeated external work.
Reusing an existing wallet or resuming an existing provisioning record does not
consume a fresh allowance. Ambiguous mint submission still requires the existing
reconciliation behavior; caps do not authorize a replacement mint submission.
The counter occupies one metadata record. UTC rollover resets its count; clock
rollback fails closed instead of granting another daily allowance.

New transaction capacity is acquired before wallet funding binding or durable
acceptance. Existing transaction identities retain their idempotent response
without acquiring another new-work permit. Rejected capacity admission creates
no new transaction record or funding binding. A permit remains owned until the
actual operation completes, including failure handling, and is released in
`finally`. There is no unbounded waiting queue or timer that releases a permit
while an economic operation is still running.

This execution gate coordinates runtime objects within **one Node process**.
It is not a distributed semaphore or a limit on all persisted nonterminal
agreements, provider-side work, or outstanding ecash. Restart clears process
permits after the process stops; existing durable transactions remain available
for recovery. The inspected deployment uses one replica and a persistent volume;
Railway [does not support replicas on a volume-backed service][volumes]. Multiple
independent requester processes or separate state volumes are unsupported by this
global execution limit and require another design before deployment.

Cold runtime initialization has one process-wide owner shared across route
bundles. Concurrent first requests await the same initialization outcome instead
of opening duplicate environments, relay connections, stores, or bootstrap work.
The existing environment factory owns cleanup of a failed attempt; its rejection
is shared and a later request may retry. Explicitly configured runtime startup is
also coalesced, preserving retries on the same runtime after a failed start.
Shutdown prevents new initialization and rejects pending callers before runtime
handoff, waits for the in-flight attempt, and closes its successful environment
once. Synchronous test reset rejects while startup or
shutdown is pending so it cannot orphan those resources. This does not change
durable recovery or guarantee startup succeeds when dependencies are unavailable.

## Recovery and HTTP behavior

Owned status/result/report and resume/reconcile/refund requests have separate
request budgets from new submissions, session creation, and wallet mutations.
New work cannot exhaust their request lane or reserved execution slot. Recovery
requests can still receive a temporary 429 when their own lane is busy; they do
not wait while holding a new-work permit. Internal reclaim reuses its caller's
permit, avoiding nested semaphore acquisition. Existing transaction locks,
revision checks, exact prepared-operation recovery, ambiguous-submission rules,
and mutually exclusive settlement/refund remain authoritative.

Every enforced limit uses HTTP 429, typed code `rate_limited`, a redacted message,
and positive integer `Retry-After` delta-seconds. Daily limits indicate the next
UTC window; busy execution indicates a one-second retry interval, not a promise
that capacity will then be available. Server transport forwards only validated
retry seconds. The UI displays its existing error state and backs off status
polling without automatically retrying an economic mutation.

These controls bound new consumption; they do not guarantee eventual recovery
when the mint, relay, provider, or operator infrastructure is unavailable.

[private-network]: https://docs.railway.com/networking/private-networking/how-it-works
[edge-headers]: https://docs.railway.com/networking/public-networking/specs-and-limits
[edge-trust]: https://station.railway.com/questions/supported-way-to-obtain-a-trusted-client-e09bae3b
[volumes]: https://docs.railway.com/volumes/reference
