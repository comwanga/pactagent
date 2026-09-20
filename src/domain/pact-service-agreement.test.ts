import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  nostrPublicKey,
  type NostrIdentity,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "./nostr";
import { createPontmoreAgentDefinition } from "./pontmore-agent";
import { createCashuEscrowDescriptor } from "./pontmore-escrow";
import {
  DOCUMENT_SUMMARY_PROFILE_ID,
  PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND,
  PACT_TERMS_COMMITMENT_SCHEME,
  PactPrivateCommitmentSalt,
  createPactAgreementTransition,
  createPactCompletionDecision,
  createPactEscrowAuthorityBinding,
  createPactEscrowAuthoritySource,
  createPactResultReference,
  createPactServiceAgreementRoot,
  createPactTermsCommitment,
  parsePactAgreementTransitionEvent,
  parsePactServiceAgreementRootEvent,
  reconstructPactAgreementHistory,
  validatePactServiceAgreementRoot,
  verifyPactTermsCommitment,
  type PactAgreementContext,
  type PactAgreementReferences,
  type PactAgreementState,
} from "./pact-service-agreement";

const ROOT_TIME = 1_800_000_000;
const EXPIRY = ROOT_TIME + 600;
const AGREEMENT_ID = "12345678-1234-4234-9234-123456789abc";

function key(seed: number): Uint8Array {
  const value = new Uint8Array(32);
  value.fill(seed);
  return value;
}

function identity(secretKey: Uint8Array): NostrIdentity {
  return {
    publicKey: nostrPublicKey(getPublicKey(secretKey)),
    relays: ["wss://relay.example"],
  };
}

function sign(event: UnsignedNostrEvent, secretKey: Uint8Array): SignedNostrEvent {
  return finalizeEvent(
    {
      ...event,
      tags: event.tags.map((tag) => [...tag]),
    },
    secretKey,
  ) as unknown as SignedNostrEvent;
}

