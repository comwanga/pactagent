import { NextResponse } from "next/server";

import { DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES } from "@/domain/pact-service-agreement";
import { PRIVATE_TASK_MAX_PROMPT_BYTES } from "@/domain/private-task-transport";

export const NO_STORE = Object.freeze({ "Cache-Control": "no-store" });
export const TRANSACTION_MAXIMUM_REQUEST_BYTES =
  DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES + PRIVATE_TASK_MAX_PROMPT_BYTES + 16 * 1024;

export function transactionJson(
  body: unknown,
  init: Omit<ResponseInit, "headers"> & { headers?: Record<string, string> } = {},
): NextResponse {
  return NextResponse.json(body, {
    ...init,
    headers: { ...init.headers, ...NO_STORE },
  });
}

export function unauthorizedTransaction(): NextResponse {
  return transactionJson({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
}

export async function readBoundedTransactionJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > TRANSACTION_MAXIMUM_REQUEST_BYTES) {
      throw new RangeError("Request body is too large");
    }
  }
  if (!request.body) throw new SyntaxError("Request body is empty");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > TRANSACTION_MAXIMUM_REQUEST_BYTES) {
      await reader.cancel();
      throw new RangeError("Request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

export function exceedsUtf8Limit(value: string, maximumBytes: number): boolean {
  return Buffer.byteLength(value, "utf8") > maximumBytes;
}
