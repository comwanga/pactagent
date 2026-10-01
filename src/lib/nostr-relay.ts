import type { NostrTag, SignedNostrEvent } from "../domain/nostr";

/*
  Nostr relay transport adapter.
 
  This boundary knows about NIP-01 relay framing and Nostr events only. It has
  no knowledge of P001/P002 policy, agent selection, escrow, or signing. The
  adapter never accepts, stores, or transmits private key material: it only
  relays already-signed {@link SignedNostrEvent} objects supplied by a caller.
 */
export interface NostrFilter {
  readonly ids?: readonly string[];
  readonly authors?: readonly string[];
  readonly kinds?: readonly number[];
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  readonly tags?: Readonly<Record<string, readonly string[]>>;
}

function toWireFilter(filter: NostrFilter): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  if (filter.ids?.length) wire.ids = [...filter.ids];
  if (filter.authors?.length) wire.authors = [...filter.authors];
  if (filter.kinds?.length) wire.kinds = [...filter.kinds];
  if (filter.since !== undefined) wire.since = filter.since;
  if (filter.until !== undefined) wire.until = filter.until;
  if (filter.limit !== undefined) wire.limit = filter.limit;
  if (filter.tags) {
    for (const [tag, values] of Object.entries(filter.tags)) {
      if (values.length) wire[`#${tag}`] = [...values];
    }
  }
  return wire;
}

export type NostrRelayErrorCode =
  | "invalid_url"
  | "connection_timeout"
  | "connection_failed"
  | "connection_closed"
  | "not_connected"
  | "publish_timeout"
  | "publish_rejected"
  | "private_key_refused"
  | "query_timeout"
  | "aborted";

export interface NostrRelayErrorOptions {
  readonly code: NostrRelayErrorCode;
  readonly relayUrl: string;
  readonly message?: string;
  readonly cause?: unknown;
}

// Controlled, typed failure surfaced by the relay adapter. 
export class NostrRelayError extends Error {
  readonly code: NostrRelayErrorCode;
  readonly relayUrl: string;

  constructor(options: NostrRelayErrorOptions) {
    super(
      options.message ?? options.code,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "NostrRelayError";
    this.code = options.code;
    this.relayUrl = options.relayUrl;
  }
}

export type RelayWebSocketEvent = "open" | "message" | "close" | "error";
export type RelayWebSocketListener = (event: unknown) => void;

// Minimal slice of the WebSocket surface the adapter depends on.  
export interface RelayWebSocket {
  readonly readyState: number;
  readonly url: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: RelayWebSocketEvent, listener: RelayWebSocketListener): void;
  removeEventListener(type: RelayWebSocketEvent, listener: RelayWebSocketListener): void;
}

export type RelayWebSocketFactory = (url: string) => RelayWebSocket;

const globalWebSocketFactory: RelayWebSocketFactory = (url) =>
  new WebSocket(url) as unknown as RelayWebSocket;

export interface NostrRelayPublishOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface NostrRelayQueryOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface NostrRelayAdapter {
  readonly url: string;
  connect(signal?: AbortSignal): Promise<void>;
  publish(event: SignedNostrEvent, options?: NostrRelayPublishOptions): Promise<void>;
  queryEvents(filter: NostrFilter, options?: NostrRelayQueryOptions): Promise<SignedNostrEvent[]>;
  disconnect(): Promise<void>;
}

export interface NostrRelayAdapterOptions {
  readonly webSocketFactory?: RelayWebSocketFactory;
  readonly connectTimeoutMs?: number;
  readonly defaultTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;
const DISCONNECT_GRACE_MS = 1_000;
const PRIVATE_KEY_FIELDS = ["privateKey", "nsec", "secretKey"] as const;
const NSEC_PREFIX = "nsec1";
const PUBKEY_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_MAX_QUERY_EVENTS = 10_000;

function assertRelayUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NostrRelayError({
      code: "invalid_url",
      relayUrl: url,
      message: `Invalid relay URL: ${url}`,
    });
  }
  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
    throw new NostrRelayError({
      code: "invalid_url",
      relayUrl: url,
      message: `Relay URL must use ws:// or wss://: ${url}`,
    });
  }
}

