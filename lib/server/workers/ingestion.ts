import { createHash } from "node:crypto";
import { z } from "zod";
import { EMBEDDING_BATCH_SIZE, OpenAICompatibleEmbeddingProvider } from "../ai/embeddings";
import {
  DocumentProcessingError,
  chunkPages,
  extractDocument,
  validateEmbeddings,
  type EmbeddingProvider,
} from "../documents/ingestion";
import { encodePath, trimTrailingSlash, upstreamFetch, type FetchLike } from "../http";
import type { Settings } from "../settings";

const ingestionJobSchema = z.object({
  job_id: z.string(),
  lease_token: z.string(),
  document_id: z.string(),
  attempt_count: z.number().int(),
  max_attempts: z.number().int(),
  title: z.string(),
  file_name: z.string(),
  mime_type: z.string(),
  storage_path: z.string(),
  size_bytes: z.number().int(),
  sha256: z.string(),
});
export type IngestionJob = z.infer<typeof ingestionJobSchema>;

export interface ChunkPayload {
  chunk_index: number;
  content: string;
  embedding: number[];
  embedding_model: string;
  page_start: number | null;
  page_end: number | null;
}

export interface IngestionGateway {
  download(job: IngestionJob): Promise<Uint8Array>;
  renew(job: IngestionJob): Promise<boolean>;
  complete(job: IngestionJob, chunks: ChunkPayload[]): Promise<void>;
  fail(job: IngestionJob, errorCode: string): Promise<void>;
}

