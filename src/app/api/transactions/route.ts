import { NextResponse } from "next/server";

import { sats } from "@/domain/money";
import { DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES } from "@/domain/pact-service-agreement";
import { PRIVATE_TASK_MAX_PROMPT_BYTES } from "@/domain/private-task-transport";
import {
  getPactAgentRuntime,
  isAuthorized,
  toApiError,
} from "@/lib/pactagent-runtime-singleton";
import {
  exceedsUtf8Limit,
  readBoundedTransactionJson,
  transactionJson,
  unauthorizedTransaction,
} from "./http";

export const dynamic = "force-dynamic";

function apiToken(): string | undefined {
  return process.env.PACTAGENT_RUNTIME_API_TOKEN;
}

function jsonError(error: unknown): NextResponse {
  return transactionJson(toApiError(error), { status: 500 });
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request, apiToken())) return unauthorizedTransaction();

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return transactionJson({ error: "Idempotency-Key header is required", code: "invalid_request" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await readBoundedTransactionJson(request);
  } catch {
    return transactionJson({ error: "Request body is invalid or too large", code: "invalid_request" }, { status: 413 });
  }
  if (typeof body !== "object" || body === null) {
    return transactionJson({ error: "Request body must be an object", code: "invalid_request" }, { status: 400 });
  }
  const candidate = body as Record<string, unknown>;
  const allowedKeys = new Set([
    "privateDocument",
    "mediaType",
    "privatePrompt",
    "maximumBudgetSats",
    "fundingReference",
  ]);
  if (
    Object.keys(candidate).some((key) => !allowedKeys.has(key)) ||
    typeof candidate.privateDocument !== "string" ||
    candidate.privateDocument.length === 0 ||
    (candidate.mediaType !== "text/plain" && candidate.mediaType !== "application/pdf") ||
    (candidate.privatePrompt !== undefined && typeof candidate.privatePrompt !== "string") ||
    typeof candidate.fundingReference !== "string" ||
    (typeof candidate.maximumBudgetSats !== "number" && typeof candidate.maximumBudgetSats !== "string")
  ) {
    return transactionJson({ error: "Request body is invalid", code: "invalid_request" }, { status: 400 });
  }
  if (
    exceedsUtf8Limit(candidate.privateDocument, DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES) ||
    (candidate.privatePrompt !== undefined &&
      exceedsUtf8Limit(candidate.privatePrompt, PRIVATE_TASK_MAX_PROMPT_BYTES))
  ) {
    return transactionJson({ error: "Request content is too large", code: "invalid_request" }, { status: 413 });
  }

  let maximumBudgetSats: bigint;
  try {
    maximumBudgetSats = BigInt(String(candidate.maximumBudgetSats));
  } catch {
    return transactionJson({ error: "maximumBudgetSats is invalid", code: "invalid_request" }, { status: 400 });
  }

  try {
    const runtime = await getPactAgentRuntime();
    const { transactionId } = await runtime.acceptTransaction({
      idempotencyKey,
      fundingReference: candidate.fundingReference,
      privateDocument: candidate.privateDocument as string,
      mediaType: candidate.mediaType as "text/plain" | "application/pdf",
      privatePrompt: candidate.privatePrompt as string | undefined,
      maximumBudgetSats: sats(maximumBudgetSats),
    });
    return transactionJson(
      { transactionId },
      { status: 202, headers: { Location: `/api/transactions/${transactionId}` } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
