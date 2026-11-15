# Security Policy

PactAgent signs and publishes Nostr events, exchanges private task/result data,
and connects to configured Cashu mints to lock, release, and refund ecash. Runtime
compositions hold signing/spending keys and durable economic state; the requester
API handles private inputs and session ownership through a server-only runtime
transport. These are implemented attack surfaces, even when exercised with test
ecash or demo balances.

The requester runtime currently controls the escrow-authority signer and both
NUT-11 spending keys. This is operator-controlled custody, not trust-minimized
escrow; see the [custody assumptions](docs/architecture.md#custody-and-economic-guarantees).
The project does not claim production financial safety. The name `live` is a
configuration mode, not proof that a mint or its ecash is safe for testing.

## Supported versions

PactAgent is pre-release software. Security fixes are applied to the latest code on
the `main` branch. Older commits, forks, and unreleased local modifications are not
supported.

Do not use the current project with real funds or production secrets unless a
future release explicitly documents that support.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, pull
request, or social-media post.

Submit a private report through
[GitHub Security Advisories](https://github.com/comwanga/pactagent/security/advisories/new).
If private vulnerability reporting is unavailable, contact the maintainers through
a private method listed on the
[repository owner's GitHub profile](https://github.com/comwanga). Do not send
secrets, private keys, ecash tokens, or real funds as evidence.

Include, when possible:

- a clear description of the issue and its impact;
- affected commit, version, component, and configuration;
- minimal reproduction steps or a proof of concept using synthetic data;
- relevant logs with credentials and personal data removed;
- any suggested mitigation; and
- a safe way to contact you for follow-up.

You should receive an acknowledgement within three business days and an initial
assessment within seven business days. The maintainers will coordinate status
updates and a disclosure timeline with you. Please keep the report confidential
until a fix or agreed mitigation is available.

## In scope

Examples include:

- exposure or misuse of private keys, credentials, tokens, or private payloads;
- bypasses of budget, duration, network, escrow, or state-transition policy;
- forged, replayed, or incorrectly validated protocol events;
- injection, cross-site scripting, request forgery, or unsafe deserialization;
- dependency or build behavior that compromises users; and
- flaws that could cause unauthorized signing or movement of value in implemented
  functionality.

Missing features described as future work are not vulnerabilities by themselves.
Reports based only on automated scanner output, without a plausible security
impact, may receive lower priority.

## Safe harbor

We will not pursue action against good-faith security research that:

- avoids privacy violations, service disruption, social engineering, and access to
  data that does not belong to the researcher;
- uses local fixtures or synthetic data instead of real funds and secrets;
- makes only the changes necessary to demonstrate the issue;
- reports the issue promptly and allows reasonable time for remediation; and
- follows applicable law.

This safe harbor applies only to systems and code maintained by PactAgent; it does
not authorize testing of third-party services such as GitHub, Nostr relays, Cashu
mints, or Bitcoin infrastructure.
