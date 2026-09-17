# Private Cashu test-mint adapter

Issue #12 adds a narrow, private execution boundary for the sats-over-Cashu path
that Issue #13 can consume. It is not a wallet and it does not decide or advance
PactAgent agreement state.

## Configuration and capability policy

The adapter is constructed with one explicit HTTPS test-mint URL, the literal
unit `sat`, an integer-safe exposure cap, and a private operation store. The URL
is normalized once. Credentials, query strings, fragments, redirects, non-HTTPS
URLs, and operation-specific mint overrides are rejected. Relay events, task
input, and model output therefore have no interface through which to select a
mint.

Before its first economic operation, the adapter inspects the configured mint
and fails closed unless it has:

- a usable, cryptographically verified active `sat` keyset and valid
  `input_fee_ppk` metadata;
- NUT-10 spending-condition support and NUT-11 P2PK support;
- NUT-07 proof-state inspection; and
- NUT-09 output restoration.

NUT-07 and NUT-09 are required, not optional, for this adapter. cashu-ts 4.10.1
provides both operations, and together they are the recovery path after a swap
request may have reached the mint: inspect the exact submitted input proofs, then
restore the exact persisted blinded outputs. The adapter never retries that swap
blindly.

## API boundary

`CashuTestMintPort` exposes only:

- `inspectCapabilities()`;
- `prepareLockedValue(...)`;
- `inspectProofState(...)`; and
- `spendLockedValue(...)`.

Successful mutations return an opaque private handle and safe settlement facts:
configured mint, `sat` amount, input/output/change amounts, mint input fee, and
the fee reserved while constructing a locked value. When a swap returns payer
change, it is retained under a separate optional `changeHandle`; bearer material
is never embedded in either result. All accounting remains `bigint`/`Sats`;
unsafe, negative, or inconsistent amounts fail closed.

The first funding mode is deliberately narrow. A trusted runtime wraps an
already-acquired array of Cashu proofs with `createPrivateCashuProofImport(...)`
and passes it to `CashuPrivateFundingSource.importFunding(...)`. The source
checks the configured mint, literal `sat` unit, current capabilities, and every
proof keyset before constructing `PrivateCashuFunding`. It does not decode
arbitrary token strings, request mint quotes, pay Lightning invoices, or choose
a mint.

`maximumExposureSats` is enforced both per request and across all unreleased
locked values recorded for the configured mint. A reservation is made before a
swap can be submitted. Ambiguous submissions keep that reservation until
reconciliation, and a confirmed spend releases it. Two adapter processes using
the same durable private store share the same exposure ledger and cannot each
consume the full limit independently.

NUT-11 lock and refund public keys must be compressed, on-curve secp256k1 keys.
Refund keys require a locktime. Spending keys are created with the explicit
`cashu-nut11` purpose and are held separately from the Nostr signer. A Nostr
x-only key is rejected rather than silently reinterpreted.

## Private data and recovery

Proofs, token material, proof secrets, witnesses, blinded outputs, spending
keys, preimages, credentials, and complete mint responses stay in private
wrappers or the injected `CashuPrivateStore`. Those wrappers refuse JSON
serialization. Public results never contain the material, and external errors
are converted to small redacted `CashuTestMintError` values without a library
error or response in a `cause` chain. cashu-ts logging is replaced with a
no-output logger.

The private store records the exact prepared swap before submission. Mutation
outcomes distinguish `not_submitted`, `submitted_unknown`, `succeeded`, and
`failed_definitively`. A duplicate operation id with identical parameters
returns or reconciles the stored operation; using it for different parameters
is rejected. When proof-state inspection and restoration cannot prove the
outcome, the adapter returns `reconciliation_required` for Issue #13 to handle.

The included in-memory store is for deterministic tests only.
`createSqliteCashuPrivateStore(...)` is the durable process-safe implementation
for prepared swaps, proof custody, restored outputs, change handles, and the
aggregate exposure ledger. It uses a private SQLite file with WAL, synchronous
writes, process leases, and owner-only file permissions. The database still
contains bearer material and must be placed in access-controlled private
application storage; it must never be served, logged, backed up to a public
location, or reused as public settlement state.

Funding and outputs remain private capabilities. `CashuPrivateValueDeliveryPort`
accepts only a retained opaque handle, a bound beneficiary identity, a private
destination capability, and a stable delivery id. It retrieves proofs inside
the private store boundary and supplies `PrivateCashuFunding` only to the
authorized destination callback. Delivery records survive restart; the same id
is idempotent, while reassignment to another id or beneficiary is rejected. A
destination must durably deduplicate the stable delivery id because a crash
after its callback succeeds but before the receipt is stored is necessarily an
ambiguous delivery that must be reconciled. No handle or bearer material enters
public status or settlement references.

The adapter still does not buy ecash, pay mint quotes, or become a wallet.
Acquisition of the proofs accepted by the import boundary and durable handling
after an authorized private delivery remain explicit runtime responsibilities.

## Tests

Required tests use a deterministic fake and never contact a mint:

```powershell
npm test -- src/lib/cashu-test-mint.test.ts
```

An optional integration test performs capability inspection only. It moves no
funds, uses a one-sat exposure cap, limits each request to five seconds and
500,000 response bytes, and may fail when a third-party test mint is unavailable
or reset. Enable it explicitly in PowerShell:

```powershell
$env:PACTAGENT_CASHU_TEST_MINT_URL = "https://your-test-mint.example"
npm test -- src/lib/cashu-test-mint.live.test.ts
```

No production funds or production mint should be used.
