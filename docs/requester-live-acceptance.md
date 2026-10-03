# Requester live browser acceptance

This runbook executes the Issue #34 requester UI unchanged against the real
Issue #33 HTTP/runtime boundary and its configured BOSS-stack integrations. It
is an explicitly economic, opt-in lane. It is not part of `npm test`,
`npm run test:e2e:requester`, or `npm run build`.

```text
Chromium
  -> /api/requester/** requester session/BFF
  -> server-only bearer transport
  -> /api/transactions/**
  -> PactAgent runtime
  -> configured Nostr relay / P002 / NIP-59 / Cashu test mint
```

The Playwright process receives only the public requester origin. It does not
receive the runtime bearer, funding reference/token, Nostr keys, Cashu spending
keys, model API key, runtime base URL, state directory, or session database.
The live runner never starts or imports the deterministic runtime fixture. A
configured runtime, relay, provider, or mint failure therefore fails the live
lane rather than becoming a fixture success.

## Prerequisites and configuration

Use Node.js 22 or newer, npm, Chromium installed for Playwright, Docker with
Compose for the repository's local Strfry/Caddy stack, and fresh **test-only**
Cashu ecash. Copy `.env.example` to the ignored `.env` file and supply the
existing Issue #33 configuration; do not create a second live configuration.

| Category | Existing configuration names |
| --- | --- |
| Requester BFF and #33 authorization | `PACTAGENT_RUNTIME_API_TOKEN`, `PACTAGENT_RUNTIME_API_BASE`, `PACTAGENT_REQUESTER_UI_ORIGIN` |
| Nostr relay and identities | `PACTAGENT_LIVE_RELAY_URL`, `PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY`, `PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY`, `PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY` |
| Cashu test mint and funding | `PACTAGENT_CASHU_TEST_MINT_URL`, `PACTAGENT_LIVE_NORMAL_SPEND_KEY`, `PACTAGENT_LIVE_REFUND_SPEND_KEY`, `PACTAGENT_LIVE_FUNDING_TOKEN`, `PACTAGENT_LIVE_FUNDING_REFERENCE` |
| Requester decision | `PACTAGENT_REQUESTER_DECISION_MODE`; model mode additionally requires `PACTAGENT_REQUESTER_MODEL_PROVIDER`, `PACTAGENT_REQUESTER_MODEL_NAME`, `PACTAGENT_REQUESTER_MODEL_API_KEY` |
| Durable state | `PACTAGENT_LIVE_STATE_DIRECTORY`; optional requester ownership override `PACTAGENT_REQUESTER_SESSION_DATABASE` |
| Local TLS trust | `PACTAGENT_LOCAL_CA_PATH`, or the existing `.local/pactagent-ca/root.crt` default exported by `local:up` |

The live command checks these categories without printing values. Missing
configuration exits successfully with category-only `SKIP` messages. Once the
configuration is complete, an unavailable configured requester application is
a test failure, not a skip.

## Safe startup and execution

1. Prepare fresh synthetic-only funding and identities. Never use a production
   document, customer information, a production key, or real economic value.
2. Start the local relay/TLS services:

   ```sh
   npm run local:up
   ```

3. Run the read-only readiness audit and resolve every failure:

   ```sh
   npm run local:doctor
   ```

   This verifies relay/TLS reachability, Testnut capabilities, unspent funding,
   the 350-sat requirement plus fees, and clean durable economic state without
   printing secret material.
4. For model decision mode, also run the bounded, non-economic model check:

   ```sh
   npm run requester:model:doctor
   ```

5. Build and start the real integrated requester/#33 process in one terminal:

   ```sh
   npm run build
   npm run runtime:start:local
   ```

   The default integrated PoC serves the UI, requester BFF, and #33 public API
   from the configured origin. `npm run runtime:bootstrap` may be run from a
   separate terminal for safe readiness evidence, but is not required; runtime
   bootstrap is lazy on the first authenticated #33 request.
6. In another terminal, explicitly opt in to the browser transaction:

   ```sh
   npm run test:e2e:requester:live
   ```

The test submits one short synthetic `text/plain` document, a synthetic private
prompt, and a 500-sat maximum budget. The current configured P002 offer is
expected to project 350 sats from #33. The lane does not automatically retry
submission, settlement, or reconciliation. A successful run consumes test
ecash; provide fresh funding before a later independent run.

Expected output contains test names, PASS/FAIL state, and safe Playwright
diagnostics only. It must not contain authorization headers, document/prompt
text, private results, proofs, keys, salts, funding material, raw relay events,
or database contents. Trace, screenshot, and video capture are disabled.

## What the live browser proves

The golden test verifies the public path end to end: requester session creation,
one BFF submission, authoritative lifecycle, selected P002 identity and stable
references, the runtime-signed 350-sat offer, requester recommendation,
deterministic authorization booleans, settlement, explicit private-result load,
separate safe-report load, same-transaction reload recovery, and isolated-
session denial for status/result/report/resume/reconcile.

It also checks request URLs, request authorization headers, the browser creation
shape, `Cache-Control: no-store`, JavaScript-visible cookies, local/session
storage, IndexedDB, service workers, page metadata, and console output. The
opaque requester cookie must remain `HttpOnly`, `SameSite=Strict`, and scoped to
`/api/requester`.

### Safe NIP-59 evidence and observability limit

