import { NextResponse } from "next/server";

import { logRuntimeApiError } from "../support";

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
      Object.keys(body).length !== 2 ||
      typeof (body as { walletKey?: unknown }).walletKey !== "string" ||
      typeof (body as { idempotencyKey?: unknown }).idempotencyKey !== "string"
    ) {
      return NextResponse.json(
        { error: "Demo reset request is invalid", code: "invalid_request" },
        { status: 400, headers: NO_STORE },
      );
    }
    const parsed = body as { walletKey: string; idempotencyKey: string };
    const result = await runtime.resetDemoWallet(parsed.walletKey, parsed.idempotencyKey);
    return NextResponse.json({ ok: true, generation: result.generation }, { headers: NO_STORE });
  } catch (error) {
    logRuntimeApiError("reset-demo", error);
    return NextResponse.json(toApiError(error), { status: apiStatusForError(error), headers: NO_STORE });
  }
}
