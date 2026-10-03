import { NextResponse } from "next/server";

import {
  apiStatusForError,
  getPactAgentRuntime,
  isAuthorized,
  toApiError,
} from "@/lib/pactagent-runtime-singleton";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function apiToken(): string | undefined {
  return process.env.PACTAGENT_RUNTIME_API_TOKEN;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request, apiToken())) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }
  try {
    const runtime = await getPactAgentRuntime();
    const body = await request.json().catch(() => undefined) as unknown;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as { walletKey?: unknown }).walletKey !== "string"
    ) {
      return NextResponse.json(
        { error: "walletKey is required", code: "invalid_request" },
        { status: 400, headers: NO_STORE },
      );
    }
    const status = await runtime.demoWalletStatus((body as { walletKey: string }).walletKey);
    return NextResponse.json({
      generation: status.generation,
      availableSats: Number(status.availableSats),
      resetAvailable: status.resetAvailable,
      accountingPending: status.accountingPending,
    }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(toApiError(error), { status: apiStatusForError(error), headers: NO_STORE });
  }
}
