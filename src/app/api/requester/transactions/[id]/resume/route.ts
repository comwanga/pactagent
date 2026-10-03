import { type NextResponse } from "next/server";

import {
  isTrustedRequesterRequest,
  requesterOwnsTransaction,
  runtimeTransport,
  transportResponse,
  unauthorizedRequester,
  unownedRequesterTransaction,
  unavailableRequester,
} from "../../http";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isTrustedRequesterRequest(request)) return unauthorizedRequester();
  try {
    const { id } = await context.params;
    if (!requesterOwnsTransaction(request, id)) return unownedRequesterTransaction();
    return transportResponse(await runtimeTransport().resume(id));
  } catch (error) {
    return unavailableRequester(error);
  }
}
