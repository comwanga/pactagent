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
import { createLocalNostrSigner } from "./nostr-signer";
import { WebSocketNostrRelayAdapter } from "./nostr-relay";
import { createLocalNostrEncrypter } from "./private-task-transport";
import { createPublicKeyOnlySigner, createPublicKeyOnlyEncrypter } from "./public-key-only-identity";
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
  readLiveDemoConfigFromEnv,
  type PactAgentLiveDemoConfig,
  type PactAgentHostedRuntimeConfig,
  type PactAgentRuntimeConfig as PactAgentRuntimeEnvConfig,
} from "./pactagent-workflow.live";
import {
  type PactAgentParticipantIdentities,
  type PactAgentWorkflowDependencies,
} from "./pactagent-workflow";
import type { RequesterDecisionBounds, RequesterDecisionModel } from "./requester-decision";
import { discoverProviders, type SelectedProviderReferences } from "./provider-discovery";
import type { SignedNostrEvent } from "../domain/nostr";
import type { NostrRelayAdapter } from "./nostr-relay";
import { createModelBackedRequesterDecisionModel } from "./model-requester-decision";
import {
  createOpenAIRequesterRecommendationTransport,
  readRequesterDecisionModeConfiguration,
} from "./openai-requester-decision";
import {
  createEconomicEnvironmentFromConfig,
  EconomicEnvironmentError,
  type EconomicEnvironment,
} from "./economic-environment";

/*
 * Opt-in live PactAgent runtime wiring (Issue #33).
 *
 * Composes the economic environment (Issue #35) with the non-economic runtime
 * resources (relay, identities, policy, decision model) to stand up the
 * long-lived runtime. The economic environment owns all Cashu, private store,
 * settlement store, spending key, and funding resolution resources. The
 * runtime receives composed economic resources through PactAgentWorkflowDependencies
 * and never constructs them directly.
 *
 * Missing configuration produces an explicit configuration error (no fallback).
 * Demo mode fails explicitly because the demo economic implementation does
 * not exist until #36.
 */

export interface PactAgentRuntimeEnv {
  readonly runtime: PactAgentRuntime;
  readonly composition: PactAgentRuntimeComposition;
  readonly close: () => void;
}

export interface PactAgentRuntimeComposition {
  readonly runtimeMode: "local" | "hosted";
  readonly externalProvider: boolean;
  readonly providerPublicKey: NostrPublicKey;
}

export interface PactAgentRuntimeWiring {
  readonly relay: NostrRelayAdapter;
  readonly economicEnvironment: EconomicEnvironment;
  readonly identities: PactAgentParticipantIdentities;
  readonly dependencies: PactAgentWorkflowDependencies;
  readonly close: () => void;
}

