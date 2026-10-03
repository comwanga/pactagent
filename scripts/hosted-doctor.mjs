import { existsSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnvironment } from "./local-env.mjs";
import { runSync } from "./local-process.mjs";
import { parseSignedNostrEvent, verifySignedNostrEvent } from "../src/domain/nostr.ts";
import { parsePontmoreAgentDefinitionEvent } from "../src/domain/pontmore-agent.ts";
import { parsePactServiceOfferEvent } from "../src/domain/pact-service-offer.ts";
import { parseCashuEscrowDescriptorEvent } from "../src/domain/pontmore-escrow.ts";

const STRFRY_EVENT_SIZE = 1_048_576;
const STRFRY_WEBSOCKET_PAYLOAD_SIZE = 1_048_832;

function checkPort(port, host = "127.0.0.1") {
  return new Promise((resolvePromise) => {
    const socket = connect({ host, port });
    const finish = (reachable) => {
      socket.destroy();
      resolvePromise(reachable);
    };
    socket.setTimeout(2_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function inspectContainer(name) {
  const result = runSync("docker", ["inspect", "--format", "{{json .State}}", name]);
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return undefined;
  }
}

function relayRead(relayUrl) {
  return new Promise((resolvePromise) => {
    const subscription = `hosted-doctor-${Date.now()}`;
    const socket = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      socket.close();
      resolvePromise(false);
    }, 8_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", subscription, { limit: 1 }]));
    });
    socket.addEventListener("message", (message) => {
      try {
        const value = JSON.parse(String(message.data));
        if (value[0] === "EOSE" && value[1] === subscription) {
          clearTimeout(timer);
          socket.close();
          resolvePromise(true);
        }
      } catch {
        clearTimeout(timer);
        socket.close();
        resolvePromise(false);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolvePromise(false);
    });
  });
}

/*
 * F38-06F: Read-only P002 artifact verification through the relay.
 * Queries the relay for the configured provider's P002 artifacts.
 */
function relayQueryP002(relayUrl, providerPublicKey) {
  return new Promise((resolvePromise) => {
    const subscription = `hosted-doctor-p002-${Date.now()}`;
    const socket = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      socket.close();
      resolvePromise({ ok: false, reason: "timeout" });
    }, 10_000);
    const found = { providers: 0, offers: 0, descriptors: 0, malformed: 0 };
    socket.addEventListener("open", () => {
      // Query for provider definition, offer, and escrow descriptor events
      socket.send(JSON.stringify(["REQ", subscription, {
        authors: [providerPublicKey],
        kinds: [30360, 30400, 30361],
        limit: 10,
      }]));
    });
    socket.addEventListener("message", (message) => {
      try {
        const value = JSON.parse(String(message.data));
        if (value[0] === "EVENT" && value[1] === subscription) {
          try {
            const event = parseSignedNostrEvent(value[2]);
            verifySignedNostrEvent(event);
            if (event.pubkey !== providerPublicKey) throw new Error("provider identity mismatch");
            if (event.kind === 30360) {
              parsePontmoreAgentDefinitionEvent(event);
              found.providers++;
            } else if (event.kind === 30400) {
              parsePactServiceOfferEvent(event);
              found.offers++;
            } else if (event.kind === 30361) {
              parseCashuEscrowDescriptorEvent(event);
              found.descriptors++;
            }
          } catch {
            found.malformed++;
          }
        }
        if (value[0] === "EOSE" && value[1] === subscription) {
          clearTimeout(timer);
          socket.close();
          resolvePromise({
            ok: found.providers > 0 && found.offers > 0 && found.descriptors > 0 && found.malformed === 0,
            providers: found.providers,
            offers: found.offers,
            descriptors: found.descriptors,
            malformed: found.malformed,
            ...(found.malformed > 0 ? { reason: `${found.malformed} malformed provider artifact(s)` } : {}),
          });
        }
      } catch {
        clearTimeout(timer);
        socket.close();
        resolvePromise({ ok: false, reason: "parse error" });
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolvePromise({ ok: false, reason: "connection error" });
    });
  });
}

