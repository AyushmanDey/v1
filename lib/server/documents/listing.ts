import { z } from "zod";
import type { AuthenticatedUser } from "../auth";
import { HttpError, UpstreamConnectionError, isUuid, readJson, trimTrailingSlash, upstreamFetch, type FetchLike } from "../http";
import type { Settings } from "../settings";

export type DocumentStatus = "queued" | "processing" | "ready" | "failed";

export interface DocumentSummary {
  id: string;
  title: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  status: DocumentStatus;
  created_at: string;
  updated_at: string;
  /** True while a failed attempt is waiting to be retried. */
  retrying: boolean;
  /** Attempts used so far; null when the caller cannot see ingestion jobs (non-managers). */
  attempts: number | null;
  max_attempts: number | null;
  /** A user-facing explanation of the latest failure, or null. */
  error: string | null;
  /** Whether the caller manages the course and may delete this document. */
  can_delete: boolean;
}

/** User-facing explanations for the worker's safe error codes. */
const ERROR_MESSAGES: Record<string, string> = {
  document_parse_failed: "The file couldn't be read. Check that it isn't corrupted or password-protected.",
  document_contains_no_extractable_text: "No text was found. Scanned PDFs (images of pages) aren't supported yet.",
  document_text_limit_exceeded: "The document has more than 4 million characters of text. Split it into smaller files.",
  document_chunk_limit_exceeded: "The document is too long to index. Split it into smaller files.",
  pdf_page_limit_exceeded: "PDFs are limited to 2,000 pages. Split it into smaller files.",
  document_validation_failed: "The stored file failed validation. Upload it again.",
  document_type_mismatch: "The file's content doesn't match its type. Upload it again.",
  stored_file_integrity_check_failed: "The stored file didn't match the upload. Upload it again.",
  embedding_provider_failed: "The AI indexing service was unavailable.",
  embedding_response_count_mismatch: "The AI indexing service returned an unexpected response.",
  embedding_dimension_invalid: "The AI indexing service returned an unexpected response.",
  embedding_vector_invalid: "The AI indexing service returned an unexpected response.",
  worker_lease_lost: "Indexing was interrupted.",
};

export function describeIngestionError(code: string | null | undefined): string | null {
  if (!code) return null;
  return ERROR_MESSAGES[code] ?? "Indexing failed unexpectedly.";
}

const jobSchema = z.object({
  status: z.string(),
  attempt_count: z.number().int(),
  max_attempts: z.number().int(),
  last_error: z.string().nullable(),
  created_at: z.string(),
});

const rowSchema = z.object({
  id: z.string().refine(isUuid),
  title: z.string(),
  file_name: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
  status: z.enum(["queued", "processing", "ready", "failed"]),
  created_at: z.string(),
  updated_at: z.string(),
  document_ingestion_jobs: z.array(jobSchema).optional().default([]),
});

function raise(response: Response): never {
  if (response.status === 401 || response.status === 403) throw new HttpError(403, "You do not have access to this course");
  throw new HttpError(502, "Course documents could not be loaded");
}

export function summarize(row: z.infer<typeof rowSchema>): DocumentSummary {
  const job = [...row.document_ingestion_jobs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const showError = row.status === "failed" || (row.status === "queued" && Boolean(job?.last_error));
  return {
    id: row.id,
    title: row.title,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    retrying: row.status === "queued" && Boolean(job?.last_error),
    attempts: job ? job.attempt_count : null,
    max_attempts: job ? job.max_attempts : null,
    error: showError ? describeIngestionError(job?.last_error) ?? (row.status === "failed" ? "Indexing failed." : null) : null,
    // Every document gets an ingestion job when it is inserted, and RLS shows job rows only to course
    // managers, so visible jobs mean the caller manages the course. Deletion is still enforced by the database.
    can_delete: row.document_ingestion_jobs.length > 0,
  };
}

/** List a course's documents, newest first, with indexing status. Members see status; managers also see attempts. */
export async function listCourseDocuments(opts: {
  settings: Settings;
  user: AuthenticatedUser;
  courseId: string;
  fetch?: FetchLike;
}): Promise<DocumentSummary[]> {
  const { settings, user, courseId } = opts;
  if (!settings.supabaseUrl || !settings.supabaseAnonKey) throw new HttpError(503, "Document storage is not configured");
  if (!user.accessToken) throw new HttpError(401, "Authentication required");
  const baseUrl = trimTrailingSlash(settings.supabaseUrl);
  const headers = { apikey: settings.supabaseAnonKey, Authorization: `Bearer ${user.accessToken}` };
  const fetchImpl = opts.fetch ?? fetch;

  try {
    const access = await upstreamFetch(fetchImpl, `${baseUrl}/rest/v1/rpc/current_user_can_access_course`, {
      method: "POST",
      body: JSON.stringify({ target_course_id: courseId }),
      headers: { ...headers, "Content-Type": "application/json" },
      timeoutMs: 15_000,
    });
    if (!access.ok) raise(access);
    if ((await readJson(access).catch(() => null)) !== true) throw new HttpError(404, "Course not found");

    const params = new URLSearchParams({
      course_id: `eq.${courseId}`,
      select:
        "id,title,file_name,mime_type,size_bytes,status,created_at,updated_at," +
        "document_ingestion_jobs(status,attempt_count,max_attempts,last_error,created_at)",
      order: "created_at.desc",
    });
    const response = await upstreamFetch(fetchImpl, `${baseUrl}/rest/v1/course_documents?${params}`, { headers, timeoutMs: 15_000 });
    if (!response.ok) raise(response);
    const rows = await readJson(response);
    if (!Array.isArray(rows)) throw new Error("Document query did not return a list");
    return rows.map((row) => summarize(rowSchema.parse(row)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof UpstreamConnectionError) throw new HttpError(503, "Document service is unavailable");
    throw new HttpError(502, "Course documents could not be loaded");
  }
}
