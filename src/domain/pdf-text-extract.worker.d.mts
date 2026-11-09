export declare const PDF_WORKER_KIND: "pactagent-pdf-text-extract";
export declare const DECODE_BUDGET_EXIT_CODE: number;

export interface PdfWorkerLimits {
  readonly maxPages: number;
  readonly maxTextChars: number;
  readonly maxDecodedBytes: number;
}

export type PdfWorkerResult =
  | { readonly status: "ok"; readonly text: string; readonly pageCount: number }
  | { readonly status: "invalid_pdf" }
  | { readonly status: "page_limit_exceeded" }
  | { readonly status: "worker_error" };

export interface TextAccumulator {
  readonly full: boolean;
  push(text: string): void;
  finish(): string;
}

export declare function createTextAccumulator(maxChars: number): TextAccumulator;

export declare function installDecodeBudget(
  scope: { Uint8Array: Uint8ArrayConstructor },
  maxBytes: number,
  onExceeded: () => void,
): { readonly allocated: number };

export declare function disableNativeDecompression(scope: { DecompressionStream?: unknown }): boolean;

export declare function extractBoundedText(
  data: Uint8Array,
  limits: Pick<PdfWorkerLimits, "maxPages" | "maxTextChars">,
): Promise<PdfWorkerResult>;
