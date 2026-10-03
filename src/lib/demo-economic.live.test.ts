import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDecodedToken } from "@cashu/cashu-ts";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sats } from "../domain/money";
import { nostrPublicKey, type NostrIdentity, type SignedNostrEvent, type UnsignedNostrEvent } from "../domain/nostr";
import { createPontmoreAgentDefinition } from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  DOCUMENT_SUMMARY_PROFILE_ID,
  PactPrivateCommitmentSalt,
  createPactAgreementTransition,
  createPactCompletionDecision,
  createPactEscrowAuthorityBinding,
  createPactEscrowAuthoritySource,
  createPactResultReference,
  createPactServiceAgreementRoot,
  createPactTermsCommitment,
  reconstructPactAgreementHistory,
  validatePactServiceAgreementRoot,
  type PactAgreementContext,
  type PactAgreementReferences,
  type PactAgreementState,
} from "../domain/pact-service-agreement";
import {
  CashuTestMintError,
  createBoundedCashuWallet,
  createSqliteCashuPrivateStore,
} from "./cashu-test-mint";
import {
  createPactCashuEscrowSettlementCoordinator,
  type PactCashuClock,
} from "./cashu-escrow-settlement";
import type { NostrRelayAdapter } from "./nostr-relay";
import { createLocalNostrSigner } from "./nostr-signer";
import {
  createDemoEconomicEnvironment,
  type EconomicEnvironment,
  type DemoEconomicEnvironmentConfig,
} from "./economic-environment";

/*
 * Issue #36, Finding 5: REAL container-backed demo economic integration lane.
 *
 * Executes against the actual pinned Nutshell 0.21.0/FakeWallet container
 * (compose.local.yml `demo-mint` on http://127.0.0.1:3338). The Cashu port is
 * NEVER mocked. Demo sats only — no Testnut, no real Lightning, no real
 * Bitcoin, no fabricated proofs, no direct mint DB mutation.
 *
 * Coverage: real demo factory bootstrap + durable funding restore; real
 * walletReady/mintAvailable/fundingAvailable; real P2PK lock and spend; replay
 * rejection; real coordinator settlement with release/refund exclusivity;
 * Nutshell mint restart with spent state preserved; demo funding exhaustion.
 *
 * A skipped test is NOT PASS. If the demo mint is unreachable the suite fails
 * explicitly. Start the mint first:
 *   docker compose -f compose.local.yml up -d demo-mint
 */

const DEMO_MINT_URL = "http://127.0.0.1:3338";
const ROOT_TIME = 1_900_000_000;
const NORMAL_SPEND_KEY_HEX = "21".repeat(32);
const REFUND_SPEND_KEY_HEX = "22".repeat(32);

const tempDirs: string[] = [];
afterAll(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows locks */ }
  }
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pactagent-demo-econ-live-"));
  tempDirs.push(dir);
  return dir;
}

function demoConfig(stateDirectory: string, fundingReference: string): DemoEconomicEnvironmentConfig {
  return {
    mintUrl: DEMO_MINT_URL,
    stateDirectory,
    normalSpendKeyHex: NORMAL_SPEND_KEY_HEX,
    refundSpendKeyHex: REFUND_SPEND_KEY_HEX,
    fundingReference,
  };
}

let transactionSequence = 0;
async function bindWalletFunding(env: EconomicEnvironment, walletKey: string) {
  const transactionId = `txn_demo_economic_${++transactionSequence}`;
  const binding = await env.bindDemoTransactionFunding!(walletKey, transactionId);
  return Object.freeze({
    transactionId,
    fundingReference: binding.fundingReference,
    funding: await env.resolveFunding(binding.fundingReference),
  });
}

async function waitForMint(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${DEMO_MINT_URL}/v1/info`);
      if (res.ok) return;
    } catch { /* keep polling */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Demo mint did not become reachable at ${DEMO_MINT_URL}`);
}

