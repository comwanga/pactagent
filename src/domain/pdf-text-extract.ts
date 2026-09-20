import { inflateSync } from "node:zlib";

import { InvalidDomainInputError } from "./errors";
import { DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES } from "./pact-service-agreement";

/** Minimal, dependency-free PDF text extractor supporting raw and FlateDecode streams. */

export type PdfTextExtractErrorCode =
  | "invalid_pdf"
  | "no_text"
  | "inflate_failed"
  | "output_too_large"
  | "unsupported_pdf_structure";

export class PdfTextExtractError extends InvalidDomainInputError {
  readonly code: PdfTextExtractErrorCode;

  constructor(code: PdfTextExtractErrorCode, message: string) {
    super(message);
    this.name = "PdfTextExtractError";
    this.code = code;
  }
}

function extractError(code: PdfTextExtractErrorCode, message: string): never {
  throw new PdfTextExtractError(code, message);
}

export interface PdfExtractResult {
  readonly text: string;
  readonly pageCount: number;
}

const PDF_HEADER = Buffer.from("%PDF-");
const STREAM_KEYWORD = Buffer.from("stream");
const ENDSTREAM_KEYWORD = Buffer.from("endstream");
const DICT_OPEN = Buffer.from("<<");
const DICT_CLOSE = Buffer.from(">>");
const LENGTH_DIRECT_PATTERN = /\/Length\s+(\d+)\s*(?![\d\s]*\d+\s+R)/;
const LENGTH_INDIRECT_PATTERN = /\/Length\s+\d+\s+\d+\s+R/;
const FLATE_PATTERN = /\/FlateDecode/;
const TYPE_PAGE = Buffer.from("/Type /Page");
const TYPE_PAGES = Buffer.from("/Type /Pages");

/** WinAnsiEncoding high-byte overrides for 0x80–0x9f. */
const WIN_ANSI_HIGH: readonly string[] = (() => {
  const table: string[] = [];
  for (let i = 0; i < 256; i++) table.push(String.fromCharCode(i));
  const overrides: Readonly<Record<number, string>> = {
    0x80: "\u20AC",
    0x82: "\u201A",
    0x83: "\u0192",
    0x84: "\u201E",
    0x85: "\u2026",
    0x86: "\u2020",
    0x87: "\u2021",
    0x88: "\u02C6",
    0x89: "\u2030",
    0x8A: "\u0160",
    0x8B: "\u2039",
    0x8C: "\u0152",
    0x8E: "\u017D",
    0x91: "\u2018",
    0x92: "\u2019",
    0x93: "\u201C",
    0x94: "\u201D",
    0x95: "\u2022",
    0x96: "\u2013",
    0x97: "\u2014",
    0x98: "\u02DC",
    0x99: "\u2122",
    0x9A: "\u0161",
    0x9B: "\u203A",
    0x9C: "\u0153",
    0x9E: "\u017E",
    0x9F: "\u0178",
  };
  for (const [byte, character] of Object.entries(overrides)) {
    table[Number(byte)] = character;
  }
  return table;
})();

function countPages(buffer: Buffer): number {
  let count = 0;
  let from = 0;
  while (true) {
    const pageIndex = buffer.indexOf(TYPE_PAGE, from);
    if (pageIndex === -1) break;
    if (!buffer.subarray(pageIndex, pageIndex + TYPE_PAGES.length).equals(TYPE_PAGES)) {
      count += 1;
    }
    from = pageIndex + TYPE_PAGE.length;
  }
  return Math.max(count, 1);
}

interface RawStream {
  readonly bytes: Buffer;
  readonly flate: boolean;
}

interface ParsedDictionary {
  readonly length: number;
  readonly flate: boolean;
}

