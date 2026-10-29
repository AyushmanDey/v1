/**
 * End-to-end tests: the production Next.js build serves both the UI and the /api/v1 backend,
 * talking to mock Supabase and AI services. Run with `npm run test:e2e` (builds first).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";
import { makeDocx, makePdf } from "../helpers/fixtures";
import { AI_API_KEY, ANON_KEY, EMBEDDING_MODEL, MockServices, SERVICE_ROLE_KEY, type MockUser } from "./mock-services";

const mock = new MockServices();
const servers: ChildProcess[] = [];
let inlineUrl = "";
let workerUrl = "";
let alice: MockUser;
let bob: MockUser;
let aliceToken = "";
let bobToken = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function serverEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "production",
    SUPABASE_URL: mock.url,
    SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    SUPABASE_STORAGE_BUCKET: "course-documents",
    AI_API_KEY,
    AI_EMBEDDING_ENDPOINT: `${mock.url}/v1/embeddings`,
    AI_EMBEDDING_MODEL: EMBEDDING_MODEL,
    AI_CHAT_ENDPOINT: `${mock.url}/v1/chat/completions`,
    AI_CHAT_MODEL: "mock-chat-1",
    RAG_MIN_SIMILARITY: "0.2",
    RAG_MAX_CHUNKS: "4",
    // Pin settings a developer's .env.local might change, so the suite is hermetic.
    RAG_RELEVANCE_MARGIN: "1",
    AI_KEEP_ALIVE: "",
    AI_CHAT_REASONING_EFFORT: "",
    ...extra,
  };
}

async function startNext(extraEnv: Record<string, string>): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    env: serverEnv(extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start exited early:\n${output}`);
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return url;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`next start did not become ready:\n${output}`);
}

function runWorkerOnce(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts", "--once"], { env: serverEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => resolve({ code, output }));
  });
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function api(base: string, path: string, init: RequestInit & { token?: string } = {}) {
  const { token, headers, ...rest } = init;
  const response = await fetch(`${base}${path}`, { ...rest, headers: { ...(token ? auth(token) : {}), ...(headers as Record<string, string>) } });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave as text
  }
  return { status: response.status, headers: response.headers, body: body as Record<string, unknown> & unknown[] };
}

async function createCourse(base: string, token: string, name: string, code: string) {
  const response = await api(base, "/api/v1/courses", { method: "POST", token, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, code }) });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body as unknown as { id: string; name: string; code: string; created_at: string };
}

async function upload(base: string, token: string, courseId: string, title: string, fileName: string, data: Uint8Array, type = "application/octet-stream") {
  const form = new FormData();
  form.append("title", title);
  form.append("file", new Blob([Buffer.from(data)], { type }), fileName);
  return api(base, `/api/v1/courses/${courseId}/documents`, { method: "POST", token, body: form });
}

async function ask(base: string, token: string, courseId: string, question: unknown) {
  return api(base, `/api/v1/courses/${courseId}/assistant/ask`, { method: "POST", token, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
}

before(async () => {
  assert.ok(existsSync(".next/BUILD_ID"), "Run `npm run build` before the e2e suite (npm run test:e2e does this).");
  await mock.start();
  alice = mock.addUser("alice@campus.edu");
  bob = mock.addUser("bob@campus.edu");
  aliceToken = await mock.tokenFor(alice);
  bobToken = await mock.tokenFor(bob);
  [inlineUrl, workerUrl] = await Promise.all([startNext({ INGESTION_INLINE: "true" }), startNext({ INGESTION_INLINE: "false" })]);
});

after(async () => {
  for (const server of servers) server.kill("SIGTERM");
  await mock.stop();
});

describe("platform", () => {
  test("health check", async () => {
    const response = await api(inlineUrl, "/api/v1/health");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: "ok" });
  });

  test("the web app is served by the same Next.js process", async () => {
    const response = await fetch(`${inlineUrl}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /NEXIS/);
    assert.match(html, /<title>NEXIS Campus AI<\/title>/);
  });

  test("unsupported methods return 405", async () => {
    assert.equal((await fetch(`${inlineUrl}/api/v1/health`, { method: "POST" })).status, 405);
  });
});

describe("authentication", () => {
  test("/me requires a bearer token", async () => {
    const response = await api(inlineUrl, "/api/v1/me");
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { detail: "Authentication required" });
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
  });

  test("/me rejects forged, expired and non-user tokens", async () => {
    for (const token of ["not-a-jwt", await mock.tokenFor(alice, { expiresIn: "-1m" }), await mock.tokenFor(alice, { role: "anon" }), `${aliceToken.slice(0, -4)}AAAA`]) {
      const response = await api(inlineUrl, "/api/v1/me", { token });
      assert.equal(response.status, 401, token);
      assert.equal(response.body.detail, "Invalid or expired access token");
    }
  });

  test("/me returns the verified identity", async () => {
    const response = await api(inlineUrl, "/api/v1/me", { token: aliceToken });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { id: alice.id, email: alice.email });
  });
});

describe("course workflow", () => {
  let courseId = "";
  let pdfDocumentId = "";

  test("a new user starts with no courses", async () => {
    const response = await api(inlineUrl, "/api/v1/courses", { token: aliceToken });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, []);
  });

  test("course creation trims input, sets the owner and validates fields", async () => {
    const course = await createCourse(inlineUrl, aliceToken, "  Introduction to Biology ", " BIO-101 ");
    courseId = course.id;
    assert.equal(course.name, "Introduction to Biology");
    assert.equal(course.code, "BIO-101");
    assert.equal(mock.courses.find((item) => item.id === courseId)?.owner_id, alice.id);

    for (const body of [{ name: "  ", code: "X" }, { name: "Bio" }, "not json"]) {
      const response = await api(inlineUrl, "/api/v1/courses", { method: "POST", token: aliceToken, headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
      assert.equal(response.status, 422, JSON.stringify(body));
    }
    assert.equal((await api(inlineUrl, "/api/v1/courses", { method: "POST", body: "{}" })).status, 401);
  });

  test("courses are listed by name and scoped to the user", async () => {
    await createCourse(inlineUrl, aliceToken, "Algebra", "MATH-100");
    const listed = await api(inlineUrl, "/api/v1/courses", { token: aliceToken });
    assert.deepEqual((listed.body as unknown as { name: string }[]).map((course) => course.name), ["Algebra", "Introduction to Biology"]);
    const bobs = await api(inlineUrl, "/api/v1/courses", { token: bobToken });
    assert.deepEqual(bobs.body, []);
  });

  test("uploads PDF, DOCX and TXT course materials", async () => {
    const pdf = makePdf([
      "Photosynthesis converts light energy into chemical energy stored as glucose in chloroplasts.",
      "Mitochondria perform cellular respiration and produce ATP for the cell.",
    ]);
    const pdfResponse = await upload(inlineUrl, aliceToken, courseId, "Week 1 Lecture", "C:\\fakepath\\week1.pdf", pdf, "application/pdf");
    assert.equal(pdfResponse.status, 201, JSON.stringify(pdfResponse.body));
    assert.equal(pdfResponse.body.status, "queued");
    assert.equal(pdfResponse.body.file_name, "week1.pdf");
    assert.equal(pdfResponse.body.mime_type, "application/pdf");
    assert.equal(pdfResponse.body.size_bytes, pdf.length);
    assert.ok(!("sha256" in pdfResponse.body));
    pdfDocumentId = String(pdfResponse.body.id);
    const stored = mock.storage.get(`${courseId}/${pdfDocumentId}/week1.pdf`);
    assert.ok(stored, "file stored at course/document/name");
    assert.deepEqual(new Uint8Array(stored.bytes), pdf);

    const docx = await makeDocx(["Ribosomes synthesize proteins by translating messenger RNA."], [["Organelle", "Role"], ["Nucleus", "Stores genetic material"]]);
    const docxResponse = await upload(inlineUrl, aliceToken, courseId, "Organelle notes", "organelles.docx", docx);
    assert.equal(docxResponse.status, 201, JSON.stringify(docxResponse.body));
    assert.equal(docxResponse.body.mime_type, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

    const txt = new TextEncoder().encode("Osmosis is the diffusion of water across a semipermeable membrane.");
    const txtResponse = await upload(inlineUrl, aliceToken, courseId, "Glossary", "glossary.txt", txt);
    assert.equal(txtResponse.status, 201);
  });

  test("uploaded documents are indexed automatically by the Next.js server", async () => {
    await waitFor(() => mock.documents.filter((d) => d.course_id === courseId).every((d) => d.status === "ready") && mock.documents.length >= 3, "inline ingestion");
    const pdfChunks = mock.chunks.filter((chunk) => chunk.document_id === pdfDocumentId);
    assert.deepEqual(pdfChunks.map((chunk) => chunk.page_start), [1, 2]);
    assert.ok(pdfChunks.every((chunk) => chunk.embedding_model === EMBEDDING_MODEL && chunk.embedding.length === 256));
    assert.ok(mock.chunks.some((chunk) => chunk.content.includes("Nucleus") && chunk.page_start === null), "DOCX table text indexed");
  });

  test("the assistant answers with verified, signed citations", async () => {
    const response = await ask(inlineUrl, aliceToken, courseId, "Which organelle produces ATP during cellular respiration?");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const result = response.body as unknown as { answer: string; insufficient_evidence: boolean; citations: { source_id: string; document_id: string; page_start: number | null; title: string; url: string; excerpt: string; similarity: number }[] };
    assert.equal(result.insufficient_evidence, false);
    assert.match(result.answer, /Mitochondria/);
    assert.match(result.answer, /\[S1\]/);
    assert.equal(result.citations.length, 1);
    const [citation] = result.citations;
    assert.equal(citation.source_id, "S1");
    assert.equal(citation.document_id, pdfDocumentId);
    assert.equal(citation.title, "Week 1 Lecture");
    assert.equal(citation.page_start, 2);
    assert.ok(citation.similarity >= 0.2);
    assert.ok(citation.url.startsWith(`${mock.url}/storage/v1/object/sign/course-documents/${courseId}/`), citation.url);

    const source = await fetch(citation.url);
    assert.equal(source.status, 200);
    assert.equal(Buffer.from(await source.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  });

  test("the assistant abstains when retrieval finds no evidence", async () => {
    const response = await ask(inlineUrl, aliceToken, courseId, "Describe quantum chromodynamics gluon confinement");
    assert.equal(response.status, 200);
    assert.equal(response.body.insufficient_evidence, true);
    assert.deepEqual(response.body.citations, []);
    assert.match(String(response.body.answer), /couldn't find enough relevant evidence/);
  });

  test("the assistant abstains when the model reports insufficient evidence", async () => {
    const response = await ask(inlineUrl, aliceToken, courseId, "Unanswerable: what does photosynthesis convert?");
    assert.equal(response.status, 200);
    assert.equal(response.body.insufficient_evidence, true);
  });

  test("ask validates input and access", async () => {
    assert.equal((await ask(inlineUrl, aliceToken, courseId, "   ")).status, 422);
    assert.equal((await ask(inlineUrl, aliceToken, courseId, "x".repeat(1001))).status, 422);
    assert.equal((await ask(inlineUrl, aliceToken, "not-a-uuid", "What is ATP?")).status, 422);
    assert.equal((await api(inlineUrl, `/api/v1/courses/${courseId}/assistant/ask`, { method: "POST", body: "{}" })).status, 401);
    const outsider = await ask(inlineUrl, bobToken, courseId, "What is ATP?");
    assert.equal(outsider.status, 404);
    assert.deepEqual(outsider.body, { detail: "Course not found" });
    assert.equal((await ask(inlineUrl, aliceToken, randomUUID(), "What is ATP?")).status, 404);
  });

  test("members can ask; non-managers cannot upload", async () => {
    mock.memberships.push({ course_id: courseId, user_id: bob.id });
    const response = await ask(inlineUrl, bobToken, courseId, "What does photosynthesis convert light energy into?");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.insufficient_evidence, false);
    const listed = await api(inlineUrl, "/api/v1/courses", { token: bobToken });
    assert.equal((listed.body as unknown[]).length, 1);
    const denied = await upload(inlineUrl, bobToken, courseId, "Sneaky", "notes.txt", new TextEncoder().encode("hello"));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.detail, "You are not authorized to access this course");
  });

  test("upload validation rejects bad files before storage", async () => {
    const before = mock.storage.size;
    const cases: [string, Uint8Array, number][] = [
      ["image.png", new Uint8Array([1, 2, 3]), 415],
      ["fake.pdf", new TextEncoder().encode("not really a pdf"), 415],
      ["fake.docx", new TextEncoder().encode("not a zip"), 415],
      ["latin1.txt", new Uint8Array([0xe9, 0x74, 0xe9]), 415],
      ["empty.txt", new Uint8Array(), 422],
    ];
    for (const [name, data, status] of cases) {
      const response = await upload(inlineUrl, aliceToken, courseId, "Bad", name, data);
      assert.equal(response.status, status, `${name}: ${JSON.stringify(response.body)}`);
    }
    assert.equal((await upload(inlineUrl, aliceToken, courseId, "   ", "ok.txt", new TextEncoder().encode("ok"))).status, 422);
    assert.equal((await upload(inlineUrl, aliceToken, "nope", "Bad", "ok.txt", new TextEncoder().encode("ok"))).status, 422);
    const missingFile = new FormData();
    missingFile.append("title", "No file");
    assert.equal((await api(inlineUrl, `/api/v1/courses/${courseId}/documents`, { method: "POST", token: aliceToken, body: missingFile })).status, 422);
    assert.equal(mock.storage.size, before);
  });

  test("large uploads arrive intact and oversized uploads are rejected", async () => {
    const large = new TextEncoder().encode("Cells divide by mitosis. ".repeat(Math.ceil((20 * 1024 * 1024) / 25)));
    const response = await upload(inlineUrl, aliceToken, courseId, "Large notes", "large.txt", large);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const stored = mock.storage.get(`${courseId}/${response.body.id}/large.txt`)!;
    assert.equal(stored.bytes.length, large.length, "body was not truncated by the proxy");
    assert.equal(createHash("sha256").update(stored.bytes).digest("hex"), mock.documents.find((d) => d.id === response.body.id)!.sha256);

    const oversized = new Uint8Array(25 * 1024 * 1024 + 1).fill(0x61);
    const rejected = await upload(inlineUrl, aliceToken, courseId, "Too big", "huge.txt", oversized);
    assert.equal(rejected.status, 413);
  });

});

type ListedDocument = { id: string; title: string; status: string; retrying: boolean; attempts: number | null; max_attempts: number | null; error: string | null };

async function listDocuments(base: string, token: string, courseId: string) {
  const response = await api(base, `/api/v1/courses/${courseId}/documents`, { token });
  return { status: response.status, documents: response.body as unknown as ListedDocument[] };
}

/** Poll the list endpoint the way the UI does until the predicate holds. */
async function pollDocuments(base: string, token: string, courseId: string, done: (documents: ListedDocument[]) => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status, documents } = await listDocuments(base, token, courseId);
    assert.equal(status, 200);
    if (done(documents)) return documents;
    if (Date.now() > deadline) assert.fail(`Timed out; last list: ${JSON.stringify(documents.map((d) => [d.title, d.status, d.error]))}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe("course materials and indexing status", () => {
  let courseId = "";
  const notes = (text: string) => new TextEncoder().encode(text);

  test("a new course lists no materials", async () => {
    courseId = (await createCourse(inlineUrl, aliceToken, "Computer Science Fundamentals", "CS-101")).id;
    const { status, documents } = await listDocuments(inlineUrl, aliceToken, courseId);
    assert.equal(status, 200);
    assert.deepEqual(documents, []);
  });

  test("several materials each index independently and are listed newest first", async () => {
    const files: [string, string, string][] = [
      ["Sorting", "sorting.txt", "Merge sort divides the array in halves and merges sorted halves in O(n log n) time."],
      ["Networking", "networking.txt", "TCP guarantees ordered reliable delivery using sequence numbers and acknowledgements."],
      ["Memory", "memory.txt", "Virtual memory maps pages to physical frames and the TLB caches recent translations."],
    ];
    for (const [title, name, text] of files) {
      const response = await upload(inlineUrl, aliceToken, courseId, title, name, notes(text));
      assert.equal(response.status, 201, JSON.stringify(response.body));
    }
    const documents = await pollDocuments(inlineUrl, aliceToken, courseId, (list) => list.length === 3 && list.every((d) => d.status === "ready"));
    assert.deepEqual(documents.map((d) => d.title), ["Memory", "Networking", "Sorting"]);
    assert.ok(documents.every((d) => d.error === null && d.retrying === false && d.attempts === 1));
  });

  test("questions are answered from whichever material matches", async () => {
    for (const [question, title] of [["How does TCP guarantee ordered delivery?", "Networking"], ["What does the TLB cache in virtual memory?", "Memory"]]) {
      const response = await ask(inlineUrl, aliceToken, courseId, question);
      assert.equal(response.status, 200);
      const citations = response.body.citations as unknown as { title: string }[];
      assert.equal(citations[0].title, title, question);
    }
  });

  test("uploading the same file twice is rejected; a failed copy can be replaced", async () => {
    const duplicate = await upload(inlineUrl, aliceToken, courseId, "Sorting again", "copy.txt", notes("Merge sort divides the array in halves and merges sorted halves in O(n log n) time."));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.detail, "This file is already in the course as “Sorting”.");
  });

  test("a temporary AI outage is retried automatically and the document becomes ready", async () => {
    mock.failEmbeddings = 2;
    const response = await upload(inlineUrl, aliceToken, courseId, "Recursion", "recursion.txt", notes("Recursion calls a function on smaller inputs until a base case returns."));
    assert.equal(response.status, 201);
    const sawRetry: ListedDocument[] = [];
    const documents = await pollDocuments(inlineUrl, aliceToken, courseId, (list) => {
      const document = list.find((d) => d.id === response.body.id)!;
      if (document.retrying) sawRetry.push(document);
      return document.status === "ready";
    });
    const document = documents.find((d) => d.id === response.body.id)!;
    assert.ok(sawRetry.length > 0, "the list reported the retry while it waited");
    assert.equal(sawRetry[0].error, "The AI indexing service was unavailable.");
    assert.equal(document.attempts, 3);
    assert.equal(document.error, null);
  });

  test("a corrupt document fails after the retry limit with a plain-English reason", async () => {
    const response = await upload(inlineUrl, aliceToken, courseId, "Corrupt", "corrupt.pdf", notes("%PDF-1.7 this is not a real pdf"));
    assert.equal(response.status, 201);
    const documents = await pollDocuments(inlineUrl, aliceToken, courseId, (list) => list.find((d) => d.id === response.body.id)!.status === "failed");
    const document = documents.find((d) => d.id === response.body.id)!;
    assert.equal(document.attempts, 5);
    assert.equal(document.error, "The file couldn't be read. Check that it isn't corrupted or password-protected.");
    assert.equal(mock.jobs.find((job) => job.document_id === response.body.id)!.last_error, "document_parse_failed");
  });

  test("members see statuses without job internals; outsiders get 404", async () => {
    mock.memberships.push({ course_id: courseId, user_id: bob.id });
    const { status, documents } = await listDocuments(inlineUrl, bobToken, courseId);
    assert.equal(status, 200);
    assert.ok(documents.length >= 5);
    assert.ok(documents.every((d) => d.attempts === null));
    const carol = mock.addUser("carol@campus.edu");
    assert.equal((await listDocuments(inlineUrl, await mock.tokenFor(carol), courseId)).status, 404);
    assert.equal((await api(inlineUrl, `/api/v1/courses/${courseId}/documents`)).status, 401);
    assert.equal((await listDocuments(inlineUrl, aliceToken, "not-a-uuid")).status, 422);
  });
});

describe("deleting course materials", () => {
  let courseId = "";
  let otherCourseId = "";
  let hashDocumentId = "";
  let linkedDocumentId = "";
  let oldCitationUrl = "";
  const HASH_TEXT = "Hash tables map keys to buckets with a hash function and resolve collisions by chaining or open addressing.";
  const LINKED_TEXT = "Linked lists store nodes that point to the next node, so insertion at the head takes constant time.";
  const remove = (token: string, course: string, document: string) => api(inlineUrl, `/api/v1/courses/${course}/documents/${document}`, { method: "DELETE", token });
  const traces = (documentId: string) => ({
    documents: mock.documents.filter((d) => d.id === documentId).length,
    chunks: mock.chunks.filter((c) => c.document_id === documentId).length,
    jobs: mock.jobs.filter((j) => j.document_id === documentId).length,
    files: [...mock.storage.keys()].filter((key) => key.includes(documentId)).length,
  });
  const NONE = { documents: 0, chunks: 0, jobs: 0, files: 0 };

  test("setup: two indexed materials, and an answer citing one of them", async () => {
    courseId = (await createCourse(inlineUrl, aliceToken, "Data Structures", "CS-201")).id;
    otherCourseId = (await createCourse(inlineUrl, aliceToken, "Discrete Math", "MATH-210")).id;
    hashDocumentId = String((await upload(inlineUrl, aliceToken, courseId, "Hash tables", "hash.txt", new TextEncoder().encode(HASH_TEXT))).body.id);
    linkedDocumentId = String((await upload(inlineUrl, aliceToken, courseId, "Linked lists", "linked.txt", new TextEncoder().encode(LINKED_TEXT))).body.id);
    const documents = await pollDocuments(inlineUrl, aliceToken, courseId, (list) => list.length === 2 && list.every((d) => d.status === "ready"));
    assert.ok(documents.every((d) => (d as unknown as { can_delete: boolean }).can_delete), "the owner may delete");
    assert.ok(traces(hashDocumentId).chunks > 0);

    const answer = await ask(inlineUrl, aliceToken, courseId, "How do hash tables resolve collisions between keys?");
    const citations = answer.body.citations as unknown as { document_id: string; url: string }[];
    assert.equal(citations[0].document_id, hashDocumentId);
    oldCitationUrl = citations[0].url;
    assert.equal((await fetch(oldCitationUrl)).status, 200);
  });

  test("only people who manage the course can delete", async () => {
    mock.memberships.push({ course_id: courseId, user_id: bob.id });
    const member = await listDocuments(inlineUrl, bobToken, courseId);
    assert.ok(member.documents.every((d) => !(d as unknown as { can_delete: boolean }).can_delete), "members are not offered delete");
    const denied = await remove(bobToken, courseId, hashDocumentId);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.detail, "Only course managers can delete course materials");
    const dave = mock.addUser("dave@campus.edu");
    assert.equal((await remove(await mock.tokenFor(dave), courseId, hashDocumentId)).status, 404, "outsiders learn nothing");
    assert.equal((await remove(aliceToken, otherCourseId, hashDocumentId)).status, 404, "the document must belong to the course in the URL");
    assert.equal((await remove(aliceToken, courseId, "not-a-uuid")).status, 422);
    assert.equal((await api(inlineUrl, `/api/v1/courses/${courseId}/documents/${hashDocumentId}`, { method: "DELETE" })).status, 401);
    assert.deepEqual(traces(hashDocumentId), { documents: 1, chunks: traces(hashDocumentId).chunks, jobs: 1, files: 1 }, "nothing was removed by the refused attempts");
  });

  test("the owner deletes a material and every trace of it is gone", async () => {
    const response = await remove(aliceToken, courseId, hashDocumentId);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, { id: hashDocumentId, deleted: true, file_removed: true });

    assert.deepEqual(traces(hashDocumentId), NONE, "document row, chunks/embeddings, jobs and stored file are all removed");
    const { documents } = await listDocuments(inlineUrl, aliceToken, courseId);
    assert.deepEqual(documents.map((d) => d.id), [linkedDocumentId]);
    assert.notEqual((await fetch(oldCitationUrl)).status, 200, "a citation link issued before the delete no longer serves the file");
  });

  test("answers no longer use the deleted material", async () => {
    for (const token of [aliceToken, bobToken]) {
      const response = await ask(inlineUrl, token, courseId, "How do hash tables resolve collisions between keys?");
      assert.equal(response.status, 200);
      const citations = response.body.citations as unknown as { document_id: string; excerpt: string }[];
      assert.ok(citations.every((citation) => citation.document_id !== hashDocumentId));
      assert.ok(!JSON.stringify(response.body).includes("open addressing"), "no text from the deleted file appears");
    }
    const linked = await ask(inlineUrl, aliceToken, courseId, "How long does insertion at the head of a linked list take?");
    assert.equal((linked.body.citations as unknown as { document_id: string }[])[0].document_id, linkedDocumentId, "the remaining material still works");
  });

  test("deleting again is 404, and the same file can be uploaded again", async () => {
    assert.equal((await remove(aliceToken, courseId, hashDocumentId)).status, 404);
    const again = await upload(inlineUrl, aliceToken, courseId, "Hash tables (v2)", "hash.txt", new TextEncoder().encode(HASH_TEXT));
    assert.equal(again.status, 201, "the duplicate check no longer sees the deleted copy");
    await pollDocuments(inlineUrl, aliceToken, courseId, (list) => list.find((d) => d.id === again.body.id)?.status === "ready");
  });

  test("deleting a material while it is being indexed leaves nothing behind", async () => {
    let release!: () => void;
    mock.embeddingGate = new Promise((resolve) => (release = resolve));
    try {
      const response = await upload(inlineUrl, aliceToken, courseId, "Trees", "trees.txt", new TextEncoder().encode("Binary search trees keep keys ordered for logarithmic lookups."));
      const documentId = String(response.body.id);
      await waitFor(() => mock.documentStatus(documentId) === "processing", "indexing to start");
      // However the in-flight job notices (its lease renewal or its final save is refused), it ends by
      // reporting a failure for a job that no longer exists.
      const failures = () => mock.requestLog.filter((r) => r.path.endsWith("/fail_document_ingestion")).length;
      const failuresBefore = failures();
      const deleted = await remove(aliceToken, courseId, documentId);
      assert.equal(deleted.status, 200);
      release();
      await waitFor(() => failures() > failuresBefore, "the in-flight indexer to stop");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(traces(documentId), NONE);
    } finally {
      mock.embeddingGate = null;
      release?.();
    }
  });
});

describe("standalone ingestion worker", () => {
  test("npm run worker processes queued jobs when inline ingestion is disabled", async () => {
    const course = await createCourse(workerUrl, aliceToken, "Chemistry", "CHEM-110");
    const response = await upload(workerUrl, aliceToken, course.id, "Bonds", "bonds.txt", new TextEncoder().encode("Covalent bonds share electron pairs between atoms."));
    assert.equal(response.status, 201);
    const documentId = String(response.body.id);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(mock.documentStatus(documentId), "queued", "no inline processing");

    const run = await runWorkerOnce();
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /result=processed/);
    assert.equal(mock.documentStatus(documentId), "ready");

    const answer = await ask(workerUrl, aliceToken, course.id, "What do covalent bonds share between atoms?");
    assert.equal(answer.status, 200);
    assert.equal(answer.body.insufficient_evidence, false);

    const idle = await runWorkerOnce();
    assert.match(idle.output, /result=idle/);
  });
});
