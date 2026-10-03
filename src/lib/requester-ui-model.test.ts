import { describe, expect, it } from "vitest";

import {
  isPromptWithinLimit,
  parseWholeSatBudget,
  prepareRequesterDocument,
  RequesterDocumentValidationError,
  REQUESTER_DOCUMENT_MAXIMUM_BYTES,
  REQUESTER_PROMPT_MAXIMUM_BYTES,
} from "./requester-ui-model";

describe("requester UI input model", () => {
  it("accepts only positive whole-sat budgets", () => {
    expect(parseWholeSatBudget("500")).toBe(500);
    for (const invalid of ["", "0", "-1", "1.5", "1e3", "abc", " 500"] ) {
      expect(parseWholeSatBudget(invalid)).toBeUndefined();
    }
  });

  it("enforces the runtime-aligned UTF-8 prompt limit", () => {
    expect(isPromptWithinLimit("x".repeat(REQUESTER_PROMPT_MAXIMUM_BYTES))).toBe(true);
    expect(isPromptWithinLimit("x".repeat(REQUESTER_PROMPT_MAXIMUM_BYTES + 1))).toBe(false);
    expect(isPromptWithinLimit("€".repeat(Math.floor(REQUESTER_PROMPT_MAXIMUM_BYTES / 3) + 1))).toBe(false);
  });

  it("rejects unsupported and oversized documents", async () => {
    await expect(prepareRequesterDocument(new File(["private"], "private.png", { type: "image/png" })))
      .rejects.toMatchObject({ code: "unsupported_media_type" });
    await expect(prepareRequesterDocument(new File(
      ["x".repeat(REQUESTER_DOCUMENT_MAXIMUM_BYTES + 1)],
      "large.txt",
      { type: "text/plain" },
    ))).rejects.toBeInstanceOf(RequesterDocumentValidationError);
  });

  it("uses text for text/plain and base64 bytes for application/pdf", async () => {
    const text = await prepareRequesterDocument(new File(["private text"], "note.txt", { type: "text/plain" }));
    expect(text.privateDocument).toBe("private text");

    const pdf = await prepareRequesterDocument(new File(["%PDF-test"], "note.pdf", { type: "application/pdf" }));
    expect(atob(pdf.privateDocument)).toBe("%PDF-test");
    expect(pdf.mediaType).toBe("application/pdf");
  });

  it("enforces the API representation limit after PDF base64 expansion", async () => {
    const rawBytes = new Uint8Array(750_001);
    rawBytes.set(new TextEncoder().encode("%PDF-"));
    await expect(prepareRequesterDocument(new File([rawBytes], "large.pdf", { type: "application/pdf" })))
      .rejects.toMatchObject({ code: "document_too_large" });
  });
});
