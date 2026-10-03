import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { sats } from "../domain/money";
import {
  createBoundedCashuWallet,
  type CashuTestMintPort,
  type ValidatedMintCapabilities,
} from "./cashu-test-mint";
import {
  createDemoEconomicEnvironment,
  type DemoEconomicEnvironmentConfig,
  type LiveEconomicEnvironmentFactories,
} from "./economic-environment";

/*
 * Issue #36 final transport-boundary regression.
 *
 * Proves that every HTTP request performed by the cashu-ts Wallet used in
 * the demo funding bootstrap and restore paths remains bound to the
 * validated configured mint origin. A configured loopback demo mint that
 * responds with a cross-origin redirect (to a different port) MUST NOT be
 * followed. The unauthorized redirect target MUST receive zero requests.
 */

const NORMAL_SPEND_KEY_HEX = "31".repeat(32);
const REFUND_SPEND_KEY_HEX = "32".repeat(32);

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    try {
      await rm(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* Windows file locks */
    }
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pactagent-redirect-"));
  tempDirs.push(dir);
  return dir;
}

interface ServerHandle {
  readonly url: string;
  readonly requestCount: () => number;
  close(): Promise<void>;
}

function startRedirectServer(targetUrl: string): Promise<ServerHandle> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(302, { location: `${targetUrl}${req.url}` });
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          requestCount: () => 0,
          close: () =>
            new Promise<void>((done) => server.close(() => done())),
        });
      }
    });
  });
}

function startCountingServer(): Promise<ServerHandle> {
  let count = 0;
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      count++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          requestCount: () => count,
          close: () =>
            new Promise<void>((done) => server.close(() => done())),
        });
      }
    });
  });
}

function createFakeAdapter(mintUrl: string): CashuTestMintPort {
  return Object.freeze({
    async inspectCapabilities(): Promise<ValidatedMintCapabilities> {
      return {
        mintUrl,
        unit: "sat",
        nuts: {
          nut07ProofState: true,
          nut09Restore: true,
          nut10SpendingConditions: true,
          nut11P2pk: true,
        },
        activeKeyset: { id: "00abcdef", inputFeePpk: 0 },
        acceptedKeysetIds: ["00abcdef"],
      };
    },
    async prepareLockedValue(): Promise<never> {
      throw new Error("fake adapter: prepareLockedValue not used");
    },
    async inspectProofState(): Promise<never> {
      throw new Error("fake adapter: inspectProofState not used");
    },
    async spendLockedValue(): Promise<never> {
      throw new Error("fake adapter: spendLockedValue not used");
    },
  });
}

function demoConfig(
  mintUrl: string,
  stateDirectory: string,
  fundingReference: string,
): DemoEconomicEnvironmentConfig {
  return {
    mintUrl,
    stateDirectory,
    normalSpendKeyHex: NORMAL_SPEND_KEY_HEX,
    refundSpendKeyHex: REFUND_SPEND_KEY_HEX,
    fundingReference,
  };
}

function assertNoPersistedFunding(stateDirectory: string): void {
  const db = new DatabaseSync(join(stateDirectory, "cashu-private.sqlite"));
  try {
    const demoRows = db
      .prepare(
        "SELECT * FROM pact_cashu_private_values WHERE scope = ?",
      )
      .all("demo-funding");
    expect(demoRows).toHaveLength(0);
    const refRows = db
      .prepare(
        "SELECT * FROM pact_cashu_private_values WHERE scope = ?",
      )
      .all("funding-reference");
    expect(refRows).toHaveLength(0);
  } finally {
    db.close();
  }
}

describe("Issue #36: demo Cashu Wallet transport boundary — cross-origin redirect rejection", () => {
  it("createBoundedCashuWallet loadMint() rejects cross-origin redirect (redirect target receives zero requests)", async () => {
    const target = await startCountingServer();
    const mint = await startRedirectServer(target.url);
    try {
      const wallet = createBoundedCashuWallet({
        testMintUrl: mint.url,
        unit: "sat",
        maximumExposureSats: sats(400n),
        requestTimeoutMs: 5_000,
        maximumResponseBytes: 100_000,
        transportPolicy: "demo-loopback",
      });
      await expect(wallet.loadMint()).rejects.toThrow();
      expect(target.requestCount()).toBe(0);
    } finally {
      await mint.close();
      await target.close();
    }
  });

  it("demo startDemoWallet rejects cross-origin redirect (redirect target receives zero requests, no funding persisted)", async () => {
    const target = await startCountingServer();
    const mint = await startRedirectServer(target.url);
    const stateDir = await tempDir();
    try {
      const factories: LiveEconomicEnvironmentFactories = {
        createCashuAdapter: () => createFakeAdapter(mint.url),
      };
      const env = await createDemoEconomicEnvironment(
        demoConfig(mint.url, stateDir, "redirect-bootstrap-ref"),
        factories,
      );
      await expect(env.startDemoWallet!("redirect-bootstrap-ref")).rejects.toThrow();
      expect(target.requestCount()).toBe(0);
      assertNoPersistedFunding(stateDir);
      env.close();
    } finally {
      await mint.close();
      await target.close();
    }
  });

  it("demo economic environment rejects cross-origin redirect at adapter inspectCapabilities (redirect target receives zero requests)", async () => {
    const target = await startCountingServer();
    const mint = await startRedirectServer(target.url);
    const stateDir = await tempDir();
    try {
      await expect(
        createDemoEconomicEnvironment(
          demoConfig(mint.url, stateDir, "redirect-adapter-ref"),
        ),
      ).rejects.toThrow();
      expect(target.requestCount()).toBe(0);
      assertNoPersistedFunding(stateDir);
    } finally {
      await mint.close();
      await target.close();
    }
  });
});
