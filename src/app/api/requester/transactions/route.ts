import { type NextResponse } from "next/server";

import {
  isTrustedRequesterRequest,
  readRequesterCreateInput,
  requesterJson,
  RequesterDocumentTooLargeError,
  runtimeTransport,
  transportResponse,
  unauthorizedRequester,
  unavailableRequester,
} from "./http";
import { requesterSessionStoreFromEnv } from "@/lib/requester-session-store.server";
import {
  attachRequesterSessionCookie,
  ensureRequesterSession,
} from "@/lib/requester-session.server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isTrustedRequesterRequest(request)) return unauthorizedRequester();
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return requesterJson(
      { error: "The transaction request is invalid", code: "invalid_request" },
      { status: 400 },
    );
  }
  let input;
  try {
    input = await readRequesterCreateInput(request);
  } catch (error) {
    if (error instanceof RequesterDocumentTooLargeError) {
      return requesterJson(
        { error: "The document exceeds the 1 MiB upload limit", code: "document_too_large" },
        { status: 413 },
      );
    }
    return requesterJson(
      { error: "The transaction request is invalid", code: "invalid_request" },
      { status: error instanceof RangeError ? 413 : 400 },
    );
  }
  try {
    const store = requesterSessionStoreFromEnv();
    const session = ensureRequesterSession(request, store);
    const walletKey = store.demoWalletKey(session.hash, Date.now());
    if (process.env.PACTAGENT_ECONOMIC_MODE === "demo" && !walletKey) {
      return attachRequesterSessionCookie(requesterJson(
        { error: "Start Demo before creating a transaction", code: "invalid_request" },
        { status: 409 },
      ), session);
    }
    const result = await runtimeTransport(walletKey ?? undefined).create(input, idempotencyKey);
    if (!result.ok) return attachRequesterSessionCookie(transportResponse(result), session);
    store.bindTransaction(session.hash, result.body.transactionId, Date.now());
    return attachRequesterSessionCookie(requesterJson(result.body, {
      status: result.status,
      headers: { Location: `/api/requester/transactions/${result.body.transactionId}` },
    }), session);
  } catch (error) {
    return unavailableRequester(error);
  }
}
