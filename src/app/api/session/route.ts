import { NextResponse } from "next/server";

import { SESSION_COOKIE_NAME } from "@/lib/pactagent-runtime-singleton";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const FUNDING_COOKIE_NAME = "pactagent_funding_ref";

function runtimeToken(): string | undefined {
  return process.env.PACTAGENT_RUNTIME_API_TOKEN;
}

function demoMode(): boolean {
  return process.env.PACTAGENT_DEMO_MODE === "1";
}

function demoCode(): string | undefined {
  return process.env.PACTAGENT_DEMO_CODE;
}

function demoFundingReference(): string | undefined {
  return process.env.PACTAGENT_LIVE_FUNDING_REFERENCE;
}

function isSecure(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded === "https") return true;
  return new URL(request.url).protocol === "https:";
}

function cookieAttributes(request: Request, maxAgeSeconds: number): string[] {
  const parts = ["Path=/api", `Max-Age=${maxAgeSeconds}`, "SameSite=Strict", "HttpOnly"];
  if (isSecure(request)) parts.push("Secure");
  return parts;
}

function clearCookieAttributes(request: Request): string[] {
  const parts = ["Path=/api", "Max-Age=0", "SameSite=Strict", "HttpOnly"];
  if (isSecure(request)) parts.push("Secure");
  return parts;
}

function setAuthCookie(
  response: NextResponse,
  token: string,
  request: Request,
): void {
  response.headers.append(
    "Set-Cookie",
    [`${SESSION_COOKIE_NAME}=${token}`, ...cookieAttributes(request, SESSION_MAX_AGE_SECONDS)].join("; "),
  );
}

function setFundingCookie(
  response: NextResponse,
  fundingReference: string,
  request: Request,
): void {
  response.headers.append(
    "Set-Cookie",
    [`${FUNDING_COOKIE_NAME}=${encodeURIComponent(fundingReference)}`, ...cookieAttributes(request, SESSION_MAX_AGE_SECONDS)].join("; "),
  );
}

function clearFundingCookie(response: NextResponse, request: Request): void {
  response.headers.append(
    "Set-Cookie",
    [`${FUNDING_COOKIE_NAME}=`, ...clearCookieAttributes(request)].join("; "),
  );
}

interface SessionBody {
  readonly token?: unknown;
  readonly demoCode?: unknown;
  readonly fundingReference?: unknown;
}

async function readBody(request: Request): Promise<SessionBody> {
  try {
    const body = (await request.json()) as Partial<SessionBody>;
    return {
      ...(typeof body.token === "string" ? { token: body.token } : {}),
      ...(typeof body.demoCode === "string" ? { demoCode: body.demoCode } : {}),
      ...(typeof body.fundingReference === "string" ? { fundingReference: body.fundingReference } : {}),
    };
  } catch {
    return {};
  }
}

function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function isCookieSessionValid(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  return readCookie(request, SESSION_COOKIE_NAME) === token;
}

/**
 * GET /api/session — probe session state without minting a new one.
 * Returns whether the caller is already authenticated and whether one-click
 * demo is available. The funding reference remains httpOnly.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const token = runtimeToken();
  const authenticated = isCookieSessionValid(request, token);
  return NextResponse.json(
    { authenticated, demoAvailable: demoMode() },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/session — exchange a demo code or a user-supplied token for an
 * httpOnly session cookie. The runtime bearer token is written only to the
 * cookie and never to the response body.
 *
 * The funding reference supplied in token mode is stored in a SEPARATE
 * httpOnly cookie so it survives reload without ever entering JS-accessible
 * browser storage (localStorage/sessionStorage/IndexedDB). In demo mode the
 * server-supplied funding reference is returned directly.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const token = runtimeToken();
  if (!token) {
    return NextResponse.json(
      { error: "Runtime API token is not configured", code: "server_misconfigured" },
      { status: 503, headers: NO_STORE },
    );
  }

  const body = await readBody(request);

  if (demoMode()) {
    const expectedCode = demoCode();
    if (expectedCode && body.demoCode !== expectedCode) {
      return NextResponse.json(
        { error: "Demo code is incorrect", code: "invalid_demo_code" },
        { status: 401, headers: NO_STORE },
      );
    }
    const fundingReference = demoFundingReference();
    const response = NextResponse.json({ authenticated: true, demoAvailable: true }, { headers: NO_STORE });
    setAuthCookie(response, token, request);
    if (fundingReference) setFundingCookie(response, fundingReference, request);
    return response;
  }

  if (typeof body.token !== "string" || body.token !== token) {
    return NextResponse.json(
      { error: "Invalid runtime token", code: "unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }

  const fundingReference =
    typeof body.fundingReference === "string" && body.fundingReference.length > 0
      ? body.fundingReference
      : undefined;
  const response = NextResponse.json({ authenticated: true, demoAvailable: false }, { headers: NO_STORE });
  setAuthCookie(response, token, request);
  if (fundingReference) setFundingCookie(response, fundingReference, request);
  return response;
}

/**
 * DELETE /api/session — clear the session and funding cookies (sign out).
 */
export async function DELETE(request: Request): Promise<NextResponse> {
  const response = NextResponse.json({ authenticated: false }, { headers: NO_STORE });
  response.headers.append(
    "Set-Cookie",
    [`${SESSION_COOKIE_NAME}=`, ...clearCookieAttributes(request)].join("; "),
  );
  clearFundingCookie(response, request);
  return response;
}
