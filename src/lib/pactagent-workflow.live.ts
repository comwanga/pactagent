import { getDecodedToken } from "@cashu/cashu-ts";

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
import { createPublicKeyOnlySigner, createPublicKeyOnlyEncrypter } from "./public-key-only-identity";
import {
  createCashuPrivateFundingSource,
  createPrivateCashuProofImport,
  type CashuTestMintPort,
} from "./cashu-test-mint";
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
import { parseEconomicMode, type EconomicMode } from "./economic-environment";
import {
  createEconomicEnvironmentFromConfig,
  type DemoEconomicEnvironmentConfig,
  type EconomicEnvironment,
  type LiveEconomicEnvironmentConfig,
} from "./economic-environment";
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

/*
 * Mode-specific economic configuration (Issue #36, Blocker 1).
 *
 * The economic configuration is parsed by mode: demo composition reads ONLY
 * `PACTAGENT_DEMO_*` economic variables, and live composition reads ONLY
 * `PACTAGENT_LIVE_*` economic variables plus `PACTAGENT_CASHU_TEST_MINT_URL`.
 * Demo never reads `PACTAGENT_CASHU_TEST_MINT_URL`, `PACTAGENT_LIVE_FUNDING_TOKEN`,
 * `PACTAGENT_LIVE_FUNDING_REFERENCE`, `PACTAGENT_LIVE_STATE_DIRECTORY`, or the
 * live spend keys. Live never implicitly consumes demo economic inputs. The
 * non-economic Nostr identity/relay variables are shared infrastructure and are
 * not economic inputs. There is no fallback, no URL-based mode inference, and
 * no "try live if demo fails" / "try demo if live fails".
 */

/**
 * Read live economic configuration exclusively from live economic environment
 * variables. Returns `undefined` if any required live economic variable is
 * missing — never falls back to demo variables.
 */
export function readLiveEconomicConfigFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LiveEconomicEnvironmentConfig | undefined {
  const mintUrl = environment.PACTAGENT_CASHU_TEST_MINT_URL;
  const stateDirectory = environment.PACTAGENT_LIVE_STATE_DIRECTORY;
  const normalSpendKeyHex = environment.PACTAGENT_LIVE_NORMAL_SPEND_KEY;
  const refundSpendKeyHex = environment.PACTAGENT_LIVE_REFUND_SPEND_KEY;
  const fundingToken = environment.PACTAGENT_LIVE_FUNDING_TOKEN;
  const fundingReference = environment.PACTAGENT_LIVE_FUNDING_REFERENCE;
  if (
    !mintUrl ||
    !stateDirectory ||
    !normalSpendKeyHex ||
    !refundSpendKeyHex ||
    !fundingToken ||
    !fundingReference
  ) {
    return undefined;
  }
  return Object.freeze({
    mintUrl,
    stateDirectory,
    normalSpendKeyHex,
    refundSpendKeyHex,
    fundingToken,
    fundingReference,
  });
}

/**
 * Read demo economic configuration exclusively from demo economic environment
 * variables. Returns `undefined` if any required demo economic variable is
 * missing — never falls back to live variables. Demo sats have NO monetary
 * value.
 */
