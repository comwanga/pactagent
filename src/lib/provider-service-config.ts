import "server-only";

import { getPublicKey } from "nostr-tools/pure";

import { createLocalNostrSigner } from "./nostr-signer";
import { createLocalNostrEncrypter, type NostrEncrypter } from "./private-task-transport";
import { WebSocketNostrRelayAdapter, type NostrRelayAdapter } from "./nostr-relay";
import { parseNostrPrivateKey, hexToBytes } from "./nostr-signer";
import type { NostrSigner } from "../domain/nostr";

/*
 * Provider service configuration (Issue #38).
 *
 * Provider identity is server-side only. It is configured through
 * environment variables and never embedded in browser bundles, returned
 * through requester DTOs, logged, or written into public documentation.
 *
 * Hosted mode requires a stable provider identity. If the identity is
 * missing in hosted mode, the service fails closed — it does NOT silently
 * generate a new identity on every restart.
 *
 * Development mode may use a generated identity for convenience, but the
 * boundary between development and hosted behavior is explicit.
 */

export type ProviderDeploymentMode = "local" | "hosted";

export interface ProviderServiceEnvConfig {
  readonly mode: ProviderDeploymentMode;
  readonly relayUrl: string;
  readonly providerPrivateKeyHex: string;
  readonly escrowAuthorityPublicKey: string;
  readonly offerAmountSats: number;
  readonly maximumExecutionSeconds: number;
  readonly escrowTimeoutSeconds: number;
  readonly pollIntervalMs: number;
  readonly transitionWaitTimeoutMs: number;
  readonly stateDirectory: string;
  readonly providerDefinitionIdentifier: string;
  readonly offerIdentifier: string;
  readonly escrowDescriptorIdentifier: string;
  readonly strfryUpstream?: string;
  readonly hostedWssHostname?: string;
}

export type ProviderConfigErrorCode =
  | "missing_provider_identity"
  | "invalid_provider_key"
  | "missing_relay_url"
  | "invalid_offer_amount"
  | "invalid_execution_seconds"
  | "invalid_escrow_timeout"
  | "missing_state_directory"
  | "invalid_poll_interval"
  | "invalid_provider_mode";

export class ProviderServiceConfigError extends Error {
  readonly code: ProviderConfigErrorCode;

  constructor(code: ProviderConfigErrorCode, message: string) {
    super(message);
    this.name = "ProviderServiceConfigError";
    this.code = code;
  }
}