async function mintIdentity(): Promise<string> {
  const res = await fetch(`${DEMO_MINT_URL}/v1/keysets`);
  if (!res.ok) throw new Error("Demo mint keysets are unavailable");
  const response = (await res.json()) as { keysets?: Array<{ id?: string }> };
  const identifiers = response.keysets
    ?.map((keyset) => keyset.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();
  if (!identifiers || identifiers.length === 0) throw new Error("Demo mint returned no keyset identity");
  return identifiers.join(",");
}

async function readPersistedDemoFunding(stateDirectory: string, walletKey: string): Promise<{
  token: string;
  createdAt: number;
  source: string;
}> {
  const store = createSqliteCashuPrivateStore(join(stateDirectory, "cashu-private.sqlite"));
  try {
    const record = (await store.read("demo-funding", `${walletKey}:1`)) as
      | { token: string; createdAt: number; source: string }
      | undefined;
    if (!record) throw new Error("demo-funding record not persisted");
    return record;
  } finally {
    store.close();
  }
}

// --- Coordinator agreement fixture (Nostr layer only; the Cashu port is real) ---

function key(seed: number): Uint8Array { return new Uint8Array(32).fill(seed); }
function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function identity(secret: Uint8Array): NostrIdentity {
  return { publicKey: nostrPublicKey(getPublicKey(secret)), relays: ["wss://relay.example"] };
}
function sign(event: UnsignedNostrEvent, secret: Uint8Array): SignedNostrEvent {
  return finalizeEvent({ ...event, tags: event.tags.map((tag) => [...tag]) }, secret) as unknown as SignedNostrEvent;
}

class TestClock implements PactCashuClock {
  constructor(public value: number) {}
  now(): number { return this.value; }
}

class TestRelay implements NostrRelayAdapter {
  readonly url = "wss://relay.example";
  readonly events: SignedNostrEvent[] = [];
  async connect(): Promise<void> {}
  async reconnect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async publish(event: SignedNostrEvent): Promise<void> {
    if (!this.events.some((candidate) => candidate.id === event.id)) this.events.push(event);
  }
  async queryEvents(): Promise<SignedNostrEvent[]> { return [...this.events]; }
}

function agreementFixture(rootTime = ROOT_TIME) {
  const requesterKey = key(31);
  const providerKey = key(32);
  const authorityKey = key(33);
  const requester = identity(requesterKey);
  const provider = identity(providerKey);
  const descriptor = createCashuEscrowDescriptor({
    identity: provider,
    identifier: "cashu-summary",
    updatedAt: rootTime - 3,
    referenceFormat: "opaque_service_reference",
    timeoutSeconds: 900,
  });
  const requesterDefinition = createPontmoreAgentDefinition({
    identity: requester, identifier: "requester", name: "Requester", about: "Requests summaries.",
    capabilities: { names: ["service-discovery"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/requester@1", escrowDescriptorReference: descriptor.address, updatedAt: rootTime - 2,
  });
  const providerDefinition = createPontmoreAgentDefinition({
    identity: provider, identifier: "provider", name: "Provider", about: "Provides summaries.",
    capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/provider@1", escrowDescriptorReference: descriptor.address, updatedAt: rootTime - 1,
  });
  const references: PactAgreementReferences = {
    requesterDefinition: sign(requesterDefinition.event, requesterKey),
    providerDefinition: sign(providerDefinition.event, providerKey),
    escrowDescriptor: sign(descriptor.event, providerKey),
  };
  const privateTerms = { source_document: "PRIVATE-DOCUMENT", input_media_type: "text/plain" as const, private_prompt: "PRIVATE-PROMPT" };
  const privateResult = { summary: "PRIVATE-RESULT" };
  const privateSalt = new PactPrivateCommitmentSalt(new Uint8Array(32).fill(9));
  const commitment = createPactTermsCommitment(DOCUMENT_SUMMARY_PROFILE_ID, privateTerms, privateSalt);
  const draft = createPactServiceAgreementRoot({
    agreementId: "12345678-1234-4234-9234-123456789abc",
    references, amountSats: "350", maximumExecutionSeconds: 300, expiresAt: rootTime + 600,
    termsCommitment: commitment, createdAt: rootTime,
  });
  const root = validatePactServiceAgreementRoot(sign(draft.event, requesterKey), references);
  const sourceDraft = createPactEscrowAuthoritySource({ root, references, authority: identity(authorityKey).publicKey, createdAt: rootTime + 1 });
  const source = sign(sourceDraft.event, providerKey);
  const escrowAuthority = createPactEscrowAuthorityBinding({ root, references, authority: identity(authorityKey).publicKey, source });
  const context: PactAgreementContext = { root, references, escrowAuthority };
  const history: SignedNostrEvent[] = [];
  append(context, history, "accepted", "provider", providerKey, rootTime + 2);
  return { requesterKey, providerKey, authorityKey, privateTerms, privateResult, privateSalt, context, history, locktime: rootTime + 2 + 900 };
}

function append(
  context: PactAgreementContext,
  history: SignedNostrEvent[],
  state: PactAgreementState,
  role: "requester" | "provider" | "escrow",
  secret: Uint8Array,
  createdAt: number,
  options: { reasonCode?: string; resultReference?: string } = {},
): SignedNostrEvent {
  const draft = createPactAgreementTransition({
    context, history, predecessorEventId: history.at(-1)?.id ?? null,
    nextState: state, actor: identity(secret).publicKey, actorRole: role,
    reasonCode: options.reasonCode, resultReference: options.resultReference,
    createdAt, validationTime: createdAt,
  });
  const event = sign(draft.event, secret);
  history.push(event);
  return event;
}

function advanceReleaseHistory(fx: ReturnType<typeof agreementFixture>, clock: TestClock): { context: PactAgreementContext; resultReference: string } {
  const firstTime = fx.history.at(-1)!.created_at + 1;
  append(fx.context, fx.history, "task_delivered", "provider", fx.providerKey, firstTime);
  const resultReference = createPactResultReference(DOCUMENT_SUMMARY_PROFILE_ID, fx.context.root.event.id, fx.privateResult);
  append(fx.context, fx.history, "result_submitted", "provider", fx.providerKey, firstTime + 1, { resultReference });
  const decision = createPactCompletionDecision({ context: fx.context, history: fx.history, privateTerms: fx.privateTerms, privateSalt: fx.privateSalt, privateResult: fx.privateResult });
  const context = { ...fx.context, completionDecisions: [decision] };
  append(context, fx.history, "result_verified", "requester", fx.requesterKey, firstTime + 2, { resultReference });
  append(context, fx.history, "release_authorized", "requester", fx.requesterKey, firstTime + 3);
  clock.value = firstTime + 4;
  return { context, resultReference };
}

describe("Issue #36 Finding 5: real container-backed demo economic integration", () => {
  beforeAll(async () => {
    try {
      const res = await fetch(`${DEMO_MINT_URL}/v1/info`);
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (error) {
      throw new Error(
        `Demo mint not reachable at ${DEMO_MINT_URL}. Start it: docker compose -f compose.local.yml up -d demo-mint. Underlying: ${(error as Error).message}`,
      );
    }
  });

  it("bootstraps a demo economic environment against the real Nutshell mint with truthful capabilities", async () => {
    const stateDir = await tempDir();
    const ref = "bootstrap-funding-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));
    try {
      expect(env.mode).toBe("demo");
      expect(env.mintUrl).toBe(DEMO_MINT_URL);
      const caps = await env.inspectCapabilities();
      expect(caps.mintAvailable).toBe(true);
      expect(caps.fundingAvailable).toBe(true);
      expect(caps.walletReady).toBe(true);
      await env.startDemoWallet!(ref);
      const walletFunding = await bindWalletFunding(env, ref);
      const funding = walletFunding.funding;
      expect(funding).toBeDefined();
      // Proves the persisted durable funding record exists under the private boundary.
      const record = await readPersistedDemoFunding(stateDir, ref);
      expect(record.source).toBe("demo-mint-bootstrap");
      expect(record.token).toMatch(/^cashu/);
      // No proof/token leakage into capabilities.
      expect(JSON.stringify(caps)).not.toContain(record.token);
    } finally {
      env.close();
    }
  }, 120_000);

  it("restores durable demo funding on restart without minting again", async () => {
    const stateDir = await tempDir();
    const ref = "restart-funding-ref";
    const config = demoConfig(stateDir, ref);

    // First initialization: mints once.
    const env1 = await createDemoEconomicEnvironment(config);
    await env1.startDemoWallet!(ref);
    const persistedBinding = await bindWalletFunding(env1, ref);
    const before = await readPersistedDemoFunding(stateDir, ref);
    env1.close();

    // Restart: reconstruct the same configured environment.
    const env2 = await createDemoEconomicEnvironment(config);
    try {
      await env2.startDemoWallet!(ref);
      const restoredFunding = await env2.resolveFunding(persistedBinding.fundingReference);
      expect(restoredFunding).toBeDefined();
      const after = await readPersistedDemoFunding(stateDir, ref);
      // The persisted token and createdAt are unchanged — no second quote/mint occurred.
      expect(after.token).toBe(before.token);
      expect(after.createdAt).toBe(before.createdAt);
      const caps = await env2.inspectCapabilities();
      expect(caps.fundingAvailable).toBe(true);
      expect(caps.walletReady).toBe(true);
    } finally {
      env2.close();
    }
  }, 120_000);

  it("executes real P2PK lock and spend against Nutshell and rejects replay of spent value", async () => {
    const stateDir = await tempDir();
    const ref = "p2pk-funding-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));
    try {
      await env.startDemoWallet!(ref);
      const { funding } = await bindWalletFunding(env, ref);
      const prepared = await env.cashu.prepareLockedValue({
        operationId: "p2pk-lock-op-1",
        funding,
        amountSats: sats(350n),
        spendingCondition: {
          lockPublicKey: env.normalSpendKey.publicKey,
          refundPublicKey: env.refundSpendKey.publicKey,
          locktime: 9999999999,
        },
      });
      expect(prepared.status).toBe("succeeded");
      if (prepared.status !== "succeeded") throw new Error("prepare did not succeed");
      const lockHandle = prepared.handle;
      expect(lockHandle).toBeDefined();

      const spent = await env.cashu.spendLockedValue({
        operationId: "p2pk-spend-op-1",
        handle: lockHandle,
        spendingKey: env.normalSpendKey,
      });
      expect(spent.status).toBe("succeeded");

      // Replay: the spent handle cannot be spent again with a fresh operation id.
      await expect(
        env.cashu.spendLockedValue({
          operationId: "p2pk-spend-replay",
          handle: lockHandle,
          spendingKey: env.normalSpendKey,
        }),
      ).rejects.toBeInstanceOf(CashuTestMintError);

      // The spent handle is recorded as spent.
      const state = await env.cashu.inspectProofState(lockHandle);
      expect(state.state).toBe("spent");
    } finally {
      env.close();
    }
  }, 120_000);

  it("completes real coordinator settlement against Nutshell and rejects duplicate/refund-after-release", async () => {
    const stateDir = await tempDir();
    const ref = "coordinator-funding-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));
    try {
      const fx = agreementFixture();
      const relay = new TestRelay();
      const clock = new TestClock(ROOT_TIME + 30);
      const escrowAuthoritySigner = createLocalNostrSigner(hex(fx.authorityKey));
      const coordinator = createPactCashuEscrowSettlementCoordinator({
        mintUrl: env.mintUrl,
        cashu: env.cashu,
        privateDelivery: env.privateDelivery,
        store: env.settlementStore,
        escrowAuthoritySigner,
        normalSpendKey: env.normalSpendKey,
        refundSpendKey: env.refundSpendKey,
        relay,
        clock,
      });

      const prepared = await coordinator.prepareEscrow({ idempotencyKey: "prepare-escrow-01", context: fx.context, history: fx.history });
      await env.startDemoWallet!(ref);
      const walletFunding = await bindWalletFunding(env, ref);
      const funding = walletFunding.funding;
      const funded = await coordinator.fundEscrow({
        idempotencyKey: "fund-escrow-001", escrowReference: prepared.escrow.escrowReference,
        expectedVersion: prepared.escrow.version, context: fx.context, history: fx.history, funding,
      });
      expect(funded.outcome).toBe("confirmed");
      expect(funded.escrow.state).toBe("funded");
      if (funded.outcome === "confirmed") fx.history.push(relay.events.at(-1)!);

      const release = advanceReleaseHistory(fx, clock);
      const authorized = await coordinator.submitReleaseAuthorization({
        idempotencyKey: "authorize-release-01", escrowReference: funded.escrow.escrowReference,
        expectedVersion: funded.escrow.version, context: release.context, history: fx.history,
        resultReference: release.resultReference,
      });
      const settled = await coordinator.releaseEscrow({
        idempotencyKey: "release-escrow-001", escrowReference: funded.escrow.escrowReference,
        expectedVersion: authorized.escrow.version, context: release.context, history: fx.history,
      });
      fx.history.push(relay.events.at(-1)!);
      expect(settled).toMatchObject({ outcome: "confirmed", escrow: { state: "settled", amountSats: "350", unit: "sat" } });
      expect(reconstructPactAgreementHistory(release.context, fx.history)).toMatchObject({ currentState: "settled" });

      await env.finalizeDemoTransaction!(
        walletFunding.fundingReference,
        walletFunding.transactionId,
        "settled",
        settled.escrow.escrowReference,
      );
      const balanceAfterSettlement = await env.demoWalletStatus!(ref);
      expect(balanceAfterSettlement.accountingPending).toBe(false);
      expect(balanceAfterSettlement.availableSats).toBeGreaterThan(0n);
      expect(balanceAfterSettlement.availableSats).toBeLessThan(1000n);

      const subsequent = await bindWalletFunding(env, ref);
      const subsequentLock = await env.cashu.prepareLockedValue({
        operationId: "subsequent-settlement-lock-01",
        funding: subsequent.funding,
        amountSats: sats(100n),
        spendingCondition: {
          lockPublicKey: env.normalSpendKey.publicKey,
          refundPublicKey: env.refundSpendKey.publicKey,
          locktime: 9999999999,
        },
      });
      expect(subsequentLock.status).toBe("succeeded");

      // Duplicate settlement with the same idempotency key returns the stored settled result (no re-spend).
      const duplicate = await coordinator.releaseEscrow({
        idempotencyKey: "release-escrow-001", escrowReference: funded.escrow.escrowReference,
        expectedVersion: settled.escrow.version, context: release.context, history: fx.history,
      });
      expect(duplicate).toMatchObject({ outcome: "confirmed", escrow: { state: "settled" } });

      // Release/refund exclusivity: refund after release is rejected.
      await expect(
        coordinator.refundEscrow({
          idempotencyKey: "refund-after-release-01", escrowReference: funded.escrow.escrowReference,
          expectedVersion: settled.escrow.version, context: release.context, history: fx.history,
        }),
      ).rejects.toMatchObject({ code: "already_released" });

      // No private token leaked into the settlement result.
      expect(JSON.stringify(settled)).not.toContain("cashu_private_");
    } finally {
      env.close();
    }
  }, 120_000);

  it("returns a real timeout refund to the same wallet generation and permits subsequent spend", async () => {
    const stateDir = await tempDir();
    const ref = "coordinator-refund-wallet-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));
    try {
      const fx = agreementFixture(Math.floor(Date.now() / 1000) - 1_200);
      const relay = new TestRelay();
      const clock = new TestClock(fx.context.root.event.created_at + 30);
      const coordinator = createPactCashuEscrowSettlementCoordinator({
        mintUrl: env.mintUrl,
        cashu: env.cashu,
        privateDelivery: env.privateDelivery,
        store: env.settlementStore,
        escrowAuthoritySigner: createLocalNostrSigner(hex(fx.authorityKey)),
        normalSpendKey: env.normalSpendKey,
        refundSpendKey: env.refundSpendKey,
        relay,
        clock,
      });
      const prepared = await coordinator.prepareEscrow({
        idempotencyKey: "refund-wallet-prepare-01",
        context: fx.context,
        history: fx.history,
      });
      await env.startDemoWallet!(ref);
      const walletFunding = await bindWalletFunding(env, ref);
      const funded = await coordinator.fundEscrow({
        idempotencyKey: "refund-wallet-fund-01",
        escrowReference: prepared.escrow.escrowReference,
        expectedVersion: prepared.escrow.version,
        context: fx.context,
        history: fx.history,
        funding: walletFunding.funding,
      });
      if (funded.outcome !== "confirmed") throw new Error("funding did not confirm");
      fx.history.push(relay.events.at(-1)!);
      clock.value = fx.locktime;
      append(fx.context, fx.history, "refund_authorized", "requester", fx.requesterKey, fx.locktime, {
        reasonCode: "timeout",
      });
      const authorized = await coordinator.submitRefundAuthorization({
        idempotencyKey: "refund-wallet-authorize-01",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: funded.escrow.version,
        context: fx.context,
        history: fx.history,
        basis: "timeout",
      });
      const refunded = await coordinator.refundEscrow({
        idempotencyKey: "refund-wallet-spend-01",
        escrowReference: funded.escrow.escrowReference,
        expectedVersion: authorized.escrow.version,
        context: fx.context,
        history: fx.history,
      });
      expect(refunded).toMatchObject({ outcome: "confirmed", escrow: { state: "refunded" } });
      await env.finalizeDemoTransaction!(
        walletFunding.fundingReference,
        walletFunding.transactionId,
        "refunded",
        refunded.escrow.escrowReference,
      );
      const returned = await env.demoWalletStatus!(ref);
      expect(returned.accountingPending).toBe(false);
      expect(returned.availableSats).toBeGreaterThanOrEqual(900n);

      const subsequent = await bindWalletFunding(env, ref);
      const subsequentLock = await env.cashu.prepareLockedValue({
        operationId: "subsequent-refund-lock-01",
        funding: subsequent.funding,
        amountSats: sats(100n),
        spendingCondition: {
          lockPublicKey: env.normalSpendKey.publicKey,
          refundPublicKey: env.refundSpendKey.publicKey,
          locktime: 9999999999,
        },
      });
      expect(subsequentLock.status).toBe("succeeded");
    } finally {
      env.close();
    }
  }, 120_000);

  it("spent value remains spent and mint identity persists across a Nutshell mint restart", async () => {
    const stateDir = await tempDir();
    const ref = "mint-restart-funding-ref";
    const env = await createDemoEconomicEnvironment(demoConfig(stateDir, ref));
    try {
      await env.startDemoWallet!(ref);
      const { funding } = await bindWalletFunding(env, ref);
      const prepared = await env.cashu.prepareLockedValue({
        operationId: "mint-restart-lock-1",
        funding,
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: env.normalSpendKey.publicKey, refundPublicKey: env.refundSpendKey.publicKey, locktime: 9999999999 },
      });
      if (prepared.status !== "succeeded") throw new Error("prepare did not succeed");
      const lockHandle = prepared.handle;
      await env.cashu.spendLockedValue({ operationId: "mint-restart-spend-1", handle: lockHandle, spendingKey: env.normalSpendKey });
      expect((await env.cashu.inspectProofState(lockHandle)).state).toBe("spent");
      const pubkeyBefore = await mintIdentity();

      // Restart the actual Nutshell container.
      execSync("docker restart pactagent-local-demo-mint", { stdio: "ignore" });
      await waitForMint();

      const pubkeyAfter = await mintIdentity();
      expect(pubkeyAfter).toBe(pubkeyBefore); // mint identity/keysets persist
      // Spent proofs remain spent after the mint restart.
      const stateAfter = await env.cashu.inspectProofState(lockHandle);
      expect(stateAfter.state).toBe("spent");
    } finally {
      env.close();
    }
  }, 180_000);

  it("fails with demo_funding_exhausted when persisted demo funding is fully spent (no silent replenishment)", async () => {
    const stateDir = await tempDir();
    const ref = "exhausted-funding-ref";
    const config = demoConfig(stateDir, ref);

    // Bootstrap, then spend the ENTIRE persisted funding. A P2PK lock selects
    // the minimum input proofs to cover amount+fee; to consume ALL proofs we
    // lock (total - fee), computed from the persisted token's proof count so
    // the swap selects every persisted proof and leaves none unspent.
    const env = await createDemoEconomicEnvironment(config);
    await env.startDemoWallet!(ref);
    let exhaustAmount: bigint;
    let transactionFundingReference = "";
    try {
      const caps = await env.cashu.inspectCapabilities();
      const record = await readPersistedDemoFunding(stateDir, ref);
      const decoded = getDecodedToken(record.token, caps.acceptedKeysetIds);
      const wallet = createBoundedCashuWallet({
        testMintUrl: DEMO_MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(400n),
        requestTimeoutMs: 10_000,
        maximumResponseBytes: 500_000,
        transportPolicy: "demo-loopback",
      });
      await wallet.loadMint();
      const fee = wallet.getFeesForProofs(decoded.proofs).toBigInt();
      const total = decoded.proofs.reduce((sum, proof) => sum + proof.amount.toBigInt(), 0n);
      // Lock (total - fee - 1) so the swap selects every persisted proof (the
      // selector must cover amount+fee = total-1, which exceeds total minus the
      // smallest denomination, forcing all original proofs to be spent) while
      // still leaving a 1-sat change output so the swap is well-formed.
      exhaustAmount = total - fee - 1n;
      expect(exhaustAmount).toBeGreaterThan(0n);

      await env.startDemoWallet!(ref);
      const binding = await bindWalletFunding(env, ref);
      transactionFundingReference = binding.fundingReference;
      const funding = binding.funding;
      const prepared = await env.cashu.prepareLockedValue({
        operationId: "exhaust-lock-01",
        funding,
        amountSats: sats(exhaustAmount),
        spendingCondition: { lockPublicKey: env.normalSpendKey.publicKey, refundPublicKey: env.refundSpendKey.publicKey, locktime: 9999999999 },
      });
      expect(prepared.status).toBe("succeeded");
    } finally {
      env.close();
    }

    // Restart must NOT silently mint replacement funding; it must fail explicitly
    // when resolveFunding is called with all proofs spent.
    const env2 = await createDemoEconomicEnvironment(config);
    try {
      await env2.startDemoWallet!(ref);
      await expect(env2.resolveFunding(transactionFundingReference)).rejects.toMatchObject({
        code: "demo_funding_exhausted",
      });
      const balance = await env2.walletBalance!(ref);
      expect(balance.availableSats).toBe(0n);
    } finally {
      env2.close();
    }
  }, 120_000);
});
