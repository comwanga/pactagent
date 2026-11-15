# Shared Codex frontend toolkit

Research and package date: 2026-11-15. Collection version: **1.0.1**.
This is development tooling; application behavior and production authority are unchanged.

## Project evidence and scope

The local checkouts, including their existing working-tree changes, were inspected.
PactAgent HEAD was `fb4822a2221d76610787670420ddc86ffcbd4d6b`;
Rieko HEAD was `f06faf420fb891e6fb63b53ae9155a38b0329d22`.
PactAgent already had substantial uncommitted runtime, domain, UI, and documentation
work; Rieko had an untracked reference image. None is part of this installation.

| Project | Confirmed architecture and implemented workflows | Conventions and boundaries to preserve |
| --- | --- | --- |
| PactAgent | Next.js 16.4.2 App Router, React 19.2.8, TypeScript 5.9.3, npm. `src/app/page.tsx` renders `RequesterTransactionApp`; the component implements demo onboarding, document/budget/prompt entry, review/submission, selected-provider and decision projections, lifecycle status, private-result/report retrieval, and recovery actions. Provider discovery is implemented in the runtime; the inspected UI is not a general agent marketplace. | Plain global CSS with paper/ink/acid tokens and responsive breakpoints at 980/720/480px; native controls, field-error associations, live/status regions, focus management, and a reconciliation confirmation dialog. Preserve the same-origin requester BFF, server-only runtime bearer, allowlisted DTOs, session ownership, in-memory private input, idempotent submission, runtime-computed action eligibility, and advisory recommendation versus deterministic authorization. |
| Rieko | Rust workspace with domain, ingest, detection, storage, API, simulation, CLI, and other crates; SQLite-backed operational intelligence. Svelte 5/Vite 6/TypeScript frontend with TanStack Svelte Query. `frontend/src/App.svelte` routes Overview, Findings/detail, Services, Recommendations, Simulations, and Audit through a hash router. The simulation page displays stored projections and compares two records; this inspection does not establish a frontend simulation-creation flow. | Existing dark/light CSS tokens, scoped component styles, responsive sidebar, selected navigation semantics, skip control, and heading focus after navigation. Preserve observation/provenance/staleness distinctions, same-origin API token handling and cache clearing, restricted read-only node access, and simulations as projections. Execution is disabled by default and remains outside these skills' authority. |

Evidence: each repository's `package.json` (Rieko: `frontend/package.json`), README,
and actual components; PactAgent `docs/architecture.md`,
`docs/requester-integration-boundary.md`, requester client/transport/contracts;
Rieko `Cargo.toml`, `SECURITY.md`, frontend auth, router, sidebar, and simulation page.
Documentation establishes intent; source tracing establishes only the inspected
paths, not a complete runtime or security audit.

PactAgent already uses ESLint/Next rules, TypeScript, Vitest, Testing Library,
deterministic/process/browser lanes, opt-in live/economic lanes, and CI build and
client-bundle privacy checks. Rieko has `svelte-check`, a Vite build, Playwright
browser/model/auth suites, and Rust tests. Its browser configuration retains
failure traces; these can contain sensitive data outside synthetic fixtures.
This task did not change either test configuration or run financial/live lanes.

The effective global engineering instructions are in
`C:\Users\mwang\.codex\AGENTS.md`; the task also supplies them explicitly.
PactAgent's on-disk AGENTS.md adds the requirement to read bundled Next.js guides.
The relevant bundled accessibility/CSS guides were read. No nested AGENTS.md was
found in the inspected source trees, and no repository AGENTS.md was found in Rieko.
No Codex repository configuration or user-installed skill collection was present
in the inspected `.agents/skills`/`.codex/skills` locations. User
`~/.codex/skills` held `.system`; user `~/.agents/skills` was absent before installation.
The Codex configuration and session catalog already provide browser/computer-use,
document, image, visualization, and other plugin capabilities. A system
`review-agent` definition is on disk, although it was not advertised in this
session's initial skill catalog. No existing skill or configuration is overwritten.
The pre-existing `.claude` directory is left untouched.

Concrete workflow opportunities are consistent review of field/focus behavior,
responsive navigation and dense information, correct stale/unknown status,
asynchronous selection and recovery races, preservation of visual tokens, and
selection of safe fixture tests. A new visual identity or application redesign
is not needed to address these opportunities.

## Selection and exact locations

All four skills are shared user skills. Installation targets are:

