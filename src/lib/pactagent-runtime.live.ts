import { join, resolve } from "node:path";

import { createNostrIdentity, type NostrPublicKey } from "../domain/nostr";
import { sats } from "../domain/money";
import type { RequesterPolicy } from "../domain/pact-agents";
import type { PactAgreementReferences } from "../domain/pact-service-agreement";
import { createPontmoreAgentDefinition } from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  createPactServiceOffer,
  PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
} from "../domain/pact-service-offer";
import {
  createSqlitePactCashuEscrowSettlementStore,
} from "./cashu-escrow-settlement";
import {
  createCashuTestMintAdapter,
  createCashuPrivateValueDelivery,
  createPrivateCashuSpendingKey,
  createSqliteCashuPrivateStore,
  type CashuPrivateStore,
  type CashuTestMintPort,
} from "./cashu-test-mint";
import { createLocalNostrSigner } from "./nostr-signer";
import { WebSocketNostrRelayAdapter } from "./nostr-relay";
import { createLocalNostrEncrypter } from "./private-task-transport";
import {
  createPactAgentRuntime,
  PactAgentRuntimeError,
  type PactAgentRuntime,
  type PactAgentRuntimeConfig,
} from "./pactagent-runtime";
import { signAndPublishAgentDefinition } from "./pontmore-agent-publication";
import { signAndPublishCashuEscrowDescriptor } from "./pontmore-escrow-publication";
import { signAndPublishPactServiceOffer } from "./pact-service-offer-publication";
import {
  assertLiveDemoConfig,
  createLiveDemoApprovalDecisionModel,
  createLiveDemoRequesterDefinition,
  importLiveDemoFunding,
  readLiveDemoConfigFromEnv,
  type PactAgentLiveDemoConfig,
} from "./pactagent-workflow.live";
import {
  type PactAgentParticipantIdentities,
  type PactAgentWorkflowDependencies,
} from "./pactagent-workflow";
import type { RequesterDecisionBounds, RequesterDecisionModel } from "./requester-decision";
import type { SelectedProviderReferences } from "./provider-discovery";
import type { SignedNostrEvent } from "../domain/nostr";
import type { NostrRelayAdapter } from "./nostr-relay";
import { createModelBackedRequesterDecisionModel } from "./model-requester-decision";
import {
  createOpenAIRequesterRecommendationTransport,
  readRequesterDecisionModeConfiguration,
} from "./openai-requester-decision";

/*
 * Opt-in live PactAgent runtime wiring (Issue #33).
 *
 * Composes the existing live-demo helpers to stand up the long-lived runtime
 * against a configured WebSocket relay + Cashu test mint. The bootstrap
 * publishes or verifies the P001 requester definition, the P002 provider
 * definition, the exact 350-sat offer, and the PIP-01 escrow descriptor, then
 * enforces a single configured mint with a literal "sat" unit.
 *
 * Missing configuration produces an explicit configuration error (no fallback).
 * Funding is imported once per process; the proof source is single-use, so each
 * funded transaction requires a fresh funding token (documented PoC limit).
 */

export interface PactAgentRuntimeEnv {
  readonly runtime: PactAgentRuntime;
  readonly close: () => void;
}

export interface PactAgentRuntimeWiring {
  readonly relay: NostrRelayAdapter;
  readonly cashu: CashuTestMintPort;
  readonly privateStore: CashuPrivateStore;
  readonly identities: PactAgentParticipantIdentities;
  readonly dependencies: PactAgentWorkflowDependencies;
  readonly close: () => void;
}

export type PactAgentRuntimeWiringFactory = (
  config: PactAgentLiveDemoConfig,
  decisionModel: RequesterDecisionModel,
) => PactAgentRuntimeWiring;

export interface LiveRequesterDecision {
  readonly source: "deterministic" | "model";
  readonly model: RequesterDecisionModel;
}

export function createLiveRequesterDecisionFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetchImplementation: typeof fetch = fetch,
): LiveRequesterDecision {
  const configuration = readRequesterDecisionModeConfiguration(environment);
  if (configuration.mode === "deterministic") {
    return Object.freeze({
      source: "deterministic",
      model: createLiveDemoApprovalDecisionModel(),
    });
  }
  return Object.freeze({
    source: "model",
    model: createModelBackedRequesterDecisionModel(
      createOpenAIRequesterRecommendationTransport({
        apiKey: configuration.apiKey,
        modelName: configuration.modelName,
        fetchImplementation,
      }),
    ),
  });
}

export async function publishRuntimeRequesterDefinition(
  config: PactAgentLiveDemoConfig,
  escrowDescriptorAddress: string,
  now: number,
  relay: NostrRelayAdapter,
): Promise<SignedNostrEvent> {
  const requesterDefinition = createLiveDemoRequesterDefinition(
    config,
    escrowDescriptorAddress,
    now,
  );
  return signAndPublishAgentDefinition(
    requesterDefinition,
    createLocalNostrSigner(config.requesterPrivateKeyHex),
    relay,
  );
}

