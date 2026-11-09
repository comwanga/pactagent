import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDocumentProxy } from "unpdf";

import { extractBoundedText } from "./pdf-text-extract.worker.mjs";

vi.mock("unpdf", () => ({ getDocumentProxy: vi.fn() }));

const limits = { maxPages: 2, maxTextChars: 100 };
const privateError = () => new Error("SECRET-DOCUMENT /private/path parser details");

function documentFixture() {
  let sent = false;
  const reader = {
    read: vi.fn(async () => {
      if (sent) return { done: true, value: undefined };
      sent = true;
      return { done: false, value: { items: [{ str: "hello world", hasEOL: false }] } };
    }),
    cancel: vi.fn(async () => undefined),
  };
  const page = { streamTextContent: () => ({ getReader: () => reader }), cleanup: vi.fn() };
  const pdf = {
    numPages: 1,
    getPage: vi.fn(async () => page),
    loadingTask: { destroy: vi.fn(async () => undefined) },
  };
  // Only the parser boundary is mocked; the extraction and cleanup logic runs.
  vi.mocked(getDocumentProxy).mockResolvedValue(pdf as unknown as Awaited<ReturnType<typeof getDocumentProxy>>);
  return { pdf, page, reader };
}

beforeEach(() => vi.resetAllMocks());

describe("PDF worker failure classification", () => {
  it.each(["InvalidPDFException", "PasswordException", "FormatError"])(
    "keeps %s as an unsupported document without returning parser details",
    async (name) => {
      vi.mocked(getDocumentProxy).mockRejectedValue(Object.assign(privateError(), { name }));
      expect(await extractBoundedText(new Uint8Array(), limits)).toEqual({ status: "invalid_pdf" });
    },
  );

  it("classifies an unexpected parser startup failure as a worker failure", async () => {
    vi.mocked(getDocumentProxy).mockRejectedValue(privateError());
    expect(await extractBoundedText(new Uint8Array(), limits)).toEqual({ status: "worker_error" });
  });

  it.each(["getPage", "read"])("classifies an unexpected %s failure and destroys the document", async (operation) => {
    const { pdf, page, reader } = documentFixture();
    if (operation === "getPage") pdf.getPage.mockRejectedValue(privateError());
    else reader.read.mockRejectedValue(privateError());
    expect(await extractBoundedText(new Uint8Array(), limits)).toEqual({ status: "worker_error" });
    expect(pdf.loadingTask.destroy).toHaveBeenCalledOnce();
    expect(page.cleanup).toHaveBeenCalledTimes(operation === "read" ? 1 : 0);
  });

  it("keeps a recognized document error during streaming classified as invalid_pdf", async () => {
    const { pdf, page, reader } = documentFixture();
    reader.read.mockRejectedValue(Object.assign(privateError(), { name: "FormatError" }));
    expect(await extractBoundedText(new Uint8Array(), limits)).toEqual({ status: "invalid_pdf" });
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(pdf.loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it("fails closed on page cleanup failure without blaming the document", async () => {
    const { pdf, page } = documentFixture();
    page.cleanup.mockImplementation(() => { throw Object.assign(privateError(), { name: "FormatError" }); });
    expect(await extractBoundedText(new Uint8Array(), limits)).toEqual({ status: "worker_error" });
    expect(pdf.loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it("fails closed on text-cap cancellation failure and still cleans up", async () => {
    const { pdf, page, reader } = documentFixture();
    reader.cancel.mockRejectedValue(Object.assign(privateError(), { name: "FormatError" }));
    expect(await extractBoundedText(new Uint8Array(), { ...limits, maxTextChars: 5 })).toEqual({ status: "worker_error" });
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(pdf.loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it("preserves successful text-cap cancellation", async () => {
    const { pdf, page, reader } = documentFixture();
    expect(await extractBoundedText(new Uint8Array(), { ...limits, maxTextChars: 5 })).toEqual({ status: "ok", text: "hello", pageCount: 1 });
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(pdf.loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it("keeps document destruction best effort because the parent terminates the worker", async () => {
    const { pdf } = documentFixture();
    pdf.loadingTask.destroy.mockRejectedValue(privateError());
    expect(await extractBoundedText(new Uint8Array(), limits)).toEqual({ status: "ok", text: "hello world", pageCount: 1 });
  });
});
