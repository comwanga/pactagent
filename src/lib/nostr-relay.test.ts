import { describe, expect, it } from "vitest";

import type { NostrTag, SignedNostrEvent } from "../domain/nostr";
import {
  NostrRelayError,
  type NostrFilter,
  type NostrRelayAdapter,
  type RelayWebSocket,
  type RelayWebSocketEvent,
  type RelayWebSocketFactory,
  type RelayWebSocketListener,
  WebSocketNostrRelayAdapter,
} from "./nostr-relay";

type FakeOpenBehavior = "open" | "error" | "hang";

interface FakeRelayOptions {
  readonly openBehavior?: FakeOpenBehavior;
  readonly openDelayMs?: number;
  readonly sendError?: Error;
  readonly closeError?: Error;
}

class FakeRelaySocket implements RelayWebSocket {
  readonly url: string;
  readyState = 0;
  private readonly listeners: Record<string, Set<RelayWebSocketListener>> = {};
  readonly sent: string[] = [];
  private readonly openTimer?: ReturnType<typeof setTimeout>;
  private readonly sendError?: Error;
  private readonly closeError?: Error;

  constructor(url: string, options: FakeRelayOptions = {}) {
    this.url = url;
    this.sendError = options.sendError;
    this.closeError = options.closeError;
    const behavior = options.openBehavior ?? "open";
    const delay = options.openDelayMs ?? 0;
    if (behavior === "open") {
      this.openTimer = setTimeout(() => this.simulateOpen(), delay);
    } else if (behavior === "error") {
      this.openTimer = setTimeout(() => this.simulateError(), delay);
    }
  }

  send(data: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
  }

