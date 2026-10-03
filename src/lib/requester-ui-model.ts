"use client";

import {
  REQUESTER_DOCUMENT_MAXIMUM_BYTES,
  REQUESTER_PROMPT_MAXIMUM_BYTES,
  type RequesterDocumentMediaType,
} from "./requester-api-contracts";

export interface PreparedRequesterDocument {
  readonly filename: string;
  readonly mediaType: RequesterDocumentMediaType;
  readonly size: number;
  /** Private API representation: UTF-8 text or base64 PDF bytes. */
  readonly privateDocument: string;
}

export type RequesterDocumentValidationCode =
  | "document_required"
  | "unsupported_media_type"
  | "document_too_large"
  | "document_empty"
  | "document_unreadable";

export class RequesterDocumentValidationError extends Error {
  readonly code: RequesterDocumentValidationCode;

  constructor(code: RequesterDocumentValidationCode) {
    super(code);
    this.name = "RequesterDocumentValidationError";
    this.code = code;
  }
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseWholeSatBudget(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function promptBytes(value: string): number {
  return utf8Bytes(value);
}

export function isPromptWithinLimit(value: string): boolean {
  return promptBytes(value) <= REQUESTER_PROMPT_MAXIMUM_BYTES;
}

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(parts.join(""));
}

export async function prepareRequesterDocument(file: File): Promise<PreparedRequesterDocument> {
  if (file.type !== "text/plain" && file.type !== "application/pdf") {
    throw new RequesterDocumentValidationError("unsupported_media_type");
  }
  if (file.size === 0) throw new RequesterDocumentValidationError("document_empty");
  if (file.size > REQUESTER_DOCUMENT_MAXIMUM_BYTES) {
    throw new RequesterDocumentValidationError("document_too_large");
  }
  try {
    const privateDocument = file.type === "text/plain"
      ? await file.text()
      : bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    if (privateDocument.length === 0) {
      throw new RequesterDocumentValidationError("document_empty");
    }
    if (utf8Bytes(privateDocument) > REQUESTER_DOCUMENT_MAXIMUM_BYTES) {
      throw new RequesterDocumentValidationError("document_too_large");
    }
    return Object.freeze({
      filename: file.name,
      mediaType: file.type,
      size: file.size,
      privateDocument,
    });
  } catch (error) {
    if (error instanceof RequesterDocumentValidationError) throw error;
    throw new RequesterDocumentValidationError("document_unreadable");
  }
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function abbreviateReference(value: string, head = 12, tail = 8): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export { REQUESTER_DOCUMENT_MAXIMUM_BYTES, REQUESTER_PROMPT_MAXIMUM_BYTES };
