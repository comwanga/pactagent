# Issue #62: public relay write policy

## Verified baseline and authorization matrix (before implementation)

Base: `d1bb971ff20deca937829163ecf1cdb0d7f27776`, branch
`fix/strfry-write-policy-62`, worktree `.local/issue-62`. Issues #61 and #62
were open; #61 / PR #105 is unmerged and has no dependency here. Existing
escrow-hardening and issue-61 checkouts were preserved, including their changes.
No earlier #62 branch or implementation was found.

Railway public WSS -> platform TLS -> Caddy's catch-all reverse_proxy -> private
Strfry:7777 -> persistent LMDB. Compose exposes the same route at :8443.
The private upstream does **not** make the relay inaccessible publicly.
Baseline configs have no plugin, no application authorization, no gift quotas,
and 4,194,304-byte events / 4,194,560-byte WebSocket frames. Native defaults
reject events over 900 seconds in the future and new events over about three
years old, but do not expire stored ordinary events. NIP-42 has no service URL.
There is no flood or storage budget in those configs.

Source trace: `pactagent-runtime.live.ts`, `provider-service-config.ts`,
`pactagent-provider-service.ts`, `pact-service-agreement-publication.ts`,
`private-task-transport.ts`, and the domain constructors. Only the encrypted
outer 1059 is published; kinds 13/14 remain inside encryption.

| Kind | Purpose / signer | Authorization | Frequency | Size cap | Retention |
| --- | --- | --- | --- | --- | --- |
| 0 | Optional Nostr profile; participant key; no current production publisher | Enrolled provider or requester | Bootstrap/update | 16 KiB | Persistent |
| 10002 | Optional relay list; participant key; no current production publisher | Enrolled provider or requester | Bootstrap/update | 16 KiB | Persistent |
| 30360 | PIP-00 definition; provider **or independently generated requester** key | Enrolled provider or requester | Bootstrap/restart | 64 KiB | Persistent/replacement |
| 30361 | PIP-01 Cashu descriptor; provider key | Enrolled provider | Bootstrap/restart | 64 KiB | Persistent/replacement |
| 30400 | PactAgent service offer; provider key | Enrolled provider | Bootstrap/restart/refresh | 64 KiB | Persistent/replacement |
| 3921 | Agreement root: requester; authority designation: provider; transitions: requester, provider, escrow authority | Enrolled participants, including explicit authority list | Roughly 10 records/transaction, plus recovery | 64 KiB | Persistent economic evidence |
| 7300 | Reserved PIP-02 request; constants only, no current publisher | Enrolled requester | Not emitted in current transaction | 64 KiB | Persistent |
| 7301 | Reserved PIP-02 transition; constants only, no current publisher | Enrolled participants | Not emitted in current transaction | 64 KiB | Persistent |
| 1059 | Private task/result; fresh one-time outer signing key | Enrolled recipient; anonymous outer author; quotas | One task + one result/transaction; bounded retries | 4 MiB | Native expiration, 30 days |

The issue's nine kinds include compatibility/reserved kinds, not nine kinds
actually emitted per transaction. Current hosted configuration uses a static
requester key from environment; cookies/session IDs do not generate signing
keys. Independent clients/acceptance fixtures generate their own requester keys;
enroll each public key before publication. Never substitute a provider-only
allowlist or admit any key merely because it completes AUTH.

The finite 64 KiB coordination allowance is well above the small constructor
fixtures (no documents live here). The existing private transport fixture
measures a worst-case 1 MiB original document plus 64 KiB prompt around 3.5 MB
after base64 and two encryption layers. Keep the existing 4 MiB contract.

Measured current runtime fixture, successful `settled` outcome: 2 definitions
(max 918 bytes), 1 descriptor (777), 1 offer (932), 8 agreement/authority/
transition records (max 1,777), and 2 wraps (max 2,925). Maximum source/prompt
fixture with expiration: 3,495,793 normalized bytes / 3,495,803 frame bytes.
`strfry-write-policy-transaction.test.ts` checks every actual signed event
against the Python policy, including an independently keyed requester and the
maximum encrypted task. This is deterministic transaction evidence, not a
claim that container-backed settlement has run.