  close(code = 1000, _reason = ""): void {
    if (this.closeError) throw this.closeError;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason: _reason, wasClean: true });
  }

  addEventListener(type: RelayWebSocketEvent, listener: RelayWebSocketListener): void {
    (this.listeners[type] ??= new Set()).add(listener);
  }

  removeEventListener(type: RelayWebSocketEvent, listener: RelayWebSocketListener): void {
    this.listeners[type]?.delete(listener);
  }

  private emit(type: RelayWebSocketEvent, event: unknown): void {
    for (const listener of [...(this.listeners[type] ?? [])]) listener(event);
  }

  simulateOpen(): void {
    if (this.readyState === 0) {
      this.readyState = 1;
      this.emit("open", undefined);
    }
  }

  simulateError(event: unknown = new Error("relay error")): void {
    this.emit("error", event);
  }

  serverClose(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: true });
  }

  receive(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  dispose(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
  }

  lastSentFrame(): unknown {
    const raw = this.sent[this.sent.length - 1];
    return raw ? JSON.parse(raw) : undefined;
  }

  sentFrames(): unknown[] {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

function fakeFactory(socketRef: { current?: FakeRelaySocket }, options: FakeRelayOptions = {}): RelayWebSocketFactory {
  return (url: string) => {
    const socket = new FakeRelaySocket(url, options);
    socketRef.current = socket;
    return socket;
  };
}

function signedEvent(overrides: Partial<SignedNostrEvent> = {}): SignedNostrEvent {
  return {
    id: "0000000000000000000000000000000000000000000000000000000000000001",
    pubkey: "000000000000000000000000000000000000000000000000000000000000000a",
    created_at: 1_700_000_000,
    kind: 1,
    tags: [["e", "parent"]] as readonly NostrTag[],
    content: "hello",
    sig: "0".repeat(64),
    ...overrides,
  } as unknown as SignedNostrEvent;
}

function createAdapter(
  socketRef: { current?: FakeRelaySocket },
  options: FakeRelayOptions & { connectTimeoutMs?: number; defaultTimeoutMs?: number } = {},
): NostrRelayAdapter {
  return new WebSocketNostrRelayAdapter("wss://relay.example", {
    webSocketFactory: fakeFactory(socketRef, options),
    connectTimeoutMs: options.connectTimeoutMs,
    defaultTimeoutMs: options.defaultTimeoutMs,
  });
}

describe("NostrRelayError", () => {
  it("carries a typed code and relay URL", () => {
    const error = new NostrRelayError({ code: "connection_failed", relayUrl: "wss://x", message: "boom" });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("connection_failed");
    expect(error.relayUrl).toBe("wss://x");
    expect(error.message).toBe("boom");
    expect(error.name).toBe("NostrRelayError");
  });

  it("defaults the message to the code", () => {
    const error = new NostrRelayError({ code: "query_timeout", relayUrl: "wss://x" });
    expect(error.message).toBe("query_timeout");
  });
});

describe("WebSocketNostrRelayAdapter - URL configuration", () => {
  it("accepts wss:// and ws:// URLs", () => {
    expect(() => new WebSocketNostrRelayAdapter("wss://relay.example")).not.toThrow();
    expect(() => new WebSocketNostrRelayAdapter("ws://localhost:8080")).not.toThrow();
  });

  it("rejects malformed URLs with invalid_url", () => {
    expect(() => new WebSocketNostrRelayAdapter("not-a-url")).toThrow(NostrRelayError);
    const error = (() => {
      try {
        new WebSocketNostrRelayAdapter("not-a-url");
        throw new Error("expected throw");
      } catch (e) {
        return e as NostrRelayError;
      }
    })();
    expect(error.code).toBe("invalid_url");
  });

  it("rejects non-websocket protocols with invalid_url", () => {
    const error = (() => {
      try {
        new WebSocketNostrRelayAdapter("https://relay.example");
        throw new Error("expected throw");
      } catch (e) {
        return e as NostrRelayError;
      }
    })();
    expect(error.code).toBe("invalid_url");
  });

  it("exposes the configured relay URL", () => {
    const adapter = new WebSocketNostrRelayAdapter("wss://relay.example");
    expect(adapter.url).toBe("wss://relay.example");
  });
});

describe("WebSocketNostrRelayAdapter - connection", () => {
  it("wraps a synchronous WebSocket factory failure", async () => {
    const adapter = new WebSocketNostrRelayAdapter("wss://relay.example", {
      webSocketFactory: () => {
        throw new Error("dial failed");
      },
    });

    await expect(adapter.connect()).rejects.toMatchObject({
      code: "connection_failed",
      cause: "dial failed",
    });
  });

  it("connects to the configured relay", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();
    expect(ref.current?.readyState).toBe(1);
  });

  it("is a no-op when already connected", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();
    const first = ref.current;
    await adapter.connect();
    expect(ref.current).toBe(first);
  });

  it("fails with connection_timeout when the relay never opens", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { openBehavior: "hang", connectTimeoutMs: 30 });
    await expect(adapter.connect()).rejects.toMatchObject({ code: "connection_timeout" });
    ref.current?.dispose();
  });

  it("fails with connection_failed when the relay errors during handshake", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { openBehavior: "error", connectTimeoutMs: 1000 });
    await expect(adapter.connect()).rejects.toMatchObject({ code: "connection_failed" });
    ref.current?.dispose();
  });

  it("fails with connection_closed when the relay closes during handshake", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { openBehavior: "open", openDelayMs: 50, connectTimeoutMs: 1000 });
    const connectPromise = adapter.connect();
    await Promise.resolve();
    ref.current?.serverClose(4000, "bye");
    await expect(connectPromise).rejects.toMatchObject({ code: "connection_closed" });
    ref.current?.dispose();
  });

  it("shares a single in-flight connection across concurrent connect() calls", async () => {
    const created: FakeRelaySocket[] = [];
    const factory: RelayWebSocketFactory = (url) => {
      const socket = new FakeRelaySocket(url, { openBehavior: "open", openDelayMs: 20 });
      created.push(socket);
      return socket;
    };
    const adapter = new WebSocketNostrRelayAdapter("wss://relay.example", {
      webSocketFactory: factory,
      connectTimeoutMs: 1000,
    });

    const first = adapter.connect();
    const second = adapter.connect();
    await Promise.all([first, second]);

    expect(created).toHaveLength(1);
    expect(adapter.url).toBe("wss://relay.example");
    created.forEach((socket) => socket.dispose());
  });

  it("honours an AbortSignal to abort a pending connect", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { openBehavior: "hang", connectTimeoutMs: 1000 });
    const controller = new AbortController();
    const connectPromise = adapter.connect(controller.signal);
    controller.abort();
    await expect(connectPromise).rejects.toMatchObject({ code: "aborted" });
    ref.current?.dispose();
  });
});

