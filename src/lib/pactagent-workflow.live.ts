import {
  createPactAgentWorkflow,
  type PactAgentParticipantIdentities,
  type PactAgentWorkflowDependencies,
} from "./pactagent-workflow";
import { WebSocketNostrRelayAdapter } from "./nostr-relay";
import { createLocalNostrSigner, generateNostrPrivateKey } from "./nostr-signer";
import { createLocalNostrEncrypter, generateNostrPrivateKeyForEncrypter } from "./private-task-transport";
import {
  createCashuTestMintAdapter,
  createCashuPrivateValueDelivery,
  createInMemoryCashuPrivateStore,
  createPrivateCashuSpendingKey,
} from "./cashu-test-mint";
import {
  createInMemoryPactCashuEscrowSettlementStore,
} from "./cashu-escrow-settlement";
import { sats } from "../domain/money";
import type { RequesterPolicy } from "../domain/pact-agents";
import type { RequesterDecisionBounds, RequesterDecisionModel } from "./requester-decision";

/*
 * Opt-in live PactAgent workflow demonstration (Issue #16).
 *
 * This module composes the existing WebSocket relay adapter and a configured
 * Cashu test mint to exercise the same application workflow used by the
 * deterministic tests. It requires explicit configuration via environment
 * variables and must never fall back to production or an arbitrary mint/relay.
 *
 * No private keys, tokens, proofs, documents, results, prompts, salts,
 * credentials, or payout material are committed or printed.
 *
 * This module is NOT required for CI. Missing configuration causes a clean
 * configuration error, not a fallback.
 */

export interface PactAgentLiveDemoConfig {
  readonly relayUrl: string;
  readonly testMintUrl: string;
  readonly requesterPrivateKeyHex: string;
  readonly providerPrivateKeyHex: string;
  readonly escrowAuthorityPrivateKeyHex: string;
  readonly requesterEncrypterPrivateKeyHex: string;
  readonly providerEncrypterPrivateKeyHex: string;
  readonly normalSpendKeyHex: string;
  readonly refundSpendKeyHex: string;
}

export function readLiveDemoConfigFromEnv(): PactAgentLiveDemoConfig | undefined {
  const relayUrl = process.env.PACTAGENT_LIVE_RELAY_URL;
  const testMintUrl = process.env.PACTAGENT_CASHU_TEST_MINT_URL;
  const requesterPrivateKeyHex = process.env.PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY;
  const providerPrivateKeyHex = process.env.PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY;
  const escrowAuthorityPrivateKeyHex = process.env.PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY;
  const requesterEncrypterPrivateKeyHex = process.env.PACTAGENT_LIVE_REQUESTER_ENCRYPTER_KEY;
  const providerEncrypterPrivateKeyHex = process.env.PACTAGENT_LIVE_PROVIDER_ENCRYPTER_KEY;
  const normalSpendKeyHex = process.env.PACTAGENT_LIVE_NORMAL_SPEND_KEY;
  const refundSpendKeyHex = process.env.PACTAGENT_LIVE_REFUND_SPEND_KEY;

  if (
    !relayUrl ||
    !testMintUrl ||
    !requesterPrivateKeyHex ||
    !providerPrivateKeyHex ||
    !escrowAuthorityPrivateKeyHex ||
    !requesterEncrypterPrivateKeyHex ||
    !providerEncrypterPrivateKeyHex ||
    !normalSpendKeyHex ||
    !refundSpendKeyHex
  ) {
    return undefined;
  }

  return {
    relayUrl,
    testMintUrl,
    requesterPrivateKeyHex,
    providerPrivateKeyHex,
    escrowAuthorityPrivateKeyHex,
    requesterEncrypterPrivateKeyHex,
    providerEncrypterPrivateKeyHex,
    normalSpendKeyHex,
    refundSpendKeyHex,
  };
}

export function assertLiveDemoConfig(config: PactAgentLiveDemoConfig | undefined): PactAgentLiveDemoConfig {
  if (!config) {
    throw new Error(
      "Live demonstration requires explicit configuration. Set PACTAGENT_LIVE_RELAY_URL, " +
        "PACTAGENT_CASHU_TEST_MINT_URL, and all PACTAGENT_LIVE_* key environment variables. " +
        "Missing configuration causes a clean skip — never a fallback to production.",
    );
  }
  return config;
}

