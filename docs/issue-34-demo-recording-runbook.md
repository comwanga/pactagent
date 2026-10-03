# Issue #34 demo recording runbook

This runbook produces the final BOSS Challenge demonstration recording for
Issue #34. The recording is a required milestone artifact. It must show the
complete live requester flow through `settled` using synthetic content and
test ecash only.

## Prerequisites

1. Complete the preflight matrix (all GREEN) per `docs/requester-live-acceptance.md`.
2. Install screen recording software (OBS Studio, ffmpeg+gdigrab, or OS-native
   screen recorder). PactAgent does not bundle or install recording tooling.
3. Prepare fresh test ecash funding if the current token was consumed by a
   prior live run. Run `npm run local:doctor` to verify 5/5 unspent proofs.

## Pre-recording checklist

- [ ] `.env` contains only synthetic/test values — no production keys or real sats.
- [ ] Terminal is clear of any prior secret output.
- [ ] Browser developer tools are closed or on a non-network tab (to avoid
      displaying authorization headers or request bodies).
- [ ] Screen recording is set to capture only the browser window, not the
      full desktop (to avoid capturing terminal output, `.env` contents, or
      file explorer).

## Recording steps

1. Start the local relay stack:
   ```sh
   npm run local:up
   ```

2. Run the doctor and confirm GREEN:
   ```sh
   npm run local:doctor
   ```

3. For model mode, run the model doctor:
   ```sh
   npm run requester:model:doctor
   ```

4. Build and start the real runtime:
   ```sh
   npm run build
   npm run runtime:start:local
   ```

5. Open `http://localhost:3000` in Chromium.

6. Start the screen recording.

7. Demonstrate the flow:
   - Show the requester landing page (PactAgent logo, "New transaction" button).
   - Click "New transaction".
   - Show the form: default 500-sat budget, document upload, optional prompt.
   - Upload a synthetic text document (e.g., `pactagent-demo.txt` containing
     synthetic text only — no personal, customer, or production data).
   - Optionally enter a synthetic private prompt.
   - Click "Review request".
   - Show the review screen: filename, media type, size, budget, prompt presence.
     Verify the raw document content and prompt are NOT displayed.
   - Click "Submit transaction".
   - Wait for the authoritative lifecycle to progress. Show the status view:
     - Transaction ID
     - Operational state (active -> settled)
     - Lifecycle phases
     - Selected provider (P002) and stable references
     - 350-sat signed offer
     - Requester-decision: advisory model recommendation
     - Deterministic policy: 6 checks passed, "Authorized: yes"
     - Trust boundary: safe/public vs private columns
   - When `settled` is reached:
     - Click "Load private result" — show the private summary.
     - Click "Load safe transaction report" — show the separate safe report.
     - Verify the safe report does NOT contain the private summary text.
   - Reload the page:
     - Show the same transaction is recovered (same ID, settled state).
     - Show private result and safe report are NOT auto-loaded.
     - Click "Load private result" again to show it can be re-retrieved.
   - (Optional) Open a second browser context and attempt to access the
     transaction — show 404 "Transaction not found".

8. Stop the screen recording.

9. Stop the runtime (Ctrl-C in the runtime terminal).

10. Stop the local relay stack:
    ```sh
    npm run local:down
    ```

## Post-recording disclosure review

Before publishing the recording, review it for accidental disclosure:

- [ ] No `.env` file contents visible.
- [ ] No private keys visible (terminal output, browser devtools, file explorer).
- [ ] No runtime bearer token visible (terminal, devtools network tab, headers).
- [ ] No model/API credentials visible.
- [ ] No Cashu proofs or funding token visible.
- [ ] No authorization headers visible.
- [ ] No secret query parameters visible.
- [ ] No terminal command history containing secrets.
- [ ] No sensitive database contents or paths visible.
- [ ] The synthetic document content is clearly synthetic (not real data).
- [ ] The private prompt is clearly synthetic.

If any secret or private material is visible, re-record after clearing the
affected source. Do not edit the recording to blur or mask secrets — re-record
from a clean state.

## Publishing

After the disclosure review passes:

1. Save the recording to the project's preferred hosting location.
2. Link the recording URL in `docs/issue-34-acceptance-audit.md` under section C.
3. Update section C from `NOT YET VERIFIED` to `PASS` with the recording link.
4. Commit the audit update.

## What NOT to record

Never record or display:

- `.env` contents
- Private keys
- Runtime bearer token
- Model/API credentials
- Cashu proofs
- Funding token
- Authorization headers
- Secret query parameters
- Terminal command history containing secrets
- Sensitive database contents or paths
- Browser developer tools showing network requests with headers/bodies