export async function publishRuntimeBootstrapArtifacts(
  config: PactAgentLiveDemoConfig,
  relay: NostrRelayAdapter,
  now: number,
): Promise<Readonly<{
  references: PactAgreementReferences;
  selectedReferences: SelectedProviderReferences;
}>> {
  const providerSigner = createLocalNostrSigner(config.providerPrivateKeyHex);
  const providerIdentity = createNostrIdentity(providerSigner.publicKey, [config.relayUrl]);
  const descriptor = createCashuEscrowDescriptor({
    identity: providerIdentity,
    identifier: "live-cashu-escrow",
    referenceFormat: "opaque_service_reference",
    timeoutSeconds: 15 * 60,
    updatedAt: now,
  });
  const descriptorEvent = await signAndPublishCashuEscrowDescriptor(
    descriptor,
    providerSigner,
    relay,
  );
  const offer = createPactServiceOffer({
    identity: providerIdentity,
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
    identity: providerIdentity,
    identifier: "live-provider",
    name: "Live Provider",
    about: "Live demonstration provider",
    capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
    pricingPolicyReference: offer.address,
    escrowDescriptorReference: descriptor.address,
    updatedAt: now,
  });
  const providerDefinitionEvent = await signAndPublishAgentDefinition(
    providerDefinition,
    providerSigner,
    relay,
  );
  const requesterDefinitionEvent = await publishRuntimeRequesterDefinition(
    config,
    descriptor.address,
    now,
    relay,
  );
  return Object.freeze({
    references: {
      requesterDefinition: requesterDefinitionEvent,
      providerDefinition: providerDefinitionEvent,
      escrowDescriptor: descriptorEvent,
    },
    selectedReferences: {
      providerPublicKey: providerSigner.publicKey as NostrPublicKey,
      providerDefinitionReference: providerDefinition.address,
      offerReference: offer.address,
      escrowDescriptorReference: descriptor.address,
    },
  });
}

function wireDependencies(
  config: PactAgentLiveDemoConfig,
  decisionModel: RequesterDecisionModel,
): PactAgentRuntimeWiring {
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
  const privateStore = createSqliteCashuPrivateStore(join(stateDirectory, "cashu-private.sqlite"));
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
    privateStore,
  });

  const privateDelivery = createCashuPrivateValueDelivery({
    configuration: {
      testMintUrl: config.testMintUrl,
      unit: "sat",
      maximumExposureSats: sats(400n),
    },
    privateStore,
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
    relay,
    cashu,
    privateStore,
    identities,
    dependencies,
    close() {
      settlementStore.close();
      privateStore.close();
    },
  };
}

async function disconnectRelayBounded(
  relay: NostrRelayAdapter,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      relay.disconnect().catch(() => undefined),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, timeoutMilliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function createPactAgentRuntimeFromEnv(
  wiringFactory: PactAgentRuntimeWiringFactory = wireDependencies,
): Promise<PactAgentRuntimeEnv> {
  let config: PactAgentLiveDemoConfig;
  let requesterDecision: LiveRequesterDecision;
  try {
    config = assertLiveDemoConfig(readLiveDemoConfigFromEnv());
    requesterDecision = createLiveRequesterDecisionFromEnv();
  } catch (error) {
    throw new PactAgentRuntimeError(
      "invalid_configuration",
      error instanceof Error ? error.message : "Live runtime configuration is missing",
    );
  }
  const wired = wiringFactory(config, requesterDecision.model);

  try {
    await wired.relay.connect();

    const now = Math.floor(Date.now() / 1000);
    const { references, selectedReferences } = await publishRuntimeBootstrapArtifacts(
      config,
      wired.relay,
      now,
    );

    // Enforce exactly one configured mint with a literal "sat" unit.
    const capabilities = await wired.cashu.inspectCapabilities();
    if (capabilities.unit !== "sat") {
      throw new Error("Configured mint does not use sat");
    }

    const funding = await importLiveDemoFunding(config, wired.cashu);
    await wired.privateStore.write("funding-reference", config.fundingReference, {
      version: 1,
      source: "configured-live-import",
    });
    const runtimeConfig: PactAgentRuntimeConfig = {
      identities: wired.identities,
      dependencies: wired.dependencies,
      privateStore: wired.privateStore,
      references,
      selectedReferences,
      requesterDecisionSource: requesterDecision.source,
      resolveFunding: async (reference) => {
        const lookupReference =
          reference === "legacy-configured-funding" ? config.fundingReference : reference;
        const authorization = await wired.privateStore.read("funding-reference", lookupReference);
        if (
          (reference !== config.fundingReference && reference !== "legacy-configured-funding") ||
          typeof authorization !== "object" ||
          authorization === null ||
          (authorization as { source?: unknown }).source !== "configured-live-import"
        ) {
          throw new PactAgentRuntimeError("invalid_request", "Funding reference was not found");
        }
        return funding;
      },
    };

    const runtime = createPactAgentRuntime(runtimeConfig);
    await runtime.start();
    return { runtime, close: wired.close };
  } catch (error) {
    await disconnectRelayBounded(wired.relay);
    try {
      wired.close();
    } catch {
      // Preserve the original initialization failure after best-effort cleanup.
    }
    throw error;
  }
}