| Skill | Version and source | Why selected | Installed folder under `C:\Users\mwang\.agents\skills\` |
| --- | --- | --- | --- |
| `fixing-accessibility` | `1.0.0-local.1`; adapted from `ibelick/ui-skills` | Small, stack-independent review of accessible names, native semantics, keyboard/focus, form errors, and announcements; directly relevant to both projects. | `fixing-accessibility` |
| `fixing-motion-performance` | `1.0.0-local.1`; adapted from `ibelick/ui-skills` | Focused review for existing or requested motion, including measurement, rendering cost, cancellation, and reduced motion; does not require an animation package or adding animations. | `fixing-motion-performance` |
| `frontend-conventions` | Original local `1.0.0` | Reconstructs an evidence-backed design/component contract before extending a frontend. Covers responsive layouts, navigation, dashboard interpretation, component ownership, and proportionate verification without imposing a shared aesthetic. | `frontend-conventions` |
| `ui-state-review` | Original local `1.0.0` | Read-only state/authority/recovery review with a state table and targeted fixture test plan; distinguishes unknown outcomes, stale data, retries, and authorization. | `ui-state-review` |

External source: [ibelick/ui-skills at the reviewed revision](https://github.com/ibelick/ui-skills/tree/65cc0edb4f64fe8bfe7e9c59466074de25bece76).
Both upstream skill folders contain **only SKILL.md**, with no executable files,
linked files, dependencies, or tool declarations. The full definitions and tree
were inspected before staging. The upstream commit is
`65cc0edb4f64fe8bfe7e9c59466074de25bece76` (2026-11-14); neither upstream skill has a
version field. Recent activity is evidence of activity, not a maintenance guarantee.
The upstream MIT license, including Julien Thibeaut's copyright, is retained in
each adapted skill. Original skills include PactAgent's MIT license.

The official `$skill-installer` downloaded the two exact upstream folders into a
temporary review directory using `--ref` and `--method download`. No upstream
scripts were executed. The final payloads are local reviewed adaptations:
Codex `$` invocation syntax; task-scoped activation; explicit read-only review
behavior; repository precedence and privacy boundaries; contextual keyboard and
heading guidance; measured rather than assumed performance defects; reduced motion;
and a warning that illustrative animation replacements may change behavior.
Each installed `PROVENANCE.md` records its origin and modifications.

Maintained snapshots are in `tools/codex-skills/skills/`, outside active discovery
directories. `tools/codex-skills/manifest.json` pins upstream revisions, original
file hashes, local versions, and SHA-256 hashes for every installed file. These
hashes detect drift; they are not signatures or proof of trust. The snapshots were
initially prepared as uncommitted local artifacts for review.
The bundle-local `.gitattributes` disables line-ending conversion for skill
payloads so a future Git checkout preserves those exact reviewed bytes, including
upstream license text. It does not change application source handling.

No repository-specific skill is installed. Project-specific architecture, security
rules, test commands, and durable engineering gates belong in the relevant
repository instructions/docs. Temporary review scope and one-off redesign briefs
remain prompts. The shared skills inspect each checkout rather than copying
Rieko's appearance or authority model into PactAgent, or the reverse.

## Other sources and exclusions

| Source/revision | Inspection and decision |
| --- | --- |
| [Requested Seti directory](https://github.com/lanoNjuguna/seti-v4/tree/main/.agents/skills) | GitHub repository/tree requests returned 404 through both `gh` and the connected GitHub app; the web fetch also failed. This does not establish whether the repository is private, renamed, or deleted. Its actual definitions, provenance, licenses, and scripts could not be inspected. **All candidates attributed to this source remain unverified and excluded.** No claim is made that similarly named skills elsewhere are identical. |
| [Official OpenAI skills](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated) | Inspected the curated inventory and the full `playwright`, `security-best-practices`, and `security-threat-model` entrypoints. Inspected `playwright_cli.sh`: Bash plus `npx --yes --package @playwright/cli`, without a package version. Do not add a second unpinned browser toolchain to these Windows/npm/Playwright projects. Security skills remain possible future task-specific choices; they are outside this focused frontend toolkit, and the best-practices skill does not cover Rust. Figma skills require a Figma-driven workflow that is not established here. No official curated skill was installed. Built-in creator/installer/docs skills were reused. |
| [Vercel collection](https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62) | Inspected full `web-design-guidelines`, `react-best-practices`, and `composition-patterns` entrypoints and README. The web review skill delegates instructions to an unpinned live `main/command.md` fetch using `WebFetch`; unsuitable for this reproducible offline toolkit. React performance/composition skills are React-only and broad, with caching/prefetch/library and architectural prescriptions that need separate privacy/stack review; they do not fit Rieko's Svelte frontend. README/React metadata claim MIT, but no standalone license file was found in the inspected tree; redistribution was not resolved. Excluded, rather than assuming all references and rights are verified. |
| [Anthropic collection](https://github.com/anthropics/skills/tree/1780c5e5a552fd4d1c9d6a7b0cab26b0c2bef064) | Inspected full `frontend-design`, its Apache-2.0 license, `webapp-testing`, and the latter's `with_server.py` without executing it. Frontend design provides an aesthetic-lead/new-direction workflow broader than preserving these established interfaces. Testing mandates running helpers before source inspection, uses Python Playwright and `networkidle`, and adds a parallel harness despite existing TypeScript suites and polling UIs. The helper launches shell commands; no such helper was installed or run. Excluded for workflow mismatch, not a claim of maliciousness. |
| [UI UX Pro Max collection](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/0e8d408204fdc66b8189960dd28cc20d71db188e) | Screened the `ui-ux-pro-max` entrypoint and file inventory, plus `design-system`, `design`, and `ui-styling` entrypoint sections. Searchable multi-stack guidance is potentially useful, but the collection includes substantial Python/data/catalog/asset maintenance, Claude-specific paths, persistent design-system generation, and broader design/brand/tool workflows. Styling targets shadcn/Radix/Tailwind rather than these existing CSS implementations. Root metadata reports MIT, but the full executable and asset provenance audit was not undertaken after scope/complexity screening. Not selected; not declared unsafe or fully audited. |
| [Engineering collection](https://github.com/heyimcarlos/agent-skills/tree/b9b929f680b72c32c524fbd6b0e8b64bae46ae6d) | Inspected full `thermo-nuclear-code-quality-review` and `prototype` entrypoints. The former repeats general review principles, includes another project's TryAgent-specific boundary, and directs patching after review; the latter prescribes throwing away verification/error handling and committing a prototype branch. These are poor defaults for this task and its gates. No repository-wide license was established; excluded. |
| [Other ibelick skills](https://github.com/ibelick/ui-skills/tree/65cc0edb4f64fe8bfe7e9c59466074de25bece76/skills) | Inspected full `baseline-ui`: mandates Tailwind, `motion/react`, `cn`, and particular accessible primitive systems. Conflicts with the existing CSS/Svelte choices and would introduce unnecessary dependencies. Only the two narrower, stack-neutral skills were selected. |
| Existing local/plugin skills | General code review, creator/installer, image generation, browser automation, visualization, and artifact workflows already exist. Duplicating them or adding SEO, landing-page, image-to-code, broad redesign, compiler-check wrappers, PR automation, or skill-gardening routers has no demonstrated recurring benefit for the inspected workflows. Retain compiler/test commands in the repositories and use existing skills when those actual tasks arise. |

The exploratory Seti names (`design-taste-frontend`, `design-enforcement`,
`high-end-visual-design`, `redesign-existing-projects`, `modular-ui-authoring`,
`modular-ui-refactor`, `pick-ui-library`, `surface-parity`, `animate`,
`animation-vocabulary`, `improve-animations`, `review-animations`,
`find-animation-opportunities`, `check-compiler-errors`, `feature-process`,
`make-pr-easy-to-review`, `skill-gardening`, `seo-and-ai-search`, etc.) are not
verified definitions. Similar capability coverage was evaluated independently;
names or search excerpts were not treated as an installation audit.

## Routing and project applicability

| Representative task | Primary skill | Relevant complement |
| --- | --- | --- |
| PactAgent document form errors or reconciliation dialog keyboard behavior | `fixing-accessibility` | `ui-state-review` for pending/recovery transitions |
| PactAgent onboarding, accepted request, status/retry/authorization wording | `ui-state-review` | `frontend-conventions` for existing component/tokens |
| Rieko navigation, findings hierarchy, responsive service tables, data visualization | `frontend-conventions` | `fixing-accessibility` for keyboard/semantics and non-color interpretation |
| Rieko loading/disconnected/stale service states or simulation comparison races | `ui-state-review` | `frontend-conventions` for existing state vocabulary |
| Existing motion jank, a requested transition, or reduced-motion review in either project | `fixing-motion-performance` | `fixing-accessibility` for motion alternatives and focus continuity |

Use one primary workflow. Load a complement only for its distinct concern and
deduplicate findings. The conventions skill owns visual/component consistency;
the state skill owns asynchronous journey and authority tracing; accessibility
owns interaction semantics; motion owns motion-specific costs and preferences.
All defer to repository instructions, gates, and actual task scope. None adds
signing, custody, authorization, production access, or permission to execute a
financial test. They declare no tools, connectors, network helpers, or runtime
dependencies. Optional browser use stays within available authorized tooling.

## Reproduce, verify, and maintain

Codex's [official skill guide](https://learn.chatgpt.com/docs/build-skills)
documents user discovery in `~/.agents/skills`, repository discovery in
`.agents/skills`, YAML name/description metadata, and explicit or implicit use.
The bundled installer still defaults to `~/.codex/skills`; this collection uses
the currently documented user location and a manual copy of reviewed snapshots.
No `config.toml`, AGENTS.md, plugin setting, or application dependency changes are
needed. A plugin package would be appropriate for wider distribution; this is a
single user's local collection shared by two repositories.

From PactAgent, with **Python 3.12 or newer** available:

```powershell
# Verify the reviewed source payload and preflight destination conflicts.
python tools/codex-skills/install.py
# Install only missing folders. Existing differing content aborts before copying.
python tools/codex-skills/install.py --install
# Require exact installed copies; check every payload hash and file inventory.
python tools/codex-skills/install.py --installed
# Run isolated installation safeguard tests (no application or network activity).
python -B -m unittest discover -s tools/codex-skills -p test_install.py -v
```

`--dest <absolute-directory>` supports a different user's documented skills
directory or temporary verification fixture. The installer uses only Python's
standard library, performs no network operations or subprocess execution, rejects
links/junctions, unexpected payload files, source drift, overlapping destinations,
and existing differing skills. It never overwrites or merges a target. Identical
copies are a no-op. An interrupted copy remains a detectable conflict; do not
automatically delete it or an existing skill. SHA-256 manifests must be reviewed
with content changes, not regenerated to hide unexplained drift.
The CLI checks its Python version and the availability of `Path.is_junction`
before inspecting source manifests or processing destination paths. Older
interpreters or missing junction detection fail closed with an explanatory error.

For updates, review the upstream revision diff, every newly introduced file and
instruction, license/attribution, local adaptations, and representative tasks.
Increment the local version, update provenance and hashes, validate again, and
obtain the applicable approval before replacing an installed local version.
Do not update from `main` or install an entire collection automatically.

### Verification record

- All eight YAML documents (four SKILL frontmatters and four `agents/openai.yaml`
  files) parsed with the already-installed `js-yaml` 4.3.2; names, descriptions,
  versions, MIT metadata, prompts, and implicit-invocation flags matched. No new
  dependency was added. The bundled Python quick validator could not run because
  PyYAML is absent; no package was installed merely to run it.
- The initial six isolated installer tests passed: installation plus identical rerun, all-target
  conflict preflight, source-tamper refusal, extra-executable refusal, missing-copy
  reporting, and source/destination overlap refusal. No third-party scripts ran.
- Source-based applicability exercises used the actual skill instructions:
  accessibility review of PactAgent's document/budget form preserved existing
  labels, field-error associations, error summary, and focus behavior; no runtime
  accessibility or conformance claim was made. Conventions review of Rieko's
  sidebar preserved CSS tokens, `aria-current`, menu expansion, and mobile layout;
  rendered zoom/reflow remains unmeasured.
- State-review exercise: Rieko `frontend/src/pages/Simulations.svelte:28` awaits a
  comparison and assigns its result, while `clearCompare()` at line 41 can clear
  the selection/result during that request. A late response can repopulate a
  comparison after Clear. This is a **source-supported, pre-existing race**, not a
  runtime-reproduced defect. Proposed test: defer the comparison response, clear,
  resolve it, then assert no cleared comparison reappears. No fix was implemented.
- Motion exercise found `scroll-behavior: smooth` in PactAgent's stylesheet at
  line 20 and no reduced-motion override there. This alone does not demonstrate a
  triggered scrolling problem or animation jank. No animation library or motion
  implementation was added, and no performance measurement was claimed.
- After the approved user-directory copy, a fresh **Codex CLI 0.169.0** app-server
  `skills/list` request with both checkout paths and `forceReload: true` returned
  exactly these four skills per checkout, all at their expected user paths with
  `scope: user`, `enabled: true`, parsed UI metadata, and **zero loading errors**.
  Only `initialize`, `initialized`, and `skills/list` were sent; no model thread
  or turn was started. This is actual Codex discovery, not just a filesystem check.
- Installed inventories and hashes match all reviewed snapshots. Content-baseline
  checks found **zero changes to 247 pre-existing PactAgent files and 196 Rieko
  files**, and both HEADs were unchanged. New workspace files are limited to this
  report and `tools/codex-skills/`. Application manifests, lockfiles, AGENTS.md,
  production configuration, business logic, and pre-existing uncommitted work
  remain unchanged. No files were added to Rieko. No application tests or builds
  were run for this text/tooling-only installation, and no CI result is claimed.
- This checkout has `core.autocrlf=true`. Git's filtered and raw blob hashes were
  compared for all 16 skill payload files after adding the bundle-local byte
  preservation attribute; they match. No index or commit was created for this check.
- A separate final self-review checked source provenance, read-only review mode,
  overlapping scopes, authority boundaries, inventory controls, and the final
  additions. This self-review was followed by the separate review described below.
- Implicit activation remains a model decision; metadata validation, discovery,
  and manual routing exercises do not prove future automatic selection. The
  safety of future skill-guided application changes still requires the applicable
  design, implementation, verification, review, and acceptance gates.

The read-only discovery exchange is reproducible with `codex app-server --stdio`
using its documented initialization protocol, followed by:

```json
{"id":2,"method":"skills/list","params":{"cwds":["C:\\Users\\mwang\\pactagent","C:\\Users\\mwang\\rieko"],"forceReload":true}}
```

Seti access, rendered browser/assistive-technology validation, and motion profiling
remain limitations. None is represented as completed. The installed toolkit itself
requires no network or model call to copy.

### Independent review and approved correction

A separately authorized reviewer identified one P2: the installer conditionally
skipped junction detection on Python versions without `Path.is_junction`, although
the documentation allowed Python 3 generally and promised junction rejection.
The reviewer found no other material instruction, provenance, or scope conflict.
Existing Python 3.14 installations were unaffected.

The user approved the focused correction. Collection 1.0.1 requires Python 3.12+
with junction detection before source inspection or destination processing and
removes the conditional fallback. Skill payloads and their individual versions
are unchanged, so no reinstall is required.

New regression cases cover simulated Python 3.11, unavailable junction detection,
and an actual Windows junction both as destination and as destination ancestor.
The first two cases failed against the original installer before the correction;
the native junction was already rejected on Python 3.14. After the correction,
all nine tests passed on Python 3.14.6. The separate reviewer independently reran
all nine tests, verified the installed copies, reported **no findings**, and
confirmed the original P2 is resolved. Actual execution under Python 3.11 and
cross-platform execution are not claimed.

The correction changed only the installer, its tests, the collection version in
the manifest, and this report. Baseline verification found no changes to
application files, Rieko, installed skill payloads, or either repository HEAD.

## Invoke in future sessions

In Codex CLI/IDE, use `/skills` or type `$` and select a skill. In the desktop
skill picker, select the corresponding display name. Explicit prompt examples:

```text
$fixing-accessibility Review src/app/requester-transaction-app.tsx for form
error associations and reconciliation-dialog keyboard behavior. Do not edit.

$ui-state-review Trace the existing requester submission and recovery flow;
separate advisory recommendations from authorization. Use source/fixtures only.

$frontend-conventions Review frontend/src/lib/Sidebar.svelte against Rieko's
existing tokens, navigation semantics, and responsive layout. Do not redesign.

$fixing-motion-performance Review existing CSS motion and reduced-motion
behavior. Report observed evidence; do not add animations or dependencies.
```

Skills may also be selected automatically for matching tasks. Codex documents
automatic detection of changed skill files; if a skill is missing from the picker,
start a new turn or restart the client and verify its path and enabled state.
This running conversation's initial catalog may remain unchanged.

The user accepted collection 1.0.1 (G5) and authorized a commit, push, and pull
request (G6). Correction verification and independent review (G3/G4) are complete;
the original P2 is resolved. Next immediate task: the user's PR verification and
merge decision. Automated merge and deployment remain unauthorized.
