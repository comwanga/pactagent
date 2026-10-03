import { resolve, join } from "node:path";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";

import { loadLocalEnvironment } from "./local-env.mjs";
import { readProviderServiceConfig, wireProviderService } from "../src/lib/provider-service-config.ts";
import { createPactAgentProviderService } from "../src/lib/pactagent-provider-service.ts";
import { createSqliteProviderIdempotencyStore } from "../src/lib/provider-idempotency-store.ts";

/*
 * Provider service entry point (Issue #38).
 *
 * Starts a long-running PactAgent provider service that connects to the
 * configured relay, publishes P002 artifacts, and polls for new agreement
 * roots to process.
 *
 * F38-06B: Also starts a local health/readiness HTTP endpoint that exposes
 * authoritative readiness from PactAgentProviderService.readiness().
 * No secrets are exposed — only safe, redacted readiness booleans/counts.
 *
 * Configuration is read from environment variables (server-side only).
 * Missing required hosted configuration causes a clean configuration error,
 * never a fallback to an arbitrary provider identity.
 */

const environment = loadLocalEnvironment();

let config;
try {
  config = readProviderServiceConfig(environment);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const stateDirectory = resolve(config.stateDirectory);
mkdirSync(stateDirectory, { recursive: true });

const wiring = wireProviderService(config);
const idempotencyStore = createSqliteProviderIdempotencyStore(
  join(stateDirectory, "provider-operations.sqlite"),
);
const service = createPactAgentProviderService({
  providerSigner: wiring.providerSigner,
  providerEncrypter: wiring.providerEncrypter,
  relay: wiring.relay,
  relayUrl: wiring.relayUrl,
  clock: () => Math.floor(Date.now() / 1000),
  offerAmountSats: BigInt(config.offerAmountSats),
  maximumExecutionSeconds: config.maximumExecutionSeconds,
  escrowTimeoutSeconds: config.escrowTimeoutSeconds,
  escrowAuthorityPublicKey: config.escrowAuthorityPublicKey,
  idempotencyStore,
  capabilityReplaySafety: "replay_safe",
  pollIntervalMs: config.pollIntervalMs,
  transitionWaitTimeoutMs: config.transitionWaitTimeoutMs,
  stateDirectory,
  providerDefinitionIdentifier: config.providerDefinitionIdentifier,
  offerIdentifier: config.offerIdentifier,
  escrowDescriptorIdentifier: config.escrowDescriptorIdentifier,
});

/*
 * F38-06B: Provider readiness HTTP endpoint.
 *
 * Binds to PACTAGENT_PROVIDER_READINESS_PORT (default 3939) on the loopback
 * interface. Exposes GET /health and GET /ready which return authoritative
 * readiness from PactAgentProviderService.readiness().
 *
 * No secrets, private keys, proofs, or task/result plaintext are exposed.
 */
const readinessPort = Number(environment.PACTAGENT_PROVIDER_READINESS_PORT?.trim() ?? "3939");
const readinessHost = environment.PACTAGENT_PROVIDER_READINESS_HOST?.trim() || "127.0.0.1";

let readinessServer;

function startReadinessServer() {
  readinessServer = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${readinessHost}`);
    if (url.pathname !== "/health" && url.pathname !== "/ready") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    try {
      const readiness = await service.readiness();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        processAlive: readiness.processAlive,
        protocolReady: readiness.protocolReady,
        relayConnected: readiness.relayConnected,
        artifactsPublished: readiness.artifactsPublished,
        pollHealthy: readiness.pollHealthy,
        recoveryRequiredCount: readiness.recoveryRequiredCount,
        storeHealthy: readiness.storeHealthy,
        providerPublicKey: readiness.providerPublicKey,
        providerDefinitionReference: readiness.providerDefinitionReference,
        offerReference: readiness.offerReference,
        escrowDescriptorReference: readiness.escrowDescriptorReference,
        agreementsProcessed: readiness.agreementsProcessed,
        reconnectAttempts: readiness.reconnectAttempts,
      }));
    } catch {
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        processAlive: true,
        protocolReady: false,
        relayConnected: false,
        artifactsPublished: false,
        pollHealthy: false,
        storeHealthy: false,
        error: "readiness inspection failed",
      }));
    }
  });
  readinessServer.listen(readinessPort, readinessHost, () => {
    console.log("Provider readiness endpoint is listening");
  });
}

async function shutdown(signal) {
  console.log(`Provider service received ${signal}; shutting down...`);
  if (readinessServer) {
    readinessServer.close();
  }
  await service.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  await service.start();
  startReadinessServer();
  console.log("PactAgent Provider Service started");
  console.log(`Provider public key: ${service.providerPublicKey}`);
  console.log(`Provider readiness: http://${readinessHost}:${readinessPort}/ready`);
} catch {
  console.error("Failed to start provider service");
  process.exit(1);
}
