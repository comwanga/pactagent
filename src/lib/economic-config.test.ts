import { describe, expect, it } from "vitest";

import {
  readDemoEconomicConfigFromEnv,
  readLiveEconomicConfigFromEnv,
  readLiveDemoConfigFromEnv,
  type PactAgentLiveDemoConfig,
} from "./pactagent-workflow.live";
import type {
  DemoEconomicEnvironmentConfig,
  LiveEconomicEnvironmentConfig,
} from "./economic-environment";

/*
 * Issue #36, Blocker 1: mode-specific economic configuration isolation.
 *
 * These tests use conflicting sentinel values to prove behaviorally that demo
 * and live economic configuration cannot consume each other's values. The
 * sentinel values are deliberately distinct so any cross-contamination is
 * immediately visible.
 */

const SHARED_NON_ECONOMIC = {
  PACTAGENT_LIVE_RELAY_URL: "wss://relay.example",
  PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY: "11".repeat(32),
  PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: "12".repeat(32),
  PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY: "13".repeat(32),
  PACTAGENT_RUNTIME_MODE: "local",
} as const;

const DEMO_SENTINEL = {
  PACTAGENT_DEMO_CASHU_MINT_URL: "http://127.0.0.1:3338",
  PACTAGENT_DEMO_STATE_DIRECTORY: ".local/demo-sentinel-state",
  PACTAGENT_DEMO_NORMAL_SPEND_KEY: "21".repeat(32),
  PACTAGENT_DEMO_REFUND_SPEND_KEY: "22".repeat(32),
  PACTAGENT_DEMO_FUNDING_REFERENCE: "demo-funding-sentinel-ref",
} as const;

const LIVE_SENTINEL = {
  PACTAGENT_CASHU_TEST_MINT_URL: "https://live-mint-sentinel.example/cashu",
  PACTAGENT_LIVE_STATE_DIRECTORY: ".local/live-sentinel-state",
  PACTAGENT_LIVE_NORMAL_SPEND_KEY: "31".repeat(32),
  PACTAGENT_LIVE_REFUND_SPEND_KEY: "32".repeat(32),
  PACTAGENT_LIVE_FUNDING_TOKEN: "cashuA-live-sentinel-token",
  PACTAGENT_LIVE_FUNDING_REFERENCE: "live-funding-sentinel-ref",
} as const;

