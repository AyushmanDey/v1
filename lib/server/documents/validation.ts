import { HttpError } from "../http";

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_DOCX_EXPANDED_BYTES = 100 * 1024 * 1024;
export const MAX_DOCX_MEMBERS = 10_000;
export const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export interface ZipMember {
  name: string;
  uncompressedSize: number;
}

class InvalidZipError extends Error {}
export class TooManyZipMembersError extends Error {}

/** Read ZIP central-directory entries without decompressing any member. */
export function readZipMembers(data: Uint8Array): ZipMember[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const EOCD = 0x06054b50;
  const searchStart = Math.max(0, data.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = data.length - 22; offset >= searchStart; offset--) {
    if (view.getUint32(offset, true) === EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new InvalidZipError("End of central directory not found");

  let entryCount = view.getUint16(eocd + 10, true);
  let directoryOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) throw new InvalidZipError("ZIP64 locator missing");
    const zip64Eocd = Number(view.getBigUint64(locator + 8, true));
    if (zip64Eocd + 56 > data.length || view.getUint32(zip64Eocd, true) !== 0x06064b50) {
      throw new InvalidZipError("ZIP64 directory missing");
    }
    entryCount = Number(view.getBigUint64(zip64Eocd + 32, true));
    directoryOffset = Number(view.getBigUint64(zip64Eocd + 48, true));
  }
  if (entryCount > MAX_DOCX_MEMBERS) throw new TooManyZipMembersError(`ZIP has ${entryCount} members`);

  const decoder = new TextDecoder();
  const members: ZipMember[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > data.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new InvalidZipError("Invalid central directory entry");
    }
    let uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const extraStart = nameStart + nameLength;
    if (extraStart + extraLength + commentLength > data.length) throw new InvalidZipError("Truncated entry");
    const name = decoder.decode(data.subarray(nameStart, extraStart));

    if (uncompressedSize === 0xffffffff) {
      // ZIP64 extended information: uncompressed size is the first 8-byte field.
      let extra = extraStart;
      const extraEnd = extraStart + extraLength;
      let found = false;
      while (extra + 4 <= extraEnd) {
        const headerId = view.getUint16(extra, true);
        const size = view.getUint16(extra + 2, true);
        if (headerId === 0x0001 && size >= 8) {
          uncompressedSize = Number(view.getBigUint64(extra + 4, true));
          found = true;
          break;
        }
        extra += 4 + size;
      }
      if (!found) throw new InvalidZipError("ZIP64 size missing");
    }
    members.push({ name, uncompressedSize });
    offset = extraStart + extraLength + commentLength;
  }
  return members;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

function validateDocx(data: Uint8Array): void {
  let members: ZipMember[];
  try {
    members = readZipMembers(data);
  } catch (error) {
    if (error instanceof TooManyZipMembersError) throw new HttpError(415, "Invalid or oversized DOCX file");
    throw new HttpError(415, "File content does not match DOCX format");
  }
  const names = new Set(members.map((member) => member.name));
  const expanded = members.reduce((total, member) => total + member.uncompressedSize, 0);
  if (
    members.length > MAX_DOCX_MEMBERS ||
    !names.has("[Content_Types].xml") ||
    !names.has("word/document.xml") ||
    expanded > MAX_DOCX_EXPANDED_BYTES
  ) {
    throw new HttpError(415, "Invalid or oversized DOCX file");
  }
}

/** Return a safe display filename and the MIME type detected from validated content. */
export function validateDocument(filename: string, data: Uint8Array): { safeName: string; mimeType: string } {
  const normalizedName = (filename || "").replace(/\\/g, "/").split("/").pop()!.trim();
  if (
    !normalizedName ||
    [...normalizedName].length > 255 ||
    [...normalizedName].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new HttpError(422, "Invalid file name");
  }
  if (!data || data.length === 0) throw new HttpError(422, "The uploaded file is empty");
  if (data.length > MAX_DOCUMENT_BYTES) throw new HttpError(413, "File exceeds the 25 MiB limit");

  const extension = extensionOf(normalizedName);
  const mimeType = MIME_TYPES[extension];
  if (!mimeType) throw new HttpError(415, "Only PDF, TXT, and DOCX files are supported");

  if (extension === ".pdf" && Buffer.from(data.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    throw new HttpError(415, "File content does not match PDF format");
  }
  if (extension === ".txt") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new HttpError(415, "Text files must use UTF-8 encoding");
    }
    if (data.includes(0)) throw new HttpError(415, "Text file contains binary data");
  }
  if (extension === ".docx") validateDocx(data);

  return { safeName: normalizedName, mimeType };
}
