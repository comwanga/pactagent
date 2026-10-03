import { finalizeEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import type { SignedNostrEvent } from "../domain/nostr";
import {
  MAX_NOSTR_NORMALIZED_EVENT_BYTES,
  MAX_NOSTR_WEBSOCKET_PAYLOAD_BYTES,
  measureNostrEventTransportSize,
  nostrEventTransportLimitViolation,
} from "./private-task-transport";
import { WebSocketNostrRelayAdapter } from "./nostr-relay";

const RELAY_URL = process.env.PACTAGENT_STRFRY_BOUNDARY_URL ?? "ws://127.0.0.1:7777";
const SECRET = new Uint8Array(32).fill(73);
const CREATED_AT = Math.floor(Date.now() / 1000);

function signedGiftWrap(contentLength: number): SignedNostrEvent {
  return finalizeEvent(
    {
      kind: 1059,
      created_at: CREATED_AT,
      tags: [["p", "1".repeat(64)], ["t", "pactagent-size-boundary"]],
      content: "A".repeat(contentLength),
    },
    SECRET,
  ) as unknown as SignedNostrEvent;
}

function largestAcceptedEvent(): SignedNostrEvent {
  let low = 0;
  let high = MAX_NOSTR_NORMALIZED_EVENT_BYTES;
  let accepted = signedGiftWrap(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = signedGiftWrap(middle);
    if (nostrEventTransportLimitViolation(candidate) === undefined) {
      accepted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return accepted;
}

async function publish(event: SignedNostrEvent): Promise<void> {
  const relay = new WebSocketNostrRelayAdapter(RELAY_URL, {
    connectTimeoutMs: 10_000,
    defaultTimeoutMs: 15_000,
  });
  await relay.connect();
  try {
    await relay.publish(event);
  } finally {
    await relay.disconnect().catch(() => undefined);
  }
}

describe("active Strfry 1.1.3 private-task size contract", () => {
  it("accepts a small and a near-boundary valid NIP-59 EVENT message", async () => {
    const small = signedGiftWrap(64);
    const nearBoundary = largestAcceptedEvent();
    const smallSize = measureNostrEventTransportSize(small);
    const nearSize = measureNostrEventTransportSize(nearBoundary);

    expect(nostrEventTransportLimitViolation(small)).toBeUndefined();
    expect(nostrEventTransportLimitViolation(nearBoundary)).toBeUndefined();
    expect(nearSize.normalizedEventBytes).toBeLessThanOrEqual(MAX_NOSTR_NORMALIZED_EVENT_BYTES);
    expect(nearSize.websocketPayloadBytes).toBeLessThanOrEqual(MAX_NOSTR_WEBSOCKET_PAYLOAD_BYTES);
    expect(MAX_NOSTR_NORMALIZED_EVENT_BYTES - nearSize.normalizedEventBytes).toBeLessThan(2);

    await expect(publish(small)).resolves.toBeUndefined();
    await expect(publish(nearBoundary)).resolves.toBeUndefined();

    console.info("STRFRY_BOUNDARY_ACCEPTED", {
      small: smallSize,
      nearBoundary: nearSize,
      normalizedEventLimit: MAX_NOSTR_NORMALIZED_EVENT_BYTES,
      websocketPayloadLimit: MAX_NOSTR_WEBSOCKET_PAYLOAD_BYTES,
    });
  });

  it("rejects normalized event overflow in preflight and at the active relay", async () => {
    const nearBoundary = largestAcceptedEvent();
    const overflow = signedGiftWrap(nearBoundary.content.length + 1);
    const size = measureNostrEventTransportSize(overflow);

    expect(size.normalizedEventBytes).toBeGreaterThan(MAX_NOSTR_NORMALIZED_EVENT_BYTES);
    expect(size.websocketPayloadBytes).toBeLessThanOrEqual(MAX_NOSTR_WEBSOCKET_PAYLOAD_BYTES);
    expect(nostrEventTransportLimitViolation(overflow)).toBe("normalized_event");
    await expect(publish(overflow)).rejects.toMatchObject({ code: "publish_rejected" });
  });

  it("rejects WebSocket payload overflow in preflight and at the active relay", async () => {
    const nearBoundary = largestAcceptedEvent();
    const nearSize = measureNostrEventTransportSize(nearBoundary);
    const overflow = signedGiftWrap(
      nearBoundary.content.length +
        (MAX_NOSTR_WEBSOCKET_PAYLOAD_BYTES - nearSize.websocketPayloadBytes) +
        1,
    );
    const size = measureNostrEventTransportSize(overflow);

    expect(size.websocketPayloadBytes).toBeGreaterThan(MAX_NOSTR_WEBSOCKET_PAYLOAD_BYTES);
    expect(nostrEventTransportLimitViolation(overflow)).toBe("websocket_payload");
    await expect(publish(overflow)).rejects.toBeDefined();
  });
});