The allowlisted #33 projections can safely establish that the configured
runtime recorded `task_delivered`, `result_submitted`, `result_verified`, a
result reference, and a requester-private result corresponding to the submitted
task. Combined with the separately configured real live runtime, these are the
browser-safe signs of the private exchange.

They do **not** independently expose or cryptographically prove the NIP-59
envelope, relay ciphertext, signer, or encryption operation to the browser.
That internal mechanism is intentionally not directly observable through the
public contract. The live test does not inspect plaintext relay events or reach
into transport internals merely to improve observability.

### Safe Cashu evidence and observability limit

The public contract can establish an escrow reference, a final `settled`
outcome, a settlement reference, 350 sats, unit `sat`, and matching safe report
history. The pre-run doctor separately establishes the configured test mint and
funding capabilities. The browser does not receive the mint URL, proofs,
witnesses, spending keys, preimages, or funding reference, so it cannot
independently identify proof-level mint activity.

If the golden transaction reaches `reconciliation_required`, the test reports
the last safe phase, operational state, failure/reconciliation code, and
availability flags and fails. It never presses Reconcile to hide economic
uncertainty.

## Cleanup and safe troubleshooting

After a successful run, the test closes the requester UI pointer; this does not
delete or alter the #33 economic record. Stop the foreground runtime with
Ctrl-C, then preserve state while stopping the local relay stack:

```sh
npm run local:down
```

Treat the funding token as consumed after a successful run. On failure, do not
blindly rerun with the same funding. Use `npm run local:doctor` and the UI/public
status projection to inspect only safe phase, operational state, failure code,
reconciliation state, and availability flags. Resolve incomplete or ambiguous
state through the existing runtime recovery boundary. Never delete state merely
to make the doctor green.

The known PoC crash window remains:

```text
#33 accepts a transaction -> process fails before requester ownership binding
```

The runtime transaction can survive while the requester session has no recovery
pointer. Cross-session access still fails closed, but the UI cannot rediscover
that orphan through its narrow current-transaction capability. This phase does
not introduce a distributed transaction protocol to close that window.

## Reproducible contrast verification

`e2e/requester-contrast.spec.ts` measures rendered Chromium computed colors.
Normal text uses the WCAG 2.x AA baseline of **4.5:1**; control boundaries,
focus indicators, and status indicators use **3:1**. The deterministic browser
lane recorded:

| Element | Foreground | Background | Ratio | Baseline |
| --- | --- | --- | ---: | ---: |
| Header environment label | `rgb(224, 232, 221)` | `rgb(17, 23, 19)` | 14.50:1 | 4.5:1 |
| Primary action text | `rgb(17, 23, 19)` | `rgb(199, 255, 61)` | 15.40:1 | 4.5:1 |
| Form heading | `rgb(17, 23, 19)` | `rgb(244, 242, 234)` | 16.21:1 | 4.5:1 |
| Form help text | `rgb(94, 104, 95)` | `rgb(255, 254, 250)` | 5.75:1 | 4.5:1 |
| Input border | `rgb(123, 132, 125)` | `rgb(255, 255, 255)` | 3.86:1 | 3:1 |
| Keyboard focus outline | `rgb(106, 146, 0)` | `rgb(255, 255, 255)` | 3.67:1 | 3:1 |
| Status card text | `rgb(17, 23, 19)` | `rgb(255, 254, 250)` | 18.00:1 | 4.5:1 |
| Status indicator | `rgb(95, 120, 15)` | `rgb(255, 254, 250)` | 4.98:1 | 3:1 |
| Status section label | `rgb(89, 104, 70)` | `rgb(255, 254, 250)` | 5.96:1 | 4.5:1 |
| Policy explanatory text | `rgb(189, 198, 190)` | `rgb(17, 23, 19)` | 10.37:1 | 4.5:1 |
| Policy pass status | `rgb(199, 255, 61)` | `rgb(17, 23, 19)` | 15.40:1 | 4.5:1 |
| Private-panel explanatory text | `rgb(189, 198, 190)` | `rgb(17, 23, 19)` | 10.37:1 | 4.5:1 |

All measured targets pass their stated baseline. This evidence covers baseline
text, action, input boundary, keyboard focus, lifecycle status, policy status,
and private-panel presentation; it is not represented as a complete WCAG audit.

## Integrated-PoC limitations

- Test ecash only; there is no real-sats or production-wallet support.
- This is an integrated proof of concept, not a production deployment.
- Requester sessions provide PoC transaction ownership, not full user
  authentication or an account system.
- There is no multi-user production identity or authorization system.
- There is no marketplace or multi-provider selection UI; the live path uses
  the configured P002 demo provider.
- Retention, session expiry/cleanup, key management, and operational controls
  are not production-grade.
- HttpOnly cookies and hashed ownership records do not protect against
  compromise of the server host or requester-session database environment.
- External relay, model-provider (when enabled), and test-mint availability can
  make the live demonstration unavailable or fail in progress.
- Private-transport and proof-level mint internals are deliberately not exposed
  to the browser for demonstration evidence.
- The current ownership-binding crash window can leave an accepted runtime
  transaction without a requester reload pointer.

These limits do not negate the implemented server-only bearer boundary,
same-origin gate, durable per-session ownership checks, redacted errors,
no-store behavior, and private-data non-persistence guarantees.
