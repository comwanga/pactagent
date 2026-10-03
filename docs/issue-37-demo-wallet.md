# Issue #37 demo wallet lifecycle

Demo Wallet is an integrated-PoC ownership boundary, not a production user account or a wallet containing monetary value. The browser owns only an opaque HttpOnly requester session. The requester BFF derives the server-side wallet identity and calls bearer-protected runtime endpoints; wallet keys, funding references, tokens, proofs, spending keys, and mint configuration never enter browser DTOs.

## Provisioning

Start Demo creates one bounded 1,000-demo-sat allocation for an established requester session. The server persists the quote before mint submission and persists `mint_submitting` before invoking the external Cashu operation. If the process can no longer prove whether submission succeeded, provisioning enters `reconciliation_required` and fails closed. It never creates a replacement quote from that uncertain state. Once the token is durable, local activation can be retried without minting again.

Reset carries a durable idempotency identity. A retry with the same identity returns the same resulting generation; a later intentional Reset uses a new identity. Reset is permitted only after every transaction bound to the active generation has reached an explicitly terminal/no-exposure accounting state: `settled`, `refunded`, or `resolved_not_funded`, with terminal output collection complete. Closing a transaction in the UI clears only the recovery pointer and does not affect this rule.

## Generations and output ownership

Transaction creation, Reset, Start, and terminal output collection share the durable per-wallet lock. Each transaction is immutably bound to a wallet key and exact generation before the runtime persists and schedules it. Reset cannot retire that generation while a transaction is being bound or has unresolved economic exposure.

Terminal Cashu output collection is a durable outbox:

1. persist the terminal transaction state;
2. persist `collection_pending` for the generation binding;
3. register each private handle with immutable wallet, generation, transaction, escrow, and source ownership;
4. mark collection complete.

A process restart or collection error leaves the outbox pending. Authoritative status and wallet-status reads retry collection idempotently, while Reset remains blocked. Proof aggregation verifies owner metadata, queries mint proof state, excludes spent proofs, and deduplicates by Cashu proof identity across every owned handle.

## Retention and cleanup

Reset retires a generation but preserves its private economic history and settlement records so replay, reconciliation, and ownership claims remain auditable. Session expiry removes the requester-session binding, not the Cashu records. The current PoC does not automatically garbage-collect abandoned session wallets; an operator retention policy must not delete a generation with active, uncertain, or collection-pending economic work. Production authentication, multi-user lifecycle policy, and hosted infrastructure remain later milestones.
