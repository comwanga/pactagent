import { getDecodedToken } from "@cashu/cashu-ts";
import { join, resolve } from "node:path";

import {
  createPactAgentWorkflow,
  PactAgentWorkflowError,
  type PactAgentParticipantIdentities,
  type PactAgentWorkflow,
  type PactAgentWorkflowDependencies,
  type PactAgentWorkflowReport,
} from "./pactagent-workflow";
import { WebSocketNostrRelayAdapter } from "./nostr-relay";
import { createLocalNostrSigner } from "./nostr-signer";
import { createLocalNostrEncrypter } from "./private-task-transport";
import {
  createCashuPrivateFundingSource,
  createCashuTestMintAdapter,
  createCashuPrivateValueDelivery,
  createPrivateCashuProofImport,
  createPrivateCashuSpendingKey,
  createSqliteCashuPrivateStore,
  type CashuTestMintPort,
} from "./cashu-test-mint";
import {
  createSqlitePactCashuEscrowSettlementStore,
} from "./cashu-escrow-settlement";
import { createNostrIdentity } from "../domain/nostr";
import { sats, type Sats } from "../domain/money";
import { createPontmoreAgentDefinition } from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  createPactServiceOffer,
  PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
} from "../domain/pact-service-offer";
import type { RequesterPolicy } from "../domain/pact-agents";
import {
  signAndPublishAgentDefinition,
} from "./pontmore-agent-publication";
import {
  signAndPublishPactServiceOffer,
} from "./pact-service-offer-publication";
import {
  signAndPublishCashuEscrowDescriptor,
} from "./pontmore-escrow-publication";
import type {
  RequesterDecisionBounds,
  RequesterDecisionModel,
  SafeRequesterDecisionInput,
} from "./requester-decision";

