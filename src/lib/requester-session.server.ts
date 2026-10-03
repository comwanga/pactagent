import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { NextResponse } from "next/server";

import type { RequesterSessionStore } from "./requester-session-store.server";

export const REQUESTER_SESSION_COOKIE = "pactagent_requester_session";
export const REQUESTER_SESSION_COOKIE_PATH = "/api/requester";
export const REQUESTER_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const SESSION_SECRET = /^[A-Za-z0-9_-]{43}$/;

export interface RequesterSession {
  readonly hash: string;
  readonly newSecret?: string;
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    const value = item.slice(separator + 1).trim();
    return SESSION_SECRET.test(value) ? value : undefined;
  }
  return undefined;
}

export function requesterSessionHash(secret: string): string {
  if (!SESSION_SECRET.test(secret)) throw new TypeError("Invalid requester session secret");
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function readRequesterSession(
  request: Request,
  store: RequesterSessionStore,
  nowMs = Date.now(),
): RequesterSession | undefined {
  const secret = cookieValue(request, REQUESTER_SESSION_COOKIE);
  if (!secret) return undefined;
  const hash = requesterSessionHash(secret);
  return store.exists(hash, nowMs) ? Object.freeze({ hash }) : undefined;
}

export function ensureRequesterSession(
  request: Request,
  store: RequesterSessionStore,
  nowMs = Date.now(),
): RequesterSession {
  const existing = readRequesterSession(request, store, nowMs);
  if (existing) return existing;
  const secret = randomBytes(32).toString("base64url");
  const hash = requesterSessionHash(secret);
  store.create(hash, nowMs, nowMs + REQUESTER_SESSION_MAX_AGE_SECONDS * 1000);
  return Object.freeze({ hash, newSecret: secret });
}

export function attachRequesterSessionCookie(
  response: NextResponse,
  session: RequesterSession,
): NextResponse {
  if (!session.newSecret) return response;
  response.cookies.set({
    name: REQUESTER_SESSION_COOKIE,
    value: session.newSecret,
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: REQUESTER_SESSION_COOKIE_PATH,
    maxAge: REQUESTER_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