function createFixture() {
  const requesterKey = key(1);
  const providerKey = key(2);
  const escrowKey = key(3);
  const requesterIdentity = identity(requesterKey);
  const providerIdentity = identity(providerKey);
  const escrowIdentity = identity(escrowKey);
  const descriptor = createCashuEscrowDescriptor({
    identity: providerIdentity,
    identifier: "document-summary-cashu",
    updatedAt: ROOT_TIME - 10,
    referenceFormat: "opaque_service_reference",
  });
  const requesterDefinition = createPontmoreAgentDefinition({
    identity: requesterIdentity,
    identifier: "p001",
    name: "Requester",
    about: "Requests a summary.",
    capabilities: { names: ["service-discovery"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/requester-policy@1",
    escrowDescriptorReference: descriptor.address,
    updatedAt: ROOT_TIME - 9,
  });
  const providerDefinition = createPontmoreAgentDefinition({
    identity: providerIdentity,
    identifier: "p002",
    name: "Provider",
    about: "Provides document summaries.",
    capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
    pricingPolicyReference: "pactagent/provider-policy@1",
    escrowDescriptorReference: descriptor.address,
    updatedAt: ROOT_TIME - 8,
  });
  const references: PactAgreementReferences = {
    requesterDefinition: sign(requesterDefinition.event, requesterKey),
    providerDefinition: sign(providerDefinition.event, providerKey),
    escrowDescriptor: sign(descriptor.event, providerKey),
  };
  const privateTerms = {
    source_document: "PRIVATE-DOCUMENT-MARKER",
    input_media_type: "text/plain" as const,
    private_prompt: "PRIVATE-PROMPT-MARKER",
  };
  const privateSalt = new PactPrivateCommitmentSalt(new Uint8Array(32).fill(9));
  const commitment = createPactTermsCommitment(
    DOCUMENT_SUMMARY_PROFILE_ID,
    privateTerms,
    privateSalt,
  );
  const draft = createPactServiceAgreementRoot({
    agreementId: AGREEMENT_ID,
    references,
    amountSats: "350",
    maximumExecutionSeconds: 300,
    expiresAt: EXPIRY,
    termsCommitment: commitment,
    createdAt: ROOT_TIME,
  });
  const root = validatePactServiceAgreementRoot(sign(draft.event, requesterKey), references);
  const authoritySourceDraft = createPactEscrowAuthoritySource({
    root,
    references,
    authority: escrowIdentity.publicKey,
    createdAt: ROOT_TIME + 1,
  });
  const authoritySource = sign(authoritySourceDraft.event, providerKey);
  const escrowAuthority = createPactEscrowAuthorityBinding({
    root,
    references,
    authority: escrowIdentity.publicKey,
    source: authoritySource,
  });
  const context: PactAgreementContext = { root, references, escrowAuthority };
  const privateResult = { summary: "PRIVATE-SUMMARY-MARKER" };
  const resultReference = createPactResultReference(
    DOCUMENT_SUMMARY_PROFILE_ID,
    root.event.id,
    privateResult,
  );
  return {
    requesterKey,
    providerKey,
    escrowKey,
    requesterIdentity,
    providerIdentity,
    escrowIdentity,
    references,
    privateTerms,
    privateSalt,
    privateResult,
    resultReference,
    commitment,
    draft,
    root,
    authoritySourceDraft,
    authoritySource,
    context,
  };
}

function appendTransition(
  fixture: ReturnType<typeof createFixture>,
  history: SignedNostrEvent[],
  nextState: PactAgreementState,
  actorRole: "requester" | "provider" | "escrow",
  secretKey: Uint8Array,
  options: { reasonCode?: string; resultReference?: string; createdAt?: number } = {},
): SignedNostrEvent {
  const actor = identity(secretKey).publicKey;
  const createdAt = options.createdAt ?? ROOT_TIME + history.length + 1;
  const draft = createPactAgreementTransition({
    context: fixture.context,
    history,
    predecessorEventId: history.at(-1)?.id ?? null,
    nextState,
    actor,
    actorRole,
    reasonCode: options.reasonCode,
    resultReference: options.resultReference,
    createdAt,
    validationTime: createdAt,
  });
  const event = sign(draft.event, secretKey);
  history.push(event);
  return event;
}

function advanceToSubmitted(
  fixture: ReturnType<typeof createFixture>,
  privateResult: { readonly summary: string } = fixture.privateResult,
): SignedNostrEvent[] {
  const history: SignedNostrEvent[] = [];
  appendTransition(fixture, history, "accepted", "provider", fixture.providerKey);
  appendTransition(fixture, history, "escrow_funded", "escrow", fixture.escrowKey);
  appendTransition(fixture, history, "task_delivered", "provider", fixture.providerKey);
  appendTransition(fixture, history, "result_submitted", "provider", fixture.providerKey, {
    resultReference: createPactResultReference(
      DOCUMENT_SUMMARY_PROFILE_ID,
      fixture.root.event.id,
      privateResult,
    ),
  });
  return history;
}

describe("PactAgent service agreement kernel", () => {
  it("constructs and validates the exact requester-signed root and Pontmore references", () => {
    const fixture = createFixture();

    expect(fixture.root.event.kind).toBe(PACTAGENT_SERVICE_AGREEMENT_EVENT_KIND);
    expect(fixture.root.event.kind).not.toBe(7300);
    expect(fixture.root.event.pubkey).toBe(fixture.requesterIdentity.publicKey);
    expect(fixture.root.content).toEqual({
      version: 1,
      agreement_id: AGREEMENT_ID,
      capability_profile: "document-summary@1",
      requester: fixture.requesterIdentity.publicKey,
      provider: fixture.providerIdentity.publicKey,
      requester_definition: `30360:${fixture.requesterIdentity.publicKey}:p001`,
      provider_definition: `30360:${fixture.providerIdentity.publicKey}:p002`,
      escrow_descriptor: `30361:${fixture.providerIdentity.publicKey}:document-summary-cashu`,
      amount_sats: "350",
      settlement_network: "cashu",
      maximum_execution_seconds: 300,
      expires_at: EXPIRY,
      terms_commitment: fixture.commitment.value,
      terms_commitment_scheme: PACT_TERMS_COMMITMENT_SCHEME,
    });
    expect(validatePactServiceAgreementRoot(fixture.root.event, fixture.references)).toEqual(
      fixture.root,
    );
  });

  it("canonicalizes equivalent private terms with the same salt and randomizes different salts", () => {
    const firstTerms = {
      source_document: "doc",
      input_media_type: "text/plain" as const,
      private_prompt: "summarize",
    };
    const equivalentTerms = {
      private_prompt: "summarize",
      input_media_type: "text/plain" as const,
      source_document: "doc",
    };
    const salt = new PactPrivateCommitmentSalt(new Uint8Array(32).fill(5));
    const first = createPactTermsCommitment(DOCUMENT_SUMMARY_PROFILE_ID, firstTerms, salt);
    const second = createPactTermsCommitment(DOCUMENT_SUMMARY_PROFILE_ID, equivalentTerms, salt);
    const randomized = createPactTermsCommitment(
      DOCUMENT_SUMMARY_PROFILE_ID,
      firstTerms,
      new PactPrivateCommitmentSalt(new Uint8Array(32).fill(6)),
    );

    expect(first.value).toBe(second.value);
    expect(first.value).not.toBe(randomized.value);
    expect(verifyPactTermsCommitment(first, DOCUMENT_SUMMARY_PROFILE_ID, equivalentTerms, salt)).toBe(
      true,
    );
    expect(() => JSON.stringify(salt)).toThrowError(
      expect.objectContaining({ code: "privacy_boundary_violation" }),
    );
    expect(String(salt)).toBe("[private PactAgent commitment salt]");
  });

  it("enforces the defined document-summary media, input-size, output, and timeout constraints", () => {
    expect(() =>
      createPactTermsCommitment(DOCUMENT_SUMMARY_PROFILE_ID, {
        source_document: "document",
        input_media_type: "text/html",
      }),
    ).toThrowError(expect.objectContaining({ code: "privacy_boundary_violation" }));
    expect(() =>
      createPactTermsCommitment(DOCUMENT_SUMMARY_PROFILE_ID, {
        source_document: "x".repeat(1_000_001),
        input_media_type: "text/plain",
      }),
    ).toThrowError(expect.objectContaining({ code: "privacy_boundary_violation" }));

    const fixture = createFixture();
    expect(() =>
      createPactServiceAgreementRoot({
        references: fixture.references,
        amountSats: "350",
        maximumExecutionSeconds: 301,
        expiresAt: EXPIRY,
        termsCommitment: fixture.commitment,
        createdAt: ROOT_TIME,
      }),
    ).toThrowError(expect.objectContaining({ code: "malformed_agreement" }));

    const submitted = advanceToSubmitted(fixture);
    expect(() =>
      createPactCompletionDecision({
        context: fixture.context,
        history: submitted,
        privateTerms: fixture.privateTerms,
        privateSalt: fixture.privateSalt,
        privateResult: { summary: "   " },
      }),
    ).toThrowError(expect.objectContaining({ code: "privacy_boundary_violation" }));

    expect(() =>
      createPactTermsCommitment(DOCUMENT_SUMMARY_PROFILE_ID, {
        source_document: "%PDF-1.7",
        input_media_type: "application/pdf",
      }),
    ).not.toThrow();
  });

  it("requires a valid completion decision for the exact submitted result before release", () => {
    const fixture = createFixture();
    const history = advanceToSubmitted(fixture);

    expect(() =>
      createPactAgreementTransition({
        context: fixture.context,
        history,
        predecessorEventId: history.at(-1)?.id,
        nextState: "result_verified",
        actor: fixture.requesterIdentity.publicKey,
        actorRole: "requester",
        resultReference: fixture.resultReference,
        createdAt: ROOT_TIME + 5,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));

    const decision = createPactCompletionDecision({
      context: fixture.context,
      history,
      privateTerms: fixture.privateTerms,
      privateSalt: fixture.privateSalt,
      privateResult: fixture.privateResult,
    });
    fixture.context = { ...fixture.context, completionDecisions: [decision] };
    const verified = appendTransition(
      fixture,
      history,
      "result_verified",
      "requester",
      fixture.requesterKey,
    );
    expect(verified.content).toContain(fixture.resultReference);
    expect(() =>
      createPactAgreementTransition({
        context: fixture.context,
        history,
        predecessorEventId: verified.id,
        nextState: "release_authorized",
        actor: fixture.requesterIdentity.publicKey,
        actorRole: "requester",
        createdAt: ROOT_TIME + 6,
      }),
    ).not.toThrow();

    expect(() =>
      reconstructPactAgreementHistory(
        { ...fixture.context, completionDecisions: undefined },
        history,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
  });

  it("rejects invalid, stale, and replayed completion decisions", () => {
    const fixture = createFixture();
    const firstHistory = advanceToSubmitted(fixture);
    expect(() =>
      createPactCompletionDecision({
        context: fixture.context,
        history: firstHistory,
        privateTerms: fixture.privateTerms,
        privateSalt: fixture.privateSalt,
        privateResult: { summary: "a different result" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));

    const firstDecision = createPactCompletionDecision({
      context: fixture.context,
      history: firstHistory,
      privateTerms: fixture.privateTerms,
      privateSalt: fixture.privateSalt,
      privateResult: fixture.privateResult,
    });
    fixture.context = { ...fixture.context, completionDecisions: [firstDecision] };
    const verificationDraft = createPactAgreementTransition({
      context: fixture.context,
      history: firstHistory,
      predecessorEventId: firstHistory.at(-1)?.id,
      nextState: "result_verified",
      actor: fixture.requesterIdentity.publicKey,
      actorRole: "requester",
      createdAt: ROOT_TIME + 6,
    });
    const verification = sign(verificationDraft.event, fixture.requesterKey);
    const duplicate = reconstructPactAgreementHistory(fixture.context, [
      ...firstHistory,
      verification,
      verification,
    ]);
    expect(duplicate.duplicateEventIds).toEqual([verification.id]);

    const replayDraft = createPactAgreementTransition({
      context: fixture.context,
      history: firstHistory,
      predecessorEventId: firstHistory.at(-1)?.id,
      nextState: "result_verified",
      actor: fixture.requesterIdentity.publicKey,
      actorRole: "requester",
      createdAt: ROOT_TIME + 7,
    });
    const replay = sign(replayDraft.event, fixture.requesterKey);
    expect(
      reconstructPactAgreementHistory(fixture.context, [
        ...firstHistory,
        replay,
        verification,
      ]).status,
    ).toBe("forked");

    const alternateResult = { summary: "alternate result" };
    const alternateHistory = firstHistory.slice(0, -1);
    appendTransition(
      fixture,
      alternateHistory,
      "result_submitted",
      "provider",
      fixture.providerKey,
      {
        resultReference: createPactResultReference(
          DOCUMENT_SUMMARY_PROFILE_ID,
          fixture.root.event.id,
          alternateResult,
        ),
        createdAt: ROOT_TIME + 20,
      },
    );
    const staleContext = fixture.context;
    expect(() =>
      createPactAgreementTransition({
        context: staleContext,
        history: alternateHistory,
        predecessorEventId: alternateHistory.at(-1)?.id,
        nextState: "result_verified",
        actor: fixture.requesterIdentity.publicKey,
        actorRole: "requester",
        createdAt: ROOT_TIME + 21,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
  });

  it("rejects unsupported profile versions and malformed Pontmore references", () => {
    const fixture = createFixture();
    expect(() =>
      createPactServiceAgreementRoot({
        agreementId: AGREEMENT_ID,
        references: fixture.references,
        amountSats: "350",
        maximumExecutionSeconds: 300,
        expiresAt: EXPIRY,
        termsCommitment: fixture.commitment,
        createdAt: ROOT_TIME,
        capabilityProfile: "document-summary@2" as never,
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_profile_version" }));

    const malformedReferences = {
      ...fixture.references,
      providerDefinition: {
        ...fixture.references.providerDefinition,
        content: `${fixture.references.providerDefinition.content} `,
      },
    };
    expect(() =>
      createPactServiceAgreementRoot({
        references: malformedReferences,
        amountSats: "350",
        maximumExecutionSeconds: 300,
        expiresAt: EXPIRY,
        termsCommitment: fixture.commitment,
        createdAt: ROOT_TIME,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_reference" }));
  });

  it("allows a requester default escrow to differ while rejecting true provider incompatibility", () => {
    const fixture = createFixture();
    const requesterDefinition = createPontmoreAgentDefinition({
      identity: fixture.requesterIdentity,
      identifier: "p001",
      name: "Requester",
      about: "Requests a summary.",
      capabilities: { names: ["service-discovery"], settlement_networks: ["cashu"] },
      pricingPolicyReference: "pactagent/requester-policy@1",
      escrowDescriptorReference: `30361:${fixture.requesterIdentity.publicKey}:requester-default`,
      updatedAt: ROOT_TIME - 9,
    });
    const compatibleReferences = {
      ...fixture.references,
      requesterDefinition: sign(requesterDefinition.event, fixture.requesterKey),
    };
    expect(() =>
      createPactServiceAgreementRoot({
        references: compatibleReferences,
        amountSats: "350",
        maximumExecutionSeconds: 300,
        expiresAt: EXPIRY,
        termsCommitment: fixture.commitment,
        createdAt: ROOT_TIME,
      }),
    ).not.toThrow();

    const providerDefinition = createPontmoreAgentDefinition({
      identity: fixture.providerIdentity,
      identifier: "p002",
      name: "Provider",
      about: "Provides document summaries.",
      capabilities: { names: ["document-summary"], settlement_networks: ["cashu"] },
      pricingPolicyReference: "pactagent/provider-policy@1",
      escrowDescriptorReference: `30361:${fixture.providerIdentity.publicKey}:unselected`,
      updatedAt: ROOT_TIME - 8,
    });
    expect(() =>
      createPactServiceAgreementRoot({
        references: {
          ...fixture.references,
          providerDefinition: sign(providerDefinition.event, fixture.providerKey),
        },
        amountSats: "350",
        maximumExecutionSeconds: 300,
        expiresAt: EXPIRY,
        termsCommitment: fixture.commitment,
        createdAt: ROOT_TIME,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_reference" }));
  });

  it("derives escrow authority only from a valid signed source for the selected configuration", () => {
    const fixture = createFixture();
    expect(fixture.context.escrowAuthority).toMatchObject({
      authority: fixture.escrowIdentity.publicKey,
      sourceReference: fixture.authoritySource.id,
      escrowDescriptor: fixture.root.content.escrow_descriptor,
    });

    expect(() =>
      createPactEscrowAuthorityBinding({
        root: fixture.root,
        references: fixture.references,
        authority: fixture.requesterIdentity.publicKey,
        source: fixture.authoritySource,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_reference" }));

    const forged = {
      ...fixture.authoritySource,
      sig: `${fixture.authoritySource.sig.slice(0, -1)}${fixture.authoritySource.sig.endsWith("0") ? "1" : "0"}`,
    } as SignedNostrEvent;
    expect(() =>
      createPactEscrowAuthorityBinding({
        root: fixture.root,
        references: fixture.references,
        authority: fixture.escrowIdentity.publicKey,
        source: forged,
      }),
    ).toThrow();

    const sourceWith = (
      changes: Partial<Pick<
        (typeof fixture.authoritySourceDraft)["content"],
        "agreement_root" | "escrow_descriptor"
      >>,
      signerKey = fixture.providerKey,
    ) => {
      const content = { ...fixture.authoritySourceDraft.content, ...changes };
      return sign(
        {
          ...fixture.authoritySourceDraft.event,
          tags: fixture.authoritySourceDraft.event.tags.map((tag) => {
            if (tag[0] === "e") return ["e", content.agreement_root] as const;
            if (tag[0] === "a") return ["a", content.escrow_descriptor] as const;
            return tag;
          }),
          content: JSON.stringify(content),
        },
        signerKey,
      );
    };
    const wrongDescriptor = `30361:${fixture.providerIdentity.publicKey}:wrong`;
    for (const source of [
      sourceWith({ escrow_descriptor: wrongDescriptor }),
      sourceWith({ agreement_root: "cd".repeat(32) }),
      sourceWith({}, fixture.requesterKey),
    ]) {
      expect(() =>
        createPactEscrowAuthorityBinding({
          root: fixture.root,
          references: fixture.references,
          authority: fixture.escrowIdentity.publicKey,
          source,
        }),
      ).toThrow();
    }
  });

  it("rejects root tag/content mismatches", () => {
    const fixture = createFixture();
    const mismatched = {
      ...fixture.draft.event,
      tags: fixture.draft.event.tags.map((tag) =>
        tag[0] === "p" && tag[1] === fixture.providerIdentity.publicKey
          ? (["p", fixture.requesterIdentity.publicKey] as const)
          : tag,
      ),
    };
    expect(() => parsePactServiceAgreementRootEvent(mismatched)).toThrowError(
      expect.objectContaining({ code: "tag_content_mismatch" }),
    );
  });

  it("rejects signed PIP-00 references with ambiguous singleton tags", () => {
    const fixture = createFixture();
    const ambiguousProvider = sign(
      {
        ...fixture.references.providerDefinition,
        tags: [...fixture.references.providerDefinition.tags, ["t", "agent"]],
      },
      fixture.providerKey,
    );
    expect(() =>
      createPactServiceAgreementRoot({
        references: { ...fixture.references, providerDefinition: ambiguousProvider },
        amountSats: "350",
        maximumExecutionSeconds: 300,
        expiresAt: EXPIRY,
        termsCommitment: fixture.commitment,
        createdAt: ROOT_TIME,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_reference" }));
  });

  it("does not treat requester publication as mutual acceptance", () => {
    const fixture = createFixture();
    const proposed = reconstructPactAgreementHistory(fixture.context, []);
    expect(proposed).toMatchObject({ status: "ok", currentState: "proposed", mutuallyAccepted: false });

    const history: SignedNostrEvent[] = [];
    appendTransition(fixture, history, "accepted", "provider", fixture.providerKey);
    expect(reconstructPactAgreementHistory(fixture.context, history)).toMatchObject({
      status: "ok",
      currentState: "accepted",
      mutuallyAccepted: true,
    });
  });

  it("reconstructs the full lifecycle from predecessor links in relay-independent order", () => {
    const fixture = createFixture();
    const history: SignedNostrEvent[] = [];
    appendTransition(fixture, history, "accepted", "provider", fixture.providerKey);
    appendTransition(fixture, history, "escrow_funded", "escrow", fixture.escrowKey);
    appendTransition(fixture, history, "task_delivered", "provider", fixture.providerKey);
    appendTransition(fixture, history, "result_submitted", "provider", fixture.providerKey, {
      resultReference: fixture.resultReference,
    });
    const completionDecision = createPactCompletionDecision({
      context: fixture.context,
      history,
      privateTerms: fixture.privateTerms,
      privateSalt: fixture.privateSalt,
      privateResult: fixture.privateResult,
    });
    fixture.context = { ...fixture.context, completionDecisions: [completionDecision] };
    appendTransition(fixture, history, "result_verified", "requester", fixture.requesterKey);
    appendTransition(fixture, history, "release_authorized", "requester", fixture.requesterKey);
    appendTransition(fixture, history, "settled", "escrow", fixture.escrowKey);

    const reconstructed = reconstructPactAgreementHistory(fixture.context, [
      history[5],
      history[1],
      history[6],
      history[0],
      history[4],
      history[2],
      history[3],
    ]);
    expect(reconstructed.status).toBe("ok");
    expect(reconstructed.currentState).toBe("settled");
    expect(reconstructed.transitions.map((transition) => transition.content.state)).toEqual([
      "accepted",
      "escrow_funded",
      "task_delivered",
      "result_submitted",
      "result_verified",
      "release_authorized",
      "settled",
    ]);
  });

  it("enforces the refund and rejected recovery branches", () => {
    const fixture = createFixture();
    const refundHistory: SignedNostrEvent[] = [];
    appendTransition(fixture, refundHistory, "accepted", "provider", fixture.providerKey);
    appendTransition(fixture, refundHistory, "refund_authorized", "requester", fixture.requesterKey, {
      reasonCode: "requester_refund",
    });
    appendTransition(fixture, refundHistory, "refunded", "escrow", fixture.escrowKey);
    expect(reconstructPactAgreementHistory(fixture.context, refundHistory).currentState).toBe("refunded");

    const rejectedHistory: SignedNostrEvent[] = [];
    appendTransition(fixture, rejectedHistory, "accepted", "provider", fixture.providerKey);
    appendTransition(fixture, rejectedHistory, "escrow_funded", "escrow", fixture.escrowKey);
    appendTransition(fixture, rejectedHistory, "task_delivered", "provider", fixture.providerKey);
    appendTransition(fixture, rejectedHistory, "result_submitted", "provider", fixture.providerKey, {
      resultReference: fixture.resultReference,
    });
    appendTransition(fixture, rejectedHistory, "rejected", "requester", fixture.requesterKey, {
      reasonCode: "verification_failed",
    });
    appendTransition(fixture, rejectedHistory, "refund_authorized", "requester", fixture.requesterKey, {
      reasonCode: "verification_failed",
    });
    expect(reconstructPactAgreementHistory(fixture.context, rejectedHistory).currentState).toBe(
      "refund_authorized",
    );
  });

  it("keeps disputed unavailable because no validated dispute authority is configured", () => {
    const fixture = createFixture();
    const history = advanceToSubmitted(fixture);
    appendTransition(fixture, history, "rejected", "requester", fixture.requesterKey, {
      reasonCode: "verification_failed",
    });
    for (const [actor, role] of [
      [fixture.requesterIdentity.publicKey, "requester"],
      [fixture.providerIdentity.publicKey, "provider"],
    ] as const) {
      expect(() =>
        createPactAgreementTransition({
          context: fixture.context,
          history,
          predecessorEventId: history.at(-1)?.id,
          nextState: "disputed",
          actor,
          actorRole: role,
          reasonCode: "result_disputed",
          createdAt: ROOT_TIME + 10,
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
    }
  });

  it("rejects wrong signers, forged roles, invalid transitions, and unbound escrow assertions", () => {
    const fixture = createFixture();
    expect(() =>
      createPactAgreementTransition({
        context: fixture.context,
        history: [],
        nextState: "accepted",
        actor: fixture.requesterIdentity.publicKey,
        actorRole: "provider",
        createdAt: ROOT_TIME + 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "signer_not_authorized" }));
    expect(() =>
      createPactAgreementTransition({
        context: fixture.context,
        history: [],
        nextState: "accepted",
        actor: fixture.providerIdentity.publicKey,
        actorRole: "requester",
        createdAt: ROOT_TIME + 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "signer_not_authorized" }));
    expect(() =>
      createPactAgreementTransition({
        context: fixture.context,
        history: [],
        nextState: "escrow_funded",
        actor: fixture.escrowIdentity.publicKey,
        actorRole: "escrow",
        createdAt: ROOT_TIME + 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));

    const history: SignedNostrEvent[] = [];
    appendTransition(fixture, history, "accepted", "provider", fixture.providerKey);
    const contextWithoutAuthority = { ...fixture.context, escrowAuthority: undefined };
    expect(() =>
      createPactAgreementTransition({
        context: contextWithoutAuthority,
        history,
        predecessorEventId: history[0].id,
        nextState: "escrow_funded",
        actor: fixture.providerIdentity.publicKey,
        actorRole: "escrow",
        createdAt: ROOT_TIME + 2,
      }),
    ).toThrowError(expect.objectContaining({ code: "signer_not_authorized" }));
  });

  it("deduplicates exact events and surfaces a replay as a deterministic fork", () => {
    const fixture = createFixture();
    const firstHistory: SignedNostrEvent[] = [];
    const accepted = appendTransition(
      fixture,
      firstHistory,
      "accepted",
      "provider",
      fixture.providerKey,
    );
    const duplicate = reconstructPactAgreementHistory(fixture.context, [accepted, accepted]);
    expect(duplicate.status).toBe("ok");
    expect(duplicate.duplicateEventIds).toEqual([accepted.id]);
    expect(duplicate.transitions).toHaveLength(1);

    const replayDraft = createPactAgreementTransition({
      context: fixture.context,
      history: [],
      nextState: "accepted",
      actor: fixture.providerIdentity.publicKey,
      actorRole: "provider",
      createdAt: ROOT_TIME + 2,
      validationTime: ROOT_TIME + 2,
    });
    const replay = sign(replayDraft.event, fixture.providerKey);
    const fork = reconstructPactAgreementHistory(fixture.context, [replay, accepted]);
    expect(fork.status).toBe("forked");
    if (fork.status === "forked") {
      expect(fork.conflict.predecessorEventId).toBeNull();
      expect(fork.conflict.competingEventIds).toEqual([accepted.id, replay.id].sort());
    }
  });

  it("anchors current acceptance and expiry decisions to trusted validator time", () => {
    const fixture = createFixture();
    const acceptanceInput = {
      context: fixture.context,
      history: [] as SignedNostrEvent[],
      nextState: "accepted" as const,
      actor: fixture.providerIdentity.publicKey,
      actorRole: "provider" as const,
      createdAt: ROOT_TIME + 1,
    };
    expect(() => createPactAgreementTransition({
      ...acceptanceInput,
      validationTime: EXPIRY,
    })).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
    expect(() => createPactAgreementTransition({
      ...acceptanceInput,
      createdAt: ROOT_TIME + 100,
      validationTime: ROOT_TIME + 1,
    })).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
    expect(() => createPactAgreementTransition({
      ...acceptanceInput,
      validationTime: ROOT_TIME + 31,
    })).not.toThrow();

    expect(() => createPactAgreementTransition({
      context: fixture.context,
      history: [],
      nextState: "expired",
      actor: fixture.requesterIdentity.publicKey,
      actorRole: "requester",
      createdAt: EXPIRY,
      validationTime: ROOT_TIME + 1,
    })).toThrowError(expect.objectContaining({ code: "invalid_transition" }));

    const historical: SignedNostrEvent[] = [];
    appendTransition(fixture, historical, "accepted", "provider", fixture.providerKey);
    expect(reconstructPactAgreementHistory(fixture.context, historical)).toMatchObject({
      currentState: "accepted",
    });
  });

  it("rejects conflicting duplicate IDs and histories beyond the protocol maximum", () => {
    const fixture = createFixture();
    const history: SignedNostrEvent[] = [];
    const accepted = appendTransition(fixture, history, "accepted", "provider", fixture.providerKey);
    const conflicting = { ...accepted, content: `${accepted.content} ` };
    expect(() => reconstructPactAgreementHistory(fixture.context, [accepted, conflicting]))
      .toThrowError(expect.objectContaining({ code: "malformed_event" }));

    const oversized = Array.from({ length: 9 }, (_value, index) => ({
      ...accepted,
      id: index.toString(16).padStart(64, "0"),
    }));
    expect(() => reconstructPactAgreementHistory(fixture.context, oversized))
      .toThrowError(expect.objectContaining({
        code: "malformed_event",
        message: expect.stringContaining("exceeds 8"),
      }));
  });

  it("rejects stale and malformed predecessor references", () => {
    const fixture = createFixture();
    const history: SignedNostrEvent[] = [];
    const accepted = appendTransition(fixture, history, "accepted", "provider", fixture.providerKey);
    appendTransition(fixture, history, "escrow_funded", "escrow", fixture.escrowKey);
    expect(() =>
      createPactAgreementTransition({
        context: fixture.context,
        history,
        predecessorEventId: accepted.id,
        nextState: "task_delivered",
        actor: fixture.providerIdentity.publicKey,
        actorRole: "provider",
        createdAt: ROOT_TIME + 3,
      }),
    ).toThrowError(expect.objectContaining({ code: "stale_predecessor" }));

    const valid = createPactAgreementTransition({
      context: fixture.context,
      history: [accepted],
      predecessorEventId: accepted.id,
      nextState: "escrow_funded",
      actor: fixture.escrowIdentity.publicKey,
      actorRole: "escrow",
      createdAt: ROOT_TIME + 2,
    });
    const content = {
      ...valid.content,
      predecessor: "cd".repeat(32),
    };
    const malformed = sign(
      {
        ...valid.event,
        tags: valid.event.tags.map((tag) =>
          tag[0] === "e" && tag[1] === accepted.id ? (["e", content.predecessor] as const) : tag,
        ),
        content: JSON.stringify(content),
      },
      fixture.escrowKey,
    );
    expect(() => reconstructPactAgreementHistory(fixture.context, [accepted, malformed])).toThrowError(
      expect.objectContaining({ code: "invalid_reference" }),
    );
  });

  it("rejects a first transition that predates the agreement root", () => {
    const fixture = createFixture();
    expect(() =>
      createPactAgreementTransition({
        context: fixture.context,
        history: [],
        nextState: "accepted",
        actor: fixture.providerIdentity.publicKey,
        actorRole: "provider",
        createdAt: ROOT_TIME - 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "stale_predecessor" }));

    const valid = createPactAgreementTransition({
      context: fixture.context,
      history: [],
      nextState: "accepted",
      actor: fixture.providerIdentity.publicKey,
      actorRole: "provider",
      createdAt: ROOT_TIME + 1,
      validationTime: ROOT_TIME + 1,
    });
    const backdated = sign(
      { ...valid.event, created_at: ROOT_TIME - 1 },
      fixture.providerKey,
    );
    expect(() => reconstructPactAgreementHistory(fixture.context, [backdated])).toThrowError(
      expect.objectContaining({ code: "stale_predecessor" }),
    );
  });

  it("rejects a transition that predates its immediate predecessor", () => {
    const fixture = createFixture();
    const history: SignedNostrEvent[] = [];
    const accepted = appendTransition(
      fixture,
      history,
      "accepted",
      "provider",
      fixture.providerKey,
      { createdAt: ROOT_TIME + 2 },
    );
    expect(() =>
      createPactAgreementTransition({
        context: fixture.context,
        history,
        predecessorEventId: accepted.id,
        nextState: "escrow_funded",
        actor: fixture.escrowIdentity.publicKey,
        actorRole: "escrow",
        createdAt: ROOT_TIME + 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "stale_predecessor" }));

    const valid = createPactAgreementTransition({
      context: fixture.context,
      history,
      predecessorEventId: accepted.id,
      nextState: "escrow_funded",
      actor: fixture.escrowIdentity.publicKey,
      actorRole: "escrow",
      createdAt: ROOT_TIME + 3,
    });
    const backdated = sign(
      { ...valid.event, created_at: ROOT_TIME + 1 },
      fixture.escrowKey,
    );
    expect(() =>
      reconstructPactAgreementHistory(fixture.context, [accepted, backdated]),
    ).toThrowError(expect.objectContaining({ code: "stale_predecessor" }));
  });

  it("rejects advancement after terminal states", () => {
    const fixture = createFixture();
    const history: SignedNostrEvent[] = [];
    appendTransition(fixture, history, "expired", "requester", fixture.requesterKey, {
      reasonCode: "agreement_expired",
      createdAt: EXPIRY,
    });
    expect(() =>
      createPactAgreementTransition({
        context: fixture.context,
        history,
        predecessorEventId: history[0].id,
        nextState: "accepted",
        actor: fixture.providerIdentity.publicKey,
        actorRole: "provider",
        createdAt: EXPIRY + 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal_state_transition" }));
  });

  it("prevents private document, result, Cashu, credential, and evidence fields entering public models", () => {
    const fixture = createFixture();
    const secretMarkers = [
      "PRIVATE-DOCUMENT-MARKER",
      "PRIVATE-PROMPT-MARKER",
      "PRIVATE-SUMMARY-MARKER",
      "cashuA-PRIVATE-TOKEN",
      "PRIVATE-PROOF",
      "PRIVATE-PREIMAGE",
      "PRIVATE-MINT-CREDENTIAL",
      "PRIVATE-PAYOUT",
      "PRIVATE-EVIDENCE",
    ];
    const publicRoot = JSON.stringify(fixture.root);
    for (const marker of secretMarkers) expect(publicRoot).not.toContain(marker);

    for (const [field, value] of [
      ["sourceDocument", secretMarkers[0]],
      ["privatePrompt", secretMarkers[1]],
      ["cashuToken", secretMarkers[3]],
      ["proofs", secretMarkers[4]],
      ["preimage", secretMarkers[5]],
      ["mintCredentials", secretMarkers[6]],
      ["payoutInstructions", secretMarkers[7]],
      ["sensitiveEvidence", secretMarkers[8]],
    ]) {
      const unsafe = {
        agreementId: AGREEMENT_ID,
        references: fixture.references,
        amountSats: "350",
        maximumExecutionSeconds: 300,
        expiresAt: EXPIRY,
        termsCommitment: fixture.commitment,
        createdAt: ROOT_TIME,
        [field]: value,
      };
      let thrown: unknown;
      try {
        createPactServiceAgreementRoot(unsafe);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "privacy_boundary_violation" });
      expect(JSON.stringify(thrown)).not.toContain(String(value));
      expect(String(thrown)).not.toContain(String(value));
    }

    const unsafeTransition = {
      context: fixture.context,
      history: [],
      nextState: "accepted" as const,
      actor: fixture.providerIdentity.publicKey,
      actorRole: "provider" as const,
      createdAt: ROOT_TIME + 1,
      completeSummary: secretMarkers[2],
    };
    expect(() => createPactAgreementTransition(unsafeTransition)).toThrowError(
      expect.objectContaining({ code: "privacy_boundary_violation" }),
    );
  });

  it("rejects private fields injected into transition content without echoing their values", () => {
    const fixture = createFixture();
    const draft = createPactAgreementTransition({
      context: fixture.context,
      history: [],
      nextState: "accepted",
      actor: fixture.providerIdentity.publicKey,
      actorRole: "provider",
      createdAt: ROOT_TIME + 1,
      validationTime: ROOT_TIME + 1,
    });
    const content = JSON.parse(draft.event.content) as Record<string, unknown>;
    content.raw_cashu_token = "cashuA-DO-NOT-LOG";
    let thrown: unknown;
    try {
      parsePactAgreementTransitionEvent({ ...draft.event, content: JSON.stringify(content) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "privacy_boundary_violation" });
    expect(String(thrown)).not.toContain("cashuA-DO-NOT-LOG");
  });
});
