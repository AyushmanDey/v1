import { HttpError } from "../http";
import { validateDocument } from "./validation";

export const MAX_EXTRACTED_CHARACTERS = 4_000_000;
export const MAX_PDF_PAGES = 2_000;
export const MAX_CHUNK_CHARACTERS = 1_200;
export const CHUNK_OVERLAP_CHARACTERS = 160;
export const MAX_CHUNKS_PER_DOCUMENT = 10_000;

export class DocumentProcessingError extends Error {
  readonly code: string;

  constructor(code: string, options?: { cause?: unknown }) {
    super(code, options);
    this.name = "DocumentProcessingError";
    this.code = code;
  }
}

export interface ExtractedPage {
  number: number | null;
  text: string;
}

export interface TextChunk {
  chunk_index: number;
  content: string;
  page_start: number | null;
  page_end: number | null;
}

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

async function extractPdf(data: Uint8Array): Promise<ExtractedPage[]> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  // pdf.js may transfer the buffer it is given, so hand it a private copy.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    if (pdf.numPages > MAX_PDF_PAGES) throw new DocumentProcessingError("pdf_page_limit_exceeded");
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((pageText, index) => ({ number: index + 1, text: pageText || "" }));
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

async function extractDocx(data: Uint8Array): Promise<ExtractedPage[]> {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
  return [{ number: null, text: value }];
}

/** Validate stored file content and extract its text, with page numbers when the format has them. */
export async function extractDocument(filename: string, mimeType: string, data: Uint8Array): Promise<ExtractedPage[]> {
  let detectedMime: string;
  try {
    detectedMime = validateDocument(filename, data).mimeType;
  } catch (error) {
    if (error instanceof HttpError) throw new DocumentProcessingError("document_validation_failed", { cause: error });
    throw error;
  }
  if (detectedMime !== mimeType) throw new DocumentProcessingError("document_type_mismatch");

  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  let pages: ExtractedPage[];
  try {
    if (extension === "txt") {
      pages = [{ number: null, text: new TextDecoder("utf-8", { fatal: true }).decode(data) }];
    } else if (extension === "pdf") {
      pages = await extractPdf(data);
    } else if (extension === "docx") {
      pages = await extractDocx(data);
    } else {
      throw new DocumentProcessingError("unsupported_document_type");
    }
  } catch (error) {
    if (error instanceof DocumentProcessingError) throw error;
    throw new DocumentProcessingError("document_parse_failed", { cause: error });
  }

  if (pages.reduce((total, page) => total + page.text.length, 0) > MAX_EXTRACTED_CHARACTERS) {
    throw new DocumentProcessingError("document_text_limit_exceeded");
  }
  if (!pages.some((page) => page.text.trim())) {
    throw new DocumentProcessingError("document_contains_no_extractable_text");
  }
  return pages;
}

/**
 * Split pages into overlapping chunks that prefer word boundaries. Works on code points
 * (not UTF-16 units) so chunks never split a surrogate pair.
 */
export function chunkPages(pages: ExtractedPage[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const page of pages) {
    const chars = Array.from(page.text.replace(/[\s\x1c-\x1f]+/g, " ").trim());
    let start = 0;
    while (start < chars.length) {
      let end = Math.min(start + MAX_CHUNK_CHARACTERS, chars.length);
      if (end < chars.length) {
        const searchFrom = start + Math.floor(MAX_CHUNK_CHARACTERS / 2);
        let boundary = -1;
        for (let index = end - 1; index >= searchFrom; index--) {
          if (chars[index] === " ") {
            boundary = index;
            break;
          }
        }
        if (boundary > start) end = boundary;
      }
      const content = chars.slice(start, end).join("").trim();
      if (content) {
        chunks.push({ chunk_index: chunks.length, content, page_start: page.number, page_end: page.number });
      }
      if (end >= chars.length) break;
      start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARACTERS);
      if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) throw new DocumentProcessingError("document_chunk_limit_exceeded");
    }
  }
  if (chunks.length === 0) throw new DocumentProcessingError("document_contains_no_extractable_text");
  if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) throw new DocumentProcessingError("document_chunk_limit_exceeded");
  return chunks;
}

export function validateEmbeddings(vectors: number[][], expectedCount: number): number {
  if (vectors.length !== expectedCount || expectedCount === 0) {
    throw new DocumentProcessingError("embedding_response_count_mismatch");
  }
  const dimension = vectors[0].length;
  if (dimension < 1 || dimension > 16_000) throw new DocumentProcessingError("embedding_dimension_invalid");
  for (const vector of vectors) {
    if (
      vector.length !== dimension ||
      vector.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
      !vector.some((value) => value !== 0)
    ) {
      throw new DocumentProcessingError("embedding_vector_invalid");
    }
  }
  return dimension;
}
