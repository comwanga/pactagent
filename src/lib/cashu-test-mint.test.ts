import { CheckStateEnum, serializeProofs, type Proof } from "@cashu/cashu-ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { sats } from "../domain/money";
import { nostrPublicKey } from "../domain/nostr";
import {
  CashuPrivateBackendError,
  CashuTestMintError,
  CASHU_TEST_MINT_MAX_ACTIVE_KEYSETS,
  cashuAccountingInputAmount,
  createCashuPrivateFundingSource,
  createCashuPrivateValueDelivery,
  createCashuTestMintAdapterWithBackend,
  createCashuTestMintAdapter,
  createInMemoryCashuPrivateStore,
  createPrivateCashuBeneficiaryDestination,
  createPrivateCashuFunding,
  createPrivateCashuProofImport,
  createPrivateCashuSpendingKey,
  createSqliteCashuPrivateStore,
  normalizeCashuMintUrl,
  normalizeCashuTestMintConfiguration,
  normalizeCashuPrivateProofState,
  normalizeCashuTestMintUrl,
  normalizeDemoPrivateHostAllowlist,
  serializeCashuRequestBody,
  type CashuPrivateStore,
  type CashuTestMintPort,
} from "./cashu-test-mint";
import {
  FakeCashuBackend,
  FAKE_CURVE_POINT as CURVE_POINT,
  FAKE_KEYSET_ID as KEYSET_ID,
  FAKE_MINT_URL as MINT_URL,
  fakeDefaultSnapshot as defaultSnapshot,
  fakeFunding as funding,
  fakeProof as proof,
} from "./cashu-test-fixture";

const LOCK_SECRET = "01".padStart(64, "0");
const REFUND_SECRET = "02".padStart(64, "0");

function harness(backend = new FakeCashuBackend()): {
  backend: FakeCashuBackend;
  adapter: CashuTestMintPort;
} {
  return {
    backend,
    adapter: createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: `${MINT_URL}/`,
        unit: "sat",
        maximumExposureSats: sats(1_000n),
      },
      backend,
      privateStore: createInMemoryCashuPrivateStore(),
    }),
  };
}

function spendingKey(secretKeyHex = LOCK_SECRET) {
  return createPrivateCashuSpendingKey({
    purpose: "cashu-nut11",
    secretKeyHex,
  });
}

async function prepare(
  adapter: CashuTestMintPort,
  operationId = "prepare-0001",
) {
  const lockKey = spendingKey();
  const result = await adapter.prepareLockedValue({
    operationId,
    funding: funding(),
    amountSats: sats(350n),
    spendingCondition: { lockPublicKey: lockKey.publicKey },
  });
  if (result.status !== "succeeded") throw new Error("test preparation did not succeed");
  return { result, lockKey };
}

describe("Cashu test-mint configuration and capabilities", () => {
  it("serializes cashu-ts Amount JSON strings as Cashu v1 integer amounts", () => {
    const serialized = serializeCashuRequestBody({
      inputs: [{ amount: "2", secret: "3" }],
      outputs: [{ amount: "4", B_: "5" }],
      memo: "6",
    });
    expect(JSON.parse(serialized)).toEqual({
      inputs: [{ amount: 2, secret: "3" }],
      outputs: [{ amount: 4, B_: "5" }],
      memo: "6",
    });
    expect(() => serializeCashuRequestBody({ amount: "not-an-amount" })).toThrow();
    expect(() => serializeCashuRequestBody({ amount: (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString() }))
      .toThrow();
  });

  it("includes cashu-ts unselected proofs in successful swap value accounting", () => {
    const selected = [proof(256n, "selected-256"), proof(128n, "selected-128")];
    const unselected = [
      proof(4_096n, "unselected-4096"),
      proof(512n, "unselected-512"),
      proof(8n, "unselected-8"),
    ];
    expect(
      cashuAccountingInputAmount({
        kind: "lock",
        inputProofs: selected,
        requestedAmountSats: 350n,
        exposureAmountSats: 351n,
        opaque: {
          preview: {},
          unselectedProofs: serializeProofs(unselected),
        },
      }),
    ).toBe(5_000n);
  });

  it("normalizes one explicit HTTPS test mint and requires sat", () => {
    expect(
      normalizeCashuTestMintConfiguration({
        testMintUrl: `${MINT_URL}///`,
        unit: "sat",
        maximumExposureSats: sats(100n),
      }).testMintUrl,
    ).toBe(MINT_URL);

    expect(() =>
      normalizeCashuTestMintConfiguration({
        testMintUrl: "http://testmint.example",
        unit: "sat",
        maximumExposureSats: sats(100n),
      }),
    ).toThrowError(CashuTestMintError);
    expect(() =>
      normalizeCashuTestMintConfiguration({
        testMintUrl: "https://credential@testmint.example?mint=other",
        unit: "sat",
        maximumExposureSats: sats(100n),
      }),
    ).toThrowError(CashuTestMintError);
  });

  // ==================================================================
  // Issue #36, Blocker 2: mode-aware URL transport policy
  // ==================================================================
  describe("normalizeCashuMintUrl transport policy (Blocker 2)", () => {
    it("live-https accepts HTTPS", () => {
      expect(normalizeCashuMintUrl("https://mint.example/cashu", "live-https")).toBe("https://mint.example/cashu");
    });

    it("live-https rejects HTTP loopback", () => {
      expect(() => normalizeCashuMintUrl("http://127.0.0.1:3338", "live-https")).toThrowError(CashuTestMintError);
    });

    it("live-https rejects HTTP remote", () => {
      expect(() => normalizeCashuMintUrl("http://example.com", "live-https")).toThrowError(CashuTestMintError);
    });

    it("demo-loopback accepts HTTPS", () => {
      expect(normalizeCashuMintUrl("https://mint.example/cashu", "demo-loopback")).toBe("https://mint.example/cashu");
    });

    it.each(["http://127.0.0.1:3338", "http://localhost:3338", "http://[::1]:3338", "http://127.0.0.1:3338/"])(
      "demo-loopback accepts HTTP loopback %s",
      (url) => {
        expect(normalizeCashuMintUrl(url, "demo-loopback")).toMatch(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):3338\/?$/);
      },
    );

    it.each(["http://example.com", "http://192.168.1.10:3338", "http://10.0.0.1", "http://mint.local"])(
      "demo-loopback rejects HTTP remote/LAN %s",
      (url) => {
        expect(() => normalizeCashuMintUrl(url, "demo-loopback")).toThrowError(CashuTestMintError);
      },
    );

    it.each(["not a url", "://no-scheme", "https://", "https://user:pass@mint.example", "https://mint.example?q=1", "https://mint.example#frag"])(
      "rejects malformed/unsafe URLs %s",
      (url) => {
        expect(() => normalizeCashuMintUrl(url, "live-https")).toThrowError(CashuTestMintError);
        expect(() => normalizeCashuMintUrl(url, "demo-loopback")).toThrowError(CashuTestMintError);
      },
    );

    it("normalizes trailing slashes for both policies", () => {
      expect(normalizeCashuMintUrl("https://mint.example/cashu///", "live-https")).toBe("https://mint.example/cashu");
      expect(normalizeCashuMintUrl("http://127.0.0.1:3338///", "demo-loopback")).toBe("http://127.0.0.1:3338");
    });

    it("normalizeCashuTestMintUrl remains the strict live-https policy", () => {
      expect(normalizeCashuTestMintUrl("https://mint.example")).toBe("https://mint.example");
      expect(() => normalizeCashuTestMintUrl("http://127.0.0.1:3338")).toThrowError(CashuTestMintError);
    });

    it("the adapter accepts a demo-loopback transport policy for HTTP loopback", () => {
      const adapter = createCashuTestMintAdapter({
        configuration: {
          testMintUrl: "http://127.0.0.1:3338",
          unit: "sat",
          maximumExposureSats: sats(400n),
          transportPolicy: "demo-loopback",
        },
        privateStore: createInMemoryCashuPrivateStore(),
      });
      expect(adapter).toBeDefined();
    });

    it("the adapter rejects a demo-loopback policy for HTTP remote (no accidental broadening)", () => {
      expect(() =>
        createCashuTestMintAdapter({
          configuration: {
            testMintUrl: "http://example.com:3338",
            unit: "sat",
            maximumExposureSats: sats(400n),
            transportPolicy: "demo-loopback",
          },
          privateStore: createInMemoryCashuPrivateStore(),
        }),
      ).toThrowError(CashuTestMintError);
    });

    it("the adapter defaults to live-https and rejects HTTP loopback", () => {
      expect(() =>
        createCashuTestMintAdapter({
          configuration: {
            testMintUrl: "http://127.0.0.1:3338",
            unit: "sat",
            maximumExposureSats: sats(400n),
          },
          privateStore: createInMemoryCashuPrivateStore(),
        }),
      ).toThrowError(CashuTestMintError);
    });

    // Issue #39: explicit private-network demo mint hosts (Railway).
    it("demo-loopback accepts an explicitly allowlisted private-network HTTP host", () => {
      expect(
        normalizeCashuMintUrl(
          "http://pactagent-demo-mint.railway.internal:3338",
          "demo-loopback",
          Object.freeze(["pactagent-demo-mint.railway.internal"]),
        ),
      ).toBe("http://pactagent-demo-mint.railway.internal:3338");
    });

    it("demo-loopback rejects an HTTP host that is not allowlisted", () => {
      expect(() =>
        normalizeCashuMintUrl(
          "http://other-service.railway.internal:3338",
          "demo-loopback",
          Object.freeze(["pactagent-demo-mint.railway.internal"]),
        ),
      ).toThrowError(CashuTestMintError);
    });

    it("demo-loopback allowlist matching is exact (no suffix or partial matches)", () => {
      expect(() =>
        normalizeCashuMintUrl(
          "http://evil-pactagent-demo-mint.railway.internal:3338",
          "demo-loopback",
          Object.freeze(["pactagent-demo-mint.railway.internal"]),
        ),
      ).toThrowError(CashuTestMintError);
    });

    it("demo-loopback allowlist rejects IP addresses", () => {
      expect(() =>
        normalizeCashuMintUrl(
          "http://10.0.0.1:3338",
          "demo-loopback",
          Object.freeze(["10.0.0.1"]),
        ),
      ).toThrowError(CashuTestMintError);
    });

    it("normalizeDemoPrivateHostAllowlist rejects invalid entries and normalizes valid ones", () => {
      expect(
        normalizeDemoPrivateHostAllowlist([" PactAgent-Demo-Mint.Railway.Internal "]),
      ).toEqual(["pactagent-demo-mint.railway.internal"]);
      for (const invalid of ["10.0.0.1", "*.railway.internal", "host", "mint", "no-dots", "with space", ""]) {
        expect(() => normalizeDemoPrivateHostAllowlist([invalid])).toThrowError(CashuTestMintError);
      }
      expect(normalizeDemoPrivateHostAllowlist(undefined)).toEqual([]);
      expect(() =>
        normalizeDemoPrivateHostAllowlist(Array.from({ length: 9 }, (_, index) => `host-${index}.railway.internal`)),
      ).toThrowError(CashuTestMintError);
    });

    it("live-https ignores the private-host allowlist entirely", () => {
      expect(() =>
        normalizeCashuMintUrl(
          "http://pactagent-demo-mint.railway.internal:3338",
          "live-https",
          Object.freeze(["pactagent-demo-mint.railway.internal"]),
        ),
      ).toThrowError(CashuTestMintError);
      expect(normalizeCashuMintUrl("https://mint.example", "live-https", Object.freeze(["mint.example"])))
        .toBe("https://mint.example");
    });

    it("the adapter accepts an allowlisted private-network demo mint URL", () => {
      const adapter = createCashuTestMintAdapter({
        configuration: {
          testMintUrl: "http://pactagent-demo-mint.railway.internal:3338",
          unit: "sat",
          maximumExposureSats: sats(400n),
          transportPolicy: "demo-loopback",
          allowedDemoPrivateHosts: Object.freeze(["pactagent-demo-mint.railway.internal"]),
        },
        privateStore: createInMemoryCashuPrivateStore(),
      });
      expect(adapter).toBeDefined();
    });
  });

  it("validates NUT-07, NUT-09, NUT-10, NUT-11, sat, key material, and fees", async () => {
    const { adapter } = harness();
    await expect(adapter.inspectCapabilities()).resolves.toEqual({
      mintUrl: MINT_URL,
      unit: "sat",
      nuts: {
        nut07ProofState: true,
        nut09Restore: true,
        nut10SpendingConditions: true,
        nut11P2pk: true,
      },
      activeKeyset: { id: KEYSET_ID, inputFeePpk: 1 },
      acceptedKeysetIds: [KEYSET_ID],
    });
  });

  it("fails closed when a required capability is unsupported", async () => {
    const backend = new FakeCashuBackend();
    backend.snapshot = defaultSnapshot({ nuts: { 7: true, 9: true, 10: true, 11: false } });
    await expect(harness(backend).adapter.inspectCapabilities()).rejects.toMatchObject({
      code: "unsupported_mint_capability",
      operationStatus: "not_submitted",
    });
  });

  it("rejects an unsupported mint unit", async () => {
    const backend = new FakeCashuBackend();
    backend.snapshot = defaultSnapshot({
      keysets: [
        { id: KEYSET_ID, unit: "usd", active: true, inputFeePpk: 1, hasKeys: true },
      ],
    });
    await expect(harness(backend).adapter.inspectCapabilities()).rejects.toMatchObject({
      code: "unsupported_unit",
    });
  });

  it("rejects missing keys and malformed keyset fee metadata", async () => {
    const missingKeys = new FakeCashuBackend();
    missingKeys.snapshot = defaultSnapshot({
      keysets: [
        { id: KEYSET_ID, unit: "sat", active: true, inputFeePpk: 1, hasKeys: false },
      ],
    });
    await expect(harness(missingKeys).adapter.inspectCapabilities()).rejects.toMatchObject({
      code: "unsupported_mint_capability",
    });

    const badFee = new FakeCashuBackend();
    badFee.snapshot = defaultSnapshot({
      keysets: [
        { id: KEYSET_ID, unit: "sat", active: true, inputFeePpk: -1, hasKeys: true },
      ],
    });
    await expect(harness(badFee).adapter.inspectCapabilities()).rejects.toMatchObject({
      code: "unsupported_mint_capability",
    });
  });

  it("rejects capability data for any mint other than the configured mint", async () => {
    const backend = new FakeCashuBackend();
    backend.snapshot = defaultSnapshot({ mintUrl: "https://other-mint.example" });
    await expect(harness(backend).adapter.inspectCapabilities()).rejects.toMatchObject({
      code: "invalid_mint_configuration",
    });
  });
});

