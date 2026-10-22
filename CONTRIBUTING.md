# Contributing to PactAgent

Thank you for helping improve PactAgent. Contributions may include bug reports,
design discussion, documentation, tests, and code.

## Before you start

- Read the [README](README.md), [architecture](docs/architecture.md), and
  [domain model](docs/domain-model.md).
- Search existing issues and pull requests before opening a duplicate.
- For a large feature, protocol change, or architectural change, open an issue
  first so the approach and scope can be discussed.
- Never post private keys, credentials, Cashu tokens, private documents, or other
  sensitive data in an issue, test fixture, commit, or pull request.

PactAgent is currently a deterministic, local foundation. Relay publishing, event
signing, AI execution, mint connections, and real-funds movement are outside the
current implementation. Changes in those areas require explicit design and
security review before implementation.

## Set up the project

PactAgent requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Use `npm install` instead of `npm ci` when intentionally changing dependencies and
the lockfile.

## Make a change

1. Create a focused branch from the latest `main`.
2. Keep the change small enough to review and avoid unrelated refactoring.
3. Add or update tests for behavior changes.
4. Update documentation when interfaces, assumptions, or workflows change.
5. Preserve the project's trust boundary: deterministic policy authorizes
   economic actions, public protocol models contain no private payloads, and key
   material is not exposed to an AI or application layer.

Follow the existing TypeScript and React style. Prefer explicit domain types,
deterministic behavior, and fixtures that do not depend on networks, credentials,
or external services.

## Validate your change

Run the same core checks used by continuous integration:

```sh
npm run lint
npm run typecheck
npm test
npm run build -- --webpack
npm audit --omit=dev --audit-level=high
```

If a check is not relevant or cannot run in your environment, explain why in the
pull request.

Continuous integration also runs `npm run test:process` and
`npm run test:e2e:requester`. Run them locally when you change recovery,
runtime, or requester UI code.

## Merge requirements

The `main` ruleset is kept in [`.github/rulesets/main.json`](.github/rulesets/main.json).
Change that file in a pull request before applying a ruleset change. A pull
request can merge into `main` only when:

- every required check passes on a branch that is up to date with `main`;
- it has one approving review, and changes to paths listed in
  [`.github/CODEOWNERS`](.github/CODEOWNERS) (Cashu, runtime, workflow,
  protocol, and CI files) are approved by a code owner other than the author;
  and
- all review threads are resolved.

Repository admins can bypass these rules only when merging a pull request, for
emergencies. Explain any bypass in the pull request.

## Open a pull request

In the pull request description:

- explain the problem and the chosen solution;
- link related issues;
- describe user-visible, protocol, privacy, or security effects;
- list the validation performed; and
- include screenshots for visible UI changes.

By contributing, you agree that your contribution may be distributed under the
project's [MIT License](LICENSE). All contributors must follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Report security issues

Do not open a public issue for a suspected vulnerability. Follow the private
reporting process in the [Security Policy](SECURITY.md).
