import { NextResponse } from "next/server";

import {
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
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }
  try {
    const runtime = await getPactAgentRuntime();
    const readiness = await runtime.bootstrap();
    return NextResponse.json(readiness, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(toApiError(error), { status: 500, headers: NO_STORE });
  }
}