/*
 * Opt-in live PactAgent workflow demonstration (Issue #16).
 *
 * This module composes the existing WebSocket relay adapter and a configured
 * Cashu test mint to exercise the same application workflow used by the
 * deterministic tests. It requires explicit configuration via environment
 * variables and must never fall back to production or an arbitrary mint/relay.
 *
 * The live lane publishes real signed PIP-00/PactAgent/PIP-01 artifacts from
 * the configured identities and discovers them back from the relay, then funds
 * the escrow with pre-acquired test ecash supplied as a Cashu token.
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
  readonly normalSpendKeyHex: string;
  readonly refundSpendKeyHex: string;
  readonly fundingToken: string;
  readonly stateDirectory: string;
}

export function readLiveDemoConfigFromEnv(): PactAgentLiveDemoConfig | undefined {
  const relayUrl = process.env.PACTAGENT_LIVE_RELAY_URL;
  const testMintUrl = process.env.PACTAGENT_CASHU_TEST_MINT_URL;
  const requesterPrivateKeyHex = process.env.PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY;
  const providerPrivateKeyHex = process.env.PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY;
  const escrowAuthorityPrivateKeyHex = process.env.PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY;
  const normalSpendKeyHex = process.env.PACTAGENT_LIVE_NORMAL_SPEND_KEY;
  const refundSpendKeyHex = process.env.PACTAGENT_LIVE_REFUND_SPEND_KEY;
  const fundingToken = process.env.PACTAGENT_LIVE_FUNDING_TOKEN;
  const stateDirectory = process.env.PACTAGENT_LIVE_STATE_DIRECTORY;

  if (
    !relayUrl ||
    !testMintUrl ||
    !requesterPrivateKeyHex ||
    !providerPrivateKeyHex ||
    !escrowAuthorityPrivateKeyHex ||
    !normalSpendKeyHex ||
    !refundSpendKeyHex ||
    !fundingToken ||
    !stateDirectory
  ) {
    return undefined;
  }

  return {
    relayUrl,
    testMintUrl,
    requesterPrivateKeyHex,
    providerPrivateKeyHex,
    escrowAuthorityPrivateKeyHex,
    normalSpendKeyHex,
    refundSpendKeyHex,
    fundingToken,
    stateDirectory,
  };
}

export function assertLiveDemoConfig(config: PactAgentLiveDemoConfig | undefined): PactAgentLiveDemoConfig {
  if (!config) {
    throw new Error(
      "Live demonstration requires explicit configuration. Set PACTAGENT_LIVE_RELAY_URL, " +
        "PACTAGENT_CASHU_TEST_MINT_URL, PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY, " +
        "PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY, PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY, " +
        "PACTAGENT_LIVE_NORMAL_SPEND_KEY, PACTAGENT_LIVE_REFUND_SPEND_KEY, and " +
        "PACTAGENT_LIVE_FUNDING_TOKEN, and PACTAGENT_LIVE_STATE_DIRECTORY. " +
        "Missing configuration causes a clean skip — never a fallback to production.",
    );
  }
  return config;
}

export interface LiveDemoWorkflow {
  readonly workflow: PactAgentWorkflow;
  readonly relay: WebSocketNostrRelayAdapter;
  readonly cashu: CashuTestMintPort;
  readonly close: () => void;
}

export function createLiveDemoWorkflow(
  config: PactAgentLiveDemoConfig,
  decisionModel: RequesterDecisionModel,
): LiveDemoWorkflow {
  const relay = new WebSocketNostrRelayAdapter(config.relayUrl, {
    connectTimeoutMs: 10_000,
    defaultTimeoutMs: 15_000,
  });

  const identities: PactAgentParticipantIdentities = {
    requesterSigner: createLocalNostrSigner(config.requesterPrivateKeyHex),
    providerSigner: createLocalNostrSigner(config.providerPrivateKeyHex),
    escrowAuthoritySigner: createLocalNostrSigner(config.escrowAuthorityPrivateKeyHex),
    requesterEncrypter: createLocalNostrEncrypter(config.requesterPrivateKeyHex),
    providerEncrypter: createLocalNostrEncrypter(config.providerPrivateKeyHex),
  };

  const stateDirectory = resolve(config.stateDirectory);
  const cashuPrivateStore = createSqliteCashuPrivateStore(
    join(stateDirectory, "cashu-private.sqlite"),
  );
  const settlementStore = createSqlitePactCashuEscrowSettlementStore(
    join(stateDirectory, "escrow-settlement.sqlite"),
  );
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
    settlementStore,
    mintUrl: config.testMintUrl,
    normalSpendKey,
    refundSpendKey,
  };

  return {
    workflow: createPactAgentWorkflow({ identities, dependencies }),
    relay,
    cashu,
    close() {
      settlementStore.close();
      cashuPrivateStore.close();
    },
  };
}

export interface RunLiveDemoTransactionInput {
  readonly privateDocument: string;
  readonly mediaType: "text/plain" | "application/pdf";
  readonly privatePrompt?: string;
  readonly maximumBudgetSats: Sats;
}

function liveProviderIdentity(config: PactAgentLiveDemoConfig) {
  const providerSigner = createLocalNostrSigner(config.providerPrivateKeyHex);
  return createNostrIdentity(providerSigner.publicKey, [config.relayUrl]);
}

export async function publishLiveDemoProviderArtifacts(
  config: PactAgentLiveDemoConfig,
  relay: WebSocketNostrRelayAdapter,
  now: number,
): Promise<{
  providerDefinitionReference: string;
  offerReference: string;
  escrowDescriptorReference: string;
}> {
  const providerSigner = createLocalNostrSigner(config.providerPrivateKeyHex);
  const identity = liveProviderIdentity(config);

  const descriptor = createCashuEscrowDescriptor({
    identity,
    identifier: "live-cashu-escrow",
    referenceFormat: "opaque_service_reference",
    timeoutSeconds: 15 * 60,
    updatedAt: now,
  });
  await signAndPublishCashuEscrowDescriptor(descriptor, providerSigner, relay);

  const offer = createPactServiceOffer({
    identity,
    identifier: "live-document-summary-offer",
    capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
    amountSats: sats(350n),
    settlementNetwork: "cashu",
    escrowDescriptorReference: descriptor.address,
    maximumExecutionSeconds: 120,
    validFrom: now - 60,
    expiresAt: now + 3600,
    updatedAt: now,
  });
  await signAndPublishPactServiceOffer(offer, providerSigner, relay);

  const providerDefinition = createPontmoreAgentDefinition({
    identity,
    identifier: "live-provider",
    name: "Live Provider",
    about: "Live demonstration provider",
    capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
    pricingPolicyReference: offer.address,
    escrowDescriptorReference: descriptor.address,
    updatedAt: now,
  });
  await signAndPublishAgentDefinition(providerDefinition, providerSigner, relay);

  return {
    providerDefinitionReference: providerDefinition.address,
    offerReference: offer.address,
    escrowDescriptorReference: descriptor.address,
  };
}

export function createLiveDemoRequesterDefinition(
  config: PactAgentLiveDemoConfig,
  escrowDescriptorReference: string,
  now: number,
) {
  const requesterSigner = createLocalNostrSigner(config.requesterPrivateKeyHex);
  const identity = createNostrIdentity(requesterSigner.publicKey, [config.relayUrl]);
  return createPontmoreAgentDefinition({
    identity,
    identifier: "live-requester",
    name: "Live Requester",
    about: "Live demonstration requester",
    capabilities: { names: ["service-discovery"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/live-requester@1",
    escrowDescriptorReference,
    updatedAt: now,
  });
}

export async function importLiveDemoFunding(
  config: PactAgentLiveDemoConfig,
  cashu: CashuTestMintPort,
): Promise<import("./cashu-test-mint").PrivateCashuFunding> {
  try {
    const capabilities = await cashu.inspectCapabilities();
    const decoded = getDecodedToken(config.fundingToken, capabilities.acceptedKeysetIds);
    if (decoded.unit !== undefined && decoded.unit !== "sat") {
      throw new Error("invalid token unit");
    }

    const source = createCashuPrivateFundingSource({
      configuration: {
        testMintUrl: config.testMintUrl,
        unit: "sat",
        maximumExposureSats: sats(400n),
        requestTimeoutMs: 10_000,
        maximumResponseBytes: 500_000,
      },
      cashu,
    });

    const imported = createPrivateCashuProofImport({
      mintUrl: decoded.mint,
      unit: "sat",
      proofs: decoded.proofs,
    });

    return await source.importFunding(imported);
  } catch {
    throw new PactAgentWorkflowError(
      "invalid_configuration",
      "Live demonstration funding token is invalid or unusable",
    );
  }
}

export function createLiveDemoApprovalDecisionModel(): RequesterDecisionModel {
  return {
    async recommend(input: SafeRequesterDecisionInput): Promise<unknown> {
      const selected = input.candidates[0];
      if (!selected) {
        return { action: "decline", rationale: "No compatible provider discovered" };
      }
      return {
        action: "recommend",
        providerPublicKey: selected.providerPublicKey,
        providerDefinitionReference: selected.providerDefinitionReference,
        offerReference: selected.offerReference,
        escrowDescriptorReference: selected.escrowDescriptorReference,
        proposedAmountSats: selected.amountSats,
        rationale: "Approved live provider",
      };
    },
  };
}

export async function runLiveDemoTransaction(
  config: PactAgentLiveDemoConfig,
  input: RunLiveDemoTransactionInput,
): Promise<PactAgentWorkflowReport> {
  const { workflow, relay, cashu, close } = createLiveDemoWorkflow(
    config,
    createLiveDemoApprovalDecisionModel(),
  );
  try {
    await relay.connect();

    const now = Math.floor(Date.now() / 1000);
    const artifacts = await publishLiveDemoProviderArtifacts(config, relay, now);
    const requesterDefinition = createLiveDemoRequesterDefinition(
      config,
      artifacts.escrowDescriptorReference,
      now,
    );
    const requesterSigner = createLocalNostrSigner(config.requesterPrivateKeyHex);
    const signedRequesterDefinition = await requesterSigner.sign(requesterDefinition.event);
    const funding = await importLiveDemoFunding(config, cashu);

    return await workflow.runSuccessfulTransaction({
      requesterDefinition: signedRequesterDefinition,
      privateDocument: input.privateDocument,
      mediaType: input.mediaType,
      privatePrompt: input.privatePrompt,
      maximumBudgetSats: input.maximumBudgetSats,
      funding,
    });
  } finally {
    try {
      await relay.disconnect();
    } finally {
      close();
    }
  }
}
