# Engineering pivot: Minmo Maker to PactAgent

## Original direction

Minmo Maker began as a balanced and profitable Lightning swap-making policy layer. Phase 1 verified a proprietary SDK boundary, and Phase 2 built careful integer-safe maker inventory and projection models around its read-only market data.

## What mentor review revealed

External review feedback sharpened an architectural problem exposed by that work: the proof of concept depended on externally controlled infrastructure, private credentials, and service availability. The installed SDK also did not verify the Lightning node, peer, channel-balance, routing, fee, or rebalancing capabilities that the original thesis required.

This was productive engineering discovery, not discarded effort. Inspecting the actual package and refusing to invent missing capabilities produced the evidence needed to pivot early.

## Why Pontmore

Pontmore provides an inspectable, Nostr-native protocol family for public agent discovery, escrow compatibility, append-only lifecycle events, and dispute boundaries. PactAgent builds on PIP-00 through PIP-03 and treats those documents—not example applications—as authoritative. PactAgent does not claim to be Pontmore and does not introduce P001/P002 as PIPs.

## Why Nostr identity

PIP-00 makes the Nostr public key the canonical agent identity. That lets capabilities and protocol history remain portable instead of belonging to one application account. PactAgent implements independent identities, unsigned event drafts, an isolated signer boundary, and relay-backed publication/retrieval. Deployment-specific key custody and runtime composition remain separate concerns.

## Why Cashu escrow

Cashu offers an ecash settlement path suited to machine-sized payments. Current PIP-01 defines `cashu_escrow` as a canonical compatibility subtype using NUT-11 conditions, refund pubkeys, and locktime at the service layer. PactAgent now includes a network-capable test-mint adapter, durable private proof custody, NUT-11 lock/release/refund operations, and an agreement-bound settlement coordinator. It does not invent token formats or expose raw tokens. Funding currently imports already-acquired proofs; Lightning mint-quote acquisition and a production wallet remain out of scope.

## Why bounded AI

AI becomes an economic proposal layer: discover, compare, evaluate, and recommend. Deterministic policy remains authoritative over capability allowlists, price and budget ceilings, duration, settlement network, escrow compatibility, completion checks, and signer access. The model never receives unrestricted wallet or secret-key authority.

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