export type PactAgentRuntimeWiringFactory = (
  config: PactAgentRuntimeEnvConfig,
  decisionModel: RequesterDecisionModel,
) => Promise<PactAgentRuntimeWiring>;

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
  config: PactAgentRuntimeEnvConfig,
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
  config: PactAgentRuntimeEnvConfig,
  relay: NostrRelayAdapter,
  now: number,
): Promise<Readonly<{
  references: PactAgreementReferences;
  selectedReferences: SelectedProviderReferences;
}>> {
  // F38-01: In hosted mode, the runtime does NOT publish provider-owned
  // P002 artifacts. The standalone provider service publishes them.
  // The runtime discovers them through the relay.
  const isHosted = "externalProvider" in config && config.externalProvider === true;
  if (isHosted) {
    // Discover the provider from the relay instead of publishing.
    const providerPublicKey = (config as PactAgentHostedRuntimeConfig).providerPublicKeyHex as NostrPublicKey;

    // Discover providers through the relay using the actual production
    // discovery path. This proves the provider service has published
    // its artifacts and the runtime can find them.
    const requesterPolicy: RequesterPolicy = {
      maxBudgetSats: sats(500n),
      allowedCapabilities: ["document-summary"],
      maximumEscrowDurationSeconds: 15 * 60,
      maximumProviderPriceSats: sats(450n),
      allowedSettlementNetworks: ["cashu"],
      autoRelease: "deterministic_checks_only",
    };

    const discovery = await discoverProviders({
      requesterPolicy,
      capability: "document-summary",
      relay,
      now,
    });

    if (!discovery.selected) {
      throw new PactAgentRuntimeError(
        "invalid_configuration",
        "Hosted runtime could not discover a provider through the relay. " +
          "Ensure the standalone provider service is running and has published its artifacts.",
      );
    }

    // Verify the discovered provider matches the configured public key.
    if (discovery.selected.selected.providerPublicKey !== providerPublicKey) {
      throw new PactAgentRuntimeError(
        "invalid_configuration",
        "Discovered provider does not match the configured provider public key. " +
          "Ensure PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY matches the running provider service identity.",
      );
    }

    // Retrieve the actual signed events from the relay for the references.
    const providerDefinitionReference = discovery.selected.selected.providerDefinitionReference;
    const offerReference = discovery.selected.selected.offerReference;
    const escrowDescriptorReference = discovery.selected.selected.escrowDescriptorReference;

    // Publish the requester definition (runtime owns requester authority).
    const requesterDefinitionEvent = await publishRuntimeRequesterDefinition(
      config,
      escrowDescriptorReference,
      now,
      relay,
    );

    // Retrieve the provider definition and escrow descriptor events from the relay.
    const { retrieveAgentDefinition } = await import("./pontmore-agent-publication");
    const { retrieveCashuEscrowDescriptor } = await import("./pontmore-escrow-publication");
    const providerDef = await retrieveAgentDefinition(providerDefinitionReference, relay);
    const descriptor = await retrieveCashuEscrowDescriptor(escrowDescriptorReference, relay);

    return Object.freeze({
      references: {
        requesterDefinition: requesterDefinitionEvent,
        providerDefinition: providerDef.event,
        escrowDescriptor: descriptor.event,
      },
      selectedReferences: {
        providerPublicKey,
        providerDefinitionReference,
        offerReference,
        escrowDescriptorReference,
      },
    });
  }

  // Local mode: publish all artifacts inline (existing behavior).
  const localConfig = config as PactAgentLiveDemoConfig;
  const providerSigner = createLocalNostrSigner(localConfig.providerPrivateKeyHex);
  const providerIdentity = createNostrIdentity(providerSigner.publicKey, [localConfig.relayUrl]);
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
    localConfig,
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

async function wireDependencies(
  config: PactAgentRuntimeEnvConfig,
  decisionModel: RequesterDecisionModel,
): Promise<PactAgentRuntimeWiring> {
  const relay = new WebSocketNostrRelayAdapter(config.relayUrl, {
    connectTimeoutMs: 10_000,
    defaultTimeoutMs: 15_000,
  });

  // F38-01: In hosted mode, the runtime does NOT possess the provider
  // private key. Use public-key-only stubs that throw if signing or
  // decryption is attempted. The standalone provider service owns
  // provider signing/encryption authority.
  const isHosted = "externalProvider" in config && config.externalProvider === true;
  const providerPrivateKeyHex = isHosted
    ? undefined
    : (config as PactAgentLiveDemoConfig).providerPrivateKeyHex;
  const providerPublicKeyHex = isHosted
    ? (config as PactAgentHostedRuntimeConfig).providerPublicKeyHex
    : undefined;

  const identities: PactAgentParticipantIdentities = {
    requesterSigner: createLocalNostrSigner(config.requesterPrivateKeyHex),
    providerSigner: isHosted
      ? createPublicKeyOnlySigner(providerPublicKeyHex!)
      : createLocalNostrSigner(providerPrivateKeyHex!),
    escrowAuthoritySigner: createLocalNostrSigner(config.escrowAuthorityPrivateKeyHex),
    requesterEncrypter: createLocalNostrEncrypter(config.requesterPrivateKeyHex),
    providerEncrypter: isHosted
      ? createPublicKeyOnlyEncrypter(providerPublicKeyHex!)
      : createLocalNostrEncrypter(providerPrivateKeyHex!),
  };

  const economicEnvironment = await createEconomicEnvironmentFromConfig(
    config.economicMode,
    config.economicConfig,
  );

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

  const clock = { now: () => Math.floor(Date.now() / 1000) };

  const dependencies: PactAgentWorkflowDependencies = {
    relay,
    clock,
    requesterPolicy,
    decisionModel,
    decisionBounds,
    cashu: economicEnvironment.cashu,
    privateDelivery: economicEnvironment.privateDelivery,
    settlementStore: economicEnvironment.settlementStore,
    mintUrl: economicEnvironment.mintUrl,
    normalSpendKey: economicEnvironment.normalSpendKey,
    refundSpendKey: economicEnvironment.refundSpendKey,
  };

  return {
    relay,
    economicEnvironment,
    identities,
    dependencies,
    close() {
      economicEnvironment.close();
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
  let config: PactAgentRuntimeEnvConfig;
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

  // F38-01: Determine if we are in hosted (externalProvider) mode.
  const isHosted = "externalProvider" in config && config.externalProvider === true;

  let wired: PactAgentRuntimeWiring;
  try {
    wired = await wiringFactory(config, requesterDecision.model);
  } catch (error) {
    if (error instanceof EconomicEnvironmentError) {
      throw new PactAgentRuntimeError(
        "invalid_configuration",
        error.message,
      );
    }
    throw error;
  }

  try {
    await wired.relay.connect();

    const now = Math.floor(Date.now() / 1000);
    const { references, selectedReferences } = await publishRuntimeBootstrapArtifacts(
      config,
      wired.relay,
      now,
    );

    const capabilities = await wired.economicEnvironment.cashu.inspectCapabilities();
    if (capabilities.unit !== "sat") {
      throw new Error("Configured mint does not use sat");
    }

    const runtimeConfig: PactAgentRuntimeConfig = {
      identities: wired.identities,
      dependencies: wired.dependencies,
      privateStore: wired.economicEnvironment.privateStore,
      references,
      selectedReferences,
      // F38-01: externalProvider is an explicit production/runtime configuration
      // property. In hosted mode, it is true. In local mode, it is false.
      // It does NOT rely on a default false value.
      externalProvider: isHosted,
      requesterDecisionSource: requesterDecision.source,
      economicMode: wired.economicEnvironment.mode,
      resolveFunding: wired.economicEnvironment.resolveFunding,
      collectWalletOutputs: wired.economicEnvironment.collectWalletOutputs,
      ...(wired.economicEnvironment.bindDemoTransactionFunding === undefined
        ? {}
        : { bindDemoTransactionFunding: wired.economicEnvironment.bindDemoTransactionFunding }),
      ...(wired.economicEnvironment.finalizeDemoTransaction === undefined
        ? {}
        : { finalizeDemoTransaction: wired.economicEnvironment.finalizeDemoTransaction }),
      ...(wired.economicEnvironment.startDemoWallet === undefined
        ? {}
        : { startDemoWallet: wired.economicEnvironment.startDemoWallet }),
      ...(wired.economicEnvironment.demoWalletExists === undefined
        ? {}
        : { demoWalletExists: wired.economicEnvironment.demoWalletExists }),
      ...(wired.economicEnvironment.resetDemoWallet === undefined
        ? {}
        : { resetDemoWallet: wired.economicEnvironment.resetDemoWallet }),
      ...(wired.economicEnvironment.walletBalance === undefined
        ? {}
        : { walletBalance: wired.economicEnvironment.walletBalance }),
      ...(wired.economicEnvironment.demoWalletStatus === undefined
        ? {}
        : { demoWalletStatus: wired.economicEnvironment.demoWalletStatus }),
    };

    const runtime = createPactAgentRuntime(runtimeConfig);
    await runtime.start();
    return {
      runtime,
      composition: Object.freeze({
        runtimeMode: isHosted ? "hosted" : "local",
        externalProvider: isHosted,
        providerPublicKey: wired.identities.providerSigner.publicKey,
      }),
      close: wired.close,
    };
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