/** Find the matching `<<` for the `>>` that closes just before the `stream` keyword. */
function findStreamDictionaryBounds(
  buffer: Buffer,
  streamAt: number,
  minimum: number,
): { readonly start: number; readonly end: number } | null {
  let scan = streamAt;
  while (scan > minimum && (buffer[scan - 1] === 0x20 || buffer[scan - 1] === 0x0d || buffer[scan - 1] === 0x0a || buffer[scan - 1] === 0x09)) {
    scan -= 1;
  }
  if (scan < DICT_CLOSE.length) return null;
  const closeEnd = scan;
  if (buffer.subarray(closeEnd - DICT_CLOSE.length, closeEnd).equals(DICT_CLOSE) === false) return null;

  let depth = 1;
  let pos = closeEnd - DICT_CLOSE.length;
  while (pos > minimum) {
    if (pos >= DICT_CLOSE.length && buffer.subarray(pos - DICT_CLOSE.length, pos).equals(DICT_CLOSE)) {
      depth += 1;
      pos -= DICT_CLOSE.length;
      continue;
    }
    if (pos >= DICT_OPEN.length && buffer.subarray(pos - DICT_OPEN.length, pos).equals(DICT_OPEN)) {
      depth -= 1;
      if (depth === 0) return { start: pos - DICT_OPEN.length, end: closeEnd };
      pos -= DICT_OPEN.length;
      continue;
    }
    pos -= 1;
  }
  return null;
}

/** Parse /Length and /Filter from the stream's own dictionary. Fail closed on unsupported lengths. */
function parseStreamDictionary(buffer: Buffer, streamAt: number, minimum: number): ParsedDictionary | null {
  const bounds = findStreamDictionaryBounds(buffer, streamAt, minimum);
  if (bounds === null) return null;
  const dictText = buffer.subarray(bounds.start, bounds.end).toString("latin1");

  if (LENGTH_INDIRECT_PATTERN.test(dictText)) {
    extractError("unsupported_pdf_structure", "PDF stream uses an indirect /Length reference which is not supported");
  }

  const directMatch = LENGTH_DIRECT_PATTERN.exec(dictText);
  if (directMatch === null) {
    extractError("unsupported_pdf_structure", "PDF stream does not declare a supported direct /Length");
  }
  const length = parseInt(directMatch[1], 10);
  if (!Number.isSafeInteger(length) || length < 0) {
    extractError("unsupported_pdf_structure", "PDF stream declares an invalid /Length");
  }
  const flate = FLATE_PATTERN.test(dictText);
  return { length, flate };
}

function findStreams(buffer: Buffer): RawStream[] {
  const streams: RawStream[] = [];
  let cursor = 0;
  let dictionaryFloor = 0;
  while (cursor < buffer.length) {
    const streamAt = buffer.indexOf(STREAM_KEYWORD, cursor);
    if (streamAt === -1) break;

    const dictionary = parseStreamDictionary(buffer, streamAt, dictionaryFloor);
    if (dictionary === null) {
      cursor = streamAt + STREAM_KEYWORD.length;
      dictionaryFloor = cursor;
      continue;
    }

    let bodyStart = streamAt + STREAM_KEYWORD.length;
    if (buffer[bodyStart] === 0x0d) {
      bodyStart += 1;
      if (buffer[bodyStart] === 0x0a) bodyStart += 1;
    } else if (buffer[bodyStart] === 0x0a) {
      bodyStart += 1;
    } else {
      extractError("unsupported_pdf_structure", "PDF stream keyword is not followed by an end-of-line marker");
    }

    const bodyEnd = bodyStart + dictionary.length;
    if (bodyEnd > buffer.length) {
      extractError("unsupported_pdf_structure", "PDF stream /Length exceeds the available document bytes");
    }

    streams.push({ bytes: buffer.subarray(bodyStart, bodyEnd), flate: dictionary.flate });

    let endstreamAt = bodyEnd;
    if (buffer[endstreamAt] === 0x0d) {
      endstreamAt += 1;
      if (buffer[endstreamAt] === 0x0a) endstreamAt += 1;
    } else if (buffer[endstreamAt] === 0x0a) {
      endstreamAt += 1;
    }
    if (
      endstreamAt + ENDSTREAM_KEYWORD.length > buffer.length ||
      buffer.subarray(endstreamAt, endstreamAt + ENDSTREAM_KEYWORD.length).equals(ENDSTREAM_KEYWORD) === false
    ) {
      extractError("unsupported_pdf_structure", "PDF stream /Length does not align with endstream");
    }
    cursor = endstreamAt + ENDSTREAM_KEYWORD.length;
    dictionaryFloor = cursor;
  }
  return streams;
}

