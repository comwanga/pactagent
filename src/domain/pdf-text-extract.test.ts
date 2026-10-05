import { describe, expect, it } from "vitest";

import { extractPdfText, PdfTextExtractError } from "./pdf-text-extract";

/*
 * Builds a small but structurally valid single-page PDF (header, body objects,
 * cross-reference table, trailer) that the pdf.js engine parses, so the tests
 * exercise the real extraction path without committing a binary fixture.
 */
function escapePdfString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(lines: readonly string[], hex = false): Buffer {
  const content = lines
    .map((line) => {
      if (hex) {
        return `BT /F1 12 Tf 72 720 Td <${Buffer.from(line, "latin1").toString("hex")}> Tj ET`;
      }
      return `BT /F1 12 Tf 72 720 Td (${escapePdfString(line)}) Tj ET`;
    })
    .join("\n");
  const contentBytes = Buffer.from(content, "latin1");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

describe("pdf-text-extract", () => {
  it("extracts text shown through Tj string operators", async () => {
    const result = await extractPdfText(buildPdf(["PactAgent document summary.", "Second line of text."]));
    expect(result.text).toContain("PactAgent document summary.");
    expect(result.text).toContain("Second line of text.");
    expect(result.pageCount).toBeGreaterThanOrEqual(1);
  });

  it("extracts text from hex-encoded string literals", async () => {
    const result = await extractPdfText(buildPdf(["Hex encoded line."], true));
    expect(result.text).toContain("Hex encoded line.");
  });

  it("rejects a buffer that is not a PDF", async () => {
    await expect(extractPdfText(Buffer.from("not a pdf document"))).rejects.toBeInstanceOf(PdfTextExtractError);
    try {
      await extractPdfText(Buffer.from("not a pdf document"));
    } catch (error) {
      expect((error as PdfTextExtractError).code).toBe("invalid_pdf");
    }
  });

  it("rejects a PDF header followed by unparseable bytes", async () => {
    await expect(
      extractPdfText(Buffer.from("%PDF-1.4\nthis is not a real pdf body", "latin1")),
    ).rejects.toMatchObject({ code: "invalid_pdf" });
  });

  it("reports no_text for a valid PDF that exposes no extractable text", async () => {
    await expect(extractPdfText(buildPdf(["   "]))).rejects.toMatchObject({ code: "no_text" });
  });
});
