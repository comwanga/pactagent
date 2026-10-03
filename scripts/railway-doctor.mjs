import https from "node:https";

import {
  readRailwayServiceVariables,
  requireRailwayVariable,
} from "./railway-config.mjs";
import { parseSignedNostrEvent, verifySignedNostrEvent } from "../src/domain/nostr.ts";
import { parsePontmoreAgentDefinitionEvent } from "../src/domain/pontmore-agent.ts";
import { parsePactServiceOfferEvent } from "../src/domain/pact-service-offer.ts";
import { parseCashuEscrowDescriptorEvent } from "../src/domain/pontmore-escrow.ts";

/*
 * Issue #39 production deployment doctor.
 *
 * Validates the REAL deployed Railway system with READ-ONLY checks. It
 * performs no economic mutation: no minting, no spending, no transactions,
 * no resets.
 *
 * Configuration is read from the linked Railway project at runtime; secret
 * values stay in memory and are never printed. Only PASS/FAIL results and
 * safe public identifiers (public URL, provider public key, certificate
 * issuer) are printed.
 */

const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function httpsGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, options, (response) => {
      const peer = response.socket?.getPeerCertificate?.() ?? null;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers, peer }));
    });
    request.setTimeout(options.timeoutMs ?? 15_000, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

function relayRequest(relayUrl, send) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const subscription = `railway-doctor-${Date.now()}`;
    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      ws.close();
      reject(new Error("relay request timed out"));
    }, 15_000);
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      resolve(value);
    };
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(send(subscription)));
    });
    ws.addEventListener("message", (message) => {
      let value;
      try {
        value = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (value[0] === "EOSE" && value[1] === subscription) {
        finish({ eose: true });
      } else if (value[0] === "EVENT" && value[2]) {
        finish({ event: value[2] });
      } else if (value[0] === "NOTICE" && value[1] === subscription) {
        finish({ notice: true });
      }
    });
    ws.addEventListener("error", () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        reject(new Error("relay connection failed"));
      }
    });
  });
}

function relayQueryP002(relayUrl, providerPublicKey) {
  return new Promise((resolve) => {
    const subscription = `railway-doctor-p002-${Date.now()}`;
    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      ws.close();
      resolve({ ok: false, reason: "timeout", found: { providers: 0, offers: 0, descriptors: 0, malformed: 0 } });
    }, 20_000);
    const found = { providers: 0, offers: 0, descriptors: 0, malformed: 0 };
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(["REQ", subscription, {
        authors: [providerPublicKey],
        kinds: [30360, 30400, 30361],
        limit: 50,
      }]));
    });
    ws.addEventListener("message", (message) => {
      let value;
      try {
        value = JSON.parse(String(message.data));
        if (value[0] === "EVENT" && value[2]) {
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
          } else {
            found.malformed++;
          }
        }
      } catch {
        found.malformed++;
      }
      if (value?.[0] === "EOSE" && value[1] === subscription) {
        clearTimeout(timer);
        ws.close();
        const ok = found.providers > 0 && found.offers > 0 && found.descriptors > 0 && found.malformed === 0;
        resolve({ ok, reason: ok ? "" : "artifacts missing or malformed", found });
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: "connection error", found });
    });
  });
}