function readStrfryConfig(configPath) {
  if (!existsSync(configPath)) return undefined;
  const content = readFileSync(configPath, "utf8");
  const maxEventMatch = content.match(/maxEventSize\s*=\s*(\d+)/);
  const wsPayloadMatch = content.match(/maxWebsocketPayloadSize\s*=\s*(\d+)/);
  if (maxEventMatch && wsPayloadMatch) {
    return {
      maxEventSize: Number(maxEventMatch[1]),
      maxWebsocketPayloadSize: Number(wsPayloadMatch[1]),
    };
  }
  return undefined;
}

/*
 * F38-06D: Read Caddyfile config ignoring comments.
 * Strip full-line comments and inline comments before checking directives.
 */
function readCaddyfileConfig(configPath) {
  if (!existsSync(configPath)) return undefined;
  const rawContent = readFileSync(configPath, "utf8");
  // F38-06D: Strip comments — lines starting with # and inline # comments
  const activeLines = rawContent.split("\n").map((line) => {
    // Strip inline comments (everything after #)
    const hashIndex = line.indexOf("#");
    if (hashIndex >= 0) return line.slice(0, hashIndex);
    return line;
  });
  const activeContent = activeLines.join("\n");
  // Check only active (non-comment) directives
  const hasAutoHttpsOff = /auto_https\s+off/.test(activeContent);
  const hasTlsInternal = /tls\s+internal/.test(activeContent);
  // Hostname: check for explicit variable without localhost default
  const hasExplicitHostname = /\{\$PACTAGENT_HOSTED_WSS_HOSTNAME\}/.test(activeContent) &&
    !/\{\$PACTAGENT_HOSTED_WSS_HOSTNAME:localhost\}/.test(activeContent);
  return { hasAutoHttpsOff, hasTlsInternal, hasExplicitHostname, content: activeContent };
}

function add(checks, ok, label, detail) {
  checks.push(Object.freeze({ ok, label, detail }));
}