export function readDemoEconomicConfigFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DemoEconomicEnvironmentConfig | undefined {
  const mintUrl = environment.PACTAGENT_DEMO_CASHU_MINT_URL;
  const stateDirectory = environment.PACTAGENT_DEMO_STATE_DIRECTORY;
  const normalSpendKeyHex = environment.PACTAGENT_DEMO_NORMAL_SPEND_KEY;
  const refundSpendKeyHex = environment.PACTAGENT_DEMO_REFUND_SPEND_KEY;
  const fundingReference = environment.PACTAGENT_DEMO_FUNDING_REFERENCE;
  if (!mintUrl || !stateDirectory || !normalSpendKeyHex || !refundSpendKeyHex || !fundingReference) {
    return undefined;
  }
  const initialBalanceSatsRaw = environment.PACTAGENT_DEMO_WALLET_INITIAL_BALANCE_SATS;
  const initialBalanceSats = initialBalanceSatsRaw ? Number(initialBalanceSatsRaw) : undefined;
  // Issue #39: explicit private-network demo mint hosts (Railway). DNS names
  // only; invalid entries fail closed inside the transport normalizer.
  const allowedPrivateHostsRaw = environment.PACTAGENT_DEMO_MINT_PRIVATE_HOSTS?.trim();
  const allowedPrivateHosts = allowedPrivateHostsRaw
    ? allowedPrivateHostsRaw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : undefined;
  return Object.freeze({
    mintUrl,
    stateDirectory,
    normalSpendKeyHex,
    refundSpendKeyHex,
    fundingReference,
    ...(initialBalanceSats === undefined ? {} : { initialBalanceSats }),
    ...(allowedPrivateHosts === undefined || allowedPrivateHosts.length === 0
      ? {}
      : { allowedPrivateHosts: Object.freeze(allowedPrivateHosts) }),
  });
}

export interface PactAgentLiveDemoConfig {
  readonly economicMode: EconomicMode;
  readonly relayUrl: string;
  readonly requesterPrivateKeyHex: string;
  readonly providerPrivateKeyHex: string;
  readonly escrowAuthorityPrivateKeyHex: string;
  /**
   * Mode-specific economic configuration constructed exclusively from the
   * economic variables of the selected mode. `LiveEconomicEnvironmentConfig`
   * for live, `DemoEconomicEnvironmentConfig` for demo.
   */
  readonly economicConfig: LiveEconomicEnvironmentConfig | DemoEconomicEnvironmentConfig;
}

/**
 * F38-01: Runtime deployment mode. Closed set — no silent fallback.
 *
 * "local":  the runtime owns the provider private key and publishes
 *           provider-owned P002 artifacts inline. Used for local
 *           development only.
 *
 * "hosted": the runtime does NOT possess the provider private key.
 *           The standalone provider service owns provider authority.
 *           The runtime uses externalProvider=true and discovers
 *           the provider through the relay. FAIL CLOSED if required
 *           hosted configuration is missing.
 */
export type RuntimeDeploymentMode = "local" | "hosted";

export interface PactAgentHostedRuntimeConfig {
  readonly economicMode: EconomicMode;
  readonly relayUrl: string;
  readonly requesterPrivateKeyHex: string;
  readonly providerPublicKeyHex: string;
  readonly escrowAuthorityPrivateKeyHex: string;
  readonly externalProvider: true;
  readonly economicConfig: LiveEconomicEnvironmentConfig | DemoEconomicEnvironmentConfig;
}

export type PactAgentRuntimeConfig = PactAgentLiveDemoConfig | PactAgentHostedRuntimeConfig;

/**
 * Read the combined runtime configuration. Mode selection is explicit via
 * `PACTAGENT_ECONOMIC_MODE`. The non-economic Nostr identity/relay variables
 * are shared. The economic configuration is dispatched to the mode-specific
 * reader so demo and live cannot consume each other's economic values.
 *
 * F38-01: Runtime deployment mode (PACTAGENT_RUNTIME_MODE) selects between
 * "local" (inline provider) and "hosted" (external provider). In hosted
 * mode, the runtime does NOT load PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY —
 * it requires PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY instead. Missing hosted
 * configuration FAILS CLOSED — no silent fallback to local.
 */