interface ShowableString {
  readonly text: string;
}

function decodePdfStringLiteral(input: Buffer, hex: boolean): string {
  let result = "";
  if (hex) {
    let hexString = "";
    for (const byte of input) {
      const char = String.fromCharCode(byte);
      if (/[0-9a-fA-F]/.test(char)) hexString += char;
    }
    if (hexString.length % 2 !== 0) hexString += "0";
    for (let i = 0; i < hexString.length; i += 2) {
      const byte = parseInt(hexString.slice(i, i + 2), 16);
      result += WIN_ANSI_HIGH[byte] ?? String.fromCharCode(byte);
    }
    return result;
  }

  for (let i = 0; i < input.length; i++) {
    const byte = input[i];
    if (byte === 0x5c) {
      const next = input[i + 1];
      const escape: Readonly<Record<number, string>> = {
        0x6e: "\n",
        0x72: "\r",
        0x74: "\t",
        0x62: "\u0008",
        0x66: "\u000c",
        0x28: "(",
        0x29: ")",
        0x5c: "\\",
      };
      if (next !== undefined && escape[next] !== undefined) {
        result += escape[next];
        i += 1;
        continue;
      }
      if (next !== undefined && next >= 0x30 && next <= 0x37) {
        let octal = String.fromCharCode(next);
        let j = i + 2;
        while (j < input.length && j < i + 4 && input[j] >= 0x30 && input[j] <= 0x37) {
          octal += String.fromCharCode(input[j]);
          j += 1;
        }
        result += WIN_ANSI_HIGH[parseInt(octal, 8) & 0xff] ?? String.fromCharCode(parseInt(octal, 8) & 0xff);
        i = j - 1;
        continue;
      }
      continue;
    }
    result += WIN_ANSI_HIGH[byte] ?? String.fromCharCode(byte);
  }
  return result;
}

/** Walk a content-stream buffer and recover text shown by Tj, TJ, ', and ". */
function extractTextFromStream(stream: Buffer): string {
  let output = "";
  const operandStack: ShowableString[] = [];
  let arrayDepth = 0;
  let arrayMembers: ShowableString[] = [];
  let i = 0;

  const pushOperand = (value: ShowableString): void => {
    if (arrayDepth > 0) {
      arrayMembers.push(value);
    } else {
      operandStack.push(value);
    }
  };

  while (i < stream.length) {
    const byte = stream[i];

    if (byte === 0x25) {
      while (i < stream.length && stream[i] !== 0x0a && stream[i] !== 0x0d) i += 1;
      continue;
    }

    if (byte === 0x28) {
      const literal = readParenLiteral(stream, i);
      const decoded = decodePdfStringLiteral(literal.bytes, false);
      pushOperand({ text: decoded });
      i = literal.next;
      continue;
    }

    if (byte === 0x3c && stream[i + 1] === 0x3c) {
      i += 2;
      continue;
    }
    if (byte === 0x3e && stream[i + 1] === 0x3e) {
      i += 2;
      continue;
    }
    if (byte === 0x3c) {
      const hex = readHexLiteral(stream, i);
      const decoded = decodePdfStringLiteral(hex.bytes, true);
      pushOperand({ text: decoded });
      i = hex.next;
      continue;
    }

    if (byte === 0x5b) {
      arrayDepth += 1;
      arrayMembers = [];
      i += 1;
      continue;
    }
    if (byte === 0x5d) {
      if (arrayDepth > 0) {
        operandStack.push({ text: arrayMembers.map((member) => member.text).join("") });
        arrayMembers = [];
        arrayDepth -= 1;
      }
      i += 1;
      continue;
    }

    if (isOperatorByte(byte)) {
      const operator = readOperator(stream, i);
      if (operator.token === "Tj" || operator.token === "TJ" || operator.token === "'" || operator.token === '"') {
        const operand = operandStack.pop();
        if (operand !== undefined && operand.text.length > 0) {
          output += operand.text + "\n";
        }
      } else if (operator.token === "Td" || operator.token === "TD" || operator.token === "T*") {
        if (output.length > 0 && !output.endsWith("\n")) output += "\n";
      }
      i = operator.next;
      continue;
    }

    i += 1;
  }

  return output;
}

