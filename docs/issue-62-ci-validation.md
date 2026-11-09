# Issue #62 Docker-backed CI validation

The `relay-policy` job in `.github/workflows/ci.yml` runs on an ephemeral
GitHub-hosted **Ubuntu 24.04 / Node 22 / Python 3.12** runner. It retains the
check name `Strfry policy and hosted protocol (Linux / Node 22)` and executes
for every `pull_request` targeting `main`, including the Issue #62 branch.
There is no head-branch or path filter. Existing quality, production-build,
process and browser checks and branch-protection settings are unchanged.

The code was committed/pushed and published as
[draft PR #106](https://github.com/comwanga/pactagent/pull/106) after explicit
user authorization. Fork/first-time-contributor approval may still be required
by repository Actions policy. No deployment or local Docker startup is needed.

## Exact commands

Each workflow step calls `node scripts/issue-62-ci.mjs <phase>`. The phase
dispatcher runs the following commands in a deliberately isolated environment:

| Phase | Command | Command deadline |
| --- | --- | --- |
| `prepare` | `docker version`, `docker compose version`; initialize resource journal | 20 seconds each |
| `install` | `npm ci` | 240 seconds |
| `unit` | `npm run test:relay-policy` | 120 seconds |
| `baseline` | `npm run test:relay-policy:baseline` | 180 seconds |
| `relay` | `npm run test:relay-policy:live` | 420 seconds |
| `build` | `npm run build -- --webpack` | 300 seconds |
| `hosted` | `npm run test:hosted-nostr:live` | 420 seconds |
| `cleanup` | For each journaled project: `docker compose -f <recorded files> -p <recorded project> down --volumes --remove-orphans --timeout 10` | 30 seconds/project |

GNU `timeout --signal=TERM --kill-after=20s` bounds each command, with an
additional Node subprocess timeout as a backstop. Every step also has a bounded
Actions timeout; the job ceiling is 40 minutes, including cleanup headroom.
The final cleanup step has `if: always()` and a three-minute ceiling.

## Expected executed coverage

The existing stock-relay reproduction, hosted policy suite and hosted economic
acceptance are reused. No relay responses are mocked by the security lane.

- Build the actual `deploy/strfry.Dockerfile` with its pinned Strfry 1.1.3 base,
  included Python/SQLite runtime, executable plugin and production hosted config.
  Compose `up --build` is executed for each fresh hosted project.
- Verify policy preflight in the running container and startup failure when
  mandatory author configuration is absent.
- Signed kind-1 and unauthorized coordination rejection; enrolled provider,
  independent requester and authority acceptance; provider artifact restrictions.
- Actual encrypted maximum-document gift publication and public read/decryption;
  normalized/frame size boundaries; missing recipient/expiry and future-time
  rejection; recipient and aggregate rate boundaries with fresh outer authors.
- Native removal of an initially present expiring gift; agreement evidence
  remains; exact enrolled pre-upgrade wrap recovery; retained event survives
  relay restart and controlled shutdown. An actual plugin SIGKILL requires the
  next write to reject; automatic restart preserves kind filtering and quota.
- A small signed gift rejects at the storage-reservation boundary while an
  authorized economic event remains writable. Only the disposable policy's
  accounting is seeded/restored; responses are actual Strfry WSS responses.
  Accounting row/page/reservation and LMDB file bounds are checked after floods.
- Full requester HTTP -> independent provider process -> discovery, agreement,
  funding, private task, execution, private result, verification and settlement
  against a newly created **Nutshell FakeWallet test mint**.

The acceptance flag makes required unavailable services fail instead of silently
skipping the provider/hosted transaction test. The baseline, policy and hosted
phases use separate disposable projects, keys, databases and ephemeral ports.

## Workflow security review

The draft job's ordinary `finally` cleanup could be bypassed by timeout or
cancellation, and inherited environment variables could enter the acceptance
processes. The completed infrastructure addresses these paths as follows:

1. Standard `pull_request`, never `pull_request_target`; `contents: read` only,
   no deployment environment, OIDC permission, repository secrets or cloud
   credentials. Action revisions are pinned to full commit SHAs and checkout
   sets `persist-credentials: false`. The relay job uses no shared action cache.
2. Test commands receive an environment allowlist with an isolated HOME,
   unauthenticated Docker/npm configuration, deterministic requester decisions,
   Demo economic mode and locally generated identities. Parent GitHub/cloud/
   Railway/SSH/npm tokens, remote Docker contexts and application URLs/keys are
   not forwarded. Setup Python's toolcache library path is preserved.
3. Preflight rejects real `.env*` files in the checkout (except `.env.example`)
   so Next and the existing local environment loader cannot load live settings.
   The harness selects loopback test URLs and fresh FakeWallet state explicitly.
4. BEFORE any Docker resource creation, each harness journals its project and
   Compose files plus public interpolation variables. Private application keys
   are excluded. At most three records / 64 KiB are accepted.
5. Cleanup validates the entire journal before running any destructive command.
   Only `pactagent-62-ci-<run-id>-<attempt>-{baseline,hosted}-<suffix>` projects
   and their exact expected Compose files are accepted. No global prune, volume
   enumeration/deletion, production checkout or developer service is involved.
   A failed project cleanup does not prevent attempts on the remaining projects;
   cleanup errors fail the job. Existing in-harness `finally` cleanup is retained.
6. The entry point refuses non-GitHub-hosted/non-Linux execution. Its local
   regression suite uses temporary journals and captured command calls, never
   the Docker daemon. No raw state databases, keys or private tasks are uploaded.

Read-only permissions and pinned actions follow GitHub's
[secure workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use).
The `always()` cleanup and process timeouts account for GitHub's
[cancellation behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation).

## Limits and current evidence

Non-Docker validation on Windows / Node 24:

- `actionlint` 1.7.12: CI and Acceptance workflows passed; the downloaded
  executable's archive was checked against the upstream release checksum.
- 16 targeted tests across four files passed in 21.40 seconds, including the
  runner isolation/cleanup tests, Python policy-suite wrapper (34 Python cases),
  settled-transaction compatibility and shutdown-wrapper regression checks.
- The 10 runner tests passed again after final bounded-journal/cache hardening.
- `npm run lint`: passed, 0 errors and 27 existing warnings.
- `npm run typecheck`, script syntax checks and `git diff --check`: passed.

Existing expensive unit/integration/process/browser/build lanes were not
unnecessarily repeated for this infrastructure-only change. No relay policy,
economic implementation or Docker image configuration changed in this task.

Docker-backed validation passed on Linux/Node 22 at `c3272ad` in
[job 121638567136](https://github.com/comwanga/pactagent/actions/runs/40341913339/job/121638567136):
34 policy cases, four baseline publications, 5 provider cases, 3 size-boundary
cases, 11 real policy cases, 3 hosted settlement cases, restart probes and cleanup.
The full Linux suite (1,133 cases), 16 process cases, 8 browser cases, build,
invariants, dependency review and CodeQL also passed at that revision. Local
Docker was not started. The subsequent report update changes documentation only.

The first baseline run reproduced a startup failure: pinned Strfry requests
1,000,000 descriptors but the runner's Docker hard limit was 65,536. Both
disposable relay fixtures now supply soft/hard `nofile=1000000`; no filter,
security assertion or production resource was weakened to pass the test.

The runner remains an untrusted-code execution environment with Internet access
for public images/packages; this is not a sandbox against a malicious PR that
rewrites the workflow. No production identities or authenticated economic
capabilities are supplied. Repository/org Actions settings must keep deployment
credentials out of ordinary PR jobs. Standard fork approval remains applicable.

Normal failure, command timeout and cancellation use the journal plus `always()`
cleanup. Abrupt VM loss/forced cancellation can prevent any cleanup code from
executing; destruction of the ephemeral GitHub-hosted runner is the final
backstop. Images/build cache are local to that disposable runner. There are no
remote volumes, deployment calls or persistent test-economic resources.
