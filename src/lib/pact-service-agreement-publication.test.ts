import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  nostrPublicKey,
  type NostrIdentity,
  type NostrSigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "../domain/nostr";
import { sats } from "../domain/money";
import { createPontmoreAgentDefinition } from "../domain/pontmore-agent";
import { createCashuEscrowDescriptor } from "../domain/pontmore-escrow";
import {
  createPactServiceOffer,
  PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
} from "../domain/pact-service-offer";
import {
  DOCUMENT_SUMMARY_PROFILE_ID,
  PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND,
  PactPrivateCommitmentSalt,
  createPactAgreementTransition,
  createPactEscrowAuthorityBinding,
  createPactEscrowAuthoritySource,
  createPactServiceAgreementRoot,
  createPactTermsCommitment,
  type PactAgreementContext,
  type PactAgreementReferences,
  type PactAgreementTransition,
} from "../domain/pact-service-agreement";
import type {
  NostrFilter,
  NostrRelayAdapter,
} from "./nostr-relay";
import { createLocalNostrSigner } from "./nostr-signer";
import { discoverProviders, type DiscoverySelection } from "./provider-discovery";
import {
  createPactServiceAgreementRootFromDiscovery,
  retrieveAndReconstructPactAgreement,
  retrievePactAgreementTransitions,
  retrievePactServiceAgreementRoot,
  signAndPublishPactAgreementTransition,
  signAndPublishPactServiceAgreementRoot,
  signPactAgreementTransition,
  signPactServiceAgreementRoot,
} from "./pact-service-agreement-publication";

const CREATED_AT = 1_800_100_000;
const AGREEMENT_ID = "87654321-4321-4321-8321-cba987654321";

