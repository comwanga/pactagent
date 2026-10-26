# Issue #62 engineering report

## A. Baseline

- Branch: `fix/strfry-write-policy-62`.
- Worktree: `C:\Users\mwang\pactagent\.local\issue-62`.
- Base: `d1bb971ff20deca937829163ecf1cdb0d7f27776`, fetched `origin/main`.
- Issues #61/#62 were open; #61 / PR #105 was unmerged. No existing #62
  implementation found. No PDF changes incorporated.
- The escrow-hardening checkout had 20 tracked modifications and untracked
  audit/recovery work at baseline. It and every previous worktree were preserved.
- The user subsequently authorized committing, pushing and opening
  [draft PR #106](https://github.com/comwanga/pactagent/pull/106). No production
  deployment, existing-volume deletion or Railway resource mutation occurred.

## B. Root cause

Public WSS reaches Caddy's catch-all proxy, then Strfry and persistent LMDB.
The private upstream address never restricted proxy clients. Both baseline
configs lacked application write authorization, kind filtering, gift quotas
and bounded storage; arbitrary valid signed events fit under the 4 MiB limit.
The previous claim of no public relay access was incorrect.

The live stock-relay reproduction passed on an isolated Ubuntu runner:
foreign kind 1 (374 bytes), coordination kind 3921 (377 bytes), recipient-free
1059 (377 bytes), and a 4,193,646-byte kind 1 were accepted. Local Docker stayed
stopped. No production relay was targeted.

## C. Implementation

- Python standard-library Strfry 1.1.3 JSON-lines plugin; reject by default and
  on configuration, parsing, state, authentication-representation or evaluation
  errors. Entrypoint preflight prevents an unusable policy from opening service.
- Nine permitted kinds: `0,10002,30360,30361,30400,3921,7300,7301,1059`.
  Explicit provider/requester/authority lists preserve independently keyed
  requester definitions and agreement roots. Provider-only artifacts have
  separate role restrictions. NIP-42 is disabled; arbitrary AUTH grants nothing.
- 16 KiB profile/list, 64 KiB coordination and unchanged 4 MiB gift limits;
  +60-second future skew. Historical economic recovery remains publishable.
- Durable recipient/aggregate count and byte quotas defeat ephemeral-author
  rotation; state/maps are bounded. Separate 256 MiB coordination and rolling
  gift reserves, a 256 MiB disk reserve and 1 GiB LMDB ceiling bound storage.
- New gifts expire natively after 30 days. Economic records never receive
  timer-based deletion. At most 32 exact operator-enrolled legacy wrap IDs can
  recover without expiration; their reservation never recycles.
- Railway and hosted Compose use the same pinned policy image. Runtime metadata
  verifies included Python/bash/curl; build verifies SQLite. Executable files
  use LF/0555. The controlled single-child shutdown wrapper is preserved.
- Hosted acceptance now uses generated keys, isolated state/mint/project/ports,
  public WSS checks and project-aware doctor lookup. Public reads remain open.

Full [authorization matrix, exact quotas, rollout and recovery procedure](issue-62-relay-write-policy.md).

## D. Regression evidence

The deterministic runtime fixture settled, emitting 14 events: two definitions,
one descriptor, one offer, eight agreement/authority/transition records and two
wraps. Every signed event passes the policy with separate participant keys.
Maximum coordination size was 1,777 bytes. A maximum 1 MiB source plus 64 KiB
prompt produces a 3,495,793-byte signed encrypted wrap and passes policy.
Exact per-kind size/first-byte-overflow, malformed protocol, rate windows,
multi-author spam, bounded state, storage isolation and restart tests pass.

The before/after signed **real relay** suites passed on Linux/Node 22 at
`8bed7c50f932bdca27dc91ce1bfcf6ba401f5e91` in
[job 121632139829](https://github.com/comwanga/pactagent/actions/runs/40340080651/job/121632139829).
The run accepted a maximum 4,194,304-byte gift event, rejected the first byte of
overflow, verified native expiration and quota persistence across an actual
plugin SIGKILL, and completed real hosted test-economic settlement.

## E. Independent security review

A separate read-only reviewer audited the full policy, pinned upstream source,
deployment and acceptance changes. Confirmed draft defects were corrected:

1. Anonymous gifts could permanently exhaust a shared lifetime budget and block
   economic records. Reproduced with scaled disposable state; separate reserves
   fixed it and independent before/after testing confirmed the correction.
2. A loopback-only hosted bind broke public access. Public default restored;
   only disposable acceptance selects loopback.
3. Expiration enforcement blocked exact pre-upgrade prepared-wrap recovery.
   Bounded exact-ID enrollment preserves those signed events without generally
   accepting expiration-free publication; focused regressions pass.

The reviewer also corrected test false positives after socket closure, missing
fixture keys, child cleanup on readiness failure, and expiry-test timing.
Targeted LF attributes prevent Windows checkout packaging risk; no Linux
container CRLF failure was claimed as reproduced. Four independent focused
regressions passed in 0.599 seconds. No unresolved policy bypass was confirmed.

The first Linux reproduction exposed the pinned relay's 1,000,000-descriptor
requirement versus the runner's 65,536 container hard limit. Disposable baseline
and hosted acceptance now request the required soft/hard limit explicitly; the
rerun passed. The reviewer checked the actual plugin-kill test's container/PID
scope, fresh-event rejection assertions and persisted-recipient quota check.

## F. Verification

| Lane | Result |
| --- | --- |
| `npm run test:relay-policy` | 34 passed, 8.248 s |
| `npm test` | 1,123 passed / 55 files, 430.57 s; includes transaction compatibility and Python-suite wrapper |
| `npm run test:integration` | 225 passed / 6 files, 103.01 s |
| `npm run lint` | Passed, 0 errors / 27 existing warnings |
| `npm run typecheck` | Passed |
| `npm audit --omit=dev --audit-level=high` | Passed, 0 production vulnerabilities |
| Hosted Compose `config --quiet` | Passed with explicit test author lists |
| Script syntax / `git diff --check` | Passed |
| `npm run test:process` | 16 passed / 1 file, 421.96 s |
| `npm run build -- --webpack` | Passed with a 1,536 MiB Node heap cap |
| `npm run audit:client-bundle` | Passed; configured secret-value scans unavailable in clean worktree, known sentinel/identifier scans passed |
| Existing Chromium acceptance | 8 passed, 1.8 min (`node scripts/run-requester-e2e.mjs --project=chromium`, using the verified webpack build) |
| Stock exposure reproduction | Passed on GitHub Ubuntu runner: four signed baseline publications accepted |
| Packaged hosted policy acceptance | 9 real WSS tests passed in 149.19 s at `8bed7c5`, including plugin SIGKILL/restart |
| Strfry size-boundary acceptance | 3 passed; exact 4 MiB event accepted and first-byte/frame overflow rejected |
| Provider service acceptance | 5 passed against packaged relay |
| Full hosted settlement acceptance | 3 passed, phase `settled`, balance 1000 → 648 Demo sats, `accountingPending=false` |
| Cleanup and persistence | Both relay restart probes and scoped project/volume cleanup passed |
| Linux/Node 22 CI | Docker policy/hosted job passed at `8bed7c5`; final-head storage-boundary additions and remaining PR checks still require completion |

Observed environment: Ubuntu 24.04 runner image `20261012.334.1`, Docker
client/server 28.0.4 (API 1.48), Compose 2.38.2, Node 22.23.3 and Python 3.12.15.
Relay base is the unchanged Strfry 1.1.3 image digest documented in the policy;
Caddy and Nutshell 0.21.0 digests remain pinned in Compose. The complete job
finished in 4 minutes 59 seconds and removed its disposable resources.

## G. Remaining limitations

Anonymous senders can consume bounded gift capacity and temporarily deny private
delivery. Enrollment is operator-managed. Thirty-day private transport recovery
is finite; durable application/economic evidence remains authoritative. Native
cleanup can stall, and the latest local event may outlive expiration; hard
storage/disk ceilings stop admission regardless. Existing expiration-free stored
gifts are not scanned/deleted. Capacity changes and policy-state restoration
require operator review and matching backups. Windows/Node 24 results cannot
replace Linux/Node 22 CI and actual pinned-image acceptance.

## H. Publication readiness

**NOT READY — VERIFICATION INCOMPLETE**

Required real-relay reproduction/acceptance, native expiration, full hosted
settlement have passed at the linked revision. Final-head coverage additions
and remaining PR checks must pass before readiness can change.

The completed [CI validation infrastructure and workflow security review](issue-62-ci-validation.md)
describe the exact PR commands, resource isolation, cleanup and outstanding
execution requirement. Local Docker was not started to implement that workflow.
