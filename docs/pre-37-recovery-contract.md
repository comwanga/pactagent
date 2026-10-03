# Pre-#37 recovery and Demo Reset contract

The requester must treat runtime status as authoritative. It must not calculate
locktime or infer economic recovery from the displayed lifecycle phase.

## Recovery actions

- `resume` continues only the successful workflow or an existing release.
- `refund` starts or continues the timeout-refund family:
  `refund_authorized`, `refund_pending`, and `refund_confirmed`.
- `reconcile` is reserved for an explicitly projected
  `reconciliation_required` state.
- `refunded` and `settled` expose no recovery actions.

A refund-family state must never advertise successful Resume. Refund recovery
uses the durable coordinator operation and its escrow-scoped idempotency key;
it must not create a parallel Cashu operation.

## Future #37 Demo Reset gate

Action flags are insufficient as a reset predicate. During an in-flight
operation all actions may temporarily be false even though economic exposure
exists.

The safe policy is a terminal allowlist:

- allow reset after `settled`;
- allow reset after `refunded`;
- allow reset after `resolved_not_funded`;
- allow reset when the requester session has no current transaction.

Block reset for every other operational state, including `active`, nonterminal
`failed`, and `reconciliation_required`, regardless of the current action
flags. In particular, block whenever `resume`, `refund`, or `reconcile` is
true, and while funding, release, or refund work is in progress.

This document defines the boundary for #37; it does not implement Demo Reset.
