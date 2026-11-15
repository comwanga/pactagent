---
name: frontend-conventions
description: Extend or review an existing frontend while preserving its design tokens, component boundaries, navigation, and responsive behavior. Use for component design, UI consistency reviews, or scoped frontend refactors; not a new visual identity or backend audit.
license: MIT
metadata:
  version: "1.0.0"
---

# Work within an existing frontend

Build a small, evidence-backed design contract before proposing UI changes.
Repository instructions and the user's authorized scope govern the work.
This skill does not grant permission to implement, install dependencies, ship,
or change financial or security behavior.

## Establish the local contract

Read applicable AGENTS.md files, the package manifest, the target component,
its callers, a comparable existing component, shared styles, and nearby tests.
Use the installed framework's documentation when APIs or conventions matter;
for Next.js, honor the repository's requirement to read its bundled guides.

Record only the conventions relevant to this task, with source paths:

- Existing color, spacing, type, focus, and semantic state tokens, including
  light/dark variants where implemented.
- Component and state ownership, public props, style scoping, and where data
  enters the view. Distinguish display state from authoritative domain state.
- Navigation URLs, history behavior, selected states, focus after navigation,
  headings, and existing mobile navigation.
- Responsive breakpoints, content wrapping, dense tables, long identifiers,
  zoom/reflow behavior, and the longest realistic labels or error messages.
- Current empty, loading, error, stale-data, and successful states. Do not
  invent product workflows or claim an unimplemented pattern already exists.

## Design the smallest extension

Use existing components and tokens when they express the required behavior.
Propose a new variant or component only when a concrete repeated responsibility
or state boundary justifies it. File length alone does not justify extraction.
Keep business decisions and authorization with their existing owners.

For a dashboard, preserve units, observation times, source/provenance, unknown
values, stale markings, and the distinction between observations and forecasts.
Provide a textual interpretation for visual encodings; color or a chart tooltip
must not be the only way to understand consequential data.

For a form or transaction view, retain the established action vocabulary,
confirmation semantics, field-error associations, and recovery behavior.
Do not introduce a UI library, animation library, font service, telemetry, or
design-system layer just to satisfy a stylistic preference. Explain any real
dependency need and follow the applicable design approval gate first.

Review the proposed layout with small screens, keyboard use, zoom, long text,
empty data, and failure messages in mind. If browser inspection is available,
use synthetic local data and report which viewports and states were observed.
Source inspection alone cannot establish rendered contrast or absence of overflow.

## Validate proportionally

Inspect package scripts and test configuration before selecting commands.
Prefer the existing component and browser fixtures over a parallel test harness.
For an approved behavior change, add a focused regression check for the changed
contract and run the relevant existing checks. Keep live, networked, financial,
and deployment lanes separate; a UI review does not authorize them.

Return the observed conventions, consequential deviations with file/line
evidence, the smallest proposed change, and the validation result or limitation.
Label design preferences as suggestions, not defects. A review request remains
read-only. Finish with the next task or pending approval gate under the local plan.
