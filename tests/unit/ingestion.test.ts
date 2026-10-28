import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { OpenAICompatibleEmbeddingProvider, ProviderConfigurationError, vectorLiteral } from "../../lib/server/ai/embeddings";
import {

  chunkPages,
  extractDocument,
  validateEmbeddings,
  type EmbeddingProvider,
} from "../../lib/server/documents/ingestion";
import { makeSettings } from "../../lib/server/settings";
import {
  SupabaseIngestionGateway,
  processJob,
  runOnce,
  type ChunkPayload,
  type IngestionGateway,
  type IngestionJob,
} from "../../lib/server/workers/ingestion";
import { makeDocx, makePdf } from "../helpers/fixtures";
import { fakeFetch, json } from "../helpers/fake-fetch";

const TEXT_DATA = new TextEncoder().encode("NEXIS campus notes. ".repeat(160));
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function makeJob(data: Uint8Array = TEXT_DATA, overrides: Partial<IngestionJob> = {}): IngestionJob {
  return {
    job_id: randomUUID(),
    lease_token: randomUUID(),
    document_id: randomUUID(),
    attempt_count: 1,
    max_attempts: 5,
    title: "Course notes",
    file_name: "notes.txt",
    mime_type: "text/plain",
    storage_path: "course-id/document-id/notes.txt",
    size_bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    ...overrides,
  };
}

class FakeGateway implements IngestionGateway {
  completed: ChunkPayload[] | null = null;
  failure: string | null = null;
  renewals = 0;
  constructor(
    private readonly data: Uint8Array,
    private readonly renewResults: boolean[] = [],
  ) {}
  async download() {
    return this.data;
  }
  async renew() {
    return this.renewResults[this.renewals++] ?? true;
  }
  async complete(_job: IngestionJob, chunks: ChunkPayload[]) {
    this.completed = chunks;
  }
  async fail(_job: IngestionJob, errorCode: string) {
    this.failure = errorCode;
  }
}

class FakeEmbeddings implements EmbeddingProvider {
  readonly model = "test-embedding-model";
  calls = 0;
  async embed(texts: string[]) {
    this.calls++;
    return texts.map(() => [0.25, 0.75]);
  }
}

describe("chunking", () => {
  test("chunks keep page references and overlap", () => {
    const chunks = chunkPages([{ number: 3, text: "campus ".repeat(500) }]);
    assert.ok(chunks.length > 1);
    assert.deepEqual(chunks.map((chunk) => chunk.chunk_index), [...chunks.keys()]);
    assert.ok(chunks.every((chunk) => chunk.page_start === 3 && chunk.page_end === 3));
    assert.ok(chunks.every((chunk) => chunk.content.length <= 1200));
    const first = new Set(chunks[0].content.split(" "));
    assert.ok(chunks[1].content.split(" ").some((word) => first.has(word)));
  });

  test("normalizes whitespace and rejects text-free documents", () => {
    assert.equal(chunkPages([{ number: null, text: "  a\n\n b\t c  " }])[0].content, "a b c");
    assert.throws(() => chunkPages([{ number: 1, text: " \n\t " }]), /document_contains_no_extractable_text/);
  });

  test("never splits astral characters", () => {
    const chunks = chunkPages([{ number: null, text: "😀".repeat(3000) }]);
    for (const chunk of chunks) assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(chunk.content));
  });
});

describe("embedding validation", () => {
  test("rejects vectors with inconsistent dimensions", () => {
    assert.throws(() => validateEmbeddings([[0.1, 0.2], [0.3]], 2), /embedding_vector_invalid/);
  });
  test("rejects count mismatches, zero vectors and non-finite values", () => {
    assert.throws(() => validateEmbeddings([[0.1]], 2), /embedding_response_count_mismatch/);
    assert.throws(() => validateEmbeddings([], 0), /embedding_response_count_mismatch/);
    assert.throws(() => validateEmbeddings([[0, 0]], 1), /embedding_vector_invalid/);
    assert.throws(() => validateEmbeddings([[Number.NaN, 1]], 1), /embedding_vector_invalid/);
    assert.throws(() => validateEmbeddings([[]], 1), /embedding_dimension_invalid/);
    assert.equal(validateEmbeddings([[0.1, 0.2, 0.3]], 1), 3);
  });
  test("formats pgvector literals like Python's .9g", () => {
    assert.equal(vectorLiteral([0.1, 0.2, 1, -0.5, 1 / 3, 1e-7, 123456789012]), "[0.1,0.2,1,-0.5,0.333333333,1e-07,1.23456789e+11]");
  });
});

