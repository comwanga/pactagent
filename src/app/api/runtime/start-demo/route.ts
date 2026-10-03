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

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request, process.env.PACTAGENT_RUNTIME_API_TOKEN)) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }
  try {
    const body = await request.json().catch(() => undefined) as unknown;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as { walletKey?: unknown }).walletKey !== "string"
    ) {
      return NextResponse.json(
        { error: "Demo start request is invalid", code: "invalid_request" },
        { status: 400, headers: NO_STORE },
      );
    }
    const runtime = await getPactAgentRuntime();
    const result = await runtime.startDemoWallet((body as { walletKey: string }).walletKey);
    return NextResponse.json(
      { ok: true, generation: result.generation },
      { headers: NO_STORE },
    );
  } catch (error) {
    logRuntimeApiError("start-demo", error);
    return NextResponse.json(toApiError(error), {
      status: apiStatusForError(error),
      headers: NO_STORE,
    });
  }
}
