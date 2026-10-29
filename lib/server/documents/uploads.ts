import { createHash, randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth";
import { HttpError, UpstreamConnectionError, encodePath, readJson, trimTrailingSlash, upstreamFetch, type FetchLike } from "../http";
import type { Settings } from "../settings";
import { validateDocument } from "./validation";

export interface CreatedDocument {
  id: string;
  course_id: string;
  title: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  status: string;
}

function raiseUpstreamError(response: Response, message: string): void {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(403, "You are not authorized to access this course");
  }
  if (response.status === 413) throw new HttpError(413, "File exceeds the storage limit");
  if (response.status === 415) throw new HttpError(415, "Storage rejected the file type");
  throw new HttpError(502, message);
}

async function cleanupUploadedObject(opts: {
  fetchImpl: FetchLike;
  baseUrl: string;
  bucket: string;
  storagePath: string;
  headers: Record<string, string>;
  documentId: string;
}): Promise<void> {
  try {
    const response = await upstreamFetch(opts.fetchImpl, `${opts.baseUrl}/storage/v1/object/${opts.bucket}`, {
      method: "DELETE",
      body: JSON.stringify({ prefixes: [opts.storagePath] }),
      headers: { ...opts.headers, "Content-Type": "application/json" },
    });
    if (!response.ok) {
      console.error("document_orphan_cleanup_failed", { document_id: opts.documentId, status_code: response.status });
    }
  } catch {
    console.error("document_orphan_cleanup_failed", { document_id: opts.documentId });
  }
}

/** Refuse a file whose exact bytes are already in the course (failed copies may be uploaded again). */
async function rejectDuplicate(opts: {
  fetchImpl: FetchLike;
  baseUrl: string;
  headers: Record<string, string>;
  courseId: string;
  sha256: string;
}): Promise<void> {
  const params = new URLSearchParams({
    course_id: `eq.${opts.courseId}`,
    sha256: `eq.${opts.sha256}`,
    status: "neq.failed",
    select: "title",
    limit: "1",
  });
  let response: Response;
  try {
    response = await upstreamFetch(opts.fetchImpl, `${opts.baseUrl}/rest/v1/course_documents?${params}`, { headers: opts.headers });
  } catch (error) {
    if (error instanceof UpstreamConnectionError) throw new HttpError(503, "Document storage is unavailable");
    throw error;
  }
  raiseUpstreamError(response, "Document lookup failed");
  const rows = (await readJson(response).catch(() => null)) as { title?: string }[] | null;
  if (Array.isArray(rows) && rows.length > 0) {
    throw new HttpError(409, `This file is already in the course as “${rows[0].title ?? "another document"}”.`);
  }
}

export async function createCourseDocument(opts: {
  settings: Settings;
  user: AuthenticatedUser;
  courseId: string;
  title: string;
  filename: string;
  data: Uint8Array;
  fetch?: FetchLike;
}): Promise<CreatedDocument> {
  const { settings, user, courseId, data } = opts;
  const fetchImpl = opts.fetch ?? fetch;
  if (!settings.supabaseUrl || !settings.supabaseAnonKey) {
    throw new HttpError(503, "Document storage is not configured");
  }
  if (!user.accessToken) throw new HttpError(401, "Authentication required");
  const title = opts.title.trim();
  if (title.length < 1 || [...title].length > 200) {
    throw new HttpError(422, "Title must be between 1 and 200 characters");
  }

  const { safeName, mimeType } = validateDocument(opts.filename, data);
  const documentId = randomUUID();
  const storagePath = `${courseId}/${documentId}/${safeName}`;
  const baseUrl = trimTrailingSlash(settings.supabaseUrl);
  const encodedBucket = encodePath(settings.supabaseStorageBucket);
  const encodedPath = encodePath(storagePath, true);
  const headers = { apikey: settings.supabaseAnonKey, Authorization: `Bearer ${user.accessToken}` };
  const sha256 = createHash("sha256").update(data).digest("hex");

  await rejectDuplicate({ fetchImpl, baseUrl, headers, courseId, sha256 });

  let storageResponse: Response;
  try {
    storageResponse = await upstreamFetch(fetchImpl, `${baseUrl}/storage/v1/object/${encodedBucket}/${encodedPath}`, {
      method: "POST",
      body: Buffer.from(data),
      headers: { ...headers, "Content-Type": mimeType, "x-upsert": "false" },
    });
  } catch (error) {
    if (error instanceof UpstreamConnectionError) throw new HttpError(503, "Document storage is unavailable");
    throw error;
  }
  raiseUpstreamError(storageResponse, "Storage upload failed");

  const metadata = {
    id: documentId,
    course_id: courseId,
    title,
    file_name: safeName,
    mime_type: mimeType,
    size_bytes: data.length,
    sha256,
    storage_path: storagePath,
    created_by: user.id,
  };
  try {
    const metadataResponse = await upstreamFetch(fetchImpl, `${baseUrl}/rest/v1/course_documents`, {
      method: "POST",
      body: JSON.stringify(metadata),
      headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    });
    raiseUpstreamError(metadataResponse, "Document registration failed");
  } catch (error) {
    await cleanupUploadedObject({ fetchImpl, baseUrl, bucket: encodedBucket, storagePath, headers, documentId });
    if (error instanceof UpstreamConnectionError) throw new HttpError(503, "Document registration is unavailable");
    throw error;
  }

  return {
    id: documentId,
    course_id: courseId,
    title,
    file_name: safeName,
    mime_type: mimeType,
    size_bytes: data.length,
    status: "queued",
  };
}
