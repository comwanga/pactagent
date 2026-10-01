import {
  summarizeDocument,
  type DocumentSummaryOutcome,
} from "../domain/document-summary-service";

export interface DocumentSummaryRequest {
  readonly source_document: string;
  readonly input_media_type: "text/plain" | "application/pdf";
  readonly private_prompt?: string;
  readonly agreementRoot?: string;
}

export interface DocumentSummaryModel {
  summarize(request: DocumentSummaryRequest, context: DocumentSummaryContext): Promise<DocumentSummaryOutcome>;
}

export interface DocumentSummaryContext {
  readonly signal: AbortSignal;
}

export class DocumentSummaryModelFailure extends Error {
  readonly code: "timeout" | "unavailable";

  constructor(code: "timeout" | "unavailable") {
    super(code === "timeout" ? "Document summary model timed out" : "Document summary model is unavailable");
    this.name = "DocumentSummaryModelFailure";
    this.code = code;
  }
}

export function createLocalDocumentSummaryModel(): DocumentSummaryModel {
  return Object.freeze({
    async summarize(request: DocumentSummaryRequest): Promise<DocumentSummaryOutcome> {
      return summarizeDocument(request);
    },
  });
}