export function readLiveDemoConfigFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PactAgentRuntimeConfig | undefined {
  const economicModeRaw = environment.PACTAGENT_ECONOMIC_MODE;
  const relayUrl = environment.PACTAGENT_LIVE_RELAY_URL;
  const requesterPrivateKeyHex = environment.PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY;
  const escrowAuthorityPrivateKeyHex = environment.PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY;

  if (
    !economicModeRaw ||
    !relayUrl ||
    !requesterPrivateKeyHex ||
    !escrowAuthorityPrivateKeyHex
  ) {
    return undefined;
  }

  const economicMode = parseEconomicMode(economicModeRaw);
  const economicConfig =
    economicMode === "demo"
      ? readDemoEconomicConfigFromEnv(environment)
      : readLiveEconomicConfigFromEnv(environment);
  if (!economicConfig) return undefined;

  // F38-06A: Parse runtime deployment mode as a closed set.
  // Missing mode FAILS CLOSED — no silent default to local.
  const runtimeModeRaw = environment.PACTAGENT_RUNTIME_MODE?.trim();
  let runtimeMode: RuntimeDeploymentMode;
  if (runtimeModeRaw === undefined || runtimeModeRaw === "") {
    throw new Error(
      "PACTAGENT_RUNTIME_MODE is required. Set it to \"local\" or \"hosted\". " +
        "Missing mode does NOT default to local — fail closed.",
    );
  } else if (runtimeModeRaw === "local" || runtimeModeRaw === "hosted") {
    runtimeMode = runtimeModeRaw;
  } else {
    throw new Error(
      `PACTAGENT_RUNTIME_MODE must be "local" or "hosted" (got: "${runtimeModeRaw}")`,
    );
  }

  if (runtimeMode === "hosted") {
    // F38-01: Hosted mode — externalProvider=true, NO provider private key.
    const providerPublicKeyHex = environment.PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY?.trim();
    if (!providerPublicKeyHex) {
      throw new Error(
        "Hosted runtime mode requires PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY. " +
          "The runtime must NOT possess the provider private key in hosted mode. " +
          "Missing configuration causes a clean error — never a fallback to inline provider.",
      );
    }
    return Object.freeze({
      economicMode,
      relayUrl,
      requesterPrivateKeyHex,
      providerPublicKeyHex,
      escrowAuthorityPrivateKeyHex,
      externalProvider: true as const,
      economicConfig,
    });
  }

  // Local mode: runtime owns the provider private key (inline provider).
  const providerPrivateKeyHex = environment.PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY;
  if (!providerPrivateKeyHex) {
    return undefined;
  }

  return Object.freeze({
    economicMode,
    relayUrl,
    requesterPrivateKeyHex,
    providerPrivateKeyHex,
    escrowAuthorityPrivateKeyHex,
    economicConfig,
  });
}

export function assertLiveDemoConfig(config: PactAgentRuntimeConfig | undefined): PactAgentRuntimeConfig {
  if (!config) {
    throw new Error(
      "Live demonstration requires explicit configuration. Set PACTAGENT_ECONOMIC_MODE, " +
        "PACTAGENT_LIVE_RELAY_URL, PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY, " +
        "PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY, " +
        "and the mode-specific economic variables: for live, PACTAGENT_CASHU_TEST_MINT_URL, " +
        "PACTAGENT_LIVE_NORMAL_SPEND_KEY, PACTAGENT_LIVE_REFUND_SPEND_KEY, " +
        "PACTAGENT_LIVE_FUNDING_TOKEN, PACTAGENT_LIVE_FUNDING_REFERENCE, and " +
        "PACTAGENT_LIVE_STATE_DIRECTORY; for demo, PACTAGENT_DEMO_CASHU_MINT_URL, " +
        "PACTAGENT_DEMO_STATE_DIRECTORY, PACTAGENT_DEMO_NORMAL_SPEND_KEY, " +
        "PACTAGENT_DEMO_REFUND_SPEND_KEY, and PACTAGENT_DEMO_FUNDING_REFERENCE. " +
        "For hosted mode, also set PACTAGENT_RUNTIME_MODE=hosted and " +
        "PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY. " +
        "Missing configuration causes a clean skip — never a fallback to production.",
    );
  }
  return config;
}

export interface LiveDemoWorkflow {
  readonly workflow: PactAgentWorkflow;
  readonly relay: WebSocketNostrRelayAdapter;
  readonly economicEnvironment: EconomicEnvironment;
  readonly close: () => void;
}

