import "server-only";

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { AdmissionLimitError, RequestBudgets, readAdmissionLimits, sharedRequestBudgets } from "./admission-control";
import type { RequesterSessionStore } from "./requester-session-store.server";
import { ensureRequesterSession, readRequesterSession } from "./requester-session.server";

/** Railway edge overwrites X-Real-IP; private-network callers must remain trusted. */
export function publicClientKey(request: Request, env: Readonly<Record<string, string | undefined>> = process.env): string {
  let identity: string;
  if (env.RAILWAY_ENVIRONMENT_ID) {
    const value = request.headers.get("x-real-ip");
    if (!value || !isIP(value) || value.includes("%")) throw new AdmissionLimitError(60);
    // Normalize IPv6 spelling so alternate representations cannot rotate keys.
    identity = isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.toLowerCase() : value;
  } else {
    let hostname: string;
    try { hostname = new URL(env.PACTAGENT_REQUESTER_UI_ORIGIN ?? "").hostname; }
    catch { throw new TypeError("Invalid admission configuration"); }
    if (env.NODE_ENV !== "test" && !["localhost", "127.0.0.1", "[::1]", "pactagent.local"].includes(hostname)) {
      throw new TypeError("A supported requester ingress is required");
    }
    // Local development/fixtures share a bounded bucket. Never trust forwarded headers here.
    identity = "local-shared";
  }
  return createHash("sha256").update(identity).digest("hex");
}

export function admitRequester(
  request: Request,
  store: RequesterSessionStore,
  options: { create?: boolean; recovery?: boolean; nowMs?: number; budgets?: RequestBudgets } = {},
) {
  const nowMs = options.nowMs ?? Date.now();
  const limits = readAdmissionLimits();
  const budgets = options.budgets ?? sharedRequestBudgets();
  const lane = options.recovery ? "recovery" : "ordinary";
  budgets.consume(`ip:${lane}:${publicClientKey(request)}`, limits.ipPerMinute, nowMs, lane);
  const session = options.create ? ensureRequesterSession(request, store, nowMs) : readRequesterSession(request, store, nowMs);
  if (session) budgets.consume(`session:${lane}:${session.hash}`, limits.sessionPerMinute, nowMs, lane);
  return session;
}
