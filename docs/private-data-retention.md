# Requester private-data lifecycle

Requester transaction records in the `transaction` scope of `cashu-private.sqlite`
contain the source document, optional prompt, and private commitment salt. New and
updated records use authenticated AES-256-GCM encryption. This does not encrypt the
whole database, provider-owned results, Cashu proof/operation/wallet scopes, session
metadata, the separate coordinator database, or relay storage. Existing NIP-59
transport protection and expiry remain unchanged.

## Configuration and keys

| Variable | Requirement |
| --- | --- |
| `PACTAGENT_PRIVATE_DATA_KEYRING` | Required JSON object of 1–16 key IDs mapped to independent 32-byte lowercase hex keys. IDs contain 1–64 letters, digits, `_`, or `-`. |
| `PACTAGENT_PRIVATE_DATA_ACTIVE_KEY_ID` | Required ID present in that keyring; used for all new writes. |
| `PACTAGENT_PRIVATE_DATA_RETENTION_DAYS` | Positive integer from 1 to 365; default **7**. No disable mode. |

Provision keys through the operator's external secrets configuration before starting
the requester runtime. Never store them on the protected data volume, in Git, in
`NEXT_PUBLIC_*`, or in logs. Railway's existing service-variable secret boundary can
carry these server-only values separately from `/data`; provision and preserve both
variable names in any infrastructure plan before applying it. This change does not
set production variables or apply infrastructure changes. Local development can use
an ignored `.env` outside the state directory. Use a cryptographically secure
32-byte key, not a password, signing key, funding token, or example fixture key.

Missing/invalid configuration fails runtime creation before resource initialization.
Missing old keys, malformed envelopes, and authentication failures produce a redacted
private-data error. They never fall back to plaintext or generate replacement keys.
Maintenance retains such rows and reports a count-only warning; operators must repair
key availability or storage integrity. A running application holding the key can
decrypt the data: encryption protects copied storage without the external key, not
compromise of that application or its secrets environment.

For rotation, add a fresh independently generated key under a new ID, retain old
keys, select the new active ID, and restart. Reads and maintenance re-encrypt old-key
rows atomically under the active key. Retain old keys until all required live rows
and retained backups can be recovered without them. Backup the database consistently
and back up the corresponding keyring separately with independent access controls.
Restoring an old backup may require an older key. Do not overwrite key bytes under
an existing ID or discard a key merely because the retention window has elapsed.
Random 96-bit GCM nonces are generated for every encryption, with 128-bit tags;
operators must rotate well before 2^32 encryptions under any key, across all copies
and processes sharing it. This demo does not maintain a global per-key usage meter.

The version-1 envelope carries its algorithm, key ID, nonce, ciphertext and tag.
Authenticated metadata binds it to its envelope version, algorithm, scope, storage
key and key ID. Envelopes have strict fields and encodings; JSON is parsed only
after authentication succeeds. Public protocol formats and economic operation
identifiers are unchanged.

## Migration and retention

Legacy version-1 plaintext records remain readable. A normal read or startup/periodic
maintenance seals the entire requester transaction record using compare-and-set in
a SQLite transaction. Failure or a competing write leaves the previous usable row
intact. Migration is per-row, idempotent and restart-safe; it does not rewrite the
whole database or delete legacy data before its replacement commits. Report GETs
decode without migration so historical reporting itself remains read-only.

Retention checks run on startup and every 15 minutes while the runtime is running.
They page through keys, coalesce overlapping sweeps, skip executing transactions,
and use the existing transaction lock and independent storage revision. The default
seven days provides a bounded post-completion access interval for this interactive
demo, rather than indefinite storage. It is not an economic recovery timeout.

Eligibility requires all of the following persisted evidence:

- A matching `settled` or `refunded` transaction and coordinator record, correct
  agreement/escrow/outcome references, and the corresponding economic claim.
- Successful funding and the corresponding release or refund, only recognized
  completed operations, no contradictory successful payout, no ambiguous or pending
  operation, and no pending signed transition publication.
- Completed Demo wallet generation accounting for that exact transaction and outcome.
  Live mode uses operator-managed outputs rather than Demo wallet collection.
- A saved safe report or an explicit historical-report-unavailable marker.
- Expiration of the configured window measured from the first durable maintenance
  observation satisfying those conditions. Legacy records without a timestamp get
  a full window from this observation, not from an inferred historic completion time.

Before deletion, maintenance rereads coordinator revision/publication identity and
accounting completion. The final encrypted tombstone update is conditional on the
private record's current revision. A stale writer cannot resurrect removed inputs.
Nonterminal, failed, unresolved, reconciliation-required, incomplete-accounting,
unknown, or inconsistent records retain their private recovery inputs regardless
of age. Maintenance never acquires transaction-execution capacity or initiates
reconciliation, settlement, refund, or task execution. Shutdown stops scheduling
and waits for in-progress maintenance before releasing runtime resources.

Cleanup removes documents, prompts and salts from the current logical record. The
encrypted tombstone retains transaction identity, verified terminal outcome, public
references and the safe report (when available). Public historical reports remain
queryable with existing ownership checks. Session-cookie expiry and ownership
availability are separate policies; retention does not extend requester access.

Historical report reconstruction validates existing signed evidence and private
results while available. It does not sign/recreate events, repeat tasks, submit
economic operations, resume, or reconcile. A missing legacy result or authority
source may make a report unavailable: `reportAvailable: false`, with the existing
`report_not_available` error on report retrieval. Verified terminal status remains
independent. Retrieval failures are errors and do not establish missing history or
permit deletion. An unavailable report is never returned as empty success. Private
result retrieval still depends on independently retained relay evidence and its
existing authorization; this policy does not guarantee relay/result availability.
Saved reports describe the verified history at completion; retrieving that snapshot
does not audit the relay for later forks. Economic recovery still uses its existing
authoritative validation and never derives new authorization from a saved report.

## Operational limits

Deletion is **not secure erasure**: historical plaintext/ciphertext may remain in
SQLite WAL/journal pages, freed pages, backups, snapshots and storage media. Migration
does not retroactively protect copied legacy plaintext. Apply separate backup/access
policies; no automatic VACUUM, database-wide rewrite, or backup deletion is performed.
Provider and relay copies have independent lifetimes. Retained economic recovery
material is deliberately outside this purge policy.

The configured retention duration applies at each sweep; changing it changes the
remaining interval for existing timestamps. A stopped runtime or failed maintenance
delays removal. Wall-clock time must be operated correctly; rollback delays expiry
and a large forward jump can advance it. SQLite transactions and existing leases
protect writers sharing the same database. This is not cross-volume or distributed
replica coordination; independent state volumes and backups require independent
maintenance and key handling. No new production authority is granted.