function containsPrivateKey(event: object): boolean {
  const candidate = event as Record<string, unknown>;
  if (PRIVATE_KEY_FIELDS.some((field) => field in candidate)) {
    return true;
  }
  if (typeof candidate.content === "string" && candidate.content.includes(NSEC_PREFIX)) {
    return true;
  }
  if (Array.isArray(candidate.tags)) {
    for (const tag of candidate.tags) {
      if (Array.isArray(tag)) {
        for (const item of tag) {
          if (typeof item === "string" && item.includes(NSEC_PREFIX)) return true;
        }
      }
    }
  }
  return false;
}

function toSignedEvent(value: unknown): SignedNostrEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as Record<string, unknown>;
  if (containsPrivateKey(event)) return undefined;
  if (
    typeof event.id !== "string" ||
    typeof event.sig !== "string" ||
    typeof event.pubkey !== "string" ||
    typeof event.content !== "string"
  ) {
    return undefined;
  }
  if (!PUBKEY_PATTERN.test(event.pubkey)) return undefined;
  if (!Number.isInteger(event.kind) || (event.kind as number) < 0) return undefined;
  if (!Number.isInteger(event.created_at) || (event.created_at as number) < 0) return undefined;
  if (!Array.isArray(event.tags)) return undefined;
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length === 0) return undefined;
    if (!tag.every((item) => typeof item === "string")) return undefined;
  }
  return event as unknown as SignedNostrEvent;
}

/*
  Reduce a raw WebSocket error event to a safe string message so transport
  internals (HTTP status, headers, request URLs) are not forwarded via `cause`
  into logged error objects.
 */