/** Service-role access to the Supabase ingestion queue RPCs and private storage. */
export class SupabaseIngestionGateway implements IngestionGateway {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(
    private readonly settings: Settings,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (!settings.supabaseUrl || !settings.supabaseServiceRoleKey) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    }
    this.baseUrl = trimTrailingSlash(settings.supabaseUrl);
    this.headers = {
      apikey: settings.supabaseServiceRoleKey,
      Authorization: `Bearer ${settings.supabaseServiceRoleKey}`,
    };
  }

  private async rpc(name: string, body: unknown): Promise<Response> {
    const response = await upstreamFetch(this.fetchImpl, `${this.baseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { ...this.headers, "Content-Type": "application/json" },
      timeoutMs: 90_000,
    });
    if (!response.ok) throw new Error(`${name} failed with status ${response.status}`);
    return response;
  }

  async claim(): Promise<IngestionJob | null> {
    const result = (await (await this.rpc("claim_document_ingestion_job", {})).json()) as unknown;
    if (!result || (Array.isArray(result) && result.length === 0)) return null;
    const parsed = ingestionJobSchema.safeParse(Array.isArray(result) ? result[0] : undefined);
    if (!parsed.success) throw new Error("Claim function returned an invalid job");
    return parsed.data;
  }

  async download(job: IngestionJob): Promise<Uint8Array> {
    const bucket = encodePath(this.settings.supabaseStorageBucket);
    const path = encodePath(job.storage_path, true);
    const response = await upstreamFetch(this.fetchImpl, `${this.baseUrl}/storage/v1/object/${bucket}/${path}`, {
      headers: this.headers,
      timeoutMs: 90_000,
    });
    if (!response.ok) throw new Error(`Storage download failed with status ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async complete(job: IngestionJob, chunks: ChunkPayload[]): Promise<void> {
    await this.rpc("complete_document_ingestion", {
      target_job_id: job.job_id,
      target_lease_token: job.lease_token,
      chunk_payloads: chunks,
    });
  }

  async fail(job: IngestionJob, errorCode: string): Promise<void> {
    await this.rpc("fail_document_ingestion", {
      target_job_id: job.job_id,
      target_lease_token: job.lease_token,
      error_message: errorCode,
    });
  }

  async renew(job: IngestionJob): Promise<boolean> {
    const response = await this.rpc("renew_document_ingestion_job", {
      target_job_id: job.job_id,
      target_lease_token: job.lease_token,
    });
    return (await response.json()) === true;
  }
}

/** Process one claimed job. Returns true on success; failures are recorded on the job for retry. */
export async function processJob(job: IngestionJob, gateway: IngestionGateway, embeddings: EmbeddingProvider): Promise<boolean> {
  try {
    const data = await gateway.download(job);
    if (data.length !== job.size_bytes || createHash("sha256").update(data).digest("hex") !== job.sha256) {
      throw new DocumentProcessingError("stored_file_integrity_check_failed");
    }
    if (!(await gateway.renew(job))) throw new DocumentProcessingError("worker_lease_lost");
    const pages = await extractDocument(job.file_name, job.mime_type, data);
    const textChunks = chunkPages(pages);
    if (!(await gateway.renew(job))) throw new DocumentProcessingError("worker_lease_lost");

    const vectors: number[][] = [];
    for (let offset = 0; offset < textChunks.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = textChunks.slice(offset, offset + EMBEDDING_BATCH_SIZE).map((chunk) => chunk.content);
      vectors.push(...(await embeddings.embed(batch)));
      if (!(await gateway.renew(job))) throw new DocumentProcessingError("worker_lease_lost");
    }
    validateEmbeddings(vectors, textChunks.length);

    await gateway.complete(
      job,
      textChunks.map((chunk, index) => ({
        chunk_index: chunk.chunk_index,
        content: chunk.content,
        embedding: vectors[index],
        embedding_model: embeddings.model,
        page_start: chunk.page_start,
        page_end: chunk.page_end,
      })),
    );
    console.info("document_ingestion_completed", { job_id: job.job_id });
    return true;
  } catch (error) {
    const errorCode = error instanceof DocumentProcessingError ? error.code : "document_ingestion_failed";
    console.error("document_ingestion_attempt_failed", {
      job_id: job.job_id,
      error_code: errorCode,
      error_type: error instanceof Error ? error.name : typeof error,
    });
    try {
      await gateway.fail(job, errorCode);
    } catch {
      console.error("document_ingestion_failure_update_failed", { job_id: job.job_id });
    }
    return false;
  }
}

export type RunOnceResult = "processed" | "failed" | "idle";

export function ingestionConfigured(settings: Settings): boolean {
  return Boolean(
    settings.supabaseUrl && settings.supabaseServiceRoleKey && settings.aiEmbeddingEndpoint && settings.aiEmbeddingModel,
  );
}

/** Claim at most one job and process it. */
export async function runOnce(settings: Settings, fetchImpl: FetchLike = fetch): Promise<RunOnceResult> {
  if (!settings.aiEmbeddingEndpoint || !settings.aiEmbeddingModel) {
    throw new Error("Configure AI_EMBEDDING_ENDPOINT and AI_EMBEDDING_MODEL before starting the worker");
  }
  const gateway = new SupabaseIngestionGateway(settings, fetchImpl);
  const embeddings = new OpenAICompatibleEmbeddingProvider(settings, fetchImpl);
  const job = await gateway.claim();
  if (!job) return "idle";
  return (await processJob(job, gateway, embeddings)) ? "processed" : "failed";
}

/** Drain ready jobs until the queue is empty or the limit is reached. */
export async function drainQueue(settings: Settings, maxJobs = 25, fetchImpl: FetchLike = fetch): Promise<number> {
  let handled = 0;
  while (handled < maxJobs) {
    if ((await runOnce(settings, fetchImpl)) === "idle") break;
    handled++;
  }
  return handled;
}

export async function runForever(
  settings: Settings,
  options: { pollMs?: number; signal?: AbortSignal; fetch?: FetchLike } = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 2_000;
  while (!options.signal?.aborted) {
    try {
      await runOnce(settings, options.fetch);
    } catch (error) {
      console.error("document_ingestion_worker_iteration_failed", error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
