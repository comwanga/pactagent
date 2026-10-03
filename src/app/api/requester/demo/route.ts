import { type NextResponse } from "next/server";

import {
  isTrustedRequesterRequest,
  requesterJson,
  runtimeTransport,
  transportResponse,
  unauthorizedRequester,
  unavailableRequester,
} from "../transactions/http";
import { requesterSessionStoreFromEnv } from "@/lib/requester-session-store.server";
import {
  attachRequesterSessionCookie,
  ensureRequesterSession,
} from "@/lib/requester-session.server";

export const dynamic = "force-dynamic";

const DEMO_DISCLOSURE = "Demo sats — no monetary value" as const;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isTrustedRequesterRequest(request)) return unauthorizedRequester();
  try {
    const store = requesterSessionStoreFromEnv();
    const session = ensureRequesterSession(request, store);
    if (process.env.PACTAGENT_ECONOMIC_MODE !== "demo") {
      return requesterJson(
        { error: "Demo wallet is only available in demo mode", code: "invalid_request" },
        { status: 400 },
      );
    }
    const walletKey = store.demoWalletKey(session.hash, Date.now());
    if (!walletKey) {
      return attachRequesterSessionCookie(
        requesterJson({ economicMode: "demo", started: false }),
        session,
      );
    }
    const result = await runtimeTransport().demoWalletStatus(walletKey);
    if (!result.ok) return attachRequesterSessionCookie(transportResponse(result), session);
    return attachRequesterSessionCookie(
      requesterJson({
        economicMode: "demo",
        started: true,
        generation: result.body.generation,
        balance: { availableSats: result.body.availableSats },
        resetAvailable: result.body.resetAvailable,
        accountingPending: result.body.accountingPending,
        disclosure: DEMO_DISCLOSURE,
      }),
      session,
    );
  } catch (error) {
    return unavailableRequester(error);
  }
}