describe("document extraction", () => {
  test("extracts text files", async () => {
    const pages = await extractDocument("notes.txt", "text/plain", TEXT_DATA);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].number, null);
  });

  test("extracts PDF text per page with page numbers", async () => {
    const pages = await extractDocument("lecture.pdf", "application/pdf", makePdf(["Photosynthesis converts light", "Mitochondria produce ATP"]));
    assert.deepEqual(pages.map((page) => page.number), [1, 2]);
    assert.match(pages[0].text, /Photosynthesis converts light/);
    assert.match(pages[1].text, /Mitochondria produce ATP/);
  });

  test("extracts DOCX paragraphs and table text", async () => {
    const docx = await makeDocx(["Cell biology overview", "Second paragraph"], [["Organelle", "Function"], ["Ribosome", "Protein synthesis"]]);
    const pages = await extractDocument("notes.docx", DOCX_MIME, docx);
    assert.equal(pages[0].number, null);
    for (const phrase of ["Cell biology overview", "Second paragraph", "Ribosome", "Protein synthesis"]) {
      assert.ok(pages[0].text.includes(phrase), phrase);
    }
  });

  test("rejects MIME mismatches, invalid content and corrupt PDFs", async () => {
    await assert.rejects(extractDocument("notes.txt", "application/pdf", TEXT_DATA), /document_type_mismatch/);
    await assert.rejects(extractDocument("notes.pdf", "application/pdf", TEXT_DATA), /document_validation_failed/);
    await assert.rejects(extractDocument("broken.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.7 garbage")), /document_parse_failed/);
    await assert.rejects(extractDocument("empty.txt", "text/plain", new TextEncoder().encode("   ")), /document_contains_no_extractable_text/);
  });
});

describe("ingestion worker", () => {
  test("persists chunks only after the integrity check", async () => {
    const gateway = new FakeGateway(TEXT_DATA);
    assert.equal(await processJob(makeJob(), gateway, new FakeEmbeddings()), true);
    assert.equal(gateway.failure, null);
    assert.ok(gateway.completed && gateway.completed.length > 0);
    assert.equal(gateway.completed[0].embedding_model, "test-embedding-model");
    assert.equal(gateway.completed[0].page_start, null);
    assert.deepEqual(gateway.completed[0].embedding, [0.25, 0.75]);
    assert.ok(gateway.renewals >= 3, "lease renewed after download, chunking and embedding");
  });

  test("records an integrity failure without embedding", async () => {
    const gateway = new FakeGateway(new TextEncoder().encode("different file"));
    const embeddings = new FakeEmbeddings();
    assert.equal(await processJob(makeJob(), gateway, embeddings), false);
    assert.equal(gateway.completed, null);
    assert.equal(gateway.failure, "stored_file_integrity_check_failed");
    assert.equal(embeddings.calls, 0);
  });

  test("stops when the lease is lost", async () => {
    const gateway = new FakeGateway(TEXT_DATA, [true, false]);
    assert.equal(await processJob(makeJob(), gateway, new FakeEmbeddings()), false);
    assert.equal(gateway.failure, "worker_lease_lost");
    assert.equal(gateway.completed, null);
  });

  test("uses a generic error code for unexpected failures", async () => {
    const gateway = new FakeGateway(TEXT_DATA);
    gateway.download = async () => {
      throw new Error("network down");
    };
    assert.equal(await processJob(makeJob(), gateway, new FakeEmbeddings()), false);
    assert.equal(gateway.failure, "document_ingestion_failed");
  });

  test("ingests PDFs with page references", async () => {
    const pdf = makePdf(["Page one text about cells", "Page two text about energy"]);
    const gateway = new FakeGateway(pdf);
    const job = makeJob(pdf, { file_name: "lecture.pdf", mime_type: "application/pdf" });
    assert.equal(await processJob(job, gateway, new FakeEmbeddings()), true);
    assert.deepEqual(gateway.completed!.map((chunk) => chunk.page_start), [1, 2]);
  });
});