describe("WebSocketNostrRelayAdapter - publish", () => {
  it("publishes a supplied signed event and resolves on OK", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();
    const event = signedEvent();

    const publish = adapter.publish(event);
    const frame = ref.current?.lastSentFrame() as unknown[];
    expect(frame[0]).toBe("EVENT");
    expect(frame[1]).toStrictEqual(event);
    ref.current?.receive(["OK", event.id, true, ""]);

    await expect(publish).resolves.toBeUndefined();
  });

  it("rejects with publish_rejected when the relay refuses the event", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();
    const event = signedEvent();

    const publish = adapter.publish(event);
    ref.current?.receive(["OK", event.id, false, "rate-limited"]);

    await expect(publish).rejects.toMatchObject({ code: "publish_rejected" });
  });

  it("rejects with publish_timeout when no OK arrives in time", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { defaultTimeoutMs: 30 });
    await adapter.connect();
    const publish = adapter.publish(signedEvent());
    await expect(publish).rejects.toMatchObject({ code: "publish_timeout" });
    ref.current?.dispose();
  });

  it("rejects with not_connected when called before connect", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await expect(adapter.publish(signedEvent())).rejects.toMatchObject({ code: "not_connected" });
  });

  it("refuses to publish events carrying private key material", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();
    const tainted = { ...signedEvent(), privateKey: "0".repeat(64) } as unknown as SignedNostrEvent;
    await expect(adapter.publish(tainted)).rejects.toMatchObject({ code: "private_key_refused" });
    expect(ref.current?.sent.length).toBe(0);
  });

  it("refuses to publish events carrying an nsec1 string inside content or tags", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();
    const taintedContent = {
      ...signedEvent(),
      content: "here is my key nsec1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    } as unknown as SignedNostrEvent;
    await expect(adapter.publish(taintedContent)).rejects.toMatchObject({
      code: "private_key_refused",
    });
    const taintedTag = {
      ...signedEvent(),
      tags: [["secret", "nsec1yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"]] as unknown as readonly NostrTag[],
    } as unknown as SignedNostrEvent;
    await expect(adapter.publish(taintedTag)).rejects.toMatchObject({ code: "private_key_refused" });
    expect(ref.current?.sent.length).toBe(0);
  });

  it("rejects with connection_closed when the relay drops mid-publish", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { defaultTimeoutMs: 1000 });
    await adapter.connect();
    const publish = adapter.publish(signedEvent());
    ref.current?.serverClose(4000, "shutdown");
    await expect(publish).rejects.toMatchObject({ code: "connection_closed" });
  });

  it("honours an AbortSignal to cancel a pending publish", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { defaultTimeoutMs: 1000 });
    await adapter.connect();
    const controller = new AbortController();
    const publish = adapter.publish(signedEvent(), { signal: controller.signal });
    controller.abort();
    await expect(publish).rejects.toMatchObject({ code: "aborted" });
  });

  it("sanitizes the WebSocket error cause to a string message, not the raw event", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { defaultTimeoutMs: 1000 });
    await adapter.connect();
    const publish = adapter.publish(signedEvent());
    ref.current?.simulateError({ message: "ECONNRESET", internal: "secret-headers" });
    let caught: unknown;
    try {
      await publish;
    } catch (error) {
      caught = error;
    }
    const error = caught as NostrRelayError;
    expect(error.code).toBe("connection_failed");
    expect(error.cause).toBe("ECONNRESET");
    expect(JSON.stringify(error.cause)).not.toContain("secret-headers");
  });

  it("wraps a synchronous send failure and cleans up the pending publish", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { defaultTimeoutMs: 1000, sendError: new Error("send failed") });
    await adapter.connect();

    await expect(adapter.publish(signedEvent())).rejects.toMatchObject({
      code: "connection_failed",
      cause: "send failed",
    });
    ref.current?.receive(["OK", signedEvent().id, true, ""]);
  });
});