function sanitizeCause(event: unknown): string | undefined {
  if (event === null || event === undefined) return undefined;
  if (event instanceof Error) return event.message;
  if (typeof event === "object" && "message" in event) {
    const message = (event as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

function connectionFailedError(relayUrl: string, operation: string, cause?: unknown): NostrRelayError {
  return new NostrRelayError({
    code: "connection_failed",
    relayUrl,
    message: `Connection to ${relayUrl} failed while ${operation}`,
    cause: sanitizeCause(cause),
  });
}

function parseRelayMessage(raw: unknown): readonly unknown[] | undefined {
  let payload: unknown = raw;
  if (payload !== null && typeof payload === "object" && "data" in payload) {
    payload = (payload as { data: unknown }).data;
  }
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(payload) ? (payload as readonly unknown[]) : undefined;
}

export class WebSocketNostrRelayAdapter implements NostrRelayAdapter {
  readonly url: string;
  private readonly factory: RelayWebSocketFactory;
  private readonly connectTimeoutMs: number;
  private readonly defaultTimeoutMs: number;
  private socket: RelayWebSocket | undefined;
  private pendingConnect: Promise<void> | undefined;
  private nextSubscriptionId = 0;

  constructor(url: string, options: NostrRelayAdapterOptions = {}) {
    assertRelayUrl(url);
    this.url = url;
    this.factory = options.webSocketFactory ?? globalWebSocketFactory;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.socket?.readyState === WEBSOCKET_OPEN) return;
    if (this.pendingConnect) return this.pendingConnect;
    if (this.socket) {
      this.closeSocket(this.socket);
      this.socket = undefined;
    }
    let socket: RelayWebSocket;
    try {
      socket = this.factory(this.url);
    } catch (error) {
      throw connectionFailedError(this.url, "opening", error);
    }
    this.socket = socket;
    const attempt = this.waitForOpen(socket, signal).finally(() => {
      this.pendingConnect = undefined;
    });
    this.pendingConnect = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.socket === socket) this.socket = undefined;
      this.closeSocket(socket);
      throw error;
    }
  }

  async publish(event: SignedNostrEvent, options?: NostrRelayPublishOptions): Promise<void> {
    if (!this.socket || this.socket.readyState !== WEBSOCKET_OPEN) {
      await this.connect(options?.signal);
    }
    this.ensureConnected();
    if (containsPrivateKey(event as object)) {
      throw new NostrRelayError({
        code: "private_key_refused",
        relayUrl: this.url,
        message: `Refusing to publish event containing private key material to ${this.url}`,
      });
    }
    const socket = this.socket as RelayWebSocket;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: NostrRelayError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onError);
        options?.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };

      const onMessage: RelayWebSocketListener = (raw) => {
        const message = parseRelayMessage(raw);
        if (!message || message[0] !== "OK" || message[1] !== event.id) return;
        const accepted = message[2] === true;
        if (accepted) {
          finish();
        } else {
          finish(
            new NostrRelayError({
              code: "publish_rejected",
              relayUrl: this.url,
              message: `Relay ${this.url} rejected event ${event.id}: ${String(message[3] ?? "")}`,
            }),
          );
        }
      };
      const onClose: RelayWebSocketListener = (event) => {
        const detail = event as { code?: number } | undefined;
        finish(
          new NostrRelayError({
            code: "connection_closed",
            relayUrl: this.url,
            message: `Connection to ${this.url} closed while publishing (code ${detail?.code ?? "?"})`,
          }),
        );
      };
      const onError: RelayWebSocketListener = (event) =>
        finish(
          new NostrRelayError({
            code: "connection_failed",
            relayUrl: this.url,
            message: `Connection to ${this.url} errored while publishing`,
            cause: sanitizeCause(event),
          }),
        );
      const onAbort = () =>
        finish(
          new NostrRelayError({
            code: "aborted",
            relayUrl: this.url,
            message: `Publish to ${this.url} aborted`,
            cause: options?.signal?.reason,
          }),
        );
      const timer = setTimeout(
        () =>
          finish(
            new NostrRelayError({
              code: "publish_timeout",
              relayUrl: this.url,
              message: `Publish to ${this.url} timed out after ${timeoutMs}ms`,
            }),
          ),
        timeoutMs,
      );

      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
      if (options?.signal?.aborted) {
        onAbort();
        return;
      }
      options?.signal?.addEventListener("abort", onAbort);

      try {
        socket.send(JSON.stringify(["EVENT", event]));
      } catch (error) {
        finish(connectionFailedError(this.url, "publishing", error));
      }
    });
  }

  async queryEvents(
    filter: NostrFilter,
    options?: NostrRelayQueryOptions,
  ): Promise<SignedNostrEvent[]> {
    if (!this.socket || this.socket.readyState !== WEBSOCKET_OPEN) {
      await this.connect(options?.signal);
    }
    this.ensureConnected();
    const socket = this.socket as RelayWebSocket;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const subscriptionId = `pactagent-${this.nextSubscriptionId++}`;
    const requestedLimit =
      typeof filter.limit === "number" && filter.limit > 0 ? filter.limit : DEFAULT_MAX_QUERY_EVENTS;
    const maxEvents = Math.min(requestedLimit, DEFAULT_MAX_QUERY_EVENTS);

    return new Promise<SignedNostrEvent[]>((resolve, reject) => {
      let settled = false;
      let reqSent = false;
      const events: SignedNostrEvent[] = [];
      const finish = (error?: NostrRelayError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onError);
        options?.signal?.removeEventListener("abort", onAbort);
        if (reqSent && socket.readyState === WEBSOCKET_OPEN) {
          try {
            socket.send(JSON.stringify(["CLOSE", subscriptionId]));
          } catch {
            // Best-effort CLOSE during teardown; a failure here does not affect the settled result.
          }
        }
        if (error) reject(error);
        else resolve(events);
      };

      const onMessage: RelayWebSocketListener = (raw) => {
        const message = parseRelayMessage(raw);
        if (!message || message[1] !== subscriptionId) return;
        if (message[0] === "EVENT") {
          const signed = toSignedEvent(message[2]);
          if (signed) {
            events.push(signed);
            if (events.length >= maxEvents) finish();
          }
        } else if (message[0] === "EOSE") {
          finish();
        }
      };
      const onClose: RelayWebSocketListener = (event) => {
        const detail = event as { code?: number } | undefined;
        finish(
          new NostrRelayError({
            code: "connection_closed",
            relayUrl: this.url,
            message: `Connection to ${this.url} closed while querying (code ${detail?.code ?? "?"})`,
          }),
        );
      };
      const onError: RelayWebSocketListener = (event) =>
        finish(
          new NostrRelayError({
            code: "connection_failed",
            relayUrl: this.url,
            message: `Connection to ${this.url} errored while querying`,
            cause: sanitizeCause(event),
          }),
        );
      const onAbort = () =>
        finish(
          new NostrRelayError({
            code: "aborted",
            relayUrl: this.url,
            message: `Query on ${this.url} aborted`,
            cause: options?.signal?.reason,
          }),
        );
      const timer = setTimeout(
        () =>
          finish(
            new NostrRelayError({
              code: "query_timeout",
              relayUrl: this.url,
              message: `Query on ${this.url} timed out after ${timeoutMs}ms`,
            }),
          ),
        timeoutMs,
      );

      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
      if (options?.signal?.aborted) {
        onAbort();
        return;
      }
      options?.signal?.addEventListener("abort", onAbort);

      try {
        const wireFilter = toWireFilter({ ...filter, limit: maxEvents });
        socket.send(JSON.stringify(["REQ", subscriptionId, wireFilter]));
        reqSent = true;
      } catch (error) {
        finish(connectionFailedError(this.url, "querying", error));
      }
    });
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.pendingConnect = undefined;
    if (!socket || socket.readyState === WEBSOCKET_CLOSED) return;

    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        socket.removeEventListener("close", onClose);
        resolve();
      };
      const onClose: RelayWebSocketListener = () => done();
      const timer = setTimeout(done, DISCONNECT_GRACE_MS);
      socket.addEventListener("close", onClose);
      try {
        socket.close(1000, "client_disconnect");
      } catch (error) {
        resolved = true;
        clearTimeout(timer);
        socket.removeEventListener("close", onClose);
        reject(connectionFailedError(this.url, "disconnecting", error));
      }
    });
  }

  private ensureConnected(): void {
    if (!this.socket || this.socket.readyState !== WEBSOCKET_OPEN) {
      throw new NostrRelayError({
        code: "not_connected",
        relayUrl: this.url,
        message: `Not connected to ${this.url}; call connect() first`,
      });
    }
  }

  private closeSocket(socket: RelayWebSocket): void {
    if (socket.readyState === WEBSOCKET_CLOSED) return;
    try {
      socket.close(1000, "client");
    } catch {
      // Best-effort shutdown during cleanup; the socket may already be closing or closed.
    }
  }

  private waitForOpen(socket: RelayWebSocket, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: NostrRelayError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };

      const onOpen: RelayWebSocketListener = () => finish();
      const onError: RelayWebSocketListener = (event) =>
        finish(
          new NostrRelayError({
            code: "connection_failed",
            relayUrl: this.url,
            message: `Connection to ${this.url} failed`,
            cause: sanitizeCause(event),
          }),
        );
      const onClose: RelayWebSocketListener = (event) => {
        const detail = event as { code?: number } | undefined;
        finish(
          new NostrRelayError({
            code: "connection_closed",
            relayUrl: this.url,
            message: `Connection to ${this.url} closed during handshake (code ${detail?.code ?? "?"})`,
          }),
        );
      };
      const onAbort = () =>
        finish(
          new NostrRelayError({
            code: "aborted",
            relayUrl: this.url,
            message: `Connection to ${this.url} aborted`,
            cause: signal?.reason,
          }),
        );
      const timer = setTimeout(
        () =>
          finish(
            new NostrRelayError({
              code: "connection_timeout",
              relayUrl: this.url,
              message: `Connection to ${this.url} timed out after ${this.connectTimeoutMs}ms`,
            }),
          ),
        this.connectTimeoutMs,
      );

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort);
    });
  }
}

export type { NostrTag };
