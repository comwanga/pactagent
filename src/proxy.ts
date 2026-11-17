import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/*
 * Runtime API origin restriction (Issue #67).
 *
 * The privileged runtime API routes (/api/transactions/**, /api/runtime/**)
 * are served by the same Next.js process as the public browser BFF
 * (/api/requester/**). The BFF calls the runtime over loopback HTTP
 * (PACTAGENT_RUNTIME_API_BASE, default http://127.0.0.1:3000). This proxy
 * blocks requests to those routes from any non-loopback host, returning 404
 * so the route's existence is not revealed to a public caller.
 *
 * Trust boundary (deployment-verified on Railway):
 * Railway's edge proxy uses the HTTP Host header for routing. A request with
 * a forged loopback Host (e.g., Host: localhost) is rejected by the edge with
 * 404 "Application not found" before reaching the container. The container
 * only sees Host values that match the configured public domain for public
 * traffic, or 127.0.0.1:3000 for loopback BFF traffic. The container port is
 * not directly exposed. A valid bearer token alone does not override this
 * restriction; bearer verification remains in each route handler as a
 * separate, independent control.
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostnameFromHost(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

export function proxy(request: NextRequest): NextResponse {
  const host = request.headers.get("host");
  if (host !== null && LOOPBACK_HOSTNAMES.has(hostnameFromHost(host))) {
    return NextResponse.next();
  }
  return new NextResponse(null, { status: 404 });
}

export const config = {
  matcher: ["/api/transactions/:path*", "/api/runtime/:path*"],
};