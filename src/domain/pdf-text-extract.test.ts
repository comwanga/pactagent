import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES } from "./pact-service-agreement";
import { extractPdfText, PdfTextExtractError } from "./pdf-text-extract";

/*
 * Minimal PDF builder. It emits a single-page PDF with one or more text
 * snippets shown through the standard `Tj` operator. The content stream can
 * optionally be FlateDecode-compressed so both the raw and inflated paths
 * are exercised deterministically, without any external PDF library.
 */
interface BuildPdfOptions {
  readonly flate?: boolean;
  readonly hexStrings?: boolean;
  readonly lines: readonly string[];
}

function escapePdfString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function toHexStrings(lines: readonly string[]): string {
  return lines
    .map((line) => {
      const hex = Buffer.from(line, "latin1").toString("hex");
      return `BT /F1 12 Tf 72 720 Td (${escapePdfString(line)}) Tj ET BT /F1 12 Tf 72 700 Td <${hex}> Tj ET`;
    })
    .join("\n");
}

function toParenStrings(lines: readonly string[]): string {
  return lines
    .map((line) => `BT /F1 12 Tf 72 720 Td (${escapePdfString(line)}) Tj ET`)
    .join("\n");
}

function buildPdf(options: BuildPdfOptions): Buffer {
  const contentText = options.hexStrings ? toHexStrings(options.lines) : toParenStrings(options.lines);
  let contentStream: string;
  let filterEntry = "";
  if (options.flate) {
    const compressed = deflateSync(Buffer.from(contentText, "latin1"));
    contentStream = compressed.toString("binary");
    filterEntry = "/Filter /FlateDecode ";
  } else {
    contentStream = contentText;
  }
  const contentBytes = Buffer.from(contentStream, "binary");

  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
  objects.push(`<< ${filterEntry}/Length ${contentBytes.length} >>\nstream\n${contentStream}\nendstream`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

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
  it("extracts text from an uncompressed PDF using Tj operators", () => {
    const pdf = buildPdf({ lines: ["PactAgent document summary.", "Second line of text."] });
    const result = extractPdfText(pdf);
    expect(result.text).toContain("PactAgent document summary.");
    expect(result.text).toContain("Second line of text.");
    expect(result.pageCount).toBe(1);
  });

  it("extracts text from a FlateDecode-compressed PDF", () => {
    const pdf = buildPdf({ flate: true, lines: ["Compressed content stream.", "Settlement over Cashu."] });
    const result = extractPdfText(pdf);
    expect(result.text).toContain("Compressed content stream.");
    expect(result.text).toContain("Settlement over Cashu.");
  });

  it("extracts text from hex-encoded PDF string literals", () => {
    const pdf = buildPdf({ hexStrings: true, lines: ["Hex encoded line."] });
    const result = extractPdfText(pdf);
    expect(result.text).toContain("Hex encoded line.");
  });

  it("rejects a buffer that is not a PDF", () => {
    expect(() => extractPdfText(Buffer.from("not a pdf"))).toThrow(PdfTextExtractError);
    try {
      extractPdfText(Buffer.from("not a pdf"));
    } catch (error) {
      expect((error as PdfTextExtractError).code).toBe("invalid_pdf");
    }
  });

  it("rejects a PDF with no extractable text", () => {
    const pdf = buildPdf({ lines: ["   "] });
    expect(() => extractPdfText(pdf)).toThrow(PdfTextExtractError);
  });

  it("does not truncate content when endstream appears inside a string literal", () => {
    const lines = ["The word endstream appears in this document."];
    const pdf = buildPdf({ lines });
    const result = extractPdfText(pdf);
    expect(result.text).toContain("endstream appears in this document");
  });

  it("does not misattribute an unrelated /FlateDecode from a nested resource dictionary", () => {
    const lines = ["Uncompressed stream whose resource sub-dictionary mentions FlateDecode."];
    const contentText = lines
      .map((line) => `BT /F1 12 Tf 72 720 Td (${escapePdfString(line)}) Tj ET`)
      .join("\n");
    const contentBytes = Buffer.from(contentText, "latin1");
    const objects: string[] = [];
    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /Filter /FlateDecode >> >> >>");
    objects.push(`<< /Length ${contentBytes.length} >>\nstream\n${contentText}\nendstream`);
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(Buffer.byteLength(pdf, "latin1"));
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(pdf, "latin1");
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    const buffer = Buffer.from(pdf, "latin1");
    const result = extractPdfText(buffer);
    expect(result.text).toContain("Uncompressed stream");
  });

  it("ignores a raw stream token that is not attached to a stream dictionary", () => {
    const contentText = "BT /F1 12 Tf 72 720 Td (Actual content stream) Tj ET";
    const contentBytes = Buffer.from(contentText, "latin1");
    const objects: string[] = [];
    objects.push("<< /Type /Catalog /Pages 2 0 R /Title (A stream processing example) >>");
    objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
    objects.push(`<< /Length ${contentBytes.length} >>\nstream\n${contentText}\nendstream`);
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(Buffer.byteLength(pdf, "latin1"));
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(pdf, "latin1");
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    const result = extractPdfText(Buffer.from(pdf, "latin1"));
    expect(result.text).toContain("Actual content stream");
  });

  it("rejects a stream dictionary without a supported direct /Length", () => {
    const contentText = "BT /F1 12 Tf 72 720 Td (Missing length test) Tj ET";
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< >>\nstream\n${contentText}\nendstream\nendobj\n%%EOF`,
      "latin1",
    );
    expect(() => extractPdfText(pdf)).toThrow(PdfTextExtractError);
    try {
      extractPdfText(pdf);
    } catch (error) {
      expect((error as PdfTextExtractError).code).toBe("unsupported_pdf_structure");
    }
  });

  it("rejects a stream with an indirect /Length reference", () => {
    const contentText = "BT /F1 12 Tf 72 720 Td (Indirect length test) Tj ET";
    const contentBytes = Buffer.from(contentText, "latin1");
    const objects: string[] = [];
    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
    objects.push(`<< /Length 6 0 R >>\nstream\n${contentText}\nendstream`);
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    objects.push(String(contentBytes.length));
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(Buffer.byteLength(pdf, "latin1"));
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(pdf, "latin1");
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    const buffer = Buffer.from(pdf, "latin1");
    expect(() => extractPdfText(buffer)).toThrow(PdfTextExtractError);
    try {
      extractPdfText(buffer);
    } catch (error) {
      expect((error as PdfTextExtractError).code).toBe("unsupported_pdf_structure");
    }
  });

  it("rejects inflated content exceeding the processing bound", () => {
    const largeText = "A".repeat(DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES + 1000);
    const compressed = deflateSync(Buffer.from(largeText, "latin1"));
    const objects: string[] = [];
    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
    objects.push(`<< /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n${compressed.toString("binary")}\nendstream`);
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(Buffer.byteLength(pdf, "latin1"));
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(pdf, "latin1");
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    const buffer = Buffer.from(pdf, "latin1");
    expect(() => extractPdfText(buffer)).toThrow(PdfTextExtractError);
    try {
      extractPdfText(buffer);
    } catch (error) {
      expect((error as PdfTextExtractError).code).toBe("output_too_large");
    }
  });
});
