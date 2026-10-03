import { defineRailway, preserve, project, service, volume } from "railway/iac";

/*
 * PactAgent Issue #39 Railway deployment (production Demo environment).
 *
 * Services:
 *   - pactagent-web:      public HTTPS requester UI + BFF + runtime (Next.js)
 *   - pactagent-provider: standalone P002 provider (private)
 *   - pactagent-strfry:   persistent Nostr relay (private)
 *   - pactagent-relay:    public WSS edge (Caddy, platform-terminated TLS)
 *   - pactagent-demo-mint: Nutshell FakeWallet Demo Cashu mint (private)
 *
 * Secret values are NEVER written into this file. Secret variables are
 * declared with preserve() so the names stay managed while the values live
 * only in Railway (set via `railway variable set`).
 *
 * Public generated domains (web UI + relay WSS) are provisioned with
 * `railway domain --service ... --port ...` and are not represented here.
 */

export default defineRailway(() => {
  const webData = volume("pactagent-web-data", { sizeMB: 1024, region: "sfo" });
  const providerData = volume("pactagent-provider-data", { sizeMB: 256, region: "sfo" });
  const strfryDb = volume("pactagent-strfry-db", { sizeMB: 2048, region: "sfo" });
  const mintData = volume("pactagent-demo-mint-data", { sizeMB: 1024, region: "sfo" });

  const web = service("pactagent-web", {
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/web.Dockerfile" },
    start: "node node_modules/next/dist/bin/next start -H 0.0.0.0",
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
    volumeMounts: { "/data": webData },
    env: {
      NODE_ENV: "production",
      PORT: "3000",
      PACTAGENT_RUNTIME_MODE: "hosted",
      PACTAGENT_ECONOMIC_MODE: "demo",
      PACTAGENT_RUNTIME_API_BASE: "http://127.0.0.1:3000",
      PACTAGENT_REQUESTER_DECISION_MODE: "deterministic",
      PACTAGENT_DEMO_CASHU_MINT_URL: "http://pactagent-demo-mint.railway.internal:3338",
      PACTAGENT_DEMO_MINT_PRIVATE_HOSTS: "pactagent-demo-mint.railway.internal",
      PACTAGENT_DEMO_STATE_DIRECTORY: "/data",
      PACTAGENT_DEMO_WALLET_INITIAL_BALANCE_SATS: "1000",
      // Derived/secret values (set on Railway, never committed):
      PACTAGENT_REQUESTER_UI_ORIGIN: preserve(),
      PACTAGENT_LIVE_RELAY_URL: preserve(),
      PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY: preserve(),
      PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY: preserve(),
      PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY: preserve(),
      PACTAGENT_DEMO_NORMAL_SPEND_KEY: preserve(),
      PACTAGENT_DEMO_REFUND_SPEND_KEY: preserve(),
      PACTAGENT_DEMO_FUNDING_REFERENCE: preserve(),
      PACTAGENT_RUNTIME_API_TOKEN: preserve(),
    },
  });

  const provider = service("pactagent-provider", {
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/web.Dockerfile" },
    start: "node --conditions=react-server --import tsx scripts/provider-start.mjs",
    healthcheck: "/health",
    healthcheckTimeout: 300,
    volumeMounts: { "/data": providerData },
    env: {
      NODE_ENV: "production",
      PORT: "3939",
      PACTAGENT_PROVIDER_MODE: "hosted",
      PACTAGENT_PROVIDER_STATE_DIRECTORY: "/data",
      PACTAGENT_PROVIDER_READINESS_HOST: "0.0.0.0",
      PACTAGENT_PROVIDER_READINESS_PORT: "3939",
      PACTAGENT_PROVIDER_OFFER_SATS: "350",
      PACTAGENT_PROVIDER_MAX_EXECUTION_SECONDS: "120",
      PACTAGENT_PROVIDER_ESCROW_TIMEOUT_SECONDS: "900",
      PACTAGENT_PROVIDER_POLL_INTERVAL_MS: "3000",
      PACTAGENT_PROVIDER_TRANSITION_TIMEOUT_MS: "120000",
      PACTAGENT_PROVIDER_DEFINITION_ID: "hosted-provider",
      PACTAGENT_PROVIDER_OFFER_ID: "hosted-document-summary-offer",
      PACTAGENT_PROVIDER_ESCROW_DESCRIPTOR_ID: "hosted-cashu-escrow",
      // Derived/secret values (set on Railway, never committed):
      PACTAGENT_LIVE_RELAY_URL: preserve(),
      PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY: preserve(),
      PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: preserve(),
    },
  });

  const strfry = service("pactagent-strfry", {
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/strfry.Dockerfile" },
    start: "/app/strfry.sh",
    healthcheck: "/",
    healthcheckTimeout: 300,
    volumeMounts: { "/app/strfry-db": strfryDb },
    env: {
      PORT: "7777",
    },
  });

  const relay = service("pactagent-relay", {
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/caddy.Dockerfile" },
    start: "caddy run --config /etc/caddy/Caddyfile --adapter caddyfile",
    healthcheck: "/health",
    healthcheckTimeout: 300,
    env: {
      PORT: "8080",
      PACTAGENT_STRFRY_UPSTREAM: "pactagent-strfry.railway.internal:7777",
    },
  });

  const demoMint = service("pactagent-demo-mint", {
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/mint.Dockerfile" },
    start: "poetry run mint",
    healthcheck: "/v1/info",
    healthcheckTimeout: 300,
    volumeMounts: { "/app/data": mintData },
    env: {
      PORT: "3338",
      MINT_BACKEND_BOLT11_SAT: "FakeWallet",
      MINT_LISTEN_HOST: "0.0.0.0",
      MINT_LISTEN_PORT: "3338",
      MINT_DATABASE: "/app/data/mint",
      TOR: "FALSE",
      // Secret value (set on Railway, never committed):
      MINT_PRIVATE_KEY: preserve(),
    },
  });

  return project("pactagent", {
    resources: [web, provider, strfry, relay, demoMint, webData, providerData, strfryDb, mintData],
  });
});
