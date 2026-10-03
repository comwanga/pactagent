import { NextResponse } from "next/server";

import {
  getRunningPactAgentRuntimeComposition,
  isAuthorized,
} from "@/lib/pactagent-runtime-singleton";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export function GET(request: Request): NextResponse {
  if (!isAuthorized(request, process.env.PACTAGENT_RUNTIME_API_TOKEN)) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }

  const composition = getRunningPactAgentRuntimeComposition();
  if (!composition) {
    return NextResponse.json(
      { error: "Runtime is not initialized", code: "not_running" },
      { status: 503, headers: NO_STORE },
    );
  }

  return NextResponse.json(composition, { headers: NO_STORE });
}