Pinned upstream: Strfry 1.1.3, commit
`16c00df04e264f4d68db5e10a48127f015c7824b`, image digest unchanged.
Reviewed [plugin protocol](https://github.com/hoytech/strfry/blob/1.1.3/docs/plugins.md),
[configuration](https://github.com/hoytech/strfry/blob/1.1.3/strfry.conf),
`PluginEventSifter.h`, `RelayIngester.cpp`, `RelayWriter.cpp`, `RelayCron.cpp`,
and `events.cpp` at that tag. Plugin failures reject; an empty plugin path
accepts everything. `authed` is forwarded only for NIP-70 protected events,
whose authenticated key must match the event author. The existing adapter
does not implement AUTH. This deployment disables AUTH explicitly and does not
use it for policy decisions. Caddy source IP is the proxy; `realIpHeader` is
unset. Quotas must not depend on source IP or ephemeral wrap authors.

Public registry inspection of that exact index resolved Linux/amd64 manifest
`sha256:d9ff9763005de61104dc61b4c05707eb88455691fd209e6e149a2bdd64136033`.
Image labels identify version 1.1.3 / image source revision
`51ced4f3a40a32aa20c95b1f9b2553622124e10e`; build history includes Alpine
`bash`, `curl` and `python3`, and no non-root user override. The child image
checks `import sqlite3` during build. Registry metadata is packaging evidence,
not a substitute for executing that build and relay acceptance.

## Enforced policy and bounds

`deploy/strfry-write-policy.py` uses only Python 3 standard-library facilities.
It reads bounded JSON lines, validates field types/representations, echoes the
event ID, and emits only documented accept/reject objects. Strfry has already
verified event hashes/signatures; it rejects plugin failure, EOF or timeout.
Missing configuration leaves the plugin alive in reject-only mode, and the
container entrypoint refuses to open the listener if preflight fails.
Diagnostics are constant strings on stderr; no event content is logged by the
plugin. Public subscriptions do not go through this write filter.

All author lists must be nonempty comma-separated lowercase 64-hex x-only
secp256k1 public keys, without whitespace or wildcards. The union is capped at
256 keys. The roles in the matrix are enforced separately. Signatures establish
key possession and the lists establish operator authorization. Neither an
arbitrary AUTH key nor a newly generated wrap author adds any privilege.
Unexpected `authed` input fails closed. Enrolling an independent provider
requires its public key in PROVIDER_AUTHORS and the requester application's
separate allowed-provider policy; enroll its escrow authority separately.
Enroll independent requester keys in REQUESTER_AUTHORS before their first
definition/root; keep keys needed by recovery. No self-service public enrollment.

| Resource | Enforced ceiling |
| --- | --- |
| Profile / relay-list event | 16,384 normalized UTF-8 JSON bytes |
| Other coordination event | 65,536 normalized UTF-8 JSON bytes |
| Gift wrap | 4,194,304 normalized UTF-8 JSON bytes |
| Entire incoming WebSocket payload | 4,194,560 bytes (unchanged) |
| Tags | 256 tags, 1–16 string elements each; native tag limits also apply |
| Future timestamp | Local relay/policy clock +60 seconds, matching agreement skew |
| All coordination / 60 seconds | 240 events and 8 MiB |
| Per enrolled author / 60 seconds | 60 coordination events and 2 MiB |
| All gift wraps / 60 seconds | 120 events and 64 MiB |
| Per enrolled recipient / 60 seconds | 12 wraps and 16 MiB |
| Permanent coordination admission budget | 256 MiB, charging event bytes +4 KiB/event |
| Separate gift storage admission budget | 256 MiB rolling reserve, same conservative charge |
| Free disk required for admission | 256 MiB plus event charge |
| LMDB mapping ceiling | 1 GiB (formerly upstream default 10 TiB) |
| Policy SQLite | 512 ×4 KiB pages; at most 514 rate rows and 723 gift storage rows |

The per-recipient byte allowance admits four near-maximum tasks/results per
minute, and the count allowance permits small bursts/retries. Rate windows
start on first admitted use and expire after 60 seconds. Rate accounting is
transactional, shared by all plugin processes and durable across restarts;
one-time author rotation and recipient rotation cannot evade aggregate limits.
Unused/de-enrolled buckets expire or are removed. No unbounded author/IP map
or event-ID history exists. Backwards policy clock movement rejects admission
until the clock catches up. A committed charge with a lost reply safely
overcounts; retries/replaceable events may consume extra budget.

The storage budgets are admission reservations, not an assertion about physical
LMDB overhead. The hard mapping ceiling and disk reserve are backstops. Existing
database bytes are not erased or subtracted. A database already above the new
ceiling needs operator capacity review before migration; startup must not be
forced by deleting records. Anonymous gift traffic cannot consume the separate
economic-evidence budget. A determined sender can still consume the **bounded**
gift quota/reserve and deny private delivery temporarily; the policy does not
promise fair scheduling or complete denial-of-service protection.

## Retention and recovery

Every newly generated task/result wrap has exactly one signed NIP-40
`expiration = created_at + 2,592,000` (30 days). Only enrolled recipients are
accepted. Missing, duplicate, expired or later expiration is rejected. This
retains delivery through the normal 900-second escrow window with substantial
restart margin. Historical agreements/definitions may be republished without
a new timestamp: the hosted native age limit is explicitly widened, while the
future limit is 60 seconds. Coordination expiration tags are rejected to
prevent timer-driven removal of economic evidence.

Strfry 1.1.3 indexes expiration and runs native cleanup about every nine seconds.
No external full-database scan or periodic economic-record deletion is added.
Gift reserve credit is returned only after the receipt hour ends +30 days
+60 seconds future skew +60 seconds cleanup grace. There are at most 723
bounded hourly rows, including an optional permanent legacy reserve row.
Accounting expiry does not prove native deletion succeeded: stalled cleanup
still encounters the hard database/disk limits and stops writes. Native cleanup
keeps the latest local event to avoid ID reuse; at most one expired wrap can
remain for this reason, covered by headroom outside the gift reserve.
Already-stored pre-upgrade wraps without expiration are not scanned or deleted.
Their storage remains bounded by the database ceiling.

Provider prepared result wraps must be republished byte for byte after a crash.
For pre-upgrade wraps without expiration, the optional
`PACTAGENT_RELAY_LEGACY_GIFT_IDS` admits at most **32 exact event IDs**, subject
to the same size/recipient/rate checks. Strfry verifies their hash and signature,
so an exception cannot authorize different content. Those admissions are charged
permanently to the gift reserve and never regain timed capacity. Do not use a
wildcard, re-sign a persisted wrap, or accept all expiration-free events.
Existing economic evidence and private provider/requester stores remain intact.
New private relay delivery/retrieval after 30 days is outside this retention
contract; inspect durable application stores and use the application's recovery
procedure. Never infer a settlement/refund decision from absence of a wrap.

## Deployment and operator procedure

1. Back up existing relay and policy state using the operator's normal snapshot
   procedure. Inspect database size/free capacity. This change does not clear,
   migrate or modify production volumes automatically.
2. Derive PUBLIC keys locally from the configured requester, provider and escrow
   authority identities; put only public keys in their respective Strfry author
   variables. Include all independent requester keys still needed for recovery.
   Lists are mandatory in Compose and preserved declarations in Railway IaC.
3. Upgrade application wrap creation first and drain active pre-upgrade
   transactions, or inspect the provider's durable prepared-event records and
   explicitly enroll their exact legacy wrap IDs before policy rollout. Keep
   private stores private; export IDs/public keys only, never task ciphertext,
   documents, tokens or private keys into logs. More than 32 pending exceptions
   requires draining/recovering a batch before proceeding, not raising the cap.
4. Build `deploy/strfry.Dockerfile` for BOTH Railway and hosted Compose. It adds
   the policy, verifies the pinned image's Python 3/SQLite runtime and makes
   `/app/strfry-write-policy.py` executable (0555). The hosted
   config points `relay.writePolicy.plugin` at that exact absolute path with a
   five-second timeout. Do not substitute the stock image or an empty plugin
   path. `compose.local.yml` is only the unrestricted loopback development relay.
5. The existing PID 1 wrapper runs policy initialization/check before Strfry,
   then retains its single-child controlled shutdown/retry behavior. State is
   `pactagent-policy.sqlite` plus its initialization marker on the SAME persistent
   relay volume. Restarting either relay/plugin preserves quotas. No other
   service needs policy state or new private credentials.
6. Hosted Compose defaults to public :8443; `PACTAGENT_HOSTED_BIND` and
   `PACTAGENT_HOSTED_WSS_PORT` select binding. Acceptance uses loopback and an
   ephemeral port. Railway Caddy exposure is unchanged. Public reads need no AUTH.

On startup/configuration failure, fix the author lists or restore the matching
policy snapshot; do not remove the plugin. On clock rollback, repair the clock
and wait for the last admitted time. A missing/corrupt state DB refuses writes;
an exclusive initialization marker prevents silent recreation/reset. Restore
the database and marker together. On quota pressure, wait for the rate window
or expiring gift reserve and investigate abuse. Do not delete economic events.
On coordination capacity exhaustion, pause admission and review a backed-up
database's actual usage and required evidence before an intentional reviewed
capacity increase. Never reset accounting merely to bypass a limit. A policy
accounting snapshot older than relay data may undercount; restore matching
snapshots or conservatively preserve/reconstruct the charged reservation under
operator review. Hard DB/disk backstops still apply.

## Reproducible checks and merge requirements

- `npm run test:relay-policy`: deterministic Python JSON-lines/state tests.
- `npm test`: includes the policy suite and a complete deterministic transaction
  compatibility check, including maximum-size private task.
- `npm run test:relay-policy:baseline`: disposable pinned stock relay,
  signed foreign kind 1 / coordination / recipient-free gift acceptance and
  near-4-MiB arbitrary publication. This targets loopback only.
- `npm run test:relay-policy:live`: disposable hosted Compose build; signed WSS
  rejection/acceptance, enrolled independent identities, actual encrypted maximum
  task, size-boundary suite, native expiration, recipient/global rate quotas,
  legacy exact-wrap recovery, public reads and persistent restart probe.
- `npm run build -- --webpack`, then `npm run test:hosted-nostr:live`: the existing
  separate-provider-process HTTP/requester/discovery/agreement/private delivery/
  result/settlement acceptance with an isolated FakeWallet test mint.

The harness generates test identities, ports and unique project volumes. It
never stops the developer checkout's containers or starts its mint. Cleanup is
scoped to that generated project. Keep the Linux/Node 22 quality/build checks
and new `Strfry policy and hosted protocol (Linux / Node 22)` job required for
merge; local Windows tests are not a substitute. Browser acceptance was not
executed by the relay-policy-only lane; use the established Chromium lane if
claiming browser runtime compatibility.
