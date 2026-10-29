import type { AuthenticatedUser } from "../auth";
import { HttpError, UpstreamConnectionError, encodePath, readJson, trimTrailingSlash, upstreamFetch, type FetchLike } from "../http";
import type { Settings } from "../settings";

export interface DeletedDocument {
  id: string;
  deleted: true;
  /** False when the database rows were removed but the stored file could not be (it is logged for cleanup). */
  file_removed: boolean;
}

/**
 * Delete a course document as the signed-in user. The database function checks that the user manages the
 * course and deletes the document row, which cascades to its chunks and ingestion jobs atomically. The stored
 * file is removed afterwards with the user's token, under the storage manager policy.
 */
export async function deleteCourseDocument(opts: {
  settings: Settings;
  user: AuthenticatedUser;
  courseId: string;
  documentId: string;
  fetch?: FetchLike;
}): Promise<DeletedDocument> {
  const { settings, user, courseId, documentId } = opts;
  if (!settings.supabaseUrl || !settings.supabaseAnonKey) throw new HttpError(503, "Document storage is not configured");
  if (!user.accessToken) throw new HttpError(401, "Authentication required");
  const fetchImpl = opts.fetch ?? fetch;
  const baseUrl = trimTrailingSlash(settings.supabaseUrl);
  const headers = { apikey: settings.supabaseAnonKey, Authorization: `Bearer ${user.accessToken}` };

  let response: Response;
  try {
    response = await upstreamFetch(fetchImpl, `${baseUrl}/rest/v1/rpc/delete_course_document`, {
      method: "POST",
      body: JSON.stringify({ target_course_id: courseId, target_document_id: documentId }),
      headers: { ...headers, "Content-Type": "application/json" },
      timeoutMs: 15_000,
    });
  } catch (error) {
    if (error instanceof UpstreamConnectionError) throw new HttpError(503, "Document service is unavailable");
    throw error;
  }
  if (!response.ok) {
    const body = (await readJson(response).catch(() => null)) as { code?: string } | null;
    if (response.status === 401 || response.status === 403) throw new HttpError(403, "Only course managers can delete course materials");
    if (response.status === 404 && body?.code === "PGRST202") {
      throw new HttpError(503, "Document deletion is not set up. Apply supabase/migrations/20261028000100_document_deletion.sql.");
    }
    throw new HttpError(502, "Document deletion failed");
  }
  const storagePath = await readJson(response).catch(() => null);
  if (typeof storagePath !== "string" || !storagePath) throw new HttpError(404, "Course material not found");

  return { id: documentId, deleted: true, file_removed: await removeStoredFile({ fetchImpl, baseUrl, headers, settings, storagePath, documentId }) };
}

async function removeStoredFile(opts: {
  fetchImpl: FetchLike;
  baseUrl: string;
  headers: Record<string, string>;
  settings: Settings;
  storagePath: string;
  documentId: string;
}): Promise<boolean> {
  const url = `${opts.baseUrl}/storage/v1/object/${encodePath(opts.settings.supabaseStorageBucket)}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await upstreamFetch(opts.fetchImpl, url, {
        method: "DELETE",
        body: JSON.stringify({ prefixes: [opts.storagePath] }),
        headers: { ...opts.headers, "Content-Type": "application/json" },
      });
      if (response.ok) return true;
      console.error("document_storage_cleanup_failed", { document_id: opts.documentId, status_code: response.status, attempt });
    } catch {
      console.error("document_storage_cleanup_failed", { document_id: opts.documentId, attempt });
    }
  }
  return false;
}
