import { describe, expect, it } from "vitest";

import { InvalidDomainInputError } from "./errors";
import { serializeUnsignedNostrEvent } from "./nostr";
import {
  createCashuEscrowDescriptor,
  createCashuEscrowPlan,
  parseCashuEscrowDescriptor,
  PontmoreEscrowDescriptorError,
} from "./pontmore-escrow";
import { createPactDemoFixtures } from "../lib/pact-fixtures";

const TEST_DIFFERENT_TIME = 1_788_853_201;

describe("PIP-01 Cashu escrow modeling", () => {
  it("declares canonical cashu_escrow compatibility without a token", () => {
    const { escrowDescriptor } = createPactDemoFixtures();
    expect(escrowDescriptor.content).toMatchObject({
      escrow_type: "cashu_escrow",
      networks: ["cashu"],
      funding_rules: { funding_threshold: 1, participant_count: 1 },
      dispute_rules: {
        policy: "pip03",
        timeout: {
          class: "refund-trigger timeout",
          duration_seconds: 900,
          fallback_resolution: "cancelling and refunding",
        },
      },
      reference_format: "opaque_service_reference",
    });
    expect(JSON.stringify(escrowDescriptor)).not.toMatch(/token|preimage|private/i);
  });

  it("round-trips the public descriptor", () => {
    const { escrowDescriptor } = createPactDemoFixtures();
    const parsed = parseCashuEscrowDescriptor(serializeUnsignedNostrEvent(escrowDescriptor.event));
    expect(parsed.address).toBe(escrowDescriptor.address);
    expect(parsed.content).toEqual(escrowDescriptor.content);
  });

  it.each([-1, 0, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe timeout duration %s",
    (durationSeconds) => {
      const { escrowDescriptor } = createPactDemoFixtures();
      const content = JSON.parse(escrowDescriptor.event.content) as {
        dispute_rules: { timeout: { duration_seconds: number } };
      };
      content.dispute_rules.timeout.duration_seconds = durationSeconds;
      const event = { ...escrowDescriptor.event, content: JSON.stringify(content) };
      expect(() => parseCashuEscrowDescriptor(JSON.stringify(event))).toThrowError(
        expect.objectContaining({ code: "missing_required_metadata" }),
      );
    },
  );

  it.each([1, 900, Number.MAX_SAFE_INTEGER])(
    "accepts positive safe timeout duration %s at the descriptor boundary",
    (durationSeconds) => {
      const { escrowDescriptor } = createPactDemoFixtures();
      const content = JSON.parse(escrowDescriptor.event.content) as {
        dispute_rules: { timeout: { duration_seconds: number } };
      };
      content.dispute_rules.timeout.duration_seconds = durationSeconds;
      const event = { ...escrowDescriptor.event, content: JSON.stringify(content) };
      expect(parseCashuEscrowDescriptor(JSON.stringify(event)).content.dispute_rules.timeout.duration_seconds)
        .toBe(durationSeconds);
    },
  );

  it("constructs identical content and tags for identical logical input", () => {
    const { provider } = createPactDemoFixtures();
    const input = {
      identity: provider.identity,
      identifier: "deterministic-cashu",
      updatedAt: 1_788_853_200,
      referenceFormat: "opaque_service_reference",
      timeoutSeconds: 900,
    } as const;
    const first = createCashuEscrowDescriptor(input);
    const second = createCashuEscrowDescriptor(input);

    expect(first.event).toEqual(second.event);
    expect(serializeUnsignedNostrEvent(first.event)).toBe(
      serializeUnsignedNostrEvent(second.event),
    );
  });

  it("rejects incompatible funding cardinality", () => {
    const { provider } = createPactDemoFixtures();
    expect(() =>
      createCashuEscrowDescriptor({
        identity: provider.identity,
        identifier: "invalid",
        referenceFormat: "opaque",
        updatedAt: 1,
        fundingThreshold: 2,
        participantCount: 1,
      }),
    ).toThrow(InvalidDomainInputError);
  });

  it("keeps funding, release, refund, timeout, and settlement as application intent", () => {
    const { escrowPlan } = createPactDemoFixtures();
    expect(escrowPlan).toMatchObject({
      settlementState: "planned",
      fundingIntent: { action: "commit", network: "cashu" },
      releaseIntent: { condition: "deterministic_completion_checks_pass" },
      refundIntent: { condition: "timeout_or_pip03_resolution" },
      timeout: {
        class: "refund-trigger timeout",
        durationSeconds: 900,
        fallbackResolution: "cancelling and refunding",
      },
    });
  });

  it("rejects unsupported fields that could leak private Cashu data", () => {
    const { escrowDescriptor } = createPactDemoFixtures();
    const content = JSON.parse(escrowDescriptor.event.content) as Record<string, unknown>;
    content.raw_cashu_token = "cashuA-secret";
    const unsafe = { ...escrowDescriptor.event, content: JSON.stringify(content) };
    expect(() => parseCashuEscrowDescriptor(JSON.stringify(unsafe))).toThrowError(
      expect.objectContaining({ code: "forbidden_public_field" }),
    );
  });

  it.each([
    ["cashuToken", "cashuA-test-only-token"],
    ["proofs", [{ id: "synthetic-proof" }]],
    ["mintCredentials", { bearer: "synthetic-mint-credential" }],
    ["privateKey", "synthetic-private-key"],
    ["nostrSecretKey", "nsec1testonlysyntheticsecret"],
    ["preimage", "synthetic-preimage"],
    ["payoutInstructions", { destination: "synthetic-destination" }],
    ["privateRoutingInformation", "synthetic-route"],
    ["internalCustodyIdentifier", "synthetic-custody-id"],
    ["privateSettlementMetadata", { note: "synthetic-private-metadata" }],
    ["settlementSecret", "synthetic-settlement-secret"],
    ["privateNotes", "synthetic-private-note"],
  ])("rejects forbidden construction input field %s", (field, value) => {
    const { provider } = createPactDemoFixtures();
    const unsafeInput = {
      identity: provider.identity,
      identifier: "unsafe-descriptor",
      updatedAt: 1,
      referenceFormat: "opaque_service_reference",
      [field]: value,
    };
    expect(() => createCashuEscrowDescriptor(unsafeInput)).toThrowError(
      expect.objectContaining({ code: "forbidden_public_field" }),
    );
  });

  it("rejects unsupported escrow types, networks, reference formats, and malformed metadata", () => {
    const { escrowDescriptor } = createPactDemoFixtures();
    const cases = [
      { field: "escrow_type", value: "custodial_escrow", code: "unsupported_escrow_type" },
      { field: "networks", value: ["bitcoin"], code: "unsupported_network" },
      { field: "reference_format", value: "cashu_v4_token", code: "missing_required_metadata" },
      { field: "funding_rules", value: { funding_threshold: 2, participant_count: 1 }, code: "missing_required_metadata" },
      { field: "dispute_rules", value: { policy: "mutual_consent" }, code: "missing_required_metadata" },
    ] as const;

    for (const testCase of cases) {
      const content = { ...escrowDescriptor.content, [testCase.field]: testCase.value };
      const event = { ...escrowDescriptor.event, content: JSON.stringify(content) };
      expect(() => parseCashuEscrowDescriptor(JSON.stringify(event))).toThrowError(
        expect.objectContaining({ code: testCase.code }),
      );
    }
  });

  it("distinguishes missing required descriptor metadata", () => {
    const { escrowDescriptor } = createPactDemoFixtures();
    const content = JSON.parse(escrowDescriptor.event.content) as Record<string, unknown>;
    delete content.funding_rules;
    const event = { ...escrowDescriptor.event, content: JSON.stringify(content) };
    expect(() => parseCashuEscrowDescriptor(JSON.stringify(event))).toThrowError(
      expect.objectContaining({ code: "missing_required_metadata" }),
    );
  });

  it("rejects incorrect kind, missing addressability tags, and timestamp mismatch", () => {
    const { escrowDescriptor } = createPactDemoFixtures();
    const wrongKind = { ...escrowDescriptor.event, kind: 1 };
    expect(() => parseCashuEscrowDescriptor(JSON.stringify(wrongKind))).toThrowError(
      expect.objectContaining({ code: "invalid_descriptor" }),
    );

    const missingIdentifier = {
      ...escrowDescriptor.event,
      tags: escrowDescriptor.event.tags.filter((tag) => tag[0] !== "d"),
    };
    expect(() => parseCashuEscrowDescriptor(JSON.stringify(missingIdentifier))).toThrowError(
      expect.objectContaining({ code: "missing_required_metadata" }),
    );

    const timestampMismatch = { ...escrowDescriptor.event, created_at: TEST_DIFFERENT_TIME };
    expect(() => parseCashuEscrowDescriptor(JSON.stringify(timestampMismatch))).toThrowError(
      expect.objectContaining({ code: "missing_required_metadata" }),
    );
  });

  it("never serializes synthetic sensitive markers into a public descriptor", () => {
    const { escrowDescriptor } = createPactDemoFixtures();
    const serialized = serializeUnsignedNostrEvent(escrowDescriptor.event);
    for (const marker of [
      "cashuA-test-only-token",
      "synthetic-proof",
      "synthetic-mint-credential",
      "synthetic-private-key",
      "synthetic-preimage",
      "synthetic-destination",
      "synthetic-settlement-secret",
    ]) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("uses a typed error for forbidden fields", () => {
    const { escrowDescriptor } = createPactDemoFixtures();
    const content = JSON.parse(escrowDescriptor.event.content) as Record<string, unknown>;
    content.private_notes = "synthetic-private-note";
    expect(() =>
      parseCashuEscrowDescriptor(
        JSON.stringify({ ...escrowDescriptor.event, content: JSON.stringify(content) }),
      ),
    ).toThrow(PontmoreEscrowDescriptorError);
  });

  it("rejects secret-key-shaped material used as a public identifier", () => {
    const { provider } = createPactDemoFixtures();
    expect(() =>
      createCashuEscrowDescriptor({
        identity: provider.identity,
        identifier: "ab".repeat(32),
        updatedAt: 1,
        referenceFormat: "opaque_service_reference",
      }),
    ).toThrowError(expect.objectContaining({ code: "forbidden_public_field" }));
  });

  it("rejects private or extra material smuggled through Nostr tags", () => {
    const { escrowDescriptor } = createPactDemoFixtures();
    const privateTag = {
      ...escrowDescriptor.event,
      tags: [...escrowDescriptor.event.tags, ["private_key", "ab".repeat(32)]],
    };
    expect(() => parseCashuEscrowDescriptor(JSON.stringify(privateTag))).toThrowError(
      expect.objectContaining({ code: "forbidden_public_field" }),
    );

    const extraTagValue = {
      ...escrowDescriptor.event,
      tags: [["d", escrowDescriptor.identifier, "synthetic-private-note"], ["network", "cashu"]],
    };
    expect(() => parseCashuEscrowDescriptor(JSON.stringify(extraTagValue))).toThrowError(
      expect.objectContaining({ code: "invalid_descriptor" }),
    );
  });

  it("requires a positive escrow amount", () => {
    const { escrowDescriptor } = createPactDemoFixtures();
    expect(() => createCashuEscrowPlan({ descriptor: escrowDescriptor, amountSats: 0n as never, timeoutSeconds: 1 }))
      .toThrow(InvalidDomainInputError);
  });
});