describe("WebSocketNostrRelayAdapter - query", () => {
  it("queries events using required filters and returns collected events at EOSE", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();

    const filter: NostrFilter = { kinds: [1], authors: ["abc"], limit: 10, tags: { e: ["parent"] } };
    const query = adapter.queryEvents(filter);

    const frame = ref.current?.lastSentFrame() as unknown[];
    expect(frame[0]).toBe("REQ");
    const subscriptionId = frame[1] as string;
    const wireFilter = frame[2] as Record<string, unknown>;
    expect(wireFilter.kinds).toEqual([1]);
    expect(wireFilter.authors).toEqual(["abc"]);
    expect(wireFilter.limit).toBe(10);
    expect(wireFilter["#e"]).toEqual(["parent"]);

    const eventA = signedEvent({ id: "a".repeat(64) });
    const eventB = signedEvent({ id: "b".repeat(64), content: "second" });
    ref.current?.receive(["EVENT", subscriptionId, eventA]);
    ref.current?.receive(["EVENT", subscriptionId, eventB]);
    ref.current?.receive(["EOSE", subscriptionId]);

    await expect(query).resolves.toEqual([eventA, eventB]);

    const closeFrame = ref.current?.sentFrames().at(-1) as unknown[];
    expect(closeFrame[0]).toBe("CLOSE");
    expect(closeFrame[1]).toBe(subscriptionId);
  });

  it("ignores events addressed to a different subscription", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();

    const query = adapter.queryEvents({ kinds: [1] });
    const subscriptionId = (ref.current?.lastSentFrame() as unknown[])[1] as string;
    const stranger = signedEvent({ id: "c".repeat(64) });
    ref.current?.receive(["EVENT", "other-sub", stranger]);
    const wanted = signedEvent({ id: "d".repeat(64) });
    ref.current?.receive(["EVENT", subscriptionId, wanted]);
    ref.current?.receive(["EOSE", subscriptionId]);

    await expect(query).resolves.toEqual([wanted]);
  });

  it("skips malformed events in the result set", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();

    const query = adapter.queryEvents({ kinds: [1] });
    const subscriptionId = (ref.current?.lastSentFrame() as unknown[])[1] as string;
    ref.current?.receive(["EVENT", subscriptionId, { kind: 1 }]);
    const valid = signedEvent({ id: "e".repeat(64) });
    ref.current?.receive(["EVENT", subscriptionId, valid]);
    ref.current?.receive(["EOSE", subscriptionId]);

    await expect(query).resolves.toEqual([valid]);
  });

  it("drops events whose content or tags carry private key material", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();

    const query = adapter.queryEvents({ kinds: [1] });
    const subscriptionId = (ref.current?.lastSentFrame() as unknown[])[1] as string;
    const tainted = {
      ...signedEvent({ id: "f".repeat(64) }),
      content: "leaked nsec1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    };
    const valid = signedEvent({ id: "e".repeat(64) });
    ref.current?.receive(["EVENT", subscriptionId, tainted]);
    ref.current?.receive(["EVENT", subscriptionId, valid]);
    ref.current?.receive(["EOSE", subscriptionId]);

    await expect(query).resolves.toEqual([valid]);
  });

  it("rejects with query_timeout when EOSE never arrives", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { defaultTimeoutMs: 30 });
    await adapter.connect();
    const query = adapter.queryEvents({ kinds: [1] });
    await expect(query).rejects.toMatchObject({ code: "query_timeout" });
    const closeFrame = ref.current?.sentFrames().at(-1) as unknown[];
    expect(closeFrame[0]).toBe("CLOSE");
    ref.current?.dispose();
  });

  it("rejects with not_connected when called before connect", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await expect(adapter.queryEvents({ kinds: [1] })).rejects.toMatchObject({ code: "not_connected" });
  });

  it("honours an AbortSignal to cancel a pending query", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { defaultTimeoutMs: 1000 });
    await adapter.connect();
    const controller = new AbortController();
    const query = adapter.queryEvents({ kinds: [1] }, { signal: controller.signal });
    controller.abort();
    await expect(query).rejects.toMatchObject({ code: "aborted" });
  });

  it("does not send a CLOSE for a pre-aborted query (no subscription opened)", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { defaultTimeoutMs: 1000 });
    await adapter.connect();
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.queryEvents({ kinds: [1] }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    const frames = ref.current?.sentFrames() ?? [];
    expect(frames.some((f) => (f as unknown[])[0] === "REQ")).toBe(false);
    expect(frames.some((f) => (f as unknown[])[0] === "CLOSE")).toBe(false);
  });

  it("wraps a synchronous query send failure and does not send CLOSE for the unopened subscription", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { sendError: new Error("send failed") });
    await adapter.connect();

    await expect(adapter.queryEvents({ kinds: [1] })).rejects.toMatchObject({
      code: "connection_failed",
      cause: "send failed",
    });
    const frames = ref.current?.sentFrames() ?? [];
    expect(frames.some((f) => (f as unknown[])[0] === "CLOSE")).toBe(false);
  });

  it("bounds the result set to the filter limit and closes the subscription", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();

    const query = adapter.queryEvents({ kinds: [1], limit: 2 });
    const subscriptionId = (ref.current?.lastSentFrame() as unknown[])[1] as string;

    const eventA = signedEvent({ id: "a".repeat(64) });
    const eventB = signedEvent({ id: "b".repeat(64) });
    const eventC = signedEvent({ id: "c".repeat(64) });
    ref.current?.receive(["EVENT", subscriptionId, eventA]);
    ref.current?.receive(["EVENT", subscriptionId, eventB]);
    ref.current?.receive(["EVENT", subscriptionId, eventC]);

    const result = await query;
    expect(result).toEqual([eventA, eventB]);
    const closeFrame = ref.current?.sentFrames().at(-1) as unknown[];
    expect(closeFrame[0]).toBe("CLOSE");
  });

  it("caps the local buffer to the hard maximum even when the relay ignores the wire limit", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { defaultTimeoutMs: 1000 });
    await adapter.connect();

    const query = adapter.queryEvents({ kinds: [1], limit: 1_000_000 });
    const subscriptionId = (ref.current?.lastSentFrame() as unknown[])[1] as string;

    // Relay ignores the requested limit and floods events; the adapter must cap locally.
    const flood: SignedNostrEvent[] = [];
    for (let i = 0; i < 11_000; i++) {
      flood.push(signedEvent({ id: i.toString(16).padStart(64, "0") }));
    }
    for (const event of flood.slice(0, 10_001)) {
      ref.current?.receive(["EVENT", subscriptionId, event]);
    }
    ref.current?.receive(["EOSE", subscriptionId]);

    const result = await query;
    expect(result.length).toBe(10_000);
    ref.current?.dispose();
  });
});