describe("Issue #36 Blocker 1: mode-specific economic configuration isolation", () => {
  it("A. demo-only config constructs the demo economic configuration", () => {
    const env = { PACTAGENT_ECONOMIC_MODE: "demo", ...SHARED_NON_ECONOMIC, ...DEMO_SENTINEL };
    const config = readLiveDemoConfigFromEnv(env) as PactAgentLiveDemoConfig;
    expect(config).toBeDefined();
    expect(config.economicMode).toBe("demo");
    const econ = config.economicConfig as DemoEconomicEnvironmentConfig;
    expect(econ.mintUrl).toBe(DEMO_SENTINEL.PACTAGENT_DEMO_CASHU_MINT_URL);
    expect(econ.stateDirectory).toBe(DEMO_SENTINEL.PACTAGENT_DEMO_STATE_DIRECTORY);
    expect(econ.normalSpendKeyHex).toBe(DEMO_SENTINEL.PACTAGENT_DEMO_NORMAL_SPEND_KEY);
    expect(econ.refundSpendKeyHex).toBe(DEMO_SENTINEL.PACTAGENT_DEMO_REFUND_SPEND_KEY);
    expect(econ.fundingReference).toBe(DEMO_SENTINEL.PACTAGENT_DEMO_FUNDING_REFERENCE);
    expect(econ).not.toHaveProperty("fundingToken");
  });

  it("B. live-only config cannot satisfy demo requirements", () => {
    const env = { PACTAGENT_ECONOMIC_MODE: "demo", ...SHARED_NON_ECONOMIC, ...LIVE_SENTINEL };
    // Demo mode with only live economic variables present: demo reader returns undefined.
    expect(readDemoEconomicConfigFromEnv(env)).toBeUndefined();
    // And the combined reader fails (returns undefined) rather than using live values.
    expect(readLiveDemoConfigFromEnv(env)).toBeUndefined();
  });

  it("C. when BOTH demo and live variables are populated, demo selects ONLY demo values", () => {
    const env = {
      PACTAGENT_ECONOMIC_MODE: "demo",
      ...SHARED_NON_ECONOMIC,
      ...DEMO_SENTINEL,
      ...LIVE_SENTINEL,
    };
    const econ = readDemoEconomicConfigFromEnv(env) as DemoEconomicEnvironmentConfig;
    expect(econ).toBeDefined();
    // Every demo field is the demo sentinel, never the live sentinel.
    expect(econ.mintUrl).toBe(DEMO_SENTINEL.PACTAGENT_DEMO_CASHU_MINT_URL);
    expect(econ.mintUrl).not.toBe(LIVE_SENTINEL.PACTAGENT_CASHU_TEST_MINT_URL);
    expect(econ.stateDirectory).toBe(DEMO_SENTINEL.PACTAGENT_DEMO_STATE_DIRECTORY);
    expect(econ.stateDirectory).not.toBe(LIVE_SENTINEL.PACTAGENT_LIVE_STATE_DIRECTORY);
    expect(econ.normalSpendKeyHex).toBe(DEMO_SENTINEL.PACTAGENT_DEMO_NORMAL_SPEND_KEY);
    expect(econ.normalSpendKeyHex).not.toBe(LIVE_SENTINEL.PACTAGENT_LIVE_NORMAL_SPEND_KEY);
    expect(econ.refundSpendKeyHex).toBe(DEMO_SENTINEL.PACTAGENT_DEMO_REFUND_SPEND_KEY);
    expect(econ.fundingReference).toBe(DEMO_SENTINEL.PACTAGENT_DEMO_FUNDING_REFERENCE);
    expect(econ.fundingReference).not.toBe(LIVE_SENTINEL.PACTAGENT_LIVE_FUNDING_REFERENCE);
    // Demo never exposes a live funding token.
    expect(econ).not.toHaveProperty("fundingToken");
  });

  it("D. when BOTH are populated, live selects ONLY live values", () => {
    const env = {
      PACTAGENT_ECONOMIC_MODE: "live",
      ...SHARED_NON_ECONOMIC,
      ...DEMO_SENTINEL,
      ...LIVE_SENTINEL,
    };
    const econ = readLiveEconomicConfigFromEnv(env) as LiveEconomicEnvironmentConfig;
    expect(econ).toBeDefined();
    expect(econ.mintUrl).toBe(LIVE_SENTINEL.PACTAGENT_CASHU_TEST_MINT_URL);
    expect(econ.mintUrl).not.toBe(DEMO_SENTINEL.PACTAGENT_DEMO_CASHU_MINT_URL);
    expect(econ.stateDirectory).toBe(LIVE_SENTINEL.PACTAGENT_LIVE_STATE_DIRECTORY);
    expect(econ.normalSpendKeyHex).toBe(LIVE_SENTINEL.PACTAGENT_LIVE_NORMAL_SPEND_KEY);
    expect(econ.normalSpendKeyHex).not.toBe(DEMO_SENTINEL.PACTAGENT_DEMO_NORMAL_SPEND_KEY);
    expect(econ.refundSpendKeyHex).toBe(LIVE_SENTINEL.PACTAGENT_LIVE_REFUND_SPEND_KEY);
    expect(econ.fundingToken).toBe(LIVE_SENTINEL.PACTAGENT_LIVE_FUNDING_TOKEN);
    expect(econ.fundingReference).toBe(LIVE_SENTINEL.PACTAGENT_LIVE_FUNDING_REFERENCE);
    expect(econ.fundingReference).not.toBe(DEMO_SENTINEL.PACTAGENT_DEMO_FUNDING_REFERENCE);
  });

  it("E. demo does not instantiate the live/Testnut mint URL", () => {
    const env = { PACTAGENT_ECONOMIC_MODE: "demo", ...SHARED_NON_ECONOMIC, ...DEMO_SENTINEL, ...LIVE_SENTINEL };
    const config = readLiveDemoConfigFromEnv(env) as PactAgentLiveDemoConfig;
    const econ = config.economicConfig as DemoEconomicEnvironmentConfig;
    expect(econ.mintUrl).not.toContain("live-mint-sentinel");
    expect(econ.mintUrl).not.toContain("testnut");
    expect(econ.mintUrl).toBe(DEMO_SENTINEL.PACTAGENT_DEMO_CASHU_MINT_URL);
  });

  it("F. missing demo config fails rather than selecting live config", () => {
    // Demo mode, no demo economic vars, but all live vars present.
    const env = { PACTAGENT_ECONOMIC_MODE: "demo", ...SHARED_NON_ECONOMIC, ...LIVE_SENTINEL };
    expect(readDemoEconomicConfigFromEnv(env)).toBeUndefined();
    expect(readLiveDemoConfigFromEnv(env)).toBeUndefined();
  });

  it("demo never reads PACTAGENT_CASHU_TEST_MINT_URL even when it is the only mint variable set", () => {
    const env = {
      PACTAGENT_ECONOMIC_MODE: "demo",
      ...SHARED_NON_ECONOMIC,
      PACTAGENT_CASHU_TEST_MINT_URL: "https://sneaky-live-mint.example",
      PACTAGENT_DEMO_CASHU_MINT_URL: DEMO_SENTINEL.PACTAGENT_DEMO_CASHU_MINT_URL,
      PACTAGENT_DEMO_STATE_DIRECTORY: DEMO_SENTINEL.PACTAGENT_DEMO_STATE_DIRECTORY,
      PACTAGENT_DEMO_NORMAL_SPEND_KEY: DEMO_SENTINEL.PACTAGENT_DEMO_NORMAL_SPEND_KEY,
      PACTAGENT_DEMO_REFUND_SPEND_KEY: DEMO_SENTINEL.PACTAGENT_DEMO_REFUND_SPEND_KEY,
      PACTAGENT_DEMO_FUNDING_REFERENCE: DEMO_SENTINEL.PACTAGENT_DEMO_FUNDING_REFERENCE,
    };
    const econ = readDemoEconomicConfigFromEnv(env) as DemoEconomicEnvironmentConfig;
    expect(econ.mintUrl).toBe(DEMO_SENTINEL.PACTAGENT_DEMO_CASHU_MINT_URL);
    expect(econ.mintUrl).not.toBe("https://sneaky-live-mint.example");
  });

  it("live never reads PACTAGENT_DEMO_CASHU_MINT_URL even when it is set", () => {
    const env = {
      PACTAGENT_ECONOMIC_MODE: "live",
      ...SHARED_NON_ECONOMIC,
      PACTAGENT_DEMO_CASHU_MINT_URL: "http://127.0.0.1:9999",
      ...LIVE_SENTINEL,
    };
    const econ = readLiveEconomicConfigFromEnv(env) as LiveEconomicEnvironmentConfig;
    expect(econ.mintUrl).toBe(LIVE_SENTINEL.PACTAGENT_CASHU_TEST_MINT_URL);
    expect(econ.mintUrl).not.toBe("http://127.0.0.1:9999");
  });

  it("returns undefined when the shared non-economic identity variables are missing", () => {
    const env = { PACTAGENT_ECONOMIC_MODE: "demo", ...DEMO_SENTINEL };
    expect(readLiveDemoConfigFromEnv(env)).toBeUndefined();
  });

  it("rejects an invalid economic mode (no fallback, no inference)", () => {
    const env = { PACTAGENT_ECONOMIC_MODE: "test", ...SHARED_NON_ECONOMIC, ...DEMO_SENTINEL, ...LIVE_SENTINEL };
    expect(() => readLiveDemoConfigFromEnv(env)).toThrow(/demo.*live/i);
  });

  // F38-06A: Missing PACTAGENT_RUNTIME_MODE FAILS CLOSED — no default to local.
  it("F38-06A: missing PACTAGENT_RUNTIME_MODE fails closed", () => {
    const env = {
      PACTAGENT_ECONOMIC_MODE: "demo",
      PACTAGENT_LIVE_RELAY_URL: "wss://relay.example",
      PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY: "11".repeat(32),
      PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: "12".repeat(32),
      PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY: "13".repeat(32),
      ...DEMO_SENTINEL,
    };
    expect(() => readLiveDemoConfigFromEnv(env)).toThrow(/PACTAGENT_RUNTIME_MODE is required/);
  });

  it("F38-06A: unknown PACTAGENT_RUNTIME_MODE fails closed", () => {
    const env = { PACTAGENT_ECONOMIC_MODE: "demo", ...SHARED_NON_ECONOMIC, ...DEMO_SENTINEL, PACTAGENT_RUNTIME_MODE: "staging" };
    expect(() => readLiveDemoConfigFromEnv(env)).toThrow(/must be "local" or "hosted"/);
  });

  it("F38-06A: local mode succeeds with explicit local", () => {
    const env = { PACTAGENT_ECONOMIC_MODE: "demo", ...SHARED_NON_ECONOMIC, ...DEMO_SENTINEL, PACTAGENT_RUNTIME_MODE: "local" };
    const config = readLiveDemoConfigFromEnv(env) as PactAgentLiveDemoConfig;
    expect(config).toBeDefined();
  });

  it("F38-06A: hosted mode succeeds with hosted required fields", () => {
    const env = {
      PACTAGENT_ECONOMIC_MODE: "demo",
      PACTAGENT_LIVE_RELAY_URL: "wss://relay.example",
      PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY: "11".repeat(32),
      PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY: "13".repeat(32),
      PACTAGENT_RUNTIME_MODE: "hosted",
      PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY: "ff".repeat(32),
      ...DEMO_SENTINEL,
    };
    const config = readLiveDemoConfigFromEnv(env);
    expect(config).toBeDefined();
    expect("externalProvider" in config!).toBe(true);
    expect((config as { externalProvider?: boolean }).externalProvider).toBe(true);
  });
});