function isOperatorByte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x2a ||
    byte === 0x27 ||
    byte === 0x22
  );
}

function readOperator(stream: Buffer, start: number): { readonly token: string; readonly next: number } {
  let i = start;
  while (i < stream.length && isOperatorByte(stream[i])) i += 1;
  const token = stream.subarray(start, i).toString("latin1");
  while (i < stream.length && (stream[i] === 0x20 || stream[i] === 0x0d || stream[i] === 0x0a || stream[i] === 0x09)) {
    i += 1;
  }
  return { token, next: i };
}

function readParenLiteral(stream: Buffer, start: number): { readonly bytes: Buffer; readonly next: number } {
  const chunks: number[] = [];
  let depth = 1;
  let i = start + 1;
  while (i < stream.length && depth > 0) {
    const byte = stream[i];
    if (byte === 0x5c) {
      chunks.push(byte);
      if (i + 1 < stream.length) {
        chunks.push(stream[i + 1]);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (byte === 0x28) {
      depth += 1;
      chunks.push(byte);
      i += 1;
      continue;
    }
    if (byte === 0x29) {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
      chunks.push(byte);
      i += 1;
      continue;
    }
    chunks.push(byte);
    i += 1;
  }
  return { bytes: Buffer.from(chunks), next: i };
}

function readHexLiteral(stream: Buffer, start: number): { readonly bytes: Buffer; readonly next: number } {
  const chunks: number[] = [];
  let i = start + 1;
  while (i < stream.length) {
    const byte = stream[i];
    if (byte === 0x3e) {
      i += 1;
      break;
    }
    chunks.push(byte);
    i += 1;
  }
  return { bytes: Buffer.from(chunks), next: i };
}

function decompressStream(stream: RawStream): Buffer {
  if (!stream.flate) return stream.bytes;
  if (stream.bytes.length === 0) return stream.bytes;
  try {
    return inflateSync(stream.bytes, { maxOutputLength: DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES });
  } catch (error) {
    if (error instanceof RangeError) {
      extractError("output_too_large", "Inflated PDF stream exceeds the maximum processing size");
    }
    extractError("inflate_failed", "PDF FlateDecode stream could not be inflated");
  }
}

export function extractPdfText(input: Buffer): PdfExtractResult {
  if (input.length < PDF_HEADER.length || input.subarray(0, PDF_HEADER.length).equals(PDF_HEADER) === false) {
    extractError("invalid_pdf", "Input is not a valid PDF document");
  }
  const streams = findStreams(input);
  let text = "";
  let cumulativeInflated = 0;
  for (const stream of streams) {
    const decompressed = decompressStream(stream);
    cumulativeInflated += decompressed.length;
    if (cumulativeInflated > DOCUMENT_SUMMARY_MAXIMUM_INPUT_BYTES) {
      extractError("output_too_large", "Cumulative inflated PDF content exceeds the maximum processing size");
    }
    if (decompressed.length === 0) continue;
    text += extractTextFromStream(decompressed);
  }
  const normalized = text.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length === 0) {
    extractError("no_text", "PDF does not expose extractable text in a supported encoding");
  }
  return { text: normalized, pageCount: countPages(input) };
}
