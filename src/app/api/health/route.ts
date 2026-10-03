import { NextResponse } from "next/server";

import { getRunningPactAgentRuntimeComposition } from "@/lib/pactagent-runtime-singleton";

/*
 * Public deployment health endpoint (Issue #39).
 *
 * Read-only, secret-free, side-effect-free. It reports process liveness and
 * whether the PactAgent runtime singleton has initialized in this process.
 *
 * It deliberately does NOT boot the runtime: the runtime initializes lazily
 * on first API use, and a healthcheck must not mutate or publish state.
 * Runtime readiness details are available on the bearer-authenticated
 * /api/runtime/readiness surface.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export function GET(): NextResponse {
  const composition = getRunningPactAgentRuntimeComposition();
  return NextResponse.json(
    {
      ok: true,
      runtimeInitialized: composition !== undefined,
    },
    { headers: NO_STORE },
  );
}