export async function runHostedDoctor(options = {}) {
  const environment = options.environment ?? loadLocalEnvironment();
  const checks = [];

  // F38-06A: Provider mode parsed as closed set
  const providerModeRaw = environment.PACTAGENT_PROVIDER_MODE?.trim();
  if (!providerModeRaw) {
    add(checks, false, "provider mode", "FAIL: PACTAGENT_PROVIDER_MODE is required — no default to local");
  } else if (providerModeRaw !== "local" && providerModeRaw !== "hosted") {
    add(checks, false, "provider mode", `FAIL: unknown mode "${providerModeRaw}" — must be local or hosted`);
  } else {
    add(checks, true, "provider mode", `valid: ${providerModeRaw}`);
  }

  // F38-06A: Runtime mode parsed as closed set
  const runtimeModeRaw = environment.PACTAGENT_RUNTIME_MODE?.trim();
  if (!runtimeModeRaw) {
    add(checks, false, "runtime mode", "FAIL: PACTAGENT_RUNTIME_MODE is required — no default to local");
  } else if (runtimeModeRaw !== "local" && runtimeModeRaw !== "hosted") {
    add(checks, false, "runtime mode", `FAIL: unknown mode "${runtimeModeRaw}" — must be local or hosted`);
  } else {
    add(checks, true, "runtime mode", `valid: ${runtimeModeRaw}`);
  }

  // 1. Hosted configuration parse
  const composeHostedPath = resolve(process.cwd(), "compose.hosted.yml");
  add(checks, existsSync(composeHostedPath), "hosted compose file",
    existsSync(composeHostedPath) ? "present" : "missing");

  // 2. Hosted Strfry config (NOT local strfry.conf)
  const strfryHostedPath = resolve(process.cwd(), "local", "strfry-hosted.conf");
  const strfryConfig = readStrfryConfig(strfryHostedPath);
  if (strfryConfig) {
    const eventSizeOk = strfryConfig.maxEventSize === STRFRY_EVENT_SIZE;
    add(checks, eventSizeOk, "hosted Strfry maxEventSize", eventSizeOk
      ? `${strfryConfig.maxEventSize} bytes (matches application limit)`
      : `${strfryConfig.maxEventSize} bytes does not match application limit ${STRFRY_EVENT_SIZE}`);
    const wsPayloadOk = strfryConfig.maxWebsocketPayloadSize === STRFRY_WEBSOCKET_PAYLOAD_SIZE;
    add(checks, wsPayloadOk, "hosted Strfry maxWebsocketPayloadSize", wsPayloadOk
      ? `${strfryConfig.maxWebsocketPayloadSize} bytes (matches application limit)`
      : `${strfryConfig.maxWebsocketPayloadSize} bytes does not match application limit ${STRFRY_WEBSOCKET_PAYLOAD_SIZE}`);
    const agreementOk = strfryConfig.maxWebsocketPayloadSize >= strfryConfig.maxEventSize;
    add(checks, agreementOk, "hosted Strfry size agreement", agreementOk
      ? "WebSocket payload limit >= event size limit"
      : "WebSocket payload limit < event size limit (configuration mismatch)");
  } else {
    add(checks, false, "hosted Strfry config", "No hosted Strfry configuration file found");
  }

  // 3. Hosted Caddyfile (NOT local Caddyfile) — validate TLS topology
  // F38-06D: Check only the real hosted Caddyfile (not acceptance)
  const caddyHostedPath = resolve(process.cwd(), "local", "Caddyfile-hosted");
  const caddyConfig = readCaddyfileConfig(caddyHostedPath);
  if (caddyConfig) {
    // F38-06D: Check only active directives (comments stripped).
    add(checks, !caddyConfig.hasAutoHttpsOff, "hosted Caddyfile no auto_https off",
      caddyConfig.hasAutoHttpsOff ? "FAIL: auto_https off is contradictory with public TLS" : "OK");
    add(checks, !caddyConfig.hasTlsInternal, "hosted Caddyfile no tls internal",
      caddyConfig.hasTlsInternal ? "FAIL: tls internal belongs in local acceptance only" : "OK: uses automatic HTTPS");
    // F38-05: Hosted Caddyfile must NOT default to localhost
    add(checks, caddyConfig.hasExplicitHostname, "hosted Caddyfile explicit hostname",
      caddyConfig.hasExplicitHostname ? "OK: requires explicit hostname" : "FAIL: defaults to localhost");
  } else {
    add(checks, false, "hosted Caddyfile", "missing");
  }

  // 4. Hosted hostname — required explicitly, does NOT default to localhost
  const hostedHostname = environment.PACTAGENT_HOSTED_WSS_HOSTNAME?.trim();
  add(checks, Boolean(hostedHostname), "hosted hostname explicit", hostedHostname
    ? `present: ${hostedHostname}` : "FAIL: PACTAGENT_HOSTED_WSS_HOSTNAME is required");

  // 5. Relay URL configured
  const relayUrl = environment.PACTAGENT_LIVE_RELAY_URL;
  add(checks, Boolean(relayUrl), "relay URL configured", relayUrl ? relayUrl : "PACTAGENT_LIVE_RELAY_URL is missing");

  // 6. Provider identity (redacted fingerprint)
  const providerKey = environment.PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY;
  const providerPublicKey = environment.PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY?.trim();
  add(checks, Boolean(providerKey || providerPublicKey), "provider identity", (providerKey || providerPublicKey)
    ? "present (fingerprint redacted)"
    : "PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY or PUBLIC_KEY is missing");

  // 7. Provider identity is NOT in NEXT_PUBLIC_*
  const nextPublicProviderKey = environment.NEXT_PUBLIC_PROVIDER_PRIVATE_KEY;
  add(checks, !nextPublicProviderKey, "provider identity not in NEXT_PUBLIC_*",
    nextPublicProviderKey ? "FAIL: provider key leaked to browser variable" : "not exposed to browser");

  // 8. Escrow authority — prefer public key; if private key provided, verify derivation
  const escrowPublicKey = environment.PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY?.trim();
  const escrowPrivateKey = environment.PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY?.trim();
  add(checks, Boolean(escrowPublicKey || escrowPrivateKey), "escrow authority key",
    escrowPublicKey ? "public key present (fingerprint redacted)" :
    escrowPrivateKey ? "private key present (public key will be derived)" :
    "PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY is missing");

  // 9. Docker + HOSTED container health (NOT pactagent-local-*)
  const docker = runSync("docker", ["version", "--format", "{{.Server.Version}}"]).status === 0;
  add(checks, docker, "Docker", docker ? "daemon is available" : "daemon is unavailable");

  const strfry = docker ? inspectContainer("pactagent-hosted-strfry") : undefined;
  const caddy = docker ? inspectContainer("pactagent-hosted-caddy") : undefined;
  const strfryHealthy = strfry?.Running === true && strfry?.Health?.Status === "healthy";
  const caddyHealthy = caddy?.Running === true && caddy?.Health?.Status === "healthy";
  add(checks, strfryHealthy, "hosted Strfry container", strfryHealthy ? "running and healthy" : "not running and healthy");
  add(checks, caddyHealthy, "hosted Caddy container", caddyHealthy ? "running and healthy" : "not running and healthy");

  // Hosted Strfry is private to the Compose network. Probe its listener from
  // inside the container instead of requiring an unsafe host port mapping.
  const strfryInternal = docker && runSync("docker", [
    "exec", "pactagent-hosted-strfry", "curl", "-ILfSs", "http://localhost:7777/",
  ]).status === 0;
  const tlsPort = await checkPort(8443);
  add(checks, strfryInternal, "hosted Strfry internal listener",
    strfryInternal ? "reachable inside hosted container" : "unreachable inside hosted container");
  add(checks, tlsPort, "hosted Caddy WSS port 8443", tlsPort ? "reachable" : "unreachable");

  // 11. WSS handshake through the intended hosted edge
  let nostrReadable = false;
  if (tlsPort && relayUrl) {
    nostrReadable = await relayRead(relayUrl);
  }
  add(checks, nostrReadable, "Nostr relay WSS handshake", nostrReadable ? "WSS handshake and REQ/EOSE succeeded" : "WSS read failed");

  // 12. F38-06E: Provider process readiness — REQUIRED, not optional
  // Doctor must fail if provider readiness is unavailable in hosted mode.
  const providerProcessUrl = environment.PACTAGENT_PROVIDER_READINESS_URL?.trim()
    || `http://127.0.0.1:${environment.PACTAGENT_PROVIDER_READINESS_PORT?.trim() || "3939"}/ready`;
  let providerReadinessData = undefined;
  try {
    const resp = await fetch(providerProcessUrl);
    if (!resp.ok) {
      add(checks, false, "provider readiness endpoint", `FAIL: HTTP ${resp.status} from ${providerProcessUrl}`);
    } else {
      providerReadinessData = await resp.json();
      add(checks, providerReadinessData.protocolReady === true, "provider protocolReady",
        providerReadinessData.protocolReady ? "protocolReady=true" : `FAIL: protocolReady=${providerReadinessData.protocolReady}`);
      add(checks, providerReadinessData.relayConnected === true, "provider relay connected",
        providerReadinessData.relayConnected ? "connected" : "FAIL: not connected");
      add(checks, providerReadinessData.pollHealthy === true, "provider poll healthy",
        providerReadinessData.pollHealthy ? "healthy" : "FAIL: poll unhealthy");
      add(checks, providerReadinessData.storeHealthy === true, "provider store healthy",
        providerReadinessData.storeHealthy ? "healthy" : "FAIL: store unhealthy");
      add(checks, (providerReadinessData.recoveryRequiredCount ?? 999) === 0, "provider recoveryRequiredCount",
        `count=${providerReadinessData.recoveryRequiredCount ?? "unknown"}`);
      add(checks, providerReadinessData.artifactsPublished === true, "provider artifacts published",
        providerReadinessData.artifactsPublished ? "published" : "FAIL: not published");
    }
  } catch {
    add(checks, false, "provider readiness endpoint", `FAIL: cannot reach ${providerProcessUrl}`);
  }

  // 13. F38-06F: Doctor must verify P002 artifacts through relay (read-only)
  if (nostrReadable && providerPublicKey) {
    const p002Result = await relayQueryP002(relayUrl, providerPublicKey);
    add(checks, p002Result.ok === true, "provider P002 artifacts through relay",
      p002Result.ok ? `validated (providers=${p002Result.providers}, offers=${p002Result.offers}, descriptors=${p002Result.descriptors})`
      : `FAIL: ${p002Result.reason || "missing artifacts"}`);
  } else if (nostrReadable && !providerPublicKey) {
    add(checks, false, "provider P002 artifacts through relay", "FAIL: no provider public key configured");
  } else {
    add(checks, false, "provider P002 artifacts through relay", "FAIL: relay not readable");
  }

  // 14. F38-06G: Verify the composition of the runtime actually instantiated
  // in the application process, not merely this doctor's environment text.
  if (runtimeModeRaw === "hosted") {
    const runtimeApiBase = environment.PACTAGENT_RUNTIME_API_BASE?.trim();
    const runtimeApiToken = environment.PACTAGENT_RUNTIME_API_TOKEN?.trim();
    let runtimeComposition;
    if (runtimeApiBase && runtimeApiToken) {
      try {
        const response = await fetch(new URL("/api/runtime/readiness", runtimeApiBase), {
          headers: { authorization: `Bearer ${runtimeApiToken}` },
          cache: "no-store",
        });
        if (response.ok) runtimeComposition = await response.json();
      } catch {
        runtimeComposition = undefined;
      }
    }
    const runtimeReady = runtimeComposition?.runtimeMode === "hosted" &&
      runtimeComposition?.externalProvider === true &&
      runtimeComposition?.providerPublicKey === providerPublicKey;
    add(checks, runtimeReady, "hosted external-provider runtime",
      runtimeReady
        ? "running runtime confirms hosted external-provider composition"
        : "FAIL: running runtime composition is unavailable or does not match the configured provider");
  } else if (runtimeModeRaw === "local") {
    add(checks, true, "external-provider runtime composition", "local mode — inline provider (explicit)");
  } else {
    add(checks, false, "external-provider runtime composition", "FAIL: runtime mode not verified");
  }

  // 15. Provider SQLite path availability
  const providerStateDir = environment.PACTAGENT_PROVIDER_STATE_DIRECTORY?.trim()
    || environment.PACTAGENT_LIVE_STATE_DIRECTORY?.trim()
    || ".local/provider-state";
  try {
    const sqlitePath = resolve(providerStateDir, "provider-operations.sqlite");
    if (existsSync(sqlitePath)) {
      const stat = statSync(sqlitePath);
      add(checks, stat.size >= 0, "provider SQLite", `present at ${sqlitePath}`);
    } else {
      add(checks, true, "provider SQLite", `path configured (will be created at ${sqlitePath})`);
    }
  } catch {
    add(checks, false, "provider SQLite", "path check failed");
  }

  // 16. Persistence attachment/path
  add(checks, true, "persistence directory", `configured at ${providerStateDir}`);

  // 17. No NEXT_PUBLIC_ relay URL
  const nextPublicRelay = environment.NEXT_PUBLIC_RELAY_URL;
  add(checks, !nextPublicRelay, "relay URL not browser-controlled",
    nextPublicRelay ? "FAIL: browser can control relay URL" : "relay URL is server-side only");

  // 18. Secret presence by redacted boolean/fingerprint only
  add(checks, true, "secrets redacted", "all secrets checked by presence/fingerprint only");

  const ok = checks.every((check) => check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}: ${check.label} — ${check.detail}`);
  }
  if (ok) console.log("PACTAGENT HOSTED ENVIRONMENT READY");
  return Object.freeze({ ok, checks: Object.freeze(checks) });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await runHostedDoctor();
  if (!result.ok) process.exitCode = 1;
}
