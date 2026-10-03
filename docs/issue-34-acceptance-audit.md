# Issue #34 automated acceptance audit

Audit date: 2026-09-29 (updated after live acceptance PASS)

This audit compares the implemented requester surface with Issue #34 and keeps
three evidence classes separate. Deterministic fixture evidence is never used
as proof of live Nostr, NIP-59, model, or Cashu behavior. The live test was
run on 2026-09-29 and passed. Recording, disclosure review, and publication
remain human evidence and cannot pass from browser automation. Nothing is
currently `BLOCKED` by a known implementation defect.

## A. AUTOMATED DETERMINISTIC — PASS

### Security and architecture

| Requirement | Result | Evidence |
| --- | --- | --- |
| Browser uses only explicit requester BFF operations | PASS | Client boundary test and production bundle; no generic proxy exists. |
| Runtime bearer and configured funding reference remain server-only | PASS | `server-only` transport, redacted BFF tests, and bundle sentinel scan. |
| Client graph excludes runtime/workflow/Nostr/Cashu/signing/settlement/provider implementation modules | PASS | Static client dependency-graph test. |
| Requester session is server-generated, unpredictable, HttpOnly, Strict, production-Secure, narrowly scoped, and non-private | PASS | Session unit tests and production browser cookie inspection. |
| Ownership is checked before status/result/report/resume/reconcile forwarding | PASS | Five endpoint denial tests verify zero upstream calls. |
| Cross-session knowledge of a transaction ID reveals no existence or transaction data | PASS | Isolated-browser-context E2E and server tests return the same redacted not-found shape. |
| Ownership survives a realistic app-process restart | PASS | Dedicated SQLite persistence and reopen test. |
| This is documented as PoC session ownership, not production authentication | PASS | Requester integration boundary threat model. |

### Request, lifecycle, and recovery UX

| Requirement | Result | Evidence |
| --- | --- | --- |
| New request, safe review, idempotent submit, authoritative status | PASS | Phase 2 component tests and success-path browser test. |
| Text/PDF types and runtime-aligned size/prompt limits | PASS | Component and runtime API tests; PDF bytes have an explicit standard-base64 regression test through #33. |
| One logical submission retains one idempotency key across navigation, duplicate clicks, and retry | PASS | Phase 1/2 unit/component tests plus fixture create-count assertion. |
| Lifecycle, selected offer, amount, requester decision, and policy checks come from #33 DTOs | PASS | Strict DTO parsing and component/browser assertions; fixture amount is 350 sats and is never UI policy truth. |
| Result/report availability uses only explicit flags and loads only on user request | PASS | Phase 3 component tests and reload E2E. |
| Result and report remain structurally/private-public distinct | PASS | Phase 3 component tests and success-path E2E. |
| Resume/reconcile use only their exact endpoints and authoritative refetch | PASS | Component tests, network assertions, and recovery E2E. |
| Reconcile requires accessible explicit confirmation and performs no browser economic retry | PASS | Keyboard/focus/Escape and single-POST browser assertions. |
| Failed, refunded, settled, resolved-not-funded, and reconciliation-required remain distinct | PASS | Component states and deterministic refund/reconciliation/failure browser scenarios. |
| Terminal states stop unnecessary status polling | PASS | Timer-focused component tests. |

### Reload, close, privacy, and caching

| Requirement | Result | Evidence |
| --- | --- | --- |
| Reload discovers only the current transaction owned by the HttpOnly session | PASS | Narrow current-transaction capability and browser reload test. |
| Reload restores the same ID/status and never creates another transaction | PASS | Browser create-count and same-ID assertions. |
| Reload does not restore or automatically fetch private result/report content | PASS | Browser network and DOM assertions. |
| Close clears the recovery pointer and browser transaction/private state | PASS | Server, component, and reload-after-close browser tests. |
| Close does not mutate the #33 transaction/economic record | PASS | DELETE route has no runtime call; test verifies zero forwarding. |
| Document, prompt, result, funding material, credentials, keys, and salts do not enter URL or browser persistence | PASS | Unit/component assertions plus URL, localStorage, sessionStorage, IndexedDB, cookie, DOM, console, and request-URL E2E inspection with sentinels. |
| Transaction/private requester responses are `Cache-Control: no-store` | PASS | Client/BFF tests and browser response-header inspection. |
| Private values are not snapshotted into browser artifacts | PASS | Playwright traces, screenshots, and video are disabled. |

### Accessibility and deterministic acceptance

| Requirement | Result | Evidence |
| --- | --- | --- |
| Labels, descriptions, errors, keyboard navigation, focus, busy state, and live status are implemented | PASS | Component tests and production-browser keyboard/focus assertions. |
| Reconciliation dialog initial focus, Escape cancellation, and focus restoration | PASS | Production-browser recovery scenario. |
| Deterministic success, reconciliation, resume, refund, failure, cross-session, result-unavailable, and report-unavailable fixtures | PASS | Test-only HTTP #33 fixture with no production import or fallback. |
| Black-box browser golden path including submit, terminal resources, reload, and close | PASS | Five Chromium tests pass against a production Next build, including measured contrast. |
| Existing Phase 1-4 and runtime suites remain green | PASS | 747/747 full Vitest tests and 39/39 dedicated runtime tests. |
| Baseline rendered text/control/focus/status contrast is measured | PASS | Chromium computed-color test covers 12 targets; normal text meets 4.5:1 and controls/indicators meet 3:1. |