export function createLiveDemoWorkflow(
  config: PactAgentLiveDemoConfig,
  decisionModel: RequesterDecisionModel,
): ReturnType<typeof createPactAgentWorkflow> {
  const relay = new WebSocketNostrRelayAdapter(config.relayUrl, {
    connectTimeoutMs: 10_000,
    defaultTimeoutMs: 15_000,
  });

  const identities: PactAgentParticipantIdentities = {
    requesterSigner: createLocalNostrSigner(config.requesterPrivateKeyHex),
    providerSigner: createLocalNostrSigner(config.providerPrivateKeyHex),
    escrowAuthoritySigner: createLocalNostrSigner(config.escrowAuthorityPrivateKeyHex),
    requesterEncrypter: createLocalNostrEncrypter(config.requesterEncrypterPrivateKeyHex),
    providerEncrypter: createLocalNostrEncrypter(config.providerEncrypterPrivateKeyHex),
  };

  const cashuPrivateStore = createInMemoryCashuPrivateStore();
  const cashu = createCashuTestMintAdapter({
    configuration: {
      testMintUrl: config.testMintUrl,
      unit: "sat",
      maximumExposureSats: sats(400n),
      requestTimeoutMs: 10_000,
      maximumResponseBytes: 500_000,
    },
    privateStore: cashuPrivateStore,
  });

  const privateDelivery = createCashuPrivateValueDelivery({
    configuration: {
      testMintUrl: config.testMintUrl,
      unit: "sat",
      maximumExposureSats: sats(400n),
    },
    privateStore: cashuPrivateStore,
  });

  const requesterPolicy: RequesterPolicy = {
    maxBudgetSats: sats(500n),
    allowedCapabilities: ["document-summary"],
    maximumEscrowDurationSeconds: 15 * 60,
    maximumProviderPriceSats: sats(450n),
    allowedSettlementNetworks: ["cashu"],
    autoRelease: "deterministic_checks_only",
  };

  const decisionBounds: RequesterDecisionBounds = {
    maximumInstructionCharacters: 1000,
    maximumRationaleCharacters: 500,
    modelTimeoutMilliseconds: 30_000,
  };

  const normalSpendKey = createPrivateCashuSpendingKey({
    purpose: "cashu-nut11",
    secretKeyHex: config.normalSpendKeyHex,
  });
  const refundSpendKey = createPrivateCashuSpendingKey({
    purpose: "cashu-nut11",
    secretKeyHex: config.refundSpendKeyHex,
  });

  const clock = { now: () => Math.floor(Date.now() / 1000) };

  const dependencies: PactAgentWorkflowDependencies = {
    relay,
    clock,
    requesterPolicy,
    decisionModel,
    decisionBounds,
    cashu,
    privateDelivery,
    settlementStore: createInMemoryPactCashuEscrowSettlementStore(),
    mintUrl: config.testMintUrl,
    normalSpendKey,
    refundSpendKey,
  };

  return createPactAgentWorkflow({ identities, dependencies });
}

export function generateLiveDemoIdentities(): {
  readonly requesterPrivateKey: string;
  readonly providerPrivateKey: string;
  readonly escrowAuthorityPrivateKey: string;
  readonly requesterEncrypterPrivateKey: string;
  readonly providerEncrypterPrivateKey: string;
  readonly normalSpendKey: string;
  readonly refundSpendKey: string;
} {
  return {
    requesterPrivateKey: generateNostrPrivateKey(),
    providerPrivateKey: generateNostrPrivateKey(),
    escrowAuthorityPrivateKey: generateNostrPrivateKey(),
    requesterEncrypterPrivateKey: generateNostrPrivateKeyForEncrypter(),
    providerEncrypterPrivateKey: generateNostrPrivateKeyForEncrypter(),
    normalSpendKey: generateNostrPrivateKey(),
    refundSpendKey: generateNostrPrivateKey(),
  };
}
