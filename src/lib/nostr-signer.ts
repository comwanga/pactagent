import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { InvalidDomainInputError } from "../domain/errors";
import {
  type NostrSigner,
  type NostrTag,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
  nostrPublicKey,
} from "../domain/nostr";

const PRIVATE_KEY_PATTERN = /^[0-9a-f]{64}$/;

// secp256k1 group order n: valid secret scalars are in [1, n-1].
const SECP256K1_ORDER = hexToBytes(
  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);

export type NostrPrivateKey = string & { readonly __nostrPrivateKey: "NostrPrivateKey" };

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}

function isLessThan(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

export function parseNostrPrivateKey(value: string): NostrPrivateKey {
  if (typeof value !== "string" || !PRIVATE_KEY_PATTERN.test(value)) {
    throw new InvalidDomainInputError("Nostr private key must be 64 lowercase hexadecimal characters");
  }
  const scalar = hexToBytes(value);
  if (isZero(scalar) || !isLessThan(scalar, SECP256K1_ORDER)) {
    throw new InvalidDomainInputError("Nostr private key must be a valid secp256k1 secret scalar");
  }
  return value as NostrPrivateKey;
}

// For local development identities only; keep it out of logs and public models.
export function generateNostrPrivateKey(): string {
  return bytesToHex(generateSecretKey());
}

/*
 * Holds a private key only inside the returned closure; it is never attached as a
 * property, returned from any method, or placed onto signed event output, so no
 * caller — AI or otherwise — can reach it. Signing is performed locally using the
 * supplied event and held key, with no model or network dependency, reusing the
 * domain's nostr-tools crypto stack.
 */
export function createLocalNostrSigner(privateKeyHex: string): NostrSigner {
  const privateKey = parseNostrPrivateKey(privateKeyHex);
  const secretKeyBytes = hexToBytes(privateKey);
  const publicKey = nostrPublicKey(getPublicKey(secretKeyBytes));

  return {
    publicKey,
    async sign(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
      if (event.pubkey !== publicKey) {
        throw new InvalidDomainInputError("Signer can only sign events for its own identity");
      }
      // finalizeEvent mutates its template, so build a throwaway copy that excludes id/sig.
      const template = {
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags.map((tag) => [...tag]),
        content: event.content,
      };
      const signed = finalizeEvent(template, secretKeyBytes);
      return {
        pubkey: nostrPublicKey(signed.pubkey),
        created_at: signed.created_at,
        kind: signed.kind,
        tags: signed.tags.map((tag): NostrTag => [tag[0], ...tag.slice(1)]),
        content: signed.content,
        id: signed.id,
        sig: signed.sig,
      };
    },
  };
}