function syntheticKey(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

function hexKey(secretKey: Uint8Array): string {
  return Array.from(secretKey, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function syntheticIdentity(secretKey: Uint8Array): NostrIdentity {
  return {
    publicKey: nostrPublicKey(getPublicKey(secretKey)),
    relays: ["wss://relay.example"],
  };
}

function signDirect(event: UnsignedNostrEvent, secretKey: Uint8Array): SignedNostrEvent {
  return finalizeEvent(
    { ...event, tags: event.tags.map((tag) => [...tag]) },
    secretKey,
  ) as unknown as SignedNostrEvent;
}

class RecordingSigner implements NostrSigner {
  calls = 0;
  readonly publicKey;

  constructor(private readonly secretKey: Uint8Array) {
    this.publicKey = syntheticIdentity(secretKey).publicKey;
  }

  async sign(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
    this.calls += 1;
    return signDirect(event, this.secretKey);
  }
}

function filterMatches(event: SignedNostrEvent, filter: NostrFilter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  if (filter.tags) {
    for (const [name, values] of Object.entries(filter.tags)) {
      if (!event.tags.some((tag) => tag[0] === name && values.includes(tag[1]))) return false;
    }
  }
  return true;
}

class MemoryRelay implements NostrRelayAdapter {
  readonly url = "wss://relay.example";
  readonly events: SignedNostrEvent[] = [];
  lastFilter: NostrFilter | undefined;

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async publish(event: SignedNostrEvent): Promise<void> {
    this.events.push(event);
  }

  async queryEvents(
    filter: NostrFilter,
  ): Promise<SignedNostrEvent[]> {
    this.lastFilter = filter;
    return this.events.filter((event) => filterMatches(event, filter)).reverse();
  }
}

function createFixture() {
  const requesterKey = syntheticKey(11);
  const providerKey = syntheticKey(12);
  const escrowKey = syntheticKey(13);
  const requester = syntheticIdentity(requesterKey);
  const provider = syntheticIdentity(providerKey);
  const escrowAuthority = syntheticIdentity(escrowKey);
  const descriptor = createCashuEscrowDescriptor({
    identity: provider,
    identifier: "cashu-summary",
    updatedAt: CREATED_AT - 3,
    referenceFormat: "opaque_service_reference",
  });
  const requesterDefinition = createPontmoreAgentDefinition({
    identity: requester,
    identifier: "requester",
    name: "Requester",
    about: "Requests document summaries.",
    capabilities: { names: ["service-discovery"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/requester@1",
    escrowDescriptorReference: descriptor.address,
    updatedAt: CREATED_AT - 2,
  });
  const providerDefinition = createPontmoreAgentDefinition({
    identity: provider,
    identifier: "provider",
    name: "Provider",
    about: "Provides document summaries.",
    capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/provider@1",
    escrowDescriptorReference: descriptor.address,
    updatedAt: CREATED_AT - 1,
  });
  const references: PactAgreementReferences = {
    requesterDefinition: signDirect(requesterDefinition.event, requesterKey),
    providerDefinition: signDirect(providerDefinition.event, providerKey),
    escrowDescriptor: signDirect(descriptor.event, providerKey),
  };
  const commitment = createPactTermsCommitment(
    DOCUMENT_SUMMARY_PROFILE_ID,
    {
      source_document: "PRIVATE-RELAY-DOCUMENT",
      input_media_type: "text/plain",
      private_prompt: "PRIVATE-RELAY-PROMPT",
    },
    new PactPrivateCommitmentSalt(new Uint8Array(32).fill(21)),
  );
  const root = createPactServiceAgreementRoot({
    agreementId: AGREEMENT_ID,
    references,
    amountSats: "350",
    maximumExecutionSeconds: 300,
    expiresAt: CREATED_AT + 600,
    termsCommitment: commitment,
    createdAt: CREATED_AT,
  });
  return {
    requesterKey,
    providerKey,
    escrowKey,
    requester,
    provider,
    escrowAuthority,
    references,
    root,
  };
}

async function createDiscoverySelectionFixture(): Promise<{
  readonly selection: DiscoverySelection;
  readonly requesterDefinition: SignedNostrEvent;
  readonly requesterKey: Uint8Array;
  readonly relay: MemoryRelay;
}> {
  const requesterKey = syntheticKey(31);
  const providerKey = syntheticKey(32);
  const requester = syntheticIdentity(requesterKey);
  const provider = syntheticIdentity(providerKey);
  const relay = new MemoryRelay();
  const descriptor = createCashuEscrowDescriptor({
    identity: provider,
    identifier: "discovered-cashu-summary",
    updatedAt: CREATED_AT - 10,
    referenceFormat: "opaque_service_reference",
    timeoutSeconds: 300,
  });
  const offer = createPactServiceOffer({
    identity: provider,
    identifier: "discovered-document-summary",
    capabilityProfile: {
      id: PACTAGENT_DOCUMENT_SUMMARY_CAPABILITY_ID,
      version: 1,
    },
    amountSats: sats(350n),
    settlementNetwork: "cashu",
    escrowDescriptorReference: descriptor.address,
    maximumExecutionSeconds: 120,
    validFrom: CREATED_AT - 10,
    expiresAt: CREATED_AT + 300,
    updatedAt: CREATED_AT - 10,
  });
  const requesterDefinition = createPontmoreAgentDefinition({
    identity: requester,
    identifier: "discovery-requester",
    name: "Discovery requester",
    about: "Requests document summaries.",
    capabilities: { names: ["service-discovery"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/requester@1",
    escrowDescriptorReference: descriptor.address,
    updatedAt: CREATED_AT - 9,
  });
  const providerDefinition = createPontmoreAgentDefinition({
    identity: provider,
    identifier: "discovery-provider",
    name: "Discovery provider",
    about: "Provides document summaries.",
    capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
    pricingPolicyReference: offer.address,
    escrowDescriptorReference: descriptor.address,
    updatedAt: CREATED_AT - 9,
  });

  await relay.publish(signDirect(descriptor.event, providerKey));
  await relay.publish(signDirect(offer.event, providerKey));
  await relay.publish(signDirect(providerDefinition.event, providerKey));
  const discovery = await discoverProviders({
    requesterPolicy: {
      maxBudgetSats: sats(500n),
      allowedCapabilities: ["document-summary"],
      maximumEscrowDurationSeconds: 300,
      maximumProviderPriceSats: sats(450n),
      allowedSettlementNetworks: ["cashu"],
      autoRelease: "deterministic_checks_only",
    },
    capability: "document-summary",
    relay,
    now: CREATED_AT,
  });
  if (!discovery.selected) throw new Error("expected provider discovery selection");
  return {
    selection: discovery.selected,
    requesterDefinition: signDirect(requesterDefinition.event, requesterKey),
    requesterKey,
    relay,
  };
}

async function publishedContext(
  fixture: ReturnType<typeof createFixture>,
  relay: MemoryRelay,
): Promise<PactAgreementContext> {
  const root = await signAndPublishPactServiceAgreementRoot({
    root: fixture.root,
    references: fixture.references,
    signer: new RecordingSigner(fixture.requesterKey),
    relay,
  });
  const authoritySource = createPactEscrowAuthoritySource({
    root,
    references: fixture.references,
    authority: fixture.escrowAuthority.publicKey,
    createdAt: CREATED_AT + 1,
  });
  return {
    root,
    references: fixture.references,
    escrowAuthority: createPactEscrowAuthorityBinding({
      root,
      references: fixture.references,
      authority: fixture.escrowAuthority.publicKey,
      source: signDirect(authoritySource.event, fixture.providerKey),
    }),
  };
}

describe("PactAgent agreement signer and relay integration", () => {
  it("creates and publishes an agreement proposal from Issue #9 discovery references", async () => {
    const fixture = await createDiscoverySelectionFixture();
    const termsCommitment = createPactTermsCommitment(
      DOCUMENT_SUMMARY_PROFILE_ID,
      {
        source_document: "PRIVATE-DISCOVERY-DOCUMENT",
        input_media_type: "text/plain",
        private_prompt: "PRIVATE-DISCOVERY-PROMPT",
      },
      new PactPrivateCommitmentSalt(new Uint8Array(32).fill(41)),
    );
    const draft = createPactServiceAgreementRootFromDiscovery({
      requesterDefinition: fixture.requesterDefinition,
      selection: fixture.selection,
      agreementId: AGREEMENT_ID,
      expiresAt: CREATED_AT + 600,
      termsCommitment,
      createdAt: CREATED_AT,
    });

    expect(draft.root.content).toMatchObject({
      provider: fixture.selection.selected.providerPublicKey,
      provider_definition: fixture.selection.selected.providerDefinitionReference,
      escrow_descriptor: fixture.selection.selected.escrowDescriptorReference,
      amount_sats: "350",
      maximum_execution_seconds: 120,
    });
    expect(draft.references.providerDefinition).toBe(
      fixture.selection.candidate.definition.event,
    );
    expect(draft.references.escrowDescriptor).toBe(
      fixture.selection.candidate.escrowDescriptor.event,
    );

    const signed = await signAndPublishPactServiceAgreementRoot({
      root: draft.root,
      references: draft.references,
      signer: new RecordingSigner(fixture.requesterKey),
      relay: fixture.relay,
    });
    const retrieved = await retrievePactServiceAgreementRoot({
      agreementId: AGREEMENT_ID,
      references: draft.references,
      relay: fixture.relay,
    });
    expect(retrieved).toEqual(signed);
  });

  it("rejects a discovery selection whose stable references were altered", async () => {
    const fixture = await createDiscoverySelectionFixture();
    const termsCommitment = createPactTermsCommitment(
      DOCUMENT_SUMMARY_PROFILE_ID,
      {
        source_document: "PRIVATE-DISCOVERY-DOCUMENT",
        input_media_type: "text/plain",
      },
      new PactPrivateCommitmentSalt(new Uint8Array(32).fill(42)),
    );
    const selection: DiscoverySelection = {
      ...fixture.selection,
      selected: {
        ...fixture.selection.selected,
        offerReference: `${fixture.selection.selected.offerReference}-altered`,
      },
    };

    expect(() =>
      createPactServiceAgreementRootFromDiscovery({
        requesterDefinition: fixture.requesterDefinition,
        selection,
        expiresAt: CREATED_AT + 600,
        termsCommitment,
        createdAt: CREATED_AT,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_reference" }));
  });

  it("rejects a discovery selection after its authenticated offer expires", async () => {
    const fixture = await createDiscoverySelectionFixture();
    const termsCommitment = createPactTermsCommitment(
      DOCUMENT_SUMMARY_PROFILE_ID,
      {
        source_document: "PRIVATE-DISCOVERY-DOCUMENT",
        input_media_type: "text/plain",
      },
      new PactPrivateCommitmentSalt(new Uint8Array(32).fill(43)),
    );

    expect(() =>
      createPactServiceAgreementRootFromDiscovery({
        requesterDefinition: fixture.requesterDefinition,
        selection: fixture.selection,
        expiresAt: CREATED_AT + 900,
        termsCommitment,
        createdAt: CREATED_AT + 301,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_reference" }));
  });

  it("uses isolated requester and provider signers for proposal and acceptance", async () => {
    const fixture = createFixture();
    const relay = new MemoryRelay();
    const requesterSigner = createLocalNostrSigner(hexKey(fixture.requesterKey));
    const providerSigner = createLocalNostrSigner(hexKey(fixture.providerKey));
    const root = await signAndPublishPactServiceAgreementRoot({
      root: fixture.root,
      references: fixture.references,
      signer: requesterSigner,
      relay,
    });
    const authoritySource = createPactEscrowAuthoritySource({
      root,
      references: fixture.references,
      authority: fixture.escrowAuthority.publicKey,
      createdAt: CREATED_AT + 1,
    });
    const context: PactAgreementContext = {
      root,
      references: fixture.references,
      escrowAuthority: createPactEscrowAuthorityBinding({
        root,
        references: fixture.references,
        authority: fixture.escrowAuthority.publicKey,
        source: signDirect(authoritySource.event, fixture.providerKey),
      }),
    };
    const acceptance = createPactAgreementTransition({
      context,
      history: [],
      nextState: "accepted",
      actor: fixture.provider.publicKey,
      actorRole: "provider",
      createdAt: CREATED_AT + 1,
      validationTime: CREATED_AT + 1,
    });
    const signedAcceptance = await signAndPublishPactAgreementTransition({
      context,
      history: [],
      transition: acceptance,
      signer: providerSigner,
      relay,
      validationTime: CREATED_AT + 1,
    });

    expect(root.event.pubkey).toBe(requesterSigner.publicKey);
    expect(signedAcceptance.event.pubkey).toBe(providerSigner.publicKey);
    expect(relay.events).toEqual([root.event, signedAcceptance.event]);
  });

  it("signs, publishes, retrieves, and round-trips the immutable root", async () => {
    const fixture = createFixture();
    const relay = new MemoryRelay();
    const signer = new RecordingSigner(fixture.requesterKey);
    const signed = await signAndPublishPactServiceAgreementRoot({
      root: fixture.root,
      references: fixture.references,
      signer,
      relay,
    });
    const retrieved = await retrievePactServiceAgreementRoot({
      agreementId: AGREEMENT_ID,
      references: fixture.references,
      relay,
    });

    expect(signer.calls).toBe(1);
    expect(relay.events).toEqual([signed.event]);
    expect(retrieved).toEqual(signed);
    expect(relay.lastFilter).toMatchObject({
      kinds: [PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND],
      authors: [fixture.requester.publicKey],
    });
  });

  it("requires separately signed provider acceptance and reconstructs relay events", async () => {
    const fixture = createFixture();
    const relay = new MemoryRelay();
    const context = await publishedContext(fixture, relay);
    expect((await retrieveAndReconstructPactAgreement({ context, relay })).mutuallyAccepted).toBe(
      false,
    );

    const acceptance = createPactAgreementTransition({
      context,
      history: [],
      nextState: "accepted",
      actor: fixture.provider.publicKey,
      actorRole: "provider",
      createdAt: CREATED_AT + 1,
      validationTime: CREATED_AT + 1,
    });
    const signed = await signAndPublishPactAgreementTransition({
      context,
      history: [],
      transition: acceptance,
      signer: new RecordingSigner(fixture.providerKey),
      relay,
      validationTime: CREATED_AT + 1,
    });
    const events = await retrievePactAgreementTransitions({ context, relay });
    const reconstructed = await retrieveAndReconstructPactAgreement({ context, relay });

    expect(signed.event.pubkey).toBe(fixture.provider.publicKey);
    expect(events).toEqual([signed.event]);
    expect(reconstructed).toMatchObject({
      status: "ok",
      currentState: "accepted",
      mutuallyAccepted: true,
    });
  });

  it("rejects an invalid transition before invoking the isolated signer", async () => {
    const fixture = createFixture();
    const relay = new MemoryRelay();
    const context = await publishedContext(fixture, relay);
    const valid = createPactAgreementTransition({
      context,
      history: [],
      nextState: "accepted",
      actor: fixture.provider.publicKey,
      actorRole: "provider",
      createdAt: CREATED_AT + 1,
      validationTime: CREATED_AT + 1,
    });
    const invalidContent = {
      ...valid.content,
      state: "escrow_funded" as const,
    };
    const invalid = {
      event: {
        ...valid.event,
        tags: valid.event.tags.map((tag) =>
          tag[0] === "t" && tag[1] === "accepted"
            ? (["t", "escrow_funded"] as const)
            : tag,
        ),
        content: JSON.stringify(invalidContent),
      },
      content: invalidContent,
    } as PactAgreementTransition;
    const signer = new RecordingSigner(fixture.escrowKey);

    await expect(
      signPactAgreementTransition({
        context,
        history: [],
        transition: invalid,
        signer,
        validationTime: CREATED_AT + 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(signer.calls).toBe(0);
  });

  it("rejects signer identities that do not match authorized actors before signing", async () => {
    const fixture = createFixture();
    const rootSigner = new RecordingSigner(fixture.providerKey);
    await expect(
      signPactServiceAgreementRoot({
        root: fixture.root,
        references: fixture.references,
        signer: rootSigner,
      }),
    ).rejects.toMatchObject({ code: "signer_not_authorized" });
    expect(rootSigner.calls).toBe(0);

    const context = await publishedContext(fixture, new MemoryRelay());
    const acceptance = createPactAgreementTransition({
      context,
      history: [],
      nextState: "accepted",
      actor: fixture.provider.publicKey,
      actorRole: "provider",
      createdAt: CREATED_AT + 1,
      validationTime: CREATED_AT + 1,
    });
    const transitionSigner = new RecordingSigner(fixture.requesterKey);
    await expect(
      signPactAgreementTransition({
        context,
        history: [],
        transition: acceptance,
        signer: transitionSigner,
        validationTime: CREATED_AT + 1,
      }),
    ).rejects.toMatchObject({ code: "signer_not_authorized" });
    expect(transitionSigner.calls).toBe(0);
  });

  it("surfaces exact duplicate relay transitions deterministically", async () => {
    const fixture = createFixture();
    const relay = new MemoryRelay();
    const context = await publishedContext(fixture, relay);
    const acceptance = createPactAgreementTransition({
      context,
      history: [],
      nextState: "accepted",
      actor: fixture.provider.publicKey,
      actorRole: "provider",
      createdAt: CREATED_AT + 1,
      validationTime: CREATED_AT + 1,
    });
    const signed = await signAndPublishPactAgreementTransition({
      context,
      history: [],
      transition: acceptance,
      signer: new RecordingSigner(fixture.providerKey),
      relay,
      validationTime: CREATED_AT + 1,
    });
    relay.events.push(signed.event);

    const reconstructed = await retrieveAndReconstructPactAgreement({ context, relay });
    expect(reconstructed.duplicateEventIds).toEqual([signed.event.id]);
    expect(reconstructed.transitions).toHaveLength(1);
  });

  it("never sends private terms, results, Cashu material, or credentials to relay/log errors", async () => {
    const fixture = createFixture();
    const relay = new MemoryRelay();
    await publishedContext(fixture, relay);
    const publicWire = JSON.stringify(relay.events);
    for (const marker of [
      "PRIVATE-RELAY-DOCUMENT",
      "PRIVATE-RELAY-PROMPT",
      "PRIVATE-RESULT",
      "cashuA-PRIVATE",
      "PRIVATE-PROOF",
      "PRIVATE-CREDENTIAL",
    ]) {
      expect(publicWire).not.toContain(marker);
    }

    const failingRelay: NostrRelayAdapter = {
      url: "wss://relay.example",
      async connect() {},
      async disconnect() {},
      async publish() {
        throw new Error("PRIVATE-CREDENTIAL");
      },
      async queryEvents() {
        throw new Error("PRIVATE-CREDENTIAL");
      },
    };
    let thrown: unknown;
    try {
      await signAndPublishPactServiceAgreementRoot({
        root: fixture.root,
        references: fixture.references,
        signer: new RecordingSigner(fixture.requesterKey),
        relay: failingRelay,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "publication_failure" });
    expect(String(thrown)).not.toContain("PRIVATE-CREDENTIAL");
    expect(JSON.stringify(thrown)).not.toContain("PRIVATE-CREDENTIAL");
  });

  it("does not serialize signer secrets through the root publication API", async () => {
    const fixture = createFixture();
    const signed = await signPactServiceAgreementRoot({
      root: fixture.root,
      references: fixture.references,
      signer: new RecordingSigner(fixture.requesterKey),
    });
    expect(JSON.stringify(signed)).not.toMatch(/privateKey|secretKey|nsec1/i);
  });
});
