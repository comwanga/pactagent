# Engineering pivot: Minmo Maker to PactAgent

This is the historical pivot rationale. Implementation-status notes below belong
to that phase; see the [README](../README.md) for the present application scope.

## Original direction

Minmo Maker began as a balanced and profitable Lightning swap-making policy layer. Phase 1 verified a proprietary SDK boundary, and Phase 2 built careful integer-safe maker inventory and projection models around its read-only market data.

## What mentor review revealed

External review feedback sharpened an architectural problem exposed by that work: the proof of concept depended on externally controlled infrastructure, private credentials, and service availability. The installed SDK also did not verify the Lightning node, peer, channel-balance, routing, fee, or rebalancing capabilities that the original thesis required.

This was productive engineering discovery, not discarded effort. Inspecting the actual package and refusing to invent missing capabilities produced the evidence needed to pivot early.

## Why Pontmore

Pontmore provides a Nostr-native specification family for capability discovery,
escrow compatibility, and coordination event chains. The pivot used the older
PIP-00/PIP-01 formats and swap/dispute drafts. The old swap-specific PIP-02 and
PIP-03 were subsequently removed; the current draft series is PIP-00, PIP-01,
and generalized PIP-02 v2. See the [pinned comparison](architecture.md#protocol-boundary).
Existing PactAgent wire formats are not automatically current-format conformance.
P001/P002 remain application roles, not PIPs.

## Why Nostr identity

PIP-00 makes the Nostr public key the canonical agent identity. That lets capabilities and protocol history remain portable instead of belonging to one application account. PactAgent implements independent identities, unsigned event drafts, an isolated signer boundary, and relay-backed publication/retrieval. Deployment-specific key custody and runtime composition remain separate concerns.

## Why Cashu escrow

Cashu offers an ecash settlement path suited to machine-sized payments. Current
PIP-01 identifies `cashu_escrow` as a compatibility type; service schemas and
coordination profiles own spending and recovery behavior. PactAgent's selected
implementation uses NUT-11 conditions, refund keys, locktime, private proof stores,
and an agreement-bound coordinator. Its requester runtime controls the authority
signer and both spending keys, so this is operator-controlled custody, not
trust-minimized escrow. See the [custody assumptions](architecture.md#custody-and-economic-guarantees).
Funding imports already-acquired proofs; Lightning acquisition and a production
wallet remain outside the supported path.

## Why bounded AI

The requester model evaluates an already deterministically selected offer. It
can veto proceeding, but cannot choose another provider or price or authorize
spending. Deterministic policy remains authoritative over capability, budget,
duration, settlement network, escrow compatibility, completion, and signer access.
The model receives neither signing keys nor wallet authority.

## Retained code

- integer-safe satoshi and basis-point representations;
- explicit domain validation and error patterns;
- strict TypeScript, Vitest, ESLint, and Next.js infrastructure;
- restrained UI scaffolding and public status reporting;
- the principle that external protocol data must be normalized at a boundary.

## Removed from the current runtime

- `@minmoto/sdk` and `server-only` dependencies;
- Minmo credentials and configuration;
- Minmo client, rate adapter, normalizer, market route, and market models;
- BTC/KES maker inventory projection UI and Minmo-specific documentation.

The original work remains intact in Git history.

## Still intentionally open

- Issue #16 end-to-end application composition and runtime hosting;
- a hosted requester-model adapter (the bounded model interface and deterministic policy exist);
- a live requester/provider transaction API and frontend;
- Lightning mint-quote acquisition, generic wallet accounts, and production custody operations;
- optional live value-flow verification beyond capability inspection;
- real disputes or operator resolutions;
- generic marketplace, reputation, bidding, or multi-service behavior.
