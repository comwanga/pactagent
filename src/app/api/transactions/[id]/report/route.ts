import { NextResponse } from "next/server";

import {
  apiStatusForError,
  getPactAgentRuntime,
  isAuthorized,
  toApiError,
} from "@/lib/pactagent-runtime-singleton";
import { transactionJson, unauthorizedTransaction } from "../../http";

export const dynamic = "force-dynamic";

function apiToken(): string | undefined {
  return process.env.PACTAGENT_RUNTIME_API_TOKEN;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isAuthorized(request, apiToken())) {
    return unauthorizedTransaction();
  }
  const { id } = await context.params;
  try {
    const runtime = await getPactAgentRuntime();
    const report = await runtime.report(id);
    return transactionJson(report);
  } catch (error) {
    return transactionJson(toApiError(error), { status: apiStatusForError(error) });
  }
}
