import { type NextResponse } from "next/server";

import {
  isTrustedRequesterRequest,
  requesterJson,
  unauthorizedRequester,
  unavailableRequester,
} from "../../transactions/http";
import { requesterSessionStoreFromEnv } from "@/lib/requester-session-store.server";
import {
  attachRequesterSessionCookie,
  ensureRequesterSession,
  readRequesterSession,
} from "@/lib/requester-session.server";

export const dynamic = "force-dynamic";

export function GET(request: Request): NextResponse {
  if (!isTrustedRequesterRequest(request)) return unauthorizedRequester();
  try {
    const store = requesterSessionStoreFromEnv();
    const session = ensureRequesterSession(request, store);
    const transactionId = store.currentTransaction(session.hash, Date.now()) ?? null;
    return attachRequesterSessionCookie(requesterJson({ transactionId }), session);
  } catch (error) {
    return unavailableRequester(error);
  }
}

export function DELETE(request: Request): NextResponse {
  if (!isTrustedRequesterRequest(request)) return unauthorizedRequester();
  try {
    const store = requesterSessionStoreFromEnv();
    const session = readRequesterSession(request, store);
    if (!session) return unauthorizedRequester();
    if (!store.clearCurrentTransaction(session.hash, Date.now())) return unauthorizedRequester();
    return requesterJson({ cleared: true });
  } catch (error) {
    return unavailableRequester(error);
  }
}