describe("WebSocketNostrRelayAdapter - disconnect", () => {
  it("cleanly disconnects an open connection", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();
    expect(ref.current?.readyState).toBe(1);
    await adapter.disconnect();
    expect(ref.current?.readyState).toBe(3);
  });

  it("is a no-op when never connected", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it("makes subsequent operations fail with not_connected", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();
    await adapter.disconnect();
    await expect(adapter.publish(signedEvent())).rejects.toMatchObject({ code: "not_connected" });
    await expect(adapter.queryEvents({ kinds: [1] })).rejects.toMatchObject({ code: "not_connected" });
  });

  it("rejects with connection_failed when socket.close() throws", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { closeError: new Error("close failed") });
    await adapter.connect();
    await expect(adapter.disconnect()).rejects.toMatchObject({
      code: "connection_failed",
      cause: "close failed",
    });
  });
});

describe("WebSocketNostrRelayAdapter - reconnect", () => {
  it("reconnects after an unexpected server close, allowing subsequent queries", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();
    expect(ref.current?.readyState).toBe(1);
    ref.current!.serverClose(1006, "unexpected");
    expect(ref.current?.readyState).toBe(3);
    await adapter.reconnect();
    expect(ref.current?.readyState).toBe(1);
    const queryPromise = adapter.queryEvents({ kinds: [1] });
    ref.current!.receive(["EOSE", "pactagent-0"]);
    const events = await queryPromise;
    expect(events).toHaveLength(0);
  });

  it("concurrent reconnect callers share one controlled connect attempt", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref, { openDelayMs: 50 });
    await adapter.connect();
    ref.current!.serverClose(1006, "unexpected");
    const [a, b] = await Promise.all([adapter.reconnect(), adapter.reconnect()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(ref.current?.readyState).toBe(1);
  });

  it("does not reconnect after explicit disconnect", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();
    await adapter.disconnect();
    await adapter.reconnect();
    expect(ref.current?.readyState).toBe(3);
    await expect(adapter.queryEvents({ kinds: [1] })).rejects.toMatchObject({ code: "not_connected" });
  });

  it("reconnect is a no-op when already connected", async () => {
    const ref: { current?: FakeRelaySocket } = {};
    const adapter = createAdapter(ref);
    await adapter.connect();
    const firstSocket = ref.current;
    await adapter.reconnect();
    expect(ref.current).toBe(firstSocket);
    expect(ref.current?.readyState).toBe(1);
  });
});
