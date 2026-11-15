---
name: ui-state-review
description: Review an existing asynchronous UI journey for loading, validation, stale data, authorization, confirmation, errors, retries, and reload recovery. Use for forms, onboarding, dashboards, and transaction status flows; produces findings and a fixture test plan without implementing changes.
license: MIT
metadata:
  version: "1.0.0"
---

# Review UI state and recovery contracts

Trace one existing user journey from input to displayed result. This is a
read-only review and test-planning workflow. Applicable repository instructions
and user authorization remain controlling; a finding grants no mutation authority.

## Trace the real journey

Read the entry component, event handlers, client/API contracts, status projection,
relevant server or domain owner, and existing tests. Record the checkout revision
and whether working-tree changes affect the evidence. Separate intended behavior
in documentation from behavior established by code or a controlled reproduction.

Build a compact state table only for states the code can reach:

| Trigger/state | Authoritative source | UI and enabled actions | Failure/recovery | Focus/announcement |
| --- | --- | --- | --- | --- |

Include initial load, local validation, pending work, success, rejection,
network failure, ambiguous completion, stale observations, cancellation, and
reload only where applicable. An HTTP timeout does not establish that a
server-side action failed. Absence of data does not establish a zero value.

## Check consequential transitions

- Trace double activation and the interval before a pending indicator renders.
  Identify the owner of deduplication/idempotency; UI disabling alone is not proof.
- Check stale or out-of-order responses, changed selection, navigation/unmount,
  and whether a late response can display the wrong entity's result.
- Distinguish refresh, retry, resume, reconcile, and starting new work. Do not
  recommend replaying an economic or irreversible request after ambiguity.
- Verify action eligibility comes from the existing authoritative contract.
  Keep recommendations, simulation results, and optimistic presentation distinct
  from authorization and confirmed settlement or operational health.
- Check that confirmation describes the real effect, scope, amount/unit when
  relevant, and cancellation behavior. Evaluate focus entry/return, keyboard
  reachability, error associations, and announcements without duplicate noise.
- Preserve useful input where permitted, explain recoverable errors near the
  action, and avoid success language until the authoritative state supports it.
- Trace reload and session expiration. Verify that credentials, private payloads,
  results, and identifiers use only storage and transport allowed by the project.
  Do not suggest persistence or background retries merely to improve convenience.
- For dashboards, distinguish unknown, empty, disconnected, outdated, and healthy;
  preserve observation time, units, pagination limits, and provenance.

## Plan safe checks

Select tests from the repository's actual scripts and fixtures. Propose the
smallest deterministic checks that distinguish the suspected failure from valid
behavior: rejected input, delayed response, duplicate activation, response
reordering, expired session, or same-entity reload recovery as applicable.

Use fake data and existing isolated browser/component fixtures. Do not submit
transactions, fund or release escrow, spend test ecash, call live infrastructure,
enable execution features, or capture credentials/private documents in artifacts
without explicit task authorization. Inspect commands before running them; names
such as "demo", "doctor", or "test" do not establish that they are non-economic.

Return only consequential findings, each with trigger, expected versus actual
behavior, source path/line, user impact, evidence level, and a targeted test.
Distinguish source-supported findings from runtime-confirmed failures and open
questions. Report preserved strengths and verification limits briefly; never
manufacture a defect or implement recommendations during this review.