### Phase 5 live-lane safety and documentation

| Requirement | Result | Evidence |
| --- | --- | --- |
| Live browser acceptance is explicit opt-in and separate from deterministic commands | PASS | Separate command, directory, Playwright config, and static boundary test; no default test/build command references it. |
| Live lane cannot start or import the deterministic fixture | PASS | Live config has no `webServer`; runner starts only Playwright; static assertion rejects fixture references and test-only endpoints. |
| Missing live configuration skips safely by category | PASS | Focused child-process test and an actual local invocation exit zero with category-only messages and no variable values. |
| Browser-test process receives no server-only live credentials | PASS | Runner removes runtime, funding, identity, spending-key, model-key, state, session-database, relay, mint, and runtime-base values before Playwright starts. |
| Safe technical runbook, observability limits, crash window, and integrated-PoC limitations are documented | PASS | `docs/requester-live-acceptance.md`. |

## B. AUTOMATED LIVE — PASS

The live command was invoked on 2026-09-29 against the real configured BOSS
stack (Strfry relay, Caddy TLS, Testnut Cashu test mint, live P002 provider)
and passed. One synthetic transaction reached `settled` through the real
Chromium browser, real requester BFF, real #33 runtime, and real Cashu test
mint. Test ecash was consumed. No deterministic fixture was used.

| Requirement | Result | Evidence |
| --- | --- | --- |
| Authorized requester UI run through the real #33 public HTTP runtime | PASS | `npm run test:e2e:requester:live` — 1 test passed (26.3s); real Chromium against `http://localhost:3000`; BFF returned 202; no fixture ports (3410/3411) in use. |
| Configured relay discovers P002 and the safe #33 history represents the NIP-59 task/result exchange | PASS | `status.selectedOffer.providerDefinitionReference` contains `"live-provider"`; `status.selectedOffer.offerReference` contains `"live-document-summary-offer"`; report lifecycle contains `task_delivered`, `result_submitted`, `result_verified`, `settled`. NIP-59 envelope internals are intentionally not directly observable. |
| Configured Cashu test mint settles the runtime-returned 350-sat offer | PASS | `status.selectedOffer.amountSats === "350"`, `status.finalOutcome === "settled"`, `status.settlementReference` is truthy; pre-run doctor confirmed Testnut mint, NUT-07/09/10/11, 5/5 unspent proofs, 614 sats. Proof-level mint activity remains private. |
| Live private summary and separate safe report correspond to the same synthetic transaction and survive explicit reload recovery | PASS | Private summary contains `LIVE-ACCEPTANCE-ALPHA` marker (matches synthetic document); safe report does NOT contain private markers; after reload, same transaction ID recovered, private result NOT auto-loaded, re-loaded explicitly; `createRequestCount === 1`. |
| Live isolated-session denial and browser privacy/storage checks | PASS | Isolated browser context gets 404 `transaction_not_found` on all 5 operations; `localStorage === {}`, `sessionStorage === {}`, `cookiesVisibleToJavaScript === ""`, no private markers in URLs/console/metadata/IndexedDB, `browserAuthorizationHeaderSeen === false`, `browserFundingFieldSeen === false`, all `/api/requester/` responses `Cache-Control: no-store`; session cookie is `HttpOnly`, `SameSite=Strict`, `path=/api/requester`. |

## C. MANUAL RECORDED DEMONSTRATION — NOT YET VERIFIED

| Requirement | Result | Evidence needed |
| --- | --- | --- |
| Final screen recording | NOT YET VERIFIED | Phase 6 recorded live run. |
| Disclosure/privacy review of the recording | NOT YET VERIFIED | Human review before publication. |
| Published recording and documentation link | NOT YET VERIFIED | Phase 6 publication artifact. |

## Result

Automated deterministic Issue #34 acceptance remains `PASS`. The checklist now
records **36 deterministic PASS items** (the 30 Phase 4 requirement items plus
six Phase 5 safety/evidence items), **5 automated-live PASS items**, **3
manual NOT YET VERIFIED items**, and **0 BLOCKED items**. The earlier combined
live/manual row was split so these category counts are intentionally more
granular than the Phase 4 `30 PASS / 5 NOT YET VERIFIED` summary.

The live BOSS-stack acceptance is now `PASS`. A real Chromium browser completed
one full transaction through the real #33 runtime, configured Nostr relay,
P002 provider, NIP-59 transport, and Cashu test mint to `settled`. All
privacy, security, cross-session, and reload-recovery assertions passed
against the live stack. No deterministic fixture was used.

Phase 6 recording/disclosure/publication requirements remain open.