async function main() {
  const webVariables = readRailwayServiceVariables("pactagent-web");

  const webOrigin = requireRailwayVariable(webVariables, "PACTAGENT_REQUESTER_UI_ORIGIN", "pactagent-web");
  const relayUrl = requireRailwayVariable(webVariables, "PACTAGENT_LIVE_RELAY_URL", "pactagent-web");
  const providerPublicKey = requireRailwayVariable(webVariables, "PACTAGENT_LIVE_PROVIDER_PUBLIC_KEY", "pactagent-web");
  const apiToken = requireRailwayVariable(webVariables, "PACTAGENT_RUNTIME_API_TOKEN", "pactagent-web");
  const runtimeMode = requireRailwayVariable(webVariables, "PACTAGENT_RUNTIME_MODE", "pactagent-web");
  const economicMode = requireRailwayVariable(webVariables, "PACTAGENT_ECONOMIC_MODE", "pactagent-web");

  console.log(`Railway production doctor — ${new Date().toISOString()}`);
  console.log(`Web origin: ${webOrigin}`);
  console.log(`Relay URL: ${relayUrl}`);
  console.log(`Provider public key: ${providerPublicKey}`);
  console.log(`Configuration: runtime=${runtimeMode} economic=${economicMode}`);

  // 1. Public HTTPS reachability + trusted certificate.
  try {
    const root = await httpsGet(`${webOrigin}/`);
    record("web HTTPS root reachable", root.status === 200, `HTTP ${root.status}`);
  } catch (error) {
    record("web HTTPS root reachable", false, error.message);
  }

  let certificate;
  try {
    const probe = await httpsGet(`${webOrigin}/api/health`);
    const peer = probe.peer;
    certificate = peer;
    const ok = probe.status === 200 && peer && peer.subject && peer.issuer;
    record("web TLS certificate trusted by system store", ok,
      peer ? `issuer=${peer.issuer?.O ?? peer.issuer?.CN} validTo=${peer.valid_to}` : "no peer certificate");
  } catch (error) {
    record("web TLS certificate trusted by system store", false, error.message);
  }

  try {
    const health = await httpsGet(`${webOrigin}/api/health`);
    const body = JSON.parse(health.body);
    record("web /api/health", health.status === 200 && body.ok === true,
      `runtimeInitialized=${String(body.runtimeInitialized)}`);
  } catch (error) {
    record("web /api/health", false, error.message);
  }

  // 2. WSS relay REQ/EOSE.
  try {
    await relayRequest(relayUrl, (sub) => ["REQ", sub, { limit: 1 }]);
    record("relay WSS REQ/EOSE", true);
  } catch (error) {
    record("relay WSS REQ/EOSE", false, error.message);
  }

  // 3. P002 provider artifacts (verified signatures).
  const p002 = await relayQueryP002(relayUrl, providerPublicKey);
  record("provider P002 artifacts visible and valid", p002.ok,
    p002.ok
      ? `providers=${p002.found.providers} offers=${p002.found.offers} descriptors=${p002.found.descriptors}`
      : p002.reason);

  // 4. Runtime composition through the bearer-authenticated surface.
  try {
    const readiness = await httpsGet(`${webOrigin}/api/runtime/readiness`, {
      headers: { authorization: `Bearer ${apiToken}` },
    });
    if (readiness.status === 401) {
      record("runtime readiness endpoint", false, "HTTP 401 unauthorized");
    } else if (readiness.status === 503) {
      record("runtime readiness endpoint", false, "runtime not initialized yet (first API use boots it)");
    } else {
      const composition = JSON.parse(readiness.body);
      const hosted = composition.runtimeMode === "hosted" && composition.externalProvider === true;
      record("runtime composition is hosted/external-provider", hosted,
        `runtimeMode=${String(composition.runtimeMode)} externalProvider=${String(composition.externalProvider)}`);
    }
  } catch (error) {
    record("runtime readiness endpoint", false, error.message);
  }

  // 5. Browser-accessible requester surfaces stay origin/session-gated.
  try {
    const gated = await httpsGet(`${webOrigin}/api/requester/demo`, { timeoutMs: 10_000 });
    record("requester demo surface is session-gated", gated.status === 401,
      `HTTP ${gated.status} without a browser session`);
  } catch (error) {
    record("requester demo surface is session-gated", false, error.message);
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\nRailway production doctor: ${failed.length === 0 ? "PASS" : "FAIL"} (${results.length - failed.length}/${results.length} checks passed)`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`Railway production doctor crashed: ${error.message}`);
  process.exit(1);
});