export function readProviderServiceConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ProviderServiceEnvConfig {
  // F38-06A: Parse provider mode as a CLOSED SET. Unknown values FAIL.
  // Missing mode FAILS CLOSED — no silent default to local.
  const modeRaw = environment.PACTAGENT_PROVIDER_MODE?.trim();
  let mode: ProviderDeploymentMode;
  if (modeRaw === undefined || modeRaw === "") {
    throw new ProviderServiceConfigError(
      "invalid_provider_mode",
      "PACTAGENT_PROVIDER_MODE is required. Set it to \"local\" or \"hosted\". " +
        "Missing mode does NOT default to local — fail closed.",
    );
  } else if (modeRaw === "local" || modeRaw === "hosted") {
    mode = modeRaw;
  } else {
    throw new ProviderServiceConfigError(
      "invalid_provider_mode",
      `PACTAGENT_PROVIDER_MODE must be "local" or "hosted" (got: "${modeRaw}")`,
    );
  }

  const relayUrl = environment.PACTAGENT_LIVE_RELAY_URL?.trim();
  if (!relayUrl) {
    throw new ProviderServiceConfigError("missing_relay_url", "PACTAGENT_LIVE_RELAY_URL is required");
  }

  const providerPrivateKeyHex = environment.PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY?.trim();
  if (!providerPrivateKeyHex) {
    if (mode === "hosted") {
      throw new ProviderServiceConfigError(
        "missing_provider_identity",
        "Hosted provider mode requires PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY. " +
          "A stable identity must be configured — the service does NOT generate one silently.",
      );
    }
    throw new ProviderServiceConfigError(
      "missing_provider_identity",
      "PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY is required",
    );
  }

  try {
    parseNostrPrivateKey(providerPrivateKeyHex);
  } catch {
    throw new ProviderServiceConfigError(
      "invalid_provider_key",
      "PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY is not a valid 32-byte hex private key",
    );
  }

  // F38-06B: Escrow identity — derive the public key cryptographically.
  // Do NOT treat a 64-character private key string as a public key merely
  // because both encodings have equal length. Prefer an explicit public
  // key; if only a private key is provided, derive the public key from it.
  const escrowAuthorityPublicKeyRaw = environment.PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY?.trim();
  const escrowAuthorityPrivateKeyRaw = environment.PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY?.trim();

  if (!escrowAuthorityPublicKeyRaw && !escrowAuthorityPrivateKeyRaw) {
    throw new ProviderServiceConfigError(
      "missing_provider_identity",
      "PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY (or PRIVATE_KEY for derivation) is required for the provider to create escrow authority bindings",
    );
  }

  let escrowAuthorityPubkeyHex: string;
  if (escrowAuthorityPublicKeyRaw) {
    // Use the explicit public key directly.
    if (!/^[0-9a-f]{64}$/.test(escrowAuthorityPublicKeyRaw)) {
      throw new ProviderServiceConfigError(
        "invalid_provider_key",
        "PACTAGENT_LIVE_ESCROW_AUTHORITY_PUBLIC_KEY is not a valid 64-hex-char public key",
      );
    }
    escrowAuthorityPubkeyHex = escrowAuthorityPublicKeyRaw;
  } else {
    // F38-06B: Derive the public key cryptographically from the private key.
    // Do NOT use the private key string as-is (it has the same length as a
    // public key but is NOT a public key).
    try {
      const privateKey = parseNostrPrivateKey(escrowAuthorityPrivateKeyRaw!);
      escrowAuthorityPubkeyHex = getPublicKey(hexToBytes(privateKey));
    } catch {
      throw new ProviderServiceConfigError(
        "invalid_provider_key",
        "PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY is not a valid 32-byte hex private key for public key derivation",
      );
    }
  }

  const offerAmountSats = Number(environment.PACTAGENT_PROVIDER_OFFER_SATS?.trim() ?? "350");
  if (!Number.isInteger(offerAmountSats) || offerAmountSats <= 0 || offerAmountSats > 100_000) {
    throw new ProviderServiceConfigError(
      "invalid_offer_amount",
      "PACTAGENT_PROVIDER_OFFER_SATS must be a positive integer between 1 and 100000",
    );
  }

  const maximumExecutionSeconds = Number(
    environment.PACTAGENT_PROVIDER_MAX_EXECUTION_SECONDS?.trim() ?? "120",
  );
  if (
    !Number.isInteger(maximumExecutionSeconds) ||
    maximumExecutionSeconds <= 0 ||
    maximumExecutionSeconds > 300
  ) {
    throw new ProviderServiceConfigError(
      "invalid_execution_seconds",
      "PACTAGENT_PROVIDER_MAX_EXECUTION_SECONDS must be an integer between 1 and 300",
    );
  }

  const escrowTimeoutSeconds = Number(
    environment.PACTAGENT_PROVIDER_ESCROW_TIMEOUT_SECONDS?.trim() ?? "900",
  );
  if (!Number.isInteger(escrowTimeoutSeconds) || escrowTimeoutSeconds <= 0) {
    throw new ProviderServiceConfigError(
      "invalid_escrow_timeout",
      "PACTAGENT_PROVIDER_ESCROW_TIMEOUT_SECONDS must be a positive integer",
    );
  }

  const pollIntervalMs = Number(
    environment.PACTAGENT_PROVIDER_POLL_INTERVAL_MS?.trim() ?? "3000",
  );
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 500) {
    throw new ProviderServiceConfigError(
      "invalid_poll_interval",
      "PACTAGENT_PROVIDER_POLL_INTERVAL_MS must be at least 500",
    );
  }

  const transitionWaitTimeoutMs = Number(
    environment.PACTAGENT_PROVIDER_TRANSITION_TIMEOUT_MS?.trim() ?? "120000",
  );

  const stateDirectory =
    environment.PACTAGENT_PROVIDER_STATE_DIRECTORY?.trim() ||
    environment.PACTAGENT_LIVE_STATE_DIRECTORY?.trim() ||
    ".local/provider-state";

  return Object.freeze({
    mode,
    relayUrl,
    providerPrivateKeyHex,
    escrowAuthorityPublicKey: escrowAuthorityPubkeyHex,
    offerAmountSats,
    maximumExecutionSeconds,
    escrowTimeoutSeconds,
    pollIntervalMs,
    transitionWaitTimeoutMs,
    stateDirectory,
    providerDefinitionIdentifier:
      environment.PACTAGENT_PROVIDER_DEFINITION_ID?.trim() || "hosted-provider",
    offerIdentifier:
      environment.PACTAGENT_PROVIDER_OFFER_ID?.trim() || "hosted-document-summary-offer",
    escrowDescriptorIdentifier:
      environment.PACTAGENT_PROVIDER_ESCROW_DESCRIPTOR_ID?.trim() || "hosted-cashu-escrow",
    strfryUpstream: environment.PACTAGENT_STRFRY_UPSTREAM?.trim(),
    hostedWssHostname: environment.PACTAGENT_HOSTED_WSS_HOSTNAME?.trim(),
  });
}

export interface ProviderServiceWiring {
  readonly providerSigner: NostrSigner;
  readonly providerEncrypter: NostrEncrypter;
  readonly relay: NostrRelayAdapter;
  readonly relayUrl: string;
}

export function wireProviderService(env: ProviderServiceEnvConfig): ProviderServiceWiring {
  const providerSigner = createLocalNostrSigner(env.providerPrivateKeyHex);
  const providerEncrypter = createLocalNostrEncrypter(env.providerPrivateKeyHex);
  const relay = new WebSocketNostrRelayAdapter(env.relayUrl, {
    connectTimeoutMs: 10_000,
    defaultTimeoutMs: 15_000,
  });
  return Object.freeze({
    providerSigner,
    providerEncrypter,
    relay,
    relayUrl: env.relayUrl,
  });
}