describe("Cashu private funding import and beneficiary delivery", () => {
  it("imports configured-mint sat proofs through the narrow funding source", async () => {
    const { adapter, backend } = harness();
    const source = createCashuPrivateFundingSource({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(1_000n),
      },
      cashu: adapter,
    });
    const imported = createPrivateCashuProofImport({
      mintUrl: `${MINT_URL}/`,
      unit: "sat",
      proofs: [proof(400n, "imported")],
    });
    const privateFunding = await source.importFunding(imported);
    const lockKey = spendingKey();

    await expect(
      adapter.prepareLockedValue({
        operationId: "imported-funding-01",
        funding: privateFunding,
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: lockKey.publicKey },
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(backend.submitCalls).toBe(1);
    expect(() => JSON.stringify(imported)).toThrowError(CashuTestMintError);
    expect(() => JSON.stringify(source)).toThrowError(CashuTestMintError);
  });

  it("rejects excessive active keysets before retrieving any key material", async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) {
        return new Response(JSON.stringify({
          name: "bounded-test-mint",
          pubkey: CURVE_POINT,
          version: "test",
          description: "test",
          contact: [],
          nuts: {
            "7": { supported: true },
            "9": { supported: true },
            "10": { supported: true },
            "11": { supported: true },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/v1/keysets")) {
        return new Response(JSON.stringify({
          keysets: Array.from(
            { length: CASHU_TEST_MINT_MAX_ACTIVE_KEYSETS + 1 },
            (_value, index) => ({
              id: index.toString(16).padStart(16, "0"),
              unit: "sat",
              active: true,
              input_fee_ppk: 0,
            }),
          ),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected key retrieval: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    try {
      const adapter = createCashuTestMintAdapter({
        configuration: {
          testMintUrl: MINT_URL,
          unit: "sat",
          maximumExposureSats: sats(1_000n),
        },
        privateStore: createInMemoryCashuPrivateStore(),
      });
      await expect(adapter.inspectCapabilities()).rejects.toMatchObject({
        code: "malformed_mint_response",
      });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects proof imports for another mint or unsupported keyset", async () => {
    const { adapter } = harness();
    const source = createCashuPrivateFundingSource({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(1_000n),
      },
      cashu: adapter,
    });
    const otherMint = createPrivateCashuProofImport({
      mintUrl: "https://other-mint.example",
      unit: "sat",
      proofs: [proof(400n, "other")],
    });
    await expect(source.importFunding(otherMint)).rejects.toMatchObject({
      code: "invalid_mint_configuration",
    });

    const unsupportedKeyset = createPrivateCashuProofImport({
      mintUrl: MINT_URL,
      unit: "sat",
      proofs: [proof(400n, "unsupported", "unknown-keyset")],
    });
    await expect(source.importFunding(unsupportedKeyset)).rejects.toMatchObject({
      code: "unsupported_mint_capability",
    });
  });

  it("recovers and idempotently delivers distinct payout and change after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-cashu-delivery-"));
    const databasePath = join(directory, "cashu-private.sqlite");
    const configuration = {
      testMintUrl: MINT_URL,
      unit: "sat" as const,
      maximumExposureSats: sats(1_000n),
    };
    let store = createSqliteCashuPrivateStore(databasePath);
    try {
      const firstAdapter = createCashuTestMintAdapterWithBackend({
        configuration,
        backend: new FakeCashuBackend(),
        privateStore: store,
      });
      const prepared = await prepare(firstAdapter, "delivery-prepare-01");
      expect(prepared.result.changeHandle).toBeDefined();
      const spent = await firstAdapter.spendLockedValue({
        operationId: "delivery-spend-001",
        handle: prepared.result.handle,
        spendingKey: prepared.lockKey,
      });
      if (spent.status !== "succeeded") throw new Error("expected successful spend");
      expect(spent.handle.reference).not.toBe(prepared.result.changeHandle!.reference);
      store.close();

      store = createSqliteCashuPrivateStore(databasePath);
      const delivery = createCashuPrivateValueDelivery({ configuration, privateStore: store });
      const provider = "ab".repeat(32);
      const requester = "cd".repeat(32);
      const providerDeliveries: string[] = [];
      const requesterDeliveries: string[] = [];
      const providerDestination = createPrivateCashuBeneficiaryDestination({
        beneficiary: provider,
        async deliver(value) {
          providerDeliveries.push(value.deliveryId);
          expect(() => JSON.stringify(value.funding)).toThrowError(CashuTestMintError);
        },
      });
      const requesterDestination = createPrivateCashuBeneficiaryDestination({
        beneficiary: requester,
        async deliver(value) {
          requesterDeliveries.push(value.deliveryId);
        },
      });
      const payoutRequest = {
        deliveryId: "provider-delivery-0001",
        handle: spent.handle,
        expectedBeneficiary: nostrPublicKey(provider),
        destination: providerDestination,
      };
      const changeRequest = {
        deliveryId: "requester-change-0001",
        handle: prepared.result.changeHandle!,
        expectedBeneficiary: nostrPublicKey(requester),
        destination: requesterDestination,
      };
      await expect(delivery.deliver(payoutRequest)).resolves.toMatchObject({ status: "delivered" });
      await expect(delivery.deliver(changeRequest)).resolves.toMatchObject({ status: "delivered" });
      await expect(delivery.deliver(payoutRequest)).resolves.toMatchObject({ status: "delivered" });
      expect(providerDeliveries).toEqual(["provider-delivery-0001"]);
      expect(requesterDeliveries).toEqual(["requester-change-0001"]);
      await expect(
        delivery.deliver({ ...payoutRequest, destination: requesterDestination }),
      ).rejects.toMatchObject({ code: "operation_rejected" });
      store.close();

      store = createSqliteCashuPrivateStore(databasePath);
      const restartedDelivery = createCashuPrivateValueDelivery({
        configuration,
        privateStore: store,
      });
      await expect(restartedDelivery.deliver(payoutRequest)).resolves.toMatchObject({
        status: "delivered",
      });
      expect(providerDeliveries).toEqual(["provider-delivery-0001"]);
      expect(() => JSON.stringify(delivery)).toThrowError(CashuTestMintError);
      expect(JSON.stringify(await restartedDelivery.deliver(payoutRequest))).not.toContain(
        "private-proof-secret",
      );
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("reconciles an ambiguous beneficiary callback after restart by stable delivery id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-cashu-delivery-reconcile-"));
    const databasePath = join(directory, "cashu-private.sqlite");
    const configuration = {
      testMintUrl: MINT_URL,
      unit: "sat" as const,
      maximumExposureSats: sats(1_000n),
    };
    let store = createSqliteCashuPrivateStore(databasePath);
    try {
      const adapter = createCashuTestMintAdapterWithBackend({
        configuration,
        backend: new FakeCashuBackend(),
        privateStore: store,
      });
      const prepared = await prepare(adapter, "delivery-reconcile-prepare");
      const spent = await adapter.spendLockedValue({
        operationId: "delivery-reconcile-spend",
        handle: prepared.result.handle,
        spendingKey: prepared.lockKey,
      });
      if (spent.status !== "succeeded") throw new Error("expected successful spend");
      const beneficiary = nostrPublicKey("ef".repeat(32));
      const deliveredIds = new Set<string>();
      const firstDestination = createPrivateCashuBeneficiaryDestination({
        beneficiary,
        async deliver(value) {
          deliveredIds.add(value.deliveryId);
          throw new Error("PRIVATE-DESTINATION-RESPONSE-LOST");
        },
      });
      const request = {
        deliveryId: "ambiguous-delivery-01",
        handle: spent.handle,
        expectedBeneficiary: beneficiary,
        destination: firstDestination,
      };
      const firstDelivery = createCashuPrivateValueDelivery({ configuration, privateStore: store });
      await expect(firstDelivery.deliver(request)).rejects.toMatchObject({
        code: "reconciliation_required",
        operationStatus: "submitted_unknown",
      });
      store.close();

      store = createSqliteCashuPrivateStore(databasePath);
      let repeatedCallback = 0;
      const recoveredDestination = createPrivateCashuBeneficiaryDestination({
        beneficiary,
        async deliver(value) {
          repeatedCallback += 1;
          expect(deliveredIds.has(value.deliveryId)).toBe(true);
        },
      });
      const recovered = createCashuPrivateValueDelivery({ configuration, privateStore: store });
      await expect(
        recovered.deliver({ ...request, destination: recoveredDestination }),
      ).resolves.toMatchObject({ status: "delivered" });
      expect(repeatedCallback).toBe(1);
      store.close();

      store = createSqliteCashuPrivateStore(databasePath);
      const finalDestination = createPrivateCashuBeneficiaryDestination({
        beneficiary,
        async deliver() {
          throw new Error("delivered output must not be exported again");
        },
      });
      const finalDelivery = createCashuPrivateValueDelivery({ configuration, privateStore: store });
      await expect(
        finalDelivery.deliver({ ...request, destination: finalDestination }),
      ).resolves.toMatchObject({ status: "delivered" });
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("Cashu test-mint private operations", () => {
  it("prepares locked value with integer-safe fee accounting and only safe output", async () => {
    const { adapter } = harness();
    const { result } = await prepare(adapter);

    expect(result.facts).toEqual({
      mintUrl: MINT_URL,
      unit: "sat",
      amountSats: 350n,
      inputAmountSats: 400n,
      outputAmountSats: 351n,
      changeAmountSats: 48n,
      mintFeeSats: 1n,
      reservedSpendFeeSats: 1n,
    });
    expect(result.handle.reference).toMatch(/^cashu_private_[0-9a-f-]{36}$/);
    expect(result.changeHandle?.reference).toMatch(/^cashu_private_[0-9a-f-]{36}$/);
    await expect(adapter.inspectProofState(result.changeHandle!)).resolves.toMatchObject({
      state: "unspent",
      proofCount: 1,
    });
  });

  it("spends locked value only with the matching private Cashu key", async () => {
    const { adapter } = harness();
    const locked = await prepare(adapter);
    const spent = await adapter.spendLockedValue({
      operationId: "spend-000001",
      handle: locked.result.handle,
      spendingKey: locked.lockKey,
    });

    expect(spent.status).toBe("succeeded");
    if (spent.status === "succeeded") {
      expect(spent.facts).toMatchObject({
        amountSats: 350n,
        inputAmountSats: 351n,
        outputAmountSats: 350n,
        mintFeeSats: 1n,
      });
    }

    const other = await prepare(adapter, "prepare-0002");
    await expect(
      adapter.spendLockedValue({
        operationId: "spend-000002",
        handle: other.result.handle,
        spendingKey: spendingKey(REFUND_SECRET),
      }),
    ).rejects.toMatchObject({ code: "invalid_spending_condition" });
  });

  it("tombstones a spent source handle so it cannot be delivered as live value", async () => {
    const backend = new FakeCashuBackend();
    const privateStore = createInMemoryCashuPrivateStore();
    const configuration = {
      testMintUrl: MINT_URL,
      unit: "sat" as const,
      maximumExposureSats: sats(1_000n),
    };
    const adapter = createCashuTestMintAdapterWithBackend({ configuration, backend, privateStore });
    const locked = await prepare(adapter, "source-tombstone-lock");
    await adapter.spendLockedValue({
      operationId: "source-tombstone-spend",
      handle: locked.result.handle,
      spendingKey: locked.lockKey,
    });

    let deliveries = 0;
    const beneficiary = nostrPublicKey("ef".repeat(32));
    const destination = createPrivateCashuBeneficiaryDestination({
      beneficiary,
      async deliver() {
        deliveries += 1;
      },
    });
    const delivery = createCashuPrivateValueDelivery({ configuration, privateStore });
    await expect(delivery.deliver({
      deliveryId: "spent-source-delivery",
      handle: locked.result.handle,
      expectedBeneficiary: beneficiary,
      destination,
    })).rejects.toMatchObject({ code: "operation_rejected" });
    expect(deliveries).toBe(0);
  });

  it("tombstones the source handle before persisting spend success", async () => {
    const base = createInMemoryCashuPrivateStore();
    let failSuccess = true;
    const privateStore: CashuPrivateStore = {
      read: (scope, key) => base.read(scope, key),
      async write(scope, key, value) {
        if (
          failSuccess &&
          key === "operation:spend-tombstone-order" &&
          (value as { status?: unknown }).status === "succeeded"
        ) {
          failSuccess = false;
          throw new Error("fault after spend success persistence");
        }
        await base.write(scope, key, value);
      },
      withExclusiveLock: (scope, key, operation) => base.withExclusiveLock(scope, key, operation),
    };
    const backend = new FakeCashuBackend();
    const configuration = {
      testMintUrl: MINT_URL,
      unit: "sat" as const,
      maximumExposureSats: sats(1_000n),
    };
    const adapter = createCashuTestMintAdapterWithBackend({ configuration, backend, privateStore });
    const locked = await prepare(adapter, "tombstone-order-lock");
    await expect(adapter.spendLockedValue({
      operationId: "spend-tombstone-order",
      handle: locked.result.handle,
      spendingKey: locked.lockKey,
    })).resolves.toMatchObject({ status: "submitted_unknown" });
    const sourceRecord = await base.read(MINT_URL, `value:${locked.result.handle.reference}`);
    expect(sourceRecord).toMatchObject({ consumedByOperationId: "spend-tombstone-order" });
  });

  it("rejects insufficient value before submission", async () => {
    const { adapter, backend } = harness();
    const key = spendingKey();
    await expect(
      adapter.prepareLockedValue({
        operationId: "prepare-0003",
        funding: funding(20n),
        amountSats: sats(50n),
        spendingCondition: { lockPublicKey: key.publicKey },
      }),
    ).rejects.toMatchObject({
      code: "insufficient_value",
      operationStatus: "not_submitted",
    });
    expect(backend.prepareCalls).toBe(0);
    expect(backend.submitCalls).toBe(0);
  });

  it("rejects malformed, zero, x-only, and incomplete refund spending conditions", async () => {
    expect(() => spendingKey("00".repeat(32))).toThrowError(CashuTestMintError);
    expect(() =>
      createPrivateCashuSpendingKey({
        purpose: "cashu-nut11",
        secretKeyHex: "A".repeat(64),
      }),
    ).toThrowError(CashuTestMintError);

    const { adapter, backend } = harness();
    await expect(
      adapter.prepareLockedValue({
        operationId: "prepare-0004",
        funding: funding(),
        amountSats: sats(50n),
        spendingCondition: { lockPublicKey: "ab".repeat(32) },
      }),
    ).rejects.toMatchObject({ code: "invalid_spending_condition" });
    const lock = spendingKey();
    const refund = spendingKey(REFUND_SECRET);
    await expect(
      adapter.prepareLockedValue({
        operationId: "prepare-0005",
        funding: funding(),
        amountSats: sats(50n),
        spendingCondition: {
          lockPublicKey: lock.publicKey,
          refundPublicKey: refund.publicKey,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_spending_condition" });
    expect(backend.capabilityCalls).toBe(0);
  });

  it.each(["unspent", "pending", "spent"] as const)(
    "reports %s proof state without exposing proofs",
    async (state) => {
      const { adapter, backend } = harness();
      const locked = await prepare(adapter);
      backend.states = [{ state }];
      await expect(adapter.inspectProofState(locked.result.handle)).resolves.toMatchObject({
        state,
        proofCount: 1,
        [`${state}Count`]: 1,
      });
    },
  );

  it("rejects an unknown Cashu proof state instead of treating it as spent", () => {
    expect(normalizeCashuPrivateProofState(CheckStateEnum.SPENT)).toEqual({ state: "spent" });

    let caught: unknown;
    try {
      normalizeCashuPrivateProofState("UNKNOWN" as unknown as CheckStateEnum);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CashuPrivateBackendError);
    expect(caught).toMatchObject({
      code: "malformed_response",
      submissionStatus: "not_submitted",
    });
  });

  it("rejects value from an unknown or incompatible keyset", async () => {
    const { adapter, backend } = harness();
    const key = spendingKey();
    await expect(
      adapter.prepareLockedValue({
        operationId: "prepare-0006",
        funding: funding(400n, "unknown-keyset"),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: key.publicKey },
      }),
    ).rejects.toMatchObject({ code: "unsupported_mint_capability" });
    expect(backend.submitCalls).toBe(0);
  });

  it("accepts a valid locktime refund path and rejects funding from another mint", async () => {
    const { adapter, backend } = harness();
    const lock = spendingKey();
    const refund = spendingKey(REFUND_SECRET);
    await expect(
      adapter.prepareLockedValue({
        operationId: "refund-path-01",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: {
          lockPublicKey: lock.publicKey,
          refundPublicKey: refund.publicKey,
          locktime: 1_900_000_000,
        },
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    const otherMintFunding = createPrivateCashuFunding({
      mintUrl: "https://other-testmint.example",
      unit: "sat",
      proofs: [proof(400n, "other-mint")],
    });
    await expect(
      adapter.prepareLockedValue({
        operationId: "wrong-mint-01",
        funding: otherMintFunding,
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: lock.publicKey },
      }),
    ).rejects.toMatchObject({ code: "invalid_mint_configuration" });
    expect(backend.submitCalls).toBe(1);
  });
});

describe("Cashu test-mint retry and reconciliation", () => {
  it("rejects understated prepared exposure before reserving or submitting", async () => {
    const backend = new FakeCashuBackend();
    backend.malformedExposure = true;
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(351n),
      },
      backend,
      privateStore: createInMemoryCashuPrivateStore(),
    });
    const request = {
      operationId: "understated-exposure",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };

    await expect(adapter.prepareLockedValue(request)).rejects.toMatchObject({
      code: "operation_rejected",
      operationStatus: "not_submitted",
    });
    expect(backend.submitCalls).toBe(0);

    backend.malformedExposure = false;
    await expect(
      adapter.prepareLockedValue({
        ...request,
        operationId: "valid-exposure-after-rejection",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("accounts for fee-inclusive proof exposure at the exact cap boundary", async () => {
    const backend = new FakeCashuBackend();
    backend.states = [{ state: "spent" }];
    backend.restoreSucceeds = true;
    const privateStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(700n),
      },
      backend,
      privateStore,
    });
    const first = await prepare(adapter, "fee-cap-first");
    const secondRequest = {
      operationId: "fee-cap-second",
      funding: funding(),
      amountSats: sats(349n),
      spendingCondition: { lockPublicKey: spendingKey(REFUND_SECRET).publicKey },
    };
    await expect(adapter.prepareLockedValue(secondRequest)).rejects.toMatchObject({
      code: "insufficient_value",
      operationStatus: "not_submitted",
    });
    expect(backend.submitCalls).toBe(1);

    await adapter.spendLockedValue({
      operationId: "fee-cap-release-first",
      handle: first.result.handle,
      spendingKey: first.lockKey,
    });
    await expect(adapter.prepareLockedValue(secondRequest)).resolves.toMatchObject({
      status: "succeeded",
      facts: { outputAmountSats: 350n },
    });
  });

  it("enforces the configured cap across concurrently locked value", async () => {
    const backend = new FakeCashuBackend();
    backend.states = [{ state: "spent" }];
    backend.restoreSucceeds = true;
    const privateStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(500n),
      },
      backend,
      privateStore,
    });
    const first = await prepare(adapter, "aggregate-0001");
    const secondKey = spendingKey(REFUND_SECRET);

    await expect(
      adapter.prepareLockedValue({
        operationId: "aggregate-0002",
        funding: funding(),
        amountSats: sats(200n),
        spendingCondition: { lockPublicKey: secondKey.publicKey },
      }),
    ).rejects.toMatchObject({ code: "insufficient_value", operationStatus: "not_submitted" });

    await expect(
      adapter.spendLockedValue({
        operationId: "aggregate-spend-01",
        handle: first.result.handle,
        spendingKey: first.lockKey,
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    await expect(
      adapter.prepareLockedValue({
        operationId: "aggregate-0002",
        funding: funding(),
        amountSats: sats(200n),
        spendingCondition: { lockPublicKey: secondKey.publicKey },
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("keeps ambiguous locked value inside the aggregate exposure cap", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    backend.states = [{ state: "pending" }];
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(500n),
      },
      backend,
      privateStore: createInMemoryCashuPrivateStore(),
    });
    const firstKey = spendingKey();
    await expect(
      adapter.prepareLockedValue({
        operationId: "ambiguous-cap-01",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: firstKey.publicKey },
      }),
    ).resolves.toMatchObject({ outcome: "reconciliation_required" });

    const secondKey = spendingKey(REFUND_SECRET);
    const disjointFunding = createPrivateCashuFunding({
      mintUrl: MINT_URL,
      unit: "sat",
      proofs: [proof(400n, "ambiguous-cap-disjoint")],
    });
    await expect(
      adapter.prepareLockedValue({
        operationId: "ambiguous-cap-02",
        funding: disjointFunding,
        amountSats: sats(200n),
        spendingCondition: { lockPublicKey: secondKey.publicKey },
      }),
    ).rejects.toMatchObject({ code: "insufficient_value" });
    expect(backend.submitCalls).toBe(1);
  });

  it("enforces aggregate exposure across durable concurrent adapter instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-cashu-exposure-"));
    const databasePath = join(directory, "cashu-private.sqlite");
    const firstStore = createSqliteCashuPrivateStore(databasePath);
    const secondStore = createSqliteCashuPrivateStore(databasePath);
    try {
      const configuration = {
        testMintUrl: MINT_URL,
        unit: "sat" as const,
        maximumExposureSats: sats(500n),
      };
      const first = createCashuTestMintAdapterWithBackend({
        configuration,
        backend: new FakeCashuBackend(),
        privateStore: firstStore,
      });
      const second = createCashuTestMintAdapterWithBackend({
        configuration,
        backend: new FakeCashuBackend(),
        privateStore: secondStore,
      });
      const lock = spendingKey();
      const refund = spendingKey(REFUND_SECRET);
      const attempts = await Promise.allSettled([
        first.prepareLockedValue({
          operationId: "durable-cap-0001",
          funding: funding(),
          amountSats: sats(350n),
          spendingCondition: { lockPublicKey: lock.publicKey },
        }),
        second.prepareLockedValue({
          operationId: "durable-cap-0002",
          funding: funding(),
          amountSats: sats(200n),
          spendingCondition: { lockPublicKey: refund.publicKey },
        }),
      ]);
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      const rejected = attempts.find((attempt) => attempt.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { code: "insufficient_value", operationStatus: "not_submitted" },
      });
    } finally {
      firstStore.close();
      secondStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("fails closed when durable lock ownership cannot be verified at commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-cashu-lock-loss-"));
    const databasePath = join(directory, "cashu-private.sqlite");
    const store = createSqliteCashuPrivateStore(databasePath);
    try {
      await expect(
        store.withExclusiveLock(MINT_URL, "lock-loss", async () => {
          store.close();
          return "must-not-commit";
        }),
      ).rejects.toMatchObject({
        code: "reconciliation_required",
        operationStatus: "submitted_unknown",
      });
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a durable write before it is made when its lock lease was stolen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-cashu-stale-writer-"));
    const databasePath = join(directory, "cashu-private.sqlite");
    const store = createSqliteCashuPrivateStore(databasePath);
    const competingConnection = new DatabaseSync(databasePath);
    try {
      await expect(
        store.withExclusiveLock(MINT_URL, "stale-writer", async () => {
          competingConnection
            .prepare(
              "UPDATE pact_cashu_private_locks SET owner = ?, expires_at_ms = ? WHERE lock_key = ?",
            )
            .run("new-owner", Date.now() + 30_000, `${MINT_URL}:stale-writer`);
          await store.write(MINT_URL, "must-not-write", { secret: "private" });
        }),
      ).rejects.toMatchObject({
        code: "reconciliation_required",
        operationStatus: "submitted_unknown",
      });
      await expect(store.read(MINT_URL, "must-not-write")).resolves.toBeUndefined();
    } finally {
      competingConnection.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enumerates in-memory store keys within a scope and isolates other scopes", async () => {
    const store = createInMemoryCashuPrivateStore();
    await store.write("transaction", "txn_a", { phase: "accepted" });
    await store.write("transaction", "txn_b", { phase: "funded" });
    await store.write("other-scope", "txn_c", { phase: "x" });
    expect([...(await store.list!("transaction"))].sort()).toEqual(["txn_a", "txn_b"]);
    expect(await store.list!("other-scope")).toEqual(["txn_c"]);
    expect(await store.list!("empty-scope")).toEqual([]);
  });

  it("enumerates durable store keys within a scope across a reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-cashu-list-"));
    const databasePath = join(directory, "cashu-private.sqlite");
    let store = createSqliteCashuPrivateStore(databasePath);
    try {
      await store.write("transaction", "txn_a", { phase: "accepted" });
      await store.write("transaction", "txn_b", { phase: "funded" });
      await store.write(MINT_URL, "exposure-ledger", { version: 1 });
      store.close();
      store = createSqliteCashuPrivateStore(databasePath);
      expect([...(await store.list!("transaction"))].sort()).toEqual(["txn_a", "txn_b"]);
      expect(await store.list!(MINT_URL)).toEqual(["exposure-ledger"]);
      expect(await store.list!("empty-scope")).toEqual([]);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers by operation identity when lock ownership is lost after mint success", async () => {
    const base = createInMemoryCashuPrivateStore();
    let loseOwnership = true;
    const privateStore: CashuPrivateStore = {
      read: (scope, key) => base.read(scope, key),
      write: (scope, key, value) => base.write(scope, key, value),
      withExclusiveLock(scope, key, operation) {
        return base.withExclusiveLock(scope, key, async () => {
          const value = await operation();
          if (loseOwnership && key === "operation:lease-loss-after-submit") {
            loseOwnership = false;
            throw new CashuTestMintError(
              "reconciliation_required",
              "simulated lease ownership loss",
              "submitted_unknown",
              "lease-loss-after-submit",
            );
          }
          return value;
        });
      },
    };
    const backend = new FakeCashuBackend();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(1_000n),
      },
      backend,
      privateStore,
    });
    const request = {
      operationId: "lease-loss-after-submit",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };

    await expect(adapter.prepareLockedValue(request)).rejects.toMatchObject({
      code: "reconciliation_required",
      operationStatus: "submitted_unknown",
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(backend.submitCalls).toBe(1);
  });

  it("does not reset aggregate exposure when the private store is reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-cashu-exposure-restart-"));
    const databasePath = join(directory, "cashu-private.sqlite");
    const configuration = {
      testMintUrl: MINT_URL,
      unit: "sat" as const,
      maximumExposureSats: sats(500n),
    };
    let store = createSqliteCashuPrivateStore(databasePath);
    try {
      const first = createCashuTestMintAdapterWithBackend({
        configuration,
        backend: new FakeCashuBackend(),
        privateStore: store,
      });
      await prepare(first, "restart-cap-0001");
      store.close();

      store = createSqliteCashuPrivateStore(databasePath);
      const restarted = createCashuTestMintAdapterWithBackend({
        configuration,
        backend: new FakeCashuBackend(),
        privateStore: store,
      });
      await expect(
        restarted.prepareLockedValue({
          operationId: "restart-cap-0002",
          funding: funding(),
          amountSats: sats(200n),
          spendingCondition: { lockPublicKey: spendingKey(REFUND_SECRET).publicKey },
        }),
      ).rejects.toMatchObject({
        code: "insufficient_value",
        operationStatus: "not_submitted",
      });
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("retries safely when preparation timed out before submission", async () => {
    const backend = new FakeCashuBackend();
    backend.prepareFailures.push(new CashuPrivateBackendError("timeout", "not_submitted"));
    const { adapter } = harness(backend);
    const key = spendingKey();
    const request = {
      operationId: "retry-before-1",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    };
    await expect(adapter.prepareLockedValue(request)).rejects.toMatchObject({
      code: "mint_timeout",
      operationStatus: "not_submitted",
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(backend.prepareCalls).toBe(2);
    expect(backend.submitCalls).toBe(1);
  });

  it("replays the exact prepared swap instead of treating all-unspent as terminal", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    const { adapter } = harness(backend);
    const key = spendingKey();
    const request = {
      operationId: "retry-after-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    };

    await expect(adapter.prepareLockedValue(request)).resolves.toEqual({
      status: "submitted_unknown",
      outcome: "reconciliation_required",
      operationId: request.operationId,
    });
    expect(backend.submitCalls).toBe(1);

    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "succeeded",
      operationId: request.operationId,
    });
    expect(backend.inspectCalls).toBe(1);
    expect(backend.restoreCalls).toBe(0);
    expect(backend.submitCalls).toBe(2);
  });

  it("keeps pending proofs in reconciliation_required", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    backend.states = [{ state: "pending" }];
    const { adapter } = harness(backend);
    const request = {
      operationId: "pending-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "submitted_unknown",
      outcome: "reconciliation_required",
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "submitted_unknown",
      outcome: "reconciliation_required",
    });
    expect(backend.inspectCalls).toBe(1);
    expect(backend.restoreCalls).toBe(0);
  });

  it("keeps mixed proof states in reconciliation_required", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    const { adapter } = harness(backend);
    const fund = createPrivateCashuFunding({
      mintUrl: MINT_URL,
      unit: "sat",
      proofs: [proof(200n, "mixed-a"), proof(200n, "mixed-b")],
    });
    backend.states = [{ state: "unspent" }, { state: "spent" }];
    const request = {
      operationId: "mixed-01",
      funding: fund,
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "submitted_unknown",
      outcome: "reconciliation_required",
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "submitted_unknown",
      outcome: "reconciliation_required",
    });
    expect(backend.restoreCalls).toBe(0);
  });

  it("does not release exposure merely because one inspection is all-unspent", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(500n),
      },
      backend,
      privateStore: createInMemoryCashuPrivateStore(),
    });
    const request = {
      operationId: "exposure-release-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(
      adapter.prepareLockedValue({
        ...request,
        operationId: "exposure-release-02",
      }),
    ).rejects.toMatchObject({ code: "insufficient_value" });
  });

  it("converts inspectProofStates failure to reconciliation_required", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    backend.inspectThrow = new CashuPrivateBackendError("unavailable", "not_submitted");
    const { adapter } = harness(backend);
    const request = {
      operationId: "inspect-fail-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
  });

  it("converts restore failure to reconciliation_required", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    backend.states = [{ state: "spent" }];
    backend.restoreThrow = new CashuPrivateBackendError("unavailable", "submitted_unknown");
    const { adapter } = harness(backend);
    const request = {
      operationId: "restore-fail-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
  });

  it("repairs stale reserved exposure after not_submitted without released", async () => {
    const baseStore = createInMemoryCashuPrivateStore();
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    const configuration = {
      testMintUrl: MINT_URL,
      unit: "sat" as const,
      maximumExposureSats: sats(500n),
    };
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration,
      backend,
      privateStore: baseStore,
    });
    const request = {
      operationId: "partial-write-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "succeeded",
    });

    await baseStore.write(MINT_URL, "exposure-ledger", {
      version: 1,
      reservations: {
        [request.operationId]: { amountSats: "351", status: "reserved" },
      },
    });

    const fresh = await adapter.prepareLockedValue(request);
    expect(fresh.status).toBe("succeeded");
    expect(backend.submitCalls).toBe(2);
  });

  it("clears stale terminal and orphan exposure reservations before a fresh lock", async () => {
    const baseStore = createInMemoryCashuPrivateStore();
    const backend = new FakeCashuBackend();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(1000n),
      },
      backend,
      privateStore: baseStore,
    });
    await baseStore.write(MINT_URL, "operation:stale-rejected-lock", {
      version: 1,
      fingerprint: "stale-rejected",
      kind: "lock",
      status: "not_submitted",
      errorCode: "insufficient_value",
      allowedPublicKeys: [],
    });
    await baseStore.write(MINT_URL, "operation:stale-failed-lock", {
      version: 1,
      fingerprint: "stale-failed",
      kind: "lock",
      status: "failed_definitively",
      errorCode: "proof_already_spent",
      allowedPublicKeys: [],
    });
    await baseStore.write(MINT_URL, "exposure-ledger", {
      version: 1,
      reservations: {
        "orphan-reservation-0": { amountSats: "351", status: "reserved" },
        "stale-rejected-lock": { amountSats: "300", status: "reserved" },
        "stale-failed-lock": { amountSats: "349", status: "locked" },
      },
    });

    const fresh = await adapter.prepareLockedValue({
      operationId: "fresh-lock-after-stale",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    });
    expect(fresh.status).toBe("succeeded");
    await expect(baseStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "fresh-lock-after-stale": { amountSats: "351", status: "locked" },
      },
    });
  });

  it("retains uncertain submitted_unknown exposure fail-closed inside the cap", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    backend.states = [{ state: "pending" }];
    const baseStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(500n),
      },
      backend,
      privateStore: baseStore,
    });
    await expect(
      adapter.prepareLockedValue({
        operationId: "ambiguous-lock-01",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: spendingKey().publicKey },
      }),
    ).resolves.toMatchObject({ outcome: "reconciliation_required" });

    await expect(
      adapter.prepareLockedValue({
        operationId: "over-cap-lock-01",
        funding: createPrivateCashuFunding({
          mintUrl: MINT_URL,
          unit: "sat",
          proofs: [proof(400n, "uncertain-cap-disjoint")],
        }),
        amountSats: sats(200n),
        spendingCondition: { lockPublicKey: spendingKey().publicKey },
      }),
    ).rejects.toMatchObject({
      code: "insufficient_value",
      operationStatus: "not_submitted",
    });
    expect(backend.submitCalls).toBe(1);
    await expect(baseStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "ambiguous-lock-01": { amountSats: "351", status: "reserved" },
      },
    });
  });

  it("retains a live succeeded lock reservation inside the exposure cap", async () => {
    const backend = new FakeCashuBackend();
    const baseStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(500n),
      },
      backend,
      privateStore: baseStore,
    });
    const live = await adapter.prepareLockedValue({
      operationId: "live-lock-0001",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    });
    expect(live.status).toBe("succeeded");

    await expect(
      adapter.prepareLockedValue({
        operationId: "over-cap-lock-02",
        funding: funding(),
        amountSats: sats(200n),
        spendingCondition: { lockPublicKey: spendingKey().publicKey },
      }),
    ).rejects.toMatchObject({
      code: "insufficient_value",
      operationStatus: "not_submitted",
    });
    await expect(baseStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "live-lock-0001": { amountSats: "351", status: "locked" },
      },
    });
  });

  it("clears a consumed lock reservation left behind by a completed spend", async () => {
    const backend = new FakeCashuBackend();
    const baseStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(500n),
      },
      backend,
      privateStore: baseStore,
    });
    const lockKey = spendingKey();
    const locked = await adapter.prepareLockedValue({
      operationId: "consumed-lock-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    });
    if (locked.status !== "succeeded") throw new Error("lock preparation did not succeed");
    await expect(
      adapter.spendLockedValue({
        operationId: "settling-spend-01",
        handle: locked.handle,
        spendingKey: lockKey,
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    await baseStore.write(MINT_URL, "exposure-ledger", {
      version: 1,
      reservations: {
        "consumed-lock-01": { amountSats: "351", status: "locked" },
      },
    });

    const fresh = await adapter.prepareLockedValue({
      operationId: "fresh-lock-after-consumed",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    });
    expect(fresh.status).toBe("succeeded");
    await expect(baseStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "fresh-lock-after-consumed": { amountSats: "351", status: "locked" },
      },
    });
  });

  it("retains spent-without-restored-output until a competing winner is durable", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    backend.states = [{ state: "spent" }];
    const privateStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(500n),
      },
      backend,
      privateStore,
    });
    const request = {
      operationId: "lost-competing-spend",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "submitted_unknown",
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    expect(backend.submitCalls).toBe(1);
    expect(backend.restoreCalls).toBe(2);
  });

  it("reuses stable value handles when success persistence fails before reconciliation", async () => {
    const base = createInMemoryCashuPrivateStore();
    const valueWrites: string[] = [];
    let failSuccess = true;
    const privateStore: CashuPrivateStore = {
      read: (scope, key) => base.read(scope, key),
      async write(scope, key, value) {
        if (key.startsWith("value:")) valueWrites.push(key);
        if (
          failSuccess &&
          key === "operation:stable-completion" &&
          (value as { status?: unknown }).status === "succeeded"
        ) {
          failSuccess = false;
          throw new Error("fault after value persistence");
        }
        await base.write(scope, key, value);
      },
      withExclusiveLock: (scope, key, operation) => base.withExclusiveLock(scope, key, operation),
    };
    const backend = new FakeCashuBackend();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: MINT_URL, unit: "sat", maximumExposureSats: sats(1_000n) },
      backend,
      privateStore,
    });
    const request = {
      operationId: "stable-completion",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "submitted_unknown",
    });
    backend.states = [{ state: "spent" }];
    backend.restoreSucceeds = true;
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({ status: "succeeded" });
    expect(new Set(valueWrites).size).toBe(2);
    expect(valueWrites).toHaveLength(4);
  });

  it("retains the NUT-11 key only while reconciliation requires it", async () => {
    const privateStore = createInMemoryCashuPrivateStore();
    const backend = new FakeCashuBackend();
    const configuration = {
      testMintUrl: MINT_URL,
      unit: "sat" as const,
      maximumExposureSats: sats(1_000n),
    };
    const adapter = createCashuTestMintAdapterWithBackend({ configuration, backend, privateStore });
    const locked = await prepare(adapter, "key-lifecycle-lock");
    backend.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    const request = {
      operationId: "key-lifecycle-spend",
      handle: locked.result.handle,
      spendingKey: locked.lockKey,
    };
    await expect(adapter.spendLockedValue(request)).resolves.toMatchObject({
      status: "submitted_unknown",
    });
    expect(JSON.stringify(await privateStore.read(MINT_URL, "operation:key-lifecycle-spend")))
      .toContain(LOCK_SECRET);

    backend.states = [{ state: "spent" }];
    backend.restoreSucceeds = true;
    await expect(adapter.spendLockedValue(request)).resolves.toMatchObject({ status: "succeeded" });
    expect(JSON.stringify(await privateStore.read(MINT_URL, "operation:key-lifecycle-spend")))
      .not.toContain(LOCK_SECRET);
  });

  it("uses NUT-07 and NUT-09 to reconcile a submitted operation", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    backend.states = [{ state: "spent" }];
    backend.restoreSucceeds = true;
    const { adapter } = harness(backend);
    const key = spendingKey();
    const request = {
      operationId: "reconcile-0001",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    };

    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "submitted_unknown",
    });
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(backend.submitCalls).toBe(1);
    expect(backend.inspectCalls).toBe(1);
    expect(backend.restoreCalls).toBe(1);
  });

  it("reconciles from private stored context after the adapter is reconstructed", async () => {
    const privateStore = createInMemoryCashuPrivateStore();
    const firstBackend = new FakeCashuBackend();
    firstBackend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    const configuration = {
      testMintUrl: MINT_URL,
      unit: "sat" as const,
      maximumExposureSats: sats(1_000n),
    };
    const firstAdapter = createCashuTestMintAdapterWithBackend({
      configuration,
      backend: firstBackend,
      privateStore,
    });
    const key = spendingKey();
    const request = {
      operationId: "restart-00001",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    };
    await expect(firstAdapter.prepareLockedValue(request)).resolves.toMatchObject({
      status: "submitted_unknown",
    });

    const secondBackend = new FakeCashuBackend();
    secondBackend.states = [{ state: "spent" }];
    secondBackend.restoreSucceeds = true;
    const reconstructedAdapter = createCashuTestMintAdapterWithBackend({
      configuration,
      backend: secondBackend,
      privateStore,
    });
    await expect(
      reconstructedAdapter.prepareLockedValue({ ...request, funding: funding() }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(secondBackend.submitCalls).toBe(0);
    expect(secondBackend.inspectCalls).toBe(1);
    expect(secondBackend.restoreCalls).toBe(1);
  });

  it("reconciles and retains payout/change handles after a durable-store restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-cashu-private-"));
    const databasePath = join(directory, "cashu-private.sqlite");
    try {
      const configuration = {
        testMintUrl: MINT_URL,
        unit: "sat" as const,
        maximumExposureSats: sats(1_000n),
      };
      const firstStore = createSqliteCashuPrivateStore(databasePath);
      const firstBackend = new FakeCashuBackend();
      firstBackend.submitFailures.push(
        new CashuPrivateBackendError("timeout", "submitted_unknown"),
      );
      const firstAdapter = createCashuTestMintAdapterWithBackend({
        configuration,
        backend: firstBackend,
        privateStore: firstStore,
      });
      const lockKey = spendingKey();
      const request = {
        operationId: "durable-reconcile-01",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: lockKey.publicKey },
      };
      await expect(firstAdapter.prepareLockedValue(request)).resolves.toMatchObject({
        outcome: "reconciliation_required",
      });
      firstStore.close();

      const secondStore = createSqliteCashuPrivateStore(databasePath);
      const secondBackend = new FakeCashuBackend();
      secondBackend.states = [{ state: "spent" }];
      secondBackend.restoreSucceeds = true;
      const secondAdapter = createCashuTestMintAdapterWithBackend({
        configuration,
        backend: secondBackend,
        privateStore: secondStore,
      });
      const reconciled = await secondAdapter.prepareLockedValue({
        ...request,
        funding: funding(),
      });
      expect(reconciled).toMatchObject({ status: "succeeded" });
      if (reconciled.status !== "succeeded") throw new Error("expected reconciled success");
      expect(reconciled.changeHandle).toBeDefined();
      secondStore.close();

      const thirdStore = createSqliteCashuPrivateStore(databasePath);
      const thirdBackend = new FakeCashuBackend();
      const thirdAdapter = createCashuTestMintAdapterWithBackend({
        configuration,
        backend: thirdBackend,
        privateStore: thirdStore,
      });
      await expect(thirdAdapter.inspectProofState(reconciled.handle)).resolves.toMatchObject({
        state: "unspent",
      });
      await expect(
        thirdAdapter.inspectProofState(reconciled.changeHandle!),
      ).resolves.toMatchObject({ state: "unspent" });
      thirdStore.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("returns reconciliation_required for malformed post-submit accounting", async () => {
    const backend = new FakeCashuBackend();
    backend.malformedSubmit = true;
    const { adapter } = harness(backend);
    const key = spendingKey();
    await expect(
      adapter.prepareLockedValue({
        operationId: "malformed-0001",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: key.publicKey },
      }),
    ).resolves.toMatchObject({
      status: "submitted_unknown",
      outcome: "reconciliation_required",
    });
  });

  it("deduplicates successful retries and rejects operation-id parameter reuse", async () => {
    const { adapter, backend } = harness();
    const key = spendingKey();
    const request = {
      operationId: "duplicate-0001",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    };
    const first = await adapter.prepareLockedValue(request);
    const duplicate = await adapter.prepareLockedValue(request);
    expect(duplicate).toEqual(first);
    expect(backend.submitCalls).toBe(1);

    await expect(
      adapter.prepareLockedValue({ ...request, amountSats: sats(349n) }),
    ).rejects.toMatchObject({ code: "operation_rejected" });
    expect(backend.submitCalls).toBe(1);
  });

  it("rejects operation-id reuse after a not-submitted failure", async () => {
    const { adapter, backend } = harness();
    const key = spendingKey();
    await expect(
      adapter.prepareLockedValue({
        operationId: "failed-reuse-1",
        funding: funding(20n),
        amountSats: sats(50n),
        spendingCondition: { lockPublicKey: key.publicKey },
      }),
    ).rejects.toMatchObject({ code: "insufficient_value" });
    await expect(
      adapter.prepareLockedValue({
        operationId: "failed-reuse-1",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: key.publicKey },
      }),
    ).rejects.toMatchObject({ code: "operation_rejected" });
    expect(backend.submitCalls).toBe(0);
  });

  it("remembers definitive failures and does not resubmit them", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("rejected", "failed_definitively"),
    );
    const { adapter } = harness(backend);
    const key = spendingKey();
    const request = {
      operationId: "definite-0001",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    };
    await expect(adapter.prepareLockedValue(request)).rejects.toMatchObject({
      code: "operation_rejected",
      operationStatus: "failed_definitively",
    });
    await expect(adapter.prepareLockedValue(request)).rejects.toMatchObject({
      code: "operation_rejected",
      operationStatus: "failed_definitively",
    });
    expect(backend.submitCalls).toBe(1);
  });
});

