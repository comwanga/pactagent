export const DOCUMENT_SOURCE_MAXIMUM_BYTES = 1024 * 1024;
export const DOCUMENT_PDF_BASE64_MAXIMUM_BYTES =
  4 * Math.ceil(DOCUMENT_SOURCE_MAXIMUM_BYTES / 3);

export type SupportedDocumentMediaType = "text/plain" | "application/pdf";

export function utf8DocumentBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Returns the decoded byte length for strict standard base64, or undefined. */
export function standardBase64DecodedBytes(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return undefined;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Measures original document bytes, not its API or private-wire representation. */
export function documentSourceBytes(
  representation: string,
  mediaType: SupportedDocumentMediaType,
): number | undefined {
  return mediaType === "text/plain"
    ? utf8DocumentBytes(representation)
    : standardBase64DecodedBytes(representation);
}

export function documentIsWithinSourceLimit(
  representation: string,
  mediaType: SupportedDocumentMediaType,
): boolean {
  const bytes = documentSourceBytes(representation, mediaType);
  return bytes !== undefined && bytes > 0 && bytes <= DOCUMENT_SOURCE_MAXIMUM_BYTES;
}