export async function createLiveDemoWorkflow(
  config: PactAgentRuntimeConfig,
  decisionModel: RequesterDecisionModel,
): Promise<LiveDemoWorkflow> {
  const relay = new WebSocketNostrRelayAdapter(config.relayUrl, {
    connectTimeoutMs: 10_000,
    defaultTimeoutMs: 15_000,
  });

  // F38-01: In hosted mode, use public-key-only stubs for the provider.
  // The runtime does NOT possess the provider private key.
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
    workflow: createPactAgentWorkflow({ identities, dependencies }),
    relay,
    economicEnvironment,
    close() {
      economicEnvironment.close();
    },
  };
}

export interface RunLiveDemoTransactionInput {
  readonly privateDocument: string;
  readonly mediaType: "text/plain" | "application/pdf";
  readonly privatePrompt?: string;
  readonly maximumBudgetSats: Sats;
}

function liveProviderIdentity(config: PactAgentRuntimeConfig) {
  const isHosted = "externalProvider" in config && config.externalProvider === true;
  if (isHosted) {
    // F38-01: In hosted mode, use the provider's public key only.
    return createNostrIdentity(
      (config as PactAgentHostedRuntimeConfig).providerPublicKeyHex,
      [config.relayUrl],
    );
  }
  const providerSigner = createLocalNostrSigner((config as PactAgentLiveDemoConfig).providerPrivateKeyHex);
  return createNostrIdentity(providerSigner.publicKey, [config.relayUrl]);
}

export async function publishLiveDemoProviderArtifacts(
  config: PactAgentRuntimeConfig,
  relay: WebSocketNostrRelayAdapter,
  now: number,
): Promise<{
  providerDefinitionReference: string;
  offerReference: string;
  escrowDescriptorReference: string;
}> {
  // F38-01: In hosted mode, the provider artifacts are published by the
  // standalone provider service, NOT by the runtime. The runtime must NOT
  // possess the provider private key and must NOT publish provider-owned
  // P002 artifacts.
  const isHosted = "externalProvider" in config && config.externalProvider === true;
  if (isHosted) {
    throw new Error(
      "Hosted runtime mode must NOT publish provider-owned P002 artifacts. " +
        "The standalone provider service owns provider artifact publication. " +
        "The runtime discovers provider artifacts through the relay.",
    );
  }

  const localConfig = config as PactAgentLiveDemoConfig;
  const providerSigner = createLocalNostrSigner(localConfig.providerPrivateKeyHex);
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
  config: PactAgentRuntimeConfig,
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

/**
 * @internal Legacy test-only funding import helper.
 *
 * Production composition must use {@link createEconomicEnvironmentFromConfig}
 * or {@link createLiveEconomicEnvironment} from `./economic-environment.ts`
 * instead. This function is retained solely for the token-redaction privacy
 * test in `pactagent-workflow.live.test.ts` and must not be called by any
 * production path. The production composition test in
 * `economic-environment.test.ts` verifies that `pactagent-runtime.live.ts`
 * does not import or call this function.
 */
export async function importLiveDemoFunding(
  config: PactAgentRuntimeConfig,
  cashu: CashuTestMintPort,
): Promise<import("./cashu-test-mint").PrivateCashuFunding> {
  try {
    const economicConfig = config.economicConfig as LiveEconomicEnvironmentConfig;
    const capabilities = await cashu.inspectCapabilities();
    const decoded = getDecodedToken(economicConfig.fundingToken, capabilities.acceptedKeysetIds);
    if (decoded.unit !== undefined && decoded.unit !== "sat") {
      throw new Error("invalid token unit");
    }

    const source = createCashuPrivateFundingSource({
      configuration: {
        testMintUrl: economicConfig.mintUrl,
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
  config: PactAgentRuntimeConfig,
  input: RunLiveDemoTransactionInput,
): Promise<PactAgentWorkflowReport> {
  const { workflow, relay, economicEnvironment, close } = await createLiveDemoWorkflow(
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
    const funding = await economicEnvironment.resolveFunding(config.economicConfig.fundingReference);

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