describe("Cashu test-mint privacy boundary", () => {
  it("prevents direct serialization of private bearer and key material", () => {
    expect(() => JSON.stringify(funding())).toThrowError(CashuTestMintError);
    expect(() => JSON.stringify(spendingKey())).toThrowError(CashuTestMintError);
    expect(() => JSON.stringify(createInMemoryCashuPrivateStore())).toThrowError(
      CashuTestMintError,
    );
  });

  it("redacts library failures and keeps secrets out of results and captured logs", async () => {
    const marker =
      "cashuA_PRIVATE_TOKEN private-proof-secret private-witness private-blinding-marker mint-credential";
    const backend = new FakeCashuBackend();
    backend.rawFailureMarker = marker;
    const consoleSpies = (["error", "warn", "info", "debug", "log"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const { adapter } = harness(backend);
    const key = spendingKey();
    let caught: unknown;
    try {
      await adapter.prepareLockedValue({
        operationId: "privacy-00001",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: key.publicKey },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CashuTestMintError);
    const serializedError = JSON.stringify(caught);
    expect(serializedError).not.toContain(marker);
    expect(serializedError).not.toContain("private-proof-secret");
    expect(serializedError).not.toContain("private-witness");
    expect("cause" in (caught as object)).toBe(false);
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);

    backend.rawFailureMarker = undefined;
    const successful = await adapter.prepareLockedValue({
      operationId: "privacy-00002",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: key.publicKey },
    });
    const serializedResult = JSON.stringify(successful, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    for (const secret of [
      "cashuA_PRIVATE_TOKEN",
      "private-proof-secret",
      "private-witness",
      "private-blinding-marker",
      LOCK_SECRET,
      "mint-credential",
    ]) {
      expect(serializedResult).not.toContain(secret);
    }
    consoleSpies.forEach((spy) => spy.mockRestore());
  });
});

describe("write-ahead submission boundary", () => {
  it("reconcile-only preparation rejects absent lock and spend operations before backend preparation", async () => {
    const backend = new FakeCashuBackend();
    const { adapter } = harness(backend);
    await expect(adapter.prepareLockedValue({
      operationId: "reconcile-only-lock",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
      allowFreshPreparation: false,
    })).rejects.toMatchObject({ code: "operation_rejected", operationStatus: "not_submitted" });
    expect(backend.prepareCalls).toBe(0);
    expect(backend.submitCalls).toBe(0);

    const locked = await prepare(adapter, "reconcile-source-lock");
    const callsAfterLock = backend.prepareCalls;
    await expect(adapter.spendLockedValue({
      operationId: "reconcile-only-spend",
      handle: locked.result.handle,
      spendingKey: locked.lockKey,
      allowFreshPreparation: false,
    })).rejects.toMatchObject({ code: "operation_rejected", operationStatus: "not_submitted" });
    expect(backend.prepareCalls).toBe(callsAfterLock);
    expect(backend.submitCalls).toBe(1);
  });

  it("persists submitted_unknown+prepared BEFORE backend.submit is entered", async () => {
    const b = new FakeCashuBackend();
    const ps = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: `${MINT_URL}/`, unit: "sat", maximumExposureSats: sats(1_000n) },
      backend: b, privateStore: ps,
    });
    let captured: unknown;
    let capturedExposure: unknown;
    b.onSubmitEntry = async () => {
      captured = await ps.read(MINT_URL, "operation:write-ahead-01");
      capturedExposure = await ps.read(MINT_URL, "exposure-ledger");
    };
    await adapter.prepareLockedValue({
      operationId: "write-ahead-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    });
    expect(b.submitCalls).toBe(1);
    expect(captured).toBeDefined();
    expect((captured as { status: string }).status).toBe("submitted_unknown");
    expect((captured as { prepared?: unknown }).prepared).toBeDefined();
    expect(capturedExposure).toEqual({
      version: 1,
      reservations: {
        "write-ahead-01": { amountSats: "351", status: "reserved" },
      },
    });
  });

  it("preempts an all-unspent legacy ambiguity with a durable recovery winner before admitting new exposure", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    const privateStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(500n),
      },
      backend,
      privateStore,
    });
    const lockKey = spendingKey();
    await expect(adapter.prepareLockedValue({
      operationId: "legacy-ambiguous-preempt-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    })).resolves.toMatchObject({ outcome: "reconciliation_required" });

    const fresh = await adapter.prepareLockedValue({
      operationId: "fresh-after-preempt-01",
      funding: createPrivateCashuFunding({
        mintUrl: MINT_URL,
        unit: "sat",
        proofs: [proof(400n, "fresh-after-preempt")],
      }),
      amountSats: sats(200n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    });
    expect(fresh.status).toBe("succeeded");
    await expect(privateStore.read(MINT_URL, "operation:legacy-ambiguous-preempt-01"))
      .resolves.toMatchObject({ status: "failed_definitively", errorCode: "proof_already_spent" });
    await expect(privateStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "fresh-after-preempt-01": { amountSats: "201", status: "locked" },
      },
    });
    expect(backend.inspectCalls).toBe(1);
    expect(backend.prepareCalls).toBe(3);
    expect(backend.submitCalls).toBe(3);
  });

  it("keeps the original lock counted when it wins the late-completion race against recovery", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
      new CashuPrivateBackendError("proof_already_spent", "submitted_unknown"),
    );
    vi.spyOn(backend, "restore").mockImplementation(async (prepared) => {
      backend.restoreCalls += 1;
      return prepared.kind === "lock" ? backend.resultFor(prepared) : undefined;
    });
    const privateStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: MINT_URL, unit: "sat", maximumExposureSats: sats(500n) },
      backend,
      privateStore,
    });
    const ambiguous = {
      operationId: "late-race-original-wins",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    await expect(adapter.prepareLockedValue(ambiguous)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    const fresh = {
      operationId: "late-race-fresh-lock",
      funding: createPrivateCashuFunding({
        mintUrl: MINT_URL,
        unit: "sat",
        proofs: [proof(400n, "late-race-fresh")],
      }),
      amountSats: sats(200n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    await expect(adapter.prepareLockedValue(fresh)).rejects.toMatchObject({ code: "insufficient_value" });

    backend.states = [{ state: "spent" }];
    await expect(adapter.prepareLockedValue(fresh)).rejects.toMatchObject({ code: "insufficient_value" });
    await expect(privateStore.read(MINT_URL, "operation:late-race-original-wins"))
      .resolves.toMatchObject({ status: "succeeded" });
    await expect(privateStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "late-race-original-wins": { amountSats: "351", status: "locked" },
      },
    });
    expect(backend.restoreCalls).toBe(2);
    vi.mocked(backend.restore).mockRestore();
  });

  it("finishes recovery idempotently after a crash between recovery success and old-lock terminality", async () => {
    const baseStore = createInMemoryCashuPrivateStore();
    let failOldTerminalWrite = true;
    const privateStore: CashuPrivateStore = {
      read: (scope, key) => baseStore.read(scope, key),
      async write(scope, key, value) {
        if (
          failOldTerminalWrite &&
          key === "operation:crash-safe-old-lock" &&
          (value as { status?: unknown }).status === "failed_definitively"
        ) {
          failOldTerminalWrite = false;
          throw new Error("simulated crash before terminal old-lock write");
        }
        await baseStore.write(scope, key, value);
      },
      withExclusiveLock: (scope, key, operation) => baseStore.withExclusiveLock(scope, key, operation),
    };
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: MINT_URL, unit: "sat", maximumExposureSats: sats(500n) },
      backend,
      privateStore,
    });
    await expect(adapter.prepareLockedValue({
      operationId: "crash-safe-old-lock",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    })).resolves.toMatchObject({ outcome: "reconciliation_required" });
    const fresh = {
      operationId: "crash-safe-fresh-lock",
      funding: createPrivateCashuFunding({
        mintUrl: MINT_URL,
        unit: "sat",
        proofs: [proof(400n, "crash-safe-fresh")],
      }),
      amountSats: sats(200n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };

    await expect(adapter.prepareLockedValue(fresh)).rejects.toMatchObject({ code: "insufficient_value" });
    expect(backend.submitCalls).toBe(2);
    await expect(adapter.prepareLockedValue(fresh)).resolves.toMatchObject({ status: "succeeded" });
    expect(backend.submitCalls).toBe(3);
    await expect(baseStore.read(MINT_URL, "operation:crash-safe-old-lock"))
      .resolves.toMatchObject({ status: "failed_definitively" });
    await expect(baseStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "crash-safe-fresh-lock": { amountSats: "201", status: "locked" },
      },
    });
  });

  // The production blockage originates from records written by pre-PR#48 code,
  // before the write-ahead recovery model existed. These seed the exact legacy
  // persisted shape DIRECTLY into the store — a `submitted_unknown` lock with
  // persisted `prepared.inputProofs`/`opaque`, a `locked` exposure reservation,
  // and no recovery metadata — and prove the new mechanism resolves them
  // without deletion, discounting, or trusting an UNSPENT snapshot.
  function seedLegacyAmbiguousLock(
    store: CashuPrivateStore,
    options: {
      readonly operationId: string;
      readonly lockPublicKey: string;
      readonly inputProofs: readonly Proof[];
      readonly requestedAmountSats: bigint;
      readonly reservationSats: bigint;
      readonly includeExposureAmount?: boolean;
      readonly includePrepared?: boolean;
    },
  ): Promise<void> {
    const prepared = {
      kind: "lock" as const,
      inputProofs: serializeProofs([...options.inputProofs]),
      requestedAmountSats: options.requestedAmountSats.toString(),
      // Older production records predate the exposure/amount split; omit the
      // field to exercise the `requestedAmountSats` fallback when requested.
      ...(options.includeExposureAmount === false
        ? {}
        : { exposureAmountSats: options.reservationSats.toString() }),
      opaque: { privateBlindingMaterial: "legacy-blinding-marker" },
    };
    return Promise.all([
      store.write(MINT_URL, `operation:${options.operationId}`, {
        version: 1,
        fingerprint: JSON.stringify({
          kind: "lock",
          funding: `legacy-funding-${options.operationId}`,
          amount: options.requestedAmountSats.toString(),
          condition: { lockPublicKey: options.lockPublicKey },
        }),
        kind: "lock",
        status: "submitted_unknown",
        ...(options.includePrepared === false ? {} : { prepared }),
        allowedPublicKeys: [options.lockPublicKey],
      }),
      store.write(MINT_URL, "exposure-ledger", {
        version: 1,
        reservations: {
          [options.operationId]: {
            amountSats: options.reservationSats.toString(),
            status: "locked",
          },
        },
      }),
    ]).then(() => undefined);
  }

  function legacyAdapter(backend: FakeCashuBackend, store: CashuPrivateStore) {
    return createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: MINT_URL, unit: "sat", maximumExposureSats: sats(500n) },
      backend,
      privateStore: store,
    });
  }

  it("heals a directly-seeded pre-PR#48 legacy ambiguous lock with a durable recovery winner", async () => {
    const backend = new FakeCashuBackend();
    const store = createInMemoryCashuPrivateStore();
    const lockKey = spendingKey();
    await seedLegacyAmbiguousLock(store, {
      operationId: "legacy-prefix-ambiguous-win",
      lockPublicKey: lockKey.publicKey,
      inputProofs: [proof(400n, "legacy-input-win")],
      requestedAmountSats: 350n,
      reservationSats: 351n,
    });
    const adapter = legacyAdapter(backend, store);

    const fresh = await adapter.prepareLockedValue({
      operationId: "fresh-after-legacy-win",
      funding: createPrivateCashuFunding({
        mintUrl: MINT_URL,
        unit: "sat",
        proofs: [proof(400n, "fresh-after-legacy-win")],
      }),
      amountSats: sats(200n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    });
    expect(fresh.status).toBe("succeeded");
    // The legacy lock is terminalized via a shared single-use input, never by
    // an UNSPENT observation, and only after recovery success is durable.
    await expect(store.read(MINT_URL, "operation:legacy-prefix-ambiguous-win"))
      .resolves.toMatchObject({ status: "failed_definitively", errorCode: "proof_already_spent" });
    await expect(store.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "fresh-after-legacy-win": { amountSats: "201", status: "locked" },
      },
    });
    // One recovery spend (shared inputs) + one fresh lock submission.
    expect(backend.submitCalls).toBe(2);
    expect(backend.prepareCalls).toBe(2);
  });

  it("preserves a directly-seeded legacy lock as counted when the original lock won", async () => {
    const backend = new FakeCashuBackend();
    backend.states = [{ state: "spent" }];
    vi.spyOn(backend, "restore").mockImplementation(async (prepared) => {
      backend.restoreCalls += 1;
      return prepared.kind === "lock" ? backend.resultFor(prepared) : undefined;
    });
    const store = createInMemoryCashuPrivateStore();
    const lockKey = spendingKey();
    await seedLegacyAmbiguousLock(store, {
      operationId: "legacy-prefix-original-won",
      lockPublicKey: lockKey.publicKey,
      inputProofs: [proof(400n, "legacy-input-original")],
      requestedAmountSats: 350n,
      reservationSats: 351n,
    });
    const adapter = legacyAdapter(backend, store);

    await expect(adapter.prepareLockedValue({
      operationId: "fresh-after-legacy-original",
      funding: createPrivateCashuFunding({
        mintUrl: MINT_URL,
        unit: "sat",
        proofs: [proof(400n, "fresh-after-legacy-original")],
      }),
      amountSats: sats(200n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    })).rejects.toMatchObject({ code: "insufficient_value" });
    // NUT-09 restoration proved the original lock won; exposure stays counted.
    await expect(store.read(MINT_URL, "operation:legacy-prefix-original-won"))
      .resolves.toMatchObject({ status: "succeeded" });
    await expect(store.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "legacy-prefix-original-won": { amountSats: "351", status: "locked" },
      },
    });
    expect(backend.submitCalls).toBe(0);
    vi.mocked(backend.restore).mockRestore();
  });

  it("retains a directly-seeded legacy lock fail-closed when proof states are not yet terminal", async () => {
    const backend = new FakeCashuBackend();
    backend.states = [{ state: "pending" }];
    const store = createInMemoryCashuPrivateStore();
    const lockKey = spendingKey();
    await seedLegacyAmbiguousLock(store, {
      operationId: "legacy-prefix-pending",
      lockPublicKey: lockKey.publicKey,
      inputProofs: [proof(400n, "legacy-input-pending")],
      requestedAmountSats: 350n,
      reservationSats: 351n,
      includeExposureAmount: false,
    });
    const adapter = legacyAdapter(backend, store);

    await expect(adapter.prepareLockedValue({
      operationId: "fresh-after-legacy-pending",
      funding: createPrivateCashuFunding({
        mintUrl: MINT_URL,
        unit: "sat",
        proofs: [proof(400n, "fresh-after-legacy-pending")],
      }),
      amountSats: sats(200n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    })).rejects.toMatchObject({ code: "insufficient_value" });
    await expect(store.read(MINT_URL, "operation:legacy-prefix-pending"))
      .resolves.toMatchObject({ status: "submitted_unknown" });
    await expect(store.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "legacy-prefix-pending": { amountSats: "351", status: "locked" },
      },
    });
    expect(backend.submitCalls).toBe(0);
  });

  it("retains a directly-seeded legacy lock fail-closed when recovery metadata is insufficient", async () => {
    const backend = new FakeCashuBackend();
    const store = createInMemoryCashuPrivateStore();
    const lockKey = spendingKey();
    await seedLegacyAmbiguousLock(store, {
      operationId: "legacy-prefix-no-prepared",
      lockPublicKey: lockKey.publicKey,
      inputProofs: [proof(400n, "legacy-input-missing")],
      requestedAmountSats: 350n,
      reservationSats: 351n,
      includePrepared: false,
    });
    const adapter = legacyAdapter(backend, store);

    await expect(adapter.prepareLockedValue({
      operationId: "fresh-after-legacy-missing",
      funding: createPrivateCashuFunding({
        mintUrl: MINT_URL,
        unit: "sat",
        proofs: [proof(400n, "fresh-after-legacy-missing")],
      }),
      amountSats: sats(200n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    })).rejects.toMatchObject({ code: "insufficient_value" });
    // Without persisted inputs there is no terminality fence; never discount.
    await expect(store.read(MINT_URL, "operation:legacy-prefix-no-prepared"))
      .resolves.toMatchObject({ status: "submitted_unknown" });
    await expect(store.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "legacy-prefix-no-prepared": { amountSats: "351", status: "locked" },
      },
    });
    expect(backend.submitCalls).toBe(0);
    expect(backend.inspectCalls).toBe(0);
  });

  it("never submits or leaks exposure when the submission-capable operation checkpoint fails", async () => {
    const backend = new FakeCashuBackend();
    const base = createInMemoryCashuPrivateStore();
    const store: CashuPrivateStore = {
      read: (scope, key) => base.read(scope, key),
      async write(scope, key, value) {
        if (
          key === "operation:write-ahead-failure-01" &&
          (value as { status?: unknown }).status === "submitted_unknown"
        ) {
          throw new Error("simulated process loss before submission checkpoint");
        }
        await base.write(scope, key, value);
      },
      withExclusiveLock: (scope, key, operation) => base.withExclusiveLock(scope, key, operation),
    };
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: `${MINT_URL}/`,
        unit: "sat",
        maximumExposureSats: sats(1_000n),
      },
      backend,
      privateStore: store,
    });

    await expect(adapter.prepareLockedValue({
      operationId: "write-ahead-failure-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    })).rejects.toMatchObject({ code: "operation_rejected" });
    expect(backend.submitCalls).toBe(0);
    await expect(base.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {},
    });
  });

  it("re-establishes a missing restart reservation before an exact replay can bypass the cap", async () => {
    const base = createInMemoryCashuPrivateStore();
    const setupBackend = new FakeCashuBackend();
    const setup = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: `${MINT_URL}/`,
        unit: "sat",
        maximumExposureSats: sats(2_000n),
      },
      backend: setupBackend,
      privateStore: base,
    });
    await setup.prepareLockedValue({
      operationId: "restart-gap-active-01",
      funding: createPrivateCashuFunding({
        mintUrl: MINT_URL,
        unit: "sat",
        proofs: [proof(800n, "restart-gap-active-proof")],
      }),
      amountSats: sats(650n),
      spendingCondition: { lockPublicKey: spendingKey(REFUND_SECRET).publicKey },
    });
    setupBackend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    const request = {
      operationId: "restart-gap-ambiguous-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    await expect(setup.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });

    const stored = await base.read(MINT_URL, "operation:restart-gap-ambiguous-01") as
      Record<string, unknown>;
    await base.write(MINT_URL, "operation:restart-gap-ambiguous-01", {
      ...stored,
      status: "not_submitted",
    });
    await base.write(MINT_URL, "exposure-ledger", {
      version: 1,
      reservations: {
        "restart-gap-active-01": { amountSats: "651", status: "locked" },
      },
    });

    const restartedBackend = new FakeCashuBackend();
    const restarted = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: `${MINT_URL}/`,
        unit: "sat",
        maximumExposureSats: sats(1_000n),
      },
      backend: restartedBackend,
      privateStore: base,
    });
    await expect(restarted.prepareLockedValue(request)).rejects.toMatchObject({
      code: "insufficient_value",
      operationStatus: "not_submitted",
    });
    expect(restartedBackend.inspectCalls).toBe(0);
    expect(restartedBackend.submitCalls).toBe(0);
  });

  it("persists spend prepared state before submit and restores after post-mint completion loss", async () => {
    const base = createInMemoryCashuPrivateStore();
    let failSpendSuccessWrite = true;
    const store: CashuPrivateStore = {
      read: (scope, key) => base.read(scope, key),
      async write(scope, key, value) {
        if (
          failSpendSuccessWrite &&
          key === "operation:spend-boundary-01" &&
          (value as { status?: unknown }).status === "succeeded"
        ) {
          failSpendSuccessWrite = false;
          throw new Error("simulated process loss after mint acceptance");
        }
        await base.write(scope, key, value);
      },
      withExclusiveLock: (scope, key, operation) => base.withExclusiveLock(scope, key, operation),
    };
    const configuration = {
      testMintUrl: `${MINT_URL}/`,
      unit: "sat" as const,
      maximumExposureSats: sats(1_000n),
    };
    const firstBackend = new FakeCashuBackend();
    const first = createCashuTestMintAdapterWithBackend({
      configuration,
      backend: firstBackend,
      privateStore: store,
    });
    const locked = await prepare(first, "spend-boundary-lock");
    let atSubmit: unknown;
    firstBackend.onSubmitEntry = async () => {
      atSubmit = await base.read(MINT_URL, "operation:spend-boundary-01");
    };
    const request = {
      operationId: "spend-boundary-01",
      handle: locked.result.handle,
      spendingKey: locked.lockKey,
    };
    await expect(first.spendLockedValue(request)).resolves.toMatchObject({
      status: "submitted_unknown",
    });
    expect(atSubmit).toMatchObject({ status: "not_submitted", prepared: expect.any(Object) });

    const restartedBackend = new FakeCashuBackend();
    restartedBackend.states = [{ state: "spent" }];
    restartedBackend.restoreSucceeds = true;
    const restarted = createCashuTestMintAdapterWithBackend({
      configuration,
      backend: restartedBackend,
      privateStore: store,
    });
    await expect(restarted.spendLockedValue(request)).resolves.toMatchObject({ status: "succeeded" });
    expect(restartedBackend.inspectCalls).toBe(1);
    expect(restartedBackend.restoreCalls).toBe(1);
    expect(restartedBackend.submitCalls).toBe(0);
  });

  it("restarts exact-swap recovery when the final operation-state write fails", async () => {
    const base = createInMemoryCashuPrivateStore();
    let failCleanupWrite = true;
    const store: CashuPrivateStore = {
      read: (scope, key) => base.read(scope, key),
      async write(scope, key, value) {
        if (
          failCleanupWrite &&
          key === "operation:cleanup-restart-01" &&
          (value as { status?: unknown }).status === "succeeded"
        ) {
          failCleanupWrite = false;
          throw new Error("simulated cleanup checkpoint failure");
        }
        await base.write(scope, key, value);
      },
      withExclusiveLock: (scope, key, operation) => base.withExclusiveLock(scope, key, operation),
    };
    const configuration = {
      testMintUrl: `${MINT_URL}/`,
      unit: "sat" as const,
      maximumExposureSats: sats(500n),
    };
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    const request = {
      operationId: "cleanup-restart-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    const first = createCashuTestMintAdapterWithBackend({ configuration, backend, privateStore: store });
    await expect(first.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    await expect(first.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    expect(await base.read(MINT_URL, "operation:cleanup-restart-01")).toMatchObject({
      status: "submitted_unknown",
      prepared: expect.any(Object),
    });
    expect(await base.read(MINT_URL, "exposure-ledger")).toEqual({
      version: 1,
      reservations: {
        "cleanup-restart-01": { amountSats: "351", status: "locked" },
      },
    });

    const restartedBackend = new FakeCashuBackend();
    restartedBackend.states = [{ state: "spent" }];
    restartedBackend.restoreSucceeds = true;
    const restarted = createCashuTestMintAdapterWithBackend({
      configuration,
      backend: restartedBackend,
      privateStore: store,
    });
    await expect(restarted.prepareLockedValue(request)).resolves.toMatchObject({ status: "succeeded" });
    expect(restartedBackend.submitCalls).toBe(0);
    expect(restartedBackend.restoreCalls).toBe(1);
  });

  it("retains spent inputs without restored outputs across restart", async () => {
    const base = createInMemoryCashuPrivateStore();
    let failCleanupWrite = true;
    const store: CashuPrivateStore = {
      read: (scope, key) => base.read(scope, key),
      async write(scope, key, value) {
        if (
          failCleanupWrite &&
          key === "operation:restore-cleanup-restart-01" &&
          (value as { status?: unknown }).status === "failed_definitively" &&
          (value as { prepared?: unknown }).prepared === undefined
        ) {
          failCleanupWrite = false;
          throw new Error("simulated failed-restore cleanup checkpoint failure");
        }
        await base.write(scope, key, value);
      },
      withExclusiveLock: (scope, key, operation) => base.withExclusiveLock(scope, key, operation),
    };
    const configuration = {
      testMintUrl: `${MINT_URL}/`,
      unit: "sat" as const,
      maximumExposureSats: sats(500n),
    };
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    backend.states = [{ state: "spent" }];
    backend.restoreSucceeds = false;
    const request = {
      operationId: "restore-cleanup-restart-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    const first = createCashuTestMintAdapterWithBackend({ configuration, backend, privateStore: store });
    await expect(first.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    await expect(first.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    expect(await base.read(MINT_URL, "operation:restore-cleanup-restart-01")).toMatchObject({
      status: "submitted_unknown",
      prepared: expect.any(Object),
    });
    expect(await base.read(MINT_URL, "exposure-ledger")).toEqual({
      version: 1,
      reservations: {
        "restore-cleanup-restart-01": { amountSats: "351", status: "reserved" },
      },
    });

    const restarted = createCashuTestMintAdapterWithBackend({ configuration, backend, privateStore: store });
    await expect(restarted.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    expect(await base.read(MINT_URL, "exposure-ledger")).toEqual({
      version: 1,
      reservations: {
        "restore-cleanup-restart-01": { amountSats: "351", status: "reserved" },
      },
    });
  });

  it("retains exposure if definitive-result persistence fails before release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-definitive-cleanup-"));
    const databasePath = join(directory, "cashu-private.sqlite");
    const configuration = {
      testMintUrl: `${MINT_URL}/`,
      unit: "sat" as const,
      maximumExposureSats: sats(500n),
    };
    const request = {
      operationId: "definitive-cleanup-restart-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
      allowFreshPreparation: false,
    };
    const firstStore = createSqliteCashuPrivateStore(databasePath);
    let failFinalOperationWrite = true;
    const interruptedStore: CashuPrivateStore = {
      read: (scope, key) => firstStore.read(scope, key),
      async write(scope, key, value) {
        if (
          failFinalOperationWrite &&
          key === "operation:definitive-cleanup-restart-01" &&
          (value as { status?: unknown }).status === "failed_definitively" &&
          (value as { prepared?: unknown }).prepared === undefined
        ) {
          failFinalOperationWrite = false;
          throw new Error("simulated death after exposure release");
        }
        await firstStore.write(scope, key, value);
      },
      withExclusiveLock: (scope, key, operation) =>
        firstStore.withExclusiveLock(scope, key, operation),
    };
    const firstBackend = new FakeCashuBackend();
    firstBackend.submitFailures.push(
      new CashuPrivateBackendError("rejected", "failed_definitively"),
    );
    try {
      const first = createCashuTestMintAdapterWithBackend({
        configuration,
        backend: firstBackend,
        privateStore: interruptedStore,
      });
      await expect(first.prepareLockedValue({ ...request, allowFreshPreparation: true }))
        .rejects.toMatchObject({ code: "operation_rejected" });
      expect(firstBackend.submitCalls).toBe(1);
      await expect(firstStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
        version: 1,
        reservations: {
          "definitive-cleanup-restart-01": { amountSats: "351", status: "reserved" },
        },
      });
      await expect(
        firstStore.read(MINT_URL, "operation:definitive-cleanup-restart-01"),
      ).resolves.toMatchObject({
        status: "submitted_unknown",
        prepared: expect.any(Object),
      });
    } finally {
      firstStore.close();
    }

    const reopened = createSqliteCashuPrivateStore(databasePath);
    try {
      const restartedBackend = new FakeCashuBackend();
      restartedBackend.states = [{ state: "unspent" }];
      const restarted = createCashuTestMintAdapterWithBackend({
        configuration,
        backend: restartedBackend,
        privateStore: reopened,
      });
      await expect(restarted.prepareLockedValue(request)).resolves.toMatchObject({
        outcome: "reconciliation_required",
      });
      expect(restartedBackend.inspectCalls).toBe(1);
      expect(restartedBackend.submitCalls).toBe(0);
      await expect(reopened.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
        version: 1,
        reservations: {
          "definitive-cleanup-restart-01": { amountSats: "351", status: "reserved" },
        },
      });
      await expect(
        reopened.read(MINT_URL, "operation:definitive-cleanup-restart-01"),
      ).resolves.toMatchObject({ status: "submitted_unknown" });
    } finally {
      reopened.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("routes legacy not_submitted+prepared through reconcilePrepared", async () => {
    const b = new FakeCashuBackend();
    const ps = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: `${MINT_URL}/`, unit: "sat", maximumExposureSats: sats(1_000n) },
      backend: b, privateStore: ps,
    });
    const fund = funding();
    const request = {
      operationId: "legacy-01", funding: fund, amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    b.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    const first = await adapter.prepareLockedValue(request);
    expect(first.status).toBe("submitted_unknown");
    const stored = await ps.read(MINT_URL, "operation:legacy-01") as Record<string, unknown>;
    await ps.write(MINT_URL, "operation:legacy-01", { ...stored, status: "not_submitted" });
    b.submitFailures.length = 0;
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({ status: "succeeded" });
    expect(b.inspectCalls).toBe(1);
    expect(b.submitCalls).toBe(2);
    expect(b.prepareCalls).toBe(1);
  });

  it("releases an authoritatively pre-submit restart checkpoint after locktime", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    const store = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: `${MINT_URL}/`,
        unit: "sat",
        maximumExposureSats: sats(1_000n),
      },
      backend,
      privateStore: store,
    });
    const request = {
      operationId: "pre-submit-expired-01",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    await adapter.prepareLockedValue(request);
    const stored = await store.read(MINT_URL, "operation:pre-submit-expired-01") as
      Record<string, unknown>;
    await store.write(MINT_URL, "operation:pre-submit-expired-01", {
      ...stored,
      status: "not_submitted",
    });

    await expect(adapter.prepareLockedValue({
      ...request,
      allowFreshPreparation: false,
    })).rejects.toMatchObject({
      code: "operation_rejected",
      operationStatus: "not_submitted",
    });
    expect(backend.submitCalls).toBe(1);
    await expect(store.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {},
    });
    const terminal = await store.read(MINT_URL, "operation:pre-submit-expired-01");
    expect(terminal).toMatchObject({ status: "not_submitted" });
    expect(terminal).not.toHaveProperty("prepared");
  });

  it("legacy not_submitted+prepared ALL SPENT routes through NUT-09 restore", async () => {
    const b = new FakeCashuBackend();
    b.states = [{ state: "spent" }];
    b.restoreSucceeds = true;
    const ps = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: `${MINT_URL}/`, unit: "sat", maximumExposureSats: sats(1_000n) },
      backend: b, privateStore: ps,
    });
    const fund = funding();
    const request = {
      operationId: "legacy-spent-01", funding: fund, amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    b.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    await adapter.prepareLockedValue(request);
    const stored = await ps.read(MINT_URL, "operation:legacy-spent-01") as Record<string, unknown>;
    await ps.write(MINT_URL, "operation:legacy-spent-01", { ...stored, status: "not_submitted" });
    b.submitFailures.length = 0;
    const result = await adapter.prepareLockedValue(request);
    expect(result.status).toBe("succeeded");
    expect(b.inspectCalls).toBe(1);
    expect(b.restoreCalls).toBe(1);
    expect(b.submitCalls).toBe(1);
  });

  it("legacy not_submitted+prepared PENDING stays reconciliation_required", async () => {
    const b = new FakeCashuBackend();
    b.states = [{ state: "pending" }];
    const ps = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: `${MINT_URL}/`, unit: "sat", maximumExposureSats: sats(1_000n) },
      backend: b, privateStore: ps,
    });
    const fund = funding();
    const request = {
      operationId: "legacy-pending-01", funding: fund, amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    b.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    await adapter.prepareLockedValue(request);
    const stored = await ps.read(MINT_URL, "operation:legacy-pending-01") as Record<string, unknown>;
    await ps.write(MINT_URL, "operation:legacy-pending-01", { ...stored, status: "not_submitted" });
    b.submitFailures.length = 0;
    const result = await adapter.prepareLockedValue(request);
    expect(result.status).toBe("submitted_unknown");
    expect((result as { outcome?: string }).outcome).toBe("reconciliation_required");
    expect(b.inspectCalls).toBe(1);
    expect(b.submitCalls).toBe(1);
  });

  it("legacy not_submitted+prepared inspection failure stays reconciliation_required", async () => {
    const b = new FakeCashuBackend();
    const ps = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: `${MINT_URL}/`, unit: "sat", maximumExposureSats: sats(1_000n) },
      backend: b, privateStore: ps,
    });
    const fund = funding();
    const request = {
      operationId: "legacy-inspect-fail-01", funding: fund, amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    b.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    await adapter.prepareLockedValue(request);
    const stored = await ps.read(MINT_URL, "operation:legacy-inspect-fail-01") as Record<string, unknown>;
    await ps.write(MINT_URL, "operation:legacy-inspect-fail-01", { ...stored, status: "not_submitted" });
    b.submitFailures.length = 0;
    b.inspectThrow = new CashuPrivateBackendError("unavailable", "not_submitted");
    const result = await adapter.prepareLockedValue(request);
    expect(result.status).toBe("submitted_unknown");
    expect((result as { outcome?: string }).outcome).toBe("reconciliation_required");
    expect(b.submitCalls).toBe(1);
  });

  it("legacy not_submitted+prepared ALL UNSPENT replays the exact swap", async () => {
    const b = new FakeCashuBackend();
    const ps = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: `${MINT_URL}/`, unit: "sat", maximumExposureSats: sats(1_000n) },
      backend: b, privateStore: ps,
    });
    const fund = funding();
    const request = {
      operationId: "legacy-retry-01", funding: fund, amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    b.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    await adapter.prepareLockedValue(request);
    const stored = await ps.read(MINT_URL, "operation:legacy-retry-01") as Record<string, unknown>;
    await ps.write(MINT_URL, "operation:legacy-retry-01", { ...stored, status: "not_submitted" });
    b.submitFailures.length = 0;
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({ status: "succeeded" });
    expect(b.inspectCalls).toBe(1);
    expect(b.submitCalls).toBe(2);
  });

  // ==================================================================
  // Regression coverage: stale exposure reservations must not block
  // repeated Demo transactions (Issue: funding stuck at `accepted` /
  // `resolved_not_funded` on Railway after prior demo executions).
  // ==================================================================
  it("fresh transaction lock completes past the accepted phase", async () => {
    const backend = new FakeCashuBackend();
    const baseStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: MINT_URL, unit: "sat", maximumExposureSats: sats(1000n) },
      backend,
      privateStore: baseStore,
    });
    const lockKey = spendingKey();
    const result = await adapter.prepareLockedValue({
      operationId: "fresh-txn-lock-001",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    });
    expect(result.status).toBe("succeeded");
    await expect(baseStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "fresh-txn-lock-001": { amountSats: "351", status: "locked" },
      },
    });
  });

  it("second and third completed transactions fund without deleting persisted state", async () => {
    const backend = new FakeCashuBackend();
    const baseStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: MINT_URL, unit: "sat", maximumExposureSats: sats(1000n) },
      backend,
      privateStore: baseStore,
    });
    const lockKey = spendingKey();

    // First transaction: lock then spend (settle) — terminal.
    const first = await adapter.prepareLockedValue({
      operationId: "repeat-txn-lock-001",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    });
    if (first.status !== "succeeded") throw new Error("first lock failed");
    await adapter.spendLockedValue({
      operationId: "repeat-txn-spend-001",
      handle: first.handle,
      spendingKey: lockKey,
    });
    await expect(baseStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {},
    });

    // Second transaction: fresh lock must succeed (ledger clean, cap available).
    const second = await adapter.prepareLockedValue({
      operationId: "repeat-txn-lock-002",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    });
    expect(second.status).toBe("succeeded");
    if (second.status !== "succeeded") throw new Error("second lock failed");
    await adapter.spendLockedValue({
      operationId: "repeat-txn-spend-002",
      handle: second.handle,
      spendingKey: lockKey,
    });
    const third = await adapter.prepareLockedValue({
      operationId: "repeat-txn-lock-003",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    });
    expect(third.status).toBe("succeeded");
    await expect(baseStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "repeat-txn-lock-003": { amountSats: "351", status: "locked" },
      },
    });
  });

  it("allows the next completed transaction after reopening the persistent store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactagent-repeatability-restart-"));
    const databasePath = join(directory, "cashu-private.sqlite");
    const configuration = {
      testMintUrl: MINT_URL,
      unit: "sat" as const,
      maximumExposureSats: sats(1_000n),
    };
    const lockKey = spendingKey();
    let store = createSqliteCashuPrivateStore(databasePath);
    try {
      const first = createCashuTestMintAdapterWithBackend({
        configuration,
        backend: new FakeCashuBackend(),
        privateStore: store,
      });
      const locked = await first.prepareLockedValue({
        operationId: "restart-repeat-lock-001",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: lockKey.publicKey },
      });
      if (locked.status !== "succeeded") throw new Error("restart source lock failed");
      await first.spendLockedValue({
        operationId: "restart-repeat-spend-001",
        handle: locked.handle,
        spendingKey: lockKey,
      });
      store.close();

      store = createSqliteCashuPrivateStore(databasePath);
      const restarted = createCashuTestMintAdapterWithBackend({
        configuration,
        backend: new FakeCashuBackend(),
        privateStore: store,
      });
      await expect(restarted.prepareLockedValue({
        operationId: "restart-repeat-lock-002",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: lockKey.publicKey },
      })).resolves.toMatchObject({ status: "succeeded" });
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reclaims an ambiguous reservation only after a competing swap is durably successful", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    const baseStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: MINT_URL, unit: "sat", maximumExposureSats: sats(500n) },
      backend,
      privateStore: baseStore,
    });
    const lockKey = spendingKey();

    // The first request times out. A single UNSPENT snapshot is deliberately
    // not used to release its reservation because that request may finish late.
    await expect(
      adapter.prepareLockedValue({
        operationId: "stale-ambiguous-001",
        funding: funding(),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: lockKey.publicKey },
      }),
    ).resolves.toMatchObject({ outcome: "reconciliation_required" });
    expect(
      (await baseStore.read(MINT_URL, "exposure-ledger") as { reservations: Record<string, unknown> })
        .reservations["stale-ambiguous-001"],
    ).toBeDefined();

    // An exact-input competing attempt is mutually exclusive with the first,
    // so it can be admitted without understating possible exposure. Once it
    // succeeds, its durable success proves the first operation can never win.
    const winner = await adapter.prepareLockedValue({
      operationId: "stale-fresh-002",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    });
    expect(winner.status).toBe("succeeded");
    if (winner.status !== "succeeded") throw new Error("winner lock failed");
    await adapter.spendLockedValue({
      operationId: "stale-winner-spend",
      handle: winner.handle,
      spendingKey: lockKey,
    });
    await expect(baseStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {},
    });
    await expect(baseStore.read(MINT_URL, "operation:stale-ambiguous-001")).resolves.toMatchObject({
      status: "failed_definitively",
      errorCode: "proof_already_spent",
    });
    await expect(adapter.spendLockedValue({
      operationId: "stale-winner-spend",
      handle: winner.handle,
      spendingKey: lockKey,
    })).resolves.toMatchObject({ status: "succeeded" });
    await expect(baseStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {},
    });
  });

  it("keeps a late-capable request counted until an exact-input winner makes it impossible", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    const baseStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: MINT_URL, unit: "sat", maximumExposureSats: sats(500n) },
      backend,
      privateStore: baseStore,
    });
    const lockKey = spendingKey();
    const ambiguous = {
      operationId: "late-completion-lock-001",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    };
    await expect(adapter.prepareLockedValue(ambiguous)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    await expect(adapter.prepareLockedValue(ambiguous)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    await expect(baseStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {
        "late-completion-lock-001": { amountSats: "351", status: "reserved" },
      },
    });

    const winner = await adapter.prepareLockedValue({
      ...ambiguous,
      operationId: "late-completion-lock-002",
    });
    if (winner.status !== "succeeded") throw new Error("late-race winner did not succeed");
    await expect(adapter.spendLockedValue({
      operationId: "late-completion-spend-002",
      handle: winner.handle,
      spendingKey: lockKey,
    })).resolves.toMatchObject({ status: "succeeded" });
    await expect(baseStore.read(MINT_URL, "exposure-ledger")).resolves.toEqual({
      version: 1,
      reservations: {},
    });
    await expect(adapter.prepareLockedValue(ambiguous)).rejects.toMatchObject({
      code: "proof_already_spent",
      operationStatus: "failed_definitively",
    });
  });

  it("never reclaims the current in-flight operation during ledger reconciliation", async () => {
    const backend = new FakeCashuBackend();
    backend.submitFailures.push(
      new CashuPrivateBackendError("timeout", "submitted_unknown"),
    );
    const store = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: {
        testMintUrl: MINT_URL,
        unit: "sat",
        maximumExposureSats: sats(1_000n),
      },
      backend,
      privateStore: store,
    });
    const request = {
      operationId: "current-in-flight-ambiguous",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: spendingKey().publicKey },
    };
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    await expect(adapter.prepareLockedValue({
      ...request,
      operationId: "current-in-flight-winner",
    })).resolves.toMatchObject({ status: "succeeded" });

    backend.states = [{ state: "pending" }];
    await expect(adapter.prepareLockedValue(request)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    await expect(store.read(MINT_URL, "operation:current-in-flight-ambiguous"))
      .resolves.toMatchObject({ status: "submitted_unknown" });
    const ledger = await store.read(MINT_URL, "exposure-ledger") as {
      reservations: Record<string, unknown>;
    };
    expect(ledger.reservations[request.operationId]).toBeDefined();
  });

  it("active reservation is never removed by stale reservation cleanup", async () => {
    const backend = new FakeCashuBackend();
    const baseStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: MINT_URL, unit: "sat", maximumExposureSats: sats(1000n) },
      backend,
      privateStore: baseStore,
    });
    const lockKey = spendingKey();

    // A live, funded (succeeded, unconsumed) lock — an active escrow.
    const live = await adapter.prepareLockedValue({
      operationId: "active-keep-001",
      funding: funding(),
      amountSats: sats(350n),
      spendingCondition: { lockPublicKey: lockKey.publicKey },
    });
    expect(live.status).toBe("succeeded");

    // A genuinely uncertain (pending) submitted_unknown lock — fail-closed.
    backend.submitFailures.push(new CashuPrivateBackendError("timeout", "submitted_unknown"));
    backend.states = [{ state: "pending" }];
    await expect(
      adapter.prepareLockedValue({
        operationId: "active-keep-002",
        funding: createPrivateCashuFunding({
          mintUrl: MINT_URL,
          unit: "sat",
          proofs: [proof(400n, "active-pending-disjoint")],
        }),
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: spendingKey(REFUND_SECRET).publicKey },
      }),
    ).resolves.toMatchObject({ outcome: "reconciliation_required" });

    // A fresh lock within the remaining cap must retain both reservations.
    const fresh = await adapter.prepareLockedValue({
      operationId: "active-keep-003",
      funding: funding(),
      amountSats: sats(200n),
      spendingCondition: { lockPublicKey: spendingKey(LOCK_SECRET).publicKey },
    });
    expect(fresh.status).toBe("succeeded");
    const ledger = await baseStore.read(MINT_URL, "exposure-ledger") as {
      reservations: Record<string, { amountSats: string; status: string }>;
    };
    expect(ledger.reservations["active-keep-001"]).toEqual({ amountSats: "351", status: "locked" });
    expect(ledger.reservations["active-keep-002"]).toEqual({ amountSats: "351", status: "reserved" });
    expect(ledger.reservations["active-keep-003"]).toBeDefined();
  });

  it("insufficient funding proofs still fail safely at the lock boundary", async () => {
    const backend = new FakeCashuBackend();
    const baseStore = createInMemoryCashuPrivateStore();
    const adapter = createCashuTestMintAdapterWithBackend({
      configuration: { testMintUrl: MINT_URL, unit: "sat", maximumExposureSats: sats(1000n) },
      backend,
      privateStore: baseStore,
    });
    const smallFunding = createPrivateCashuFunding({
      mintUrl: MINT_URL,
      unit: "sat",
      proofs: [proof(100n, "insufficient-funding")],
    });
    await expect(
      adapter.prepareLockedValue({
        operationId: "insufficient-funds-001",
        funding: smallFunding,
        amountSats: sats(350n),
        spendingCondition: { lockPublicKey: spendingKey().publicKey },
      }),
    ).rejects.toMatchObject({ code: "insufficient_value", operationStatus: "not_submitted" });
    // The lock failed before any exposure was reserved; no reservation is recorded.
    const ledger = await baseStore.read(MINT_URL, "exposure-ledger");
    expect(ledger === undefined || (ledger as { reservations?: Record<string, unknown> }).reservations === undefined || Object.keys((ledger as { reservations: Record<string, unknown> }).reservations).length === 0).toBe(true);
  });
});
