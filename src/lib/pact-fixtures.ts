import { createNostrIdentity, nostrPublicKey } from "../domain/nostr";
import { btcToSats } from "../domain/money";
import type { ProviderAgent, RequesterAgent, ServiceOffer } from "../domain/pact-agents";
import { createPontmoreAgentDefinition } from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor, createCashuEscrowPlan } from "../domain/pontmore-escrow";
import {
  createPactServiceOffer,
  PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
} from "../domain/pact-service-offer";

const FIXTURE_TIME = 1_788_853_200;
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol"] as const;

export function createPactDemoFixtures() {
  const requesterIdentity = createNostrIdentity("11".repeat(32), RELAYS);
  const providerIdentity = createNostrIdentity("22".repeat(32), RELAYS);
  const escrowDescriptor = createCashuEscrowDescriptor({
    identity: providerIdentity,
    identifier: "cashu-document-summary",
    updatedAt: FIXTURE_TIME,
    referenceFormat: "opaque_service_reference",
  });
  const serviceOffer = createPactServiceOffer({
    identity: providerIdentity,
    identifier: "document-summary-offer",
    capabilityProfile: { id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID, version: 1 },
    amountSats: btcToSats("0.00000350"),
    settlementNetwork: "cashu",
    escrowDescriptorReference: escrowDescriptor.address,
    maximumExecutionSeconds: 120,
    validFrom: FIXTURE_TIME,
    expiresAt: FIXTURE_TIME + 3_600,
    updatedAt: FIXTURE_TIME,
  });
  const requesterDefinition = createPontmoreAgentDefinition({
    identity: requesterIdentity,
    identifier: "agent",
    name: "P001 Requester",
    about: "Discovers and evaluates a bounded document-summary service.",
    capabilities: {
      names: ["service-discovery", "offer-evaluation", "task-verification"],
      settlement_networks: ["cashu"],
    },
    pricingPolicyReference: "pactagent:P001-requester-policy:v1",
    escrowDescriptorReference: escrowDescriptor.address,
    updatedAt: FIXTURE_TIME,
  });
  const providerDefinition = createPontmoreAgentDefinition({
    identity: providerIdentity,
    identifier: "agent",
    name: "P002 Provider",
    about: "Provides the bounded document-summary service.",
    capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
    pricingPolicyReference: serviceOffer.address,
    escrowDescriptorReference: escrowDescriptor.address,
    updatedAt: FIXTURE_TIME,
  });
  const requester: RequesterAgent = {
    id: "P001",
    role: "requester",
    identity: requesterIdentity,
    definition: requesterDefinition,
    policy: {
      maxBudgetSats: btcToSats("0.00000500"),
      allowedCapabilities: ["document-summary"],
      maximumEscrowDurationSeconds: 15 * 60,
      maximumProviderPriceSats: btcToSats("0.00000450"),
      allowedSettlementNetworks: ["cashu"],
      autoRelease: "deterministic_checks_only",
      allowedProviders: [nostrPublicKey(providerIdentity.publicKey)],
    },
  };
  const provider: ProviderAgent = {
    id: "P002",
    role: "provider",
    identity: providerIdentity,
    definition: providerDefinition,
    policy: {
      minimumPriceSats: btcToSats("0.00000200"),
      maximumDocumentBytes: 1_000_000,
      supportedMediaTypes: ["text/plain", "application/pdf"],
      maximumExecutionDurationSeconds: 5 * 60,
      serviceCapabilities: ["document-summary"],
    },
  };
  const offer: ServiceOffer = {
    providerPublicKey: providerIdentity.publicKey,
    capability: "document-summary",
    priceSats: btcToSats("0.00000350"),
    settlementNetwork: "cashu",
    escrowDescriptorReference: escrowDescriptor.address,
    estimatedExecutionSeconds: 120,
  };
  const escrowPlan = createCashuEscrowPlan({
    descriptor: escrowDescriptor,
    amountSats: offer.priceSats,
    timeoutSeconds: requester.policy.maximumEscrowDurationSeconds,
  });
  return { requester, provider, escrowDescriptor, escrowPlan, offer, serviceOffer };
}
