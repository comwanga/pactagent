import "server-only";

import { nostrPublicKey, type SignedNostrEvent } from "../domain/nostr";
import type { NostrEncrypter } from "./private-task-transport";
import type { NostrSigner } from "../domain/nostr";

/*
 * Public-key-only signer and encrypter (Issue #38 Blocker 3).
 *
 * In externalProvider mode, the requester process does NOT possess the
 * provider's private key. These stubs expose only the provider's public
 * key (which is not a secret) and throw if any signing or decryption
 * operation is attempted.
 *
 * This enforces the trust boundary: the requester can reference the
 * provider's public identity but cannot sign provider-owned events or
 * decrypt provider-bound messages.
 */

const PROVIDER_SIGNER_UNAVAILABLE = "Provider signer is not available in externalProvider mode; the provider service owns provider signing authority";

export function createPublicKeyOnlySigner(publicKey: string): NostrSigner {
  const pubkey = nostrPublicKey(publicKey);
  return {
    publicKey: pubkey,
    async sign(): Promise<SignedNostrEvent> {
      throw new Error(PROVIDER_SIGNER_UNAVAILABLE);
    },
  };
}

export function createPublicKeyOnlyEncrypter(publicKey: string): NostrEncrypter {
  const pubkey = nostrPublicKey(publicKey);
  return {
    publicKey: pubkey,
    async sign(): Promise<SignedNostrEvent> {
      throw new Error(PROVIDER_SIGNER_UNAVAILABLE);
    },
    encryptNip44(): string {
      throw new Error("Provider encrypter is not available in externalProvider mode");
    },
    decryptNip44(): string {
      throw new Error("Provider encrypter is not available in externalProvider mode");
    },
  };
}

export { nostrPublicKey };
