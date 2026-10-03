import { type NextResponse } from "next/server";

import {
  isTrustedRequesterRequest,
  requesterJson,
  runtimeTransport,
  transportResponse,
  unauthorizedRequester,
  unavailableRequester,
} from "../../transactions/http";
import { requesterSessionStoreFromEnv } from "@/lib/requester-session-store.server";
import {
  attachRequesterSessionCookie,
  readRequesterSession,
} from "@/lib/requester-session.server";

export const dynamic = "force-dynamic";

const DEMO_DISCLOSURE = "Demo sats — no monetary value" as const;

export async function POST(request: Request): Promise<NextResponse> {
  if (!isTrustedRequesterRequest(request)) return unauthorizedRequester();
  try {
    const store = requesterSessionStoreFromEnv();
    const session = readRequesterSession(request, store);
    if (!session) return unauthorizedRequester();
    if (process.env.PACTAGENT_ECONOMIC_MODE !== "demo") {
      return requesterJson(
        { error: "Demo wallet is only available in demo mode", code: "invalid_request" },
        { status: 400 },
      );
    }
    const walletKey = session.hash;
    const result = await runtimeTransport().startDemo(walletKey);
    if (!result.ok) return attachRequesterSessionCookie(transportResponse(result), session);
    store.bindDemoWallet(session.hash, walletKey, Date.now());
    return attachRequesterSessionCookie(
      requesterJson({
        economicMode: "demo",
        generation: result.body.generation,
        disclosure: DEMO_DISCLOSURE,
      }),
      session,
    );
  } catch (error) {
    return unavailableRequester(error);
  }
}
