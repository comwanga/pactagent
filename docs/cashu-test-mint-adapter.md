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
the fee reserved while constructing a locked value. All accounting remains
`bigint`/`Sats`; unsafe, negative, or inconsistent amounts fail closed.

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

The included in-memory store is for deterministic tests only. Issue #13 must
provide a durable private implementation for interruption-safe orchestration;
that storage/orchestration is deliberately outside Issue #12.

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