describe("embedding provider", () => {
  const settings = makeSettings({
    aiEmbeddingEndpoint: "https://embeddings.example/v1/embeddings",
    aiEmbeddingModel: "campus-model",
    aiApiKey: "test-key",
  });

  test("sends the configured model and parses ordered results", async () => {
    const fetchImpl = fakeFetch((request) => {
      const body = JSON.parse(request.body);
      return json({ data: body.input.map((_: string, index: number) => ({ index, embedding: [index, 1.0] })).reverse() });
    });
    const vectors = await new OpenAICompatibleEmbeddingProvider(settings, fetchImpl).embed(["first", "second"]);
    assert.deepEqual(vectors, [[0, 1], [1, 1]]);
    assert.equal(fetchImpl.requests[0].headers.get("authorization"), "Bearer test-key");
    assert.equal(JSON.parse(fetchImpl.requests[0].body).model, "campus-model");
  });

  test("batches requests at 48 inputs", async () => {
    const fetchImpl = fakeFetch((request) => {
      const body = JSON.parse(request.body);
      return json({ data: body.input.map((_: string, index: number) => ({ index, embedding: [1, index + 1] })) });
    });
    const vectors = await new OpenAICompatibleEmbeddingProvider(settings, fetchImpl).embed(Array.from({ length: 100 }, (_, i) => `t${i}`));
    assert.equal(vectors.length, 100);
    assert.deepEqual(fetchImpl.requests.map((request) => JSON.parse(request.body).input.length), [48, 48, 4]);
  });

  test("maps provider failures to embedding error codes", async () => {
    const provider = (handler: Parameters<typeof fakeFetch>[0]) => new OpenAICompatibleEmbeddingProvider(settings, fakeFetch(handler));
    await assert.rejects(provider(() => json({}, 500)).embed(["a"]), /embedding_provider_failed/);
    await assert.rejects(provider(() => json({ data: [] })).embed(["a"]), /embedding_response_count_mismatch/);
    await assert.rejects(provider(() => json({ data: [{ index: 5, embedding: [1] }] })).embed(["a"]), /embedding_response_count_mismatch/);
    await assert.rejects(provider(() => json({ data: [{ index: 0, embedding: ["x"] }] })).embed(["a"]), /embedding_provider_failed/);
  });

  test("requires HTTPS endpoints without embedded credentials", () => {
    const make = (endpoint: string) => () => new OpenAICompatibleEmbeddingProvider(makeSettings({ aiEmbeddingEndpoint: endpoint, aiEmbeddingModel: "m" }));
    assert.throws(make("http://ai.example/v1"), ProviderConfigurationError);
    assert.throws(make("https://user:pass@ai.example/v1"), ProviderConfigurationError);
    assert.doesNotThrow(make("http://localhost:11434/v1/embeddings"));
    assert.doesNotThrow(make("http://127.0.0.1:8080/embeddings"));
    assert.throws(() => new OpenAICompatibleEmbeddingProvider(makeSettings()), ProviderConfigurationError);
  });
});

describe("Supabase ingestion gateway", () => {
  const settings = makeSettings({ supabaseUrl: "https://campus.example.supabase.co", supabaseServiceRoleKey: "server-secret" });

  test("claim uses the service role and parses the job", async () => {
    const payload = makeJob();
    const fetchImpl = fakeFetch((request) => {
      assert.ok(request.url.pathname.endsWith("/rpc/claim_document_ingestion_job"));
      assert.equal(request.headers.get("authorization"), "Bearer server-secret");
      assert.equal(request.headers.get("apikey"), "server-secret");
      return json([payload]);
    });
    const job = await new SupabaseIngestionGateway(settings, fetchImpl).claim();
    assert.equal(job?.sha256, payload.sha256);
  });

  test("claim returns null when the queue is empty and rejects malformed jobs", async () => {
    assert.equal(await new SupabaseIngestionGateway(settings, fakeFetch(() => json([]))).claim(), null);
    await assert.rejects(new SupabaseIngestionGateway(settings, fakeFetch(() => json([{ job_id: 1 }]))).claim(), /invalid job/);
  });

  test("download, renew, complete and fail call the expected endpoints", async () => {
    const job = makeJob(TEXT_DATA, { storage_path: "c/d/week 1.txt" });
    const fetchImpl = fakeFetch((request) => {
      if (request.url.pathname.startsWith("/storage/")) return new Response(TEXT_DATA);
      if (request.url.pathname.endsWith("renew_document_ingestion_job")) return json(true);
      return new Response(null, { status: 204 });
    });
    const gateway = new SupabaseIngestionGateway(settings, fetchImpl);
    assert.deepEqual(await gateway.download(job), TEXT_DATA);
    assert.equal(await gateway.renew(job), true);
    await gateway.complete(job, []);
    await gateway.fail(job, "document_parse_failed");
    const paths = fetchImpl.requests.map((request) => request.url.pathname);
    assert.deepEqual(paths, [
      "/storage/v1/object/course-documents/c/d/week%201.txt",
      "/rest/v1/rpc/renew_document_ingestion_job",
      "/rest/v1/rpc/complete_document_ingestion",
      "/rest/v1/rpc/fail_document_ingestion",
    ]);
    assert.deepEqual(JSON.parse(fetchImpl.requests[3].body), { target_job_id: job.job_id, target_lease_token: job.lease_token, error_message: "document_parse_failed" });
  });

  test("requires service role configuration", () => {
    assert.throws(() => new SupabaseIngestionGateway(makeSettings({ supabaseUrl: "https://x.supabase.co" })), /SUPABASE_SERVICE_ROLE_KEY/);
  });

  test("runOnce reports idle when there is no work", async () => {
    const full = makeSettings({ ...settings, aiEmbeddingEndpoint: "https://ai.example/embeddings", aiEmbeddingModel: "m" });
    assert.equal(await runOnce(full, fakeFetch(() => json([]))), "idle");
    await assert.rejects(runOnce(settings, fakeFetch(() => json([]))), /AI_EMBEDDING_ENDPOINT/);
  });
});

