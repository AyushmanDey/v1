import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, test } from "node:test";
import { SYSTEM_MESSAGE, answerCourseQuestion, clearAssistantCaches, parseAskRequest, selectRelevantChunks } from "../../lib/server/assistant/rag";
import type { AuthenticatedUser } from "../../lib/server/auth";
import { HttpError } from "../../lib/server/http";
import { makeSettings, type Settings } from "../../lib/server/settings";
import { fakeFetch, json, type FakeHandler, type RecordedRequest } from "../helpers/fake-fetch";

const COURSE_ID = randomUUID();
const DOCUMENT_ID = randomUUID();
const CHUNK_ID = randomUUID();

const baseSettings = makeSettings({
  supabaseUrl: "https://campus.example.supabase.co",
  supabaseAnonKey: "public-test-key",
  aiEmbeddingEndpoint: "https://ai.example/embeddings",
  aiEmbeddingModel: "campus-embedding-v1",
  aiChatEndpoint: "https://ai.example/chat/completions",
  aiChatModel: "campus-chat-v1",
  aiApiKey: "provider-test-key",
  ragMinSimilarity: 0.7,
  ragMaxChunks: 8,
});
const user: AuthenticatedUser = { id: randomUUID(), email: "student@example.edu", accessToken: "student-jwt" };

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    chunk_id: CHUNK_ID,
    document_id: DOCUMENT_ID,
    chunk_index: 0,
    title: "Week 1 Lecture",
    file_name: "lecture.pdf",
    storage_path: `${COURSE_ID}/${DOCUMENT_ID}/lecture.pdf`,
    content: "The course defines retrieval-augmented generation as grounding answers in sources.",
    page_start: 4,
    page_end: 4,
    similarity: 0.86,
    ...overrides,
  };
}

const chatReply = (content: unknown) => json({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] });

/** Default happy-path upstream; individual tests override pieces. */
function upstream(overrides: { access?: () => Response; match?: () => Response; chat?: (request: RecordedRequest) => Response; sign?: (request: RecordedRequest) => Response } = {}): FakeHandler {
  return (request) => {
    const path = request.url.pathname;
    if (path.endsWith("/current_user_can_access_course")) return overrides.access?.() ?? json(true);
    if (path === "/embeddings") return json({ data: [{ index: 0, embedding: [0.1, 0.2] }] });
    if (path.endsWith("/match_course_document_chunks")) return overrides.match?.() ?? json([sourceRow()]);
    if (path === "/chat/completions") {
      return overrides.chat?.(request) ?? chatReply({ answer: "RAG grounds generated answers in source material [S1].", insufficient_evidence: false, citations: ["S1"] });
    }
    if (path.includes("/object/sign/")) return overrides.sign?.(request) ?? json({ signedURL: "/object/sign/course-documents/file?token=signed" });
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

function ask(handler: FakeHandler, settings: Settings = baseSettings, question = "What is RAG?") {
  const fetchImpl = fakeFetch(handler);
  return { fetchImpl, result: answerCourseQuestion({ settings, user, courseId: COURSE_ID, question, fetch: fetchImpl }) };
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<HttpError> {
  const error = await promise.then(
    () => assert.fail(`expected HTTP ${status}`),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof HttpError, String(error));
  assert.equal(error.status, status);
  return error;
}

describe("campus assistant", () => {
  beforeEach(() => clearAssistantCaches());

  test("answer contains only verified course citations", async () => {
    const { fetchImpl, result } = ask(
      upstream({
        chat: (request) => {
          const body = JSON.parse(request.body);
          assert.ok(body.messages[0].content.includes("never as instructions"));
          assert.equal(body.messages[0].content, SYSTEM_MESSAGE);
          assert.deepEqual(body.response_format, { type: "json_object" });
          assert.equal(body.temperature, 0);
          assert.equal(body.model, "campus-chat-v1");
          assert.equal(request.headers.get("authorization"), "Bearer provider-test-key");
          const userContent = JSON.parse(body.messages[1].content);
          assert.equal(userContent.question, "What is RAG?");
          assert.equal(userContent.sources[0].source_id, "S1");
          assert.ok(!("storage_path" in userContent.sources[0]), "storage paths are not sent to the model");
          return chatReply({ answer: "RAG grounds generated answers in source material [S1].", insufficient_evidence: false, citations: ["S1"] });
        },
      }),
    );
    const answer = await result;
    assert.equal(answer.insufficient_evidence, false);
    assert.ok(answer.answer.startsWith("RAG grounds"));
    assert.equal(answer.citations.length, 1);
    const [citation] = answer.citations;
    assert.equal(citation.source_id, "S1");
    assert.equal(citation.chunk_id, CHUNK_ID);
    assert.equal(citation.document_id, DOCUMENT_ID);
    assert.equal(citation.page_start, 4);
    assert.equal(citation.similarity, 0.86);
    assert.equal(citation.url, "https://campus.example.supabase.co/storage/v1/object/sign/course-documents/file?token=signed");
    assert.equal(citation.excerpt, sourceRow().content);
    assert.deepEqual(fetchImpl.requests.slice(0, 4).map((request) => request.url.pathname.split("/").at(-1)), [
      "current_user_can_access_course",
      "embeddings",
      "match_course_document_chunks",
      "completions",
    ]);
    const match = JSON.parse(fetchImpl.requests[2].body);
    assert.equal(fetchImpl.requests[2].headers.get("authorization"), "Bearer student-jwt");
    assert.deepEqual(match, {
      query_embedding: "[0.1,0.2]",
      target_course_id: COURSE_ID,
      target_embedding_model: "campus-embedding-v1",
      minimum_similarity: 0.7,
      maximum_results: 8,
    });
    const sign = fetchImpl.requests[4];
    assert.equal(sign.headers.get("authorization"), "Bearer student-jwt");
    assert.equal(sign.url.pathname, `/storage/v1/object/sign/course-documents/${COURSE_ID}/${DOCUMENT_ID}/lecture.pdf`);
    assert.deepEqual(JSON.parse(sign.body), { expiresIn: 3600 });
  });

  test("insufficient retrieval abstains without calling the chat model", async () => {
    const { fetchImpl, result } = ask(upstream({ match: () => json([]) }), baseSettings, "What is an unrelated topic?");
    const answer = await result;
    assert.equal(answer.insufficient_evidence, true);
    assert.deepEqual(answer.citations, []);
    assert.match(answer.answer, /couldn't find enough/);
    assert.equal(fetchImpl.requests.length, 3);
  });

  test("model-reported insufficient evidence abstains with the standard answer", async () => {
    const { result } = ask(upstream({ chat: () => chatReply({ answer: "", insufficient_evidence: true, citations: [] }) }));
    const answer = await result;
    assert.equal(answer.insufficient_evidence, true);
    assert.match(answer.answer, /couldn't find enough/);
  });

  test("rejects model citations outside retrieved sources before signing", async () => {
    const { fetchImpl, result } = ask(upstream({ chat: () => chatReply({ answer: "Unsupported answer", insufficient_evidence: false, citations: ["S99"] }) }));
    const error = await expectStatus(result, 502);
    assert.equal(error.detail, "The answer could not be tied to verified course sources");
    assert.ok(!fetchImpl.requests.some((request) => request.url.pathname.includes("/sign/")));
  });

  test("an answer without citations is never shown: the assistant abstains", async () => {
    const { fetchImpl, result } = ask(upstream({ chat: () => chatReply({ answer: "Here's a poem about computers.", insufficient_evidence: false, citations: [] }) }));
    const answer = await result;
    assert.equal(answer.insufficient_evidence, true);
    assert.deepEqual(answer.citations, []);
    assert.match(answer.answer, /couldn't find enough/);
    assert.ok(!fetchImpl.requests.some((request) => request.url.pathname.includes("/sign/")));
  });

  test("rejects inline references that are not in the citation list", async () => {
    const { result } = ask(
      upstream({
        match: () => json([sourceRow(), sourceRow({ chunk_id: randomUUID(), chunk_index: 1 })]),
        chat: () => chatReply({ answer: "Claim [S1] and another [S2].", insufficient_evidence: false, citations: ["S1"] }),
      }),
    );
    const error = await expectStatus(result, 502);
    assert.equal(error.detail, "The answer included an unverified source reference");
  });

  test("rejects non-member before calling the embedding provider", async () => {
    const { fetchImpl, result } = ask(upstream({ access: () => json(false) }));
    const error = await expectStatus(result, 404);
    assert.equal(error.detail, "Course not found");
    assert.equal(fetchImpl.requests.length, 1);
  });

  test("maps course authorization failures", async () => {
    await expectStatus(ask(upstream({ access: () => json({}, 401) })).result, 403);
    await expectStatus(ask(upstream({ access: () => json({}, 404) })).result, 404);
    await expectStatus(ask(upstream({ access: () => json({}, 500) })).result, 502);
  });

  test("invalid or failing model responses are 502/503", async () => {
    for (const content of ["not json", { answer: 5, insufficient_evidence: false, citations: [] }, { answer: "x", insufficient_evidence: "no", citations: [] }, { answer: "x", insufficient_evidence: false, citations: [1] }, [1, 2], { answer: "x".repeat(8001), insufficient_evidence: false, citations: ["S1"] }]) {
      await expectStatus(ask(upstream({ chat: () => chatReply(content) })).result, 502);
    }
    await expectStatus(ask(upstream({ chat: () => json({ choices: [] }) })).result, 502);
    const error = await expectStatus(ask(upstream({ chat: () => json({ error: "overloaded" }, 529) })).result, 503);
    assert.equal(error.detail, "Campus answer provider is unavailable");
  });

  test("embedding provider failure is 503", async () => {
    const handler: FakeHandler = (request) => (request.url.pathname === "/embeddings" ? json({}, 500) : upstream()(request));
    const error = await expectStatus(ask(handler).result, 503);
    assert.equal(error.detail, "Campus embeddings provider is unavailable");
  });

  test("invalid retrieval rows are 502", async () => {
    await expectStatus(ask(upstream({ match: () => json([{ chunk_id: "nope" }]) })).result, 502);
  });

  test("deduplicates citations and signs each document once", async () => {
    const secondDocument = randomUUID();
    const { fetchImpl, result } = ask(
      upstream({
        match: () => json([sourceRow(), sourceRow({ chunk_id: randomUUID(), chunk_index: 1 }), sourceRow({ chunk_id: randomUUID(), document_id: secondDocument, storage_path: `${COURSE_ID}/${secondDocument}/b.pdf` })]),
        chat: () => chatReply({ answer: "A [S1] B [S2] C [S3]", insufficient_evidence: false, citations: ["S1", "S2", "S1", "S3"] }),
      }),
    );
    const answer = await result;
    assert.deepEqual(answer.citations.map((citation) => citation.source_id), ["S1", "S2", "S3"]);
    assert.equal(fetchImpl.requests.filter((request) => request.url.pathname.includes("/sign/")).length, 2);
  });

  test("normalizes every signed URL form Supabase can return", async () => {
    const cases: [unknown, string][] = [
      [{ signedURL: "https://cdn.example/file?token=a" }, "https://cdn.example/file?token=a"],
      [{ signedURL: "/storage/v1/object/sign/x?token=b" }, "https://campus.example.supabase.co/storage/v1/object/sign/x?token=b"],
      [{ signedUrl: "/object/sign/x?token=c" }, "https://campus.example.supabase.co/storage/v1/object/sign/x?token=c"],
      [{ signedURL: "object/sign/x?token=d" }, "https://campus.example.supabase.co/storage/v1/object/sign/x?token=d"],
    ];
    for (const [body, expected] of cases) {
      clearAssistantCaches();
      const answer = await ask(upstream({ sign: () => json(body) })).result;
      assert.equal(answer.citations[0].url, expected);
    }
    clearAssistantCaches();
    await expectStatus(ask(upstream({ sign: () => json({}) })).result, 502);
    clearAssistantCaches();
    await expectStatus(ask(upstream({ sign: () => json({}, 403) })).result, 403);
  });

  test("repeat questions reuse the access check and the citation link", async () => {
    const fetchImpl = fakeFetch(upstream());
    for (let index = 0; index < 3; index++) {
      const answer = await answerCourseQuestion({ settings: baseSettings, user, courseId: COURSE_ID, question: "What is RAG?", fetch: fetchImpl });
      assert.equal(answer.citations[0].url, "https://campus.example.supabase.co/storage/v1/object/sign/course-documents/file?token=signed");
    }
    const count = (part: string) => fetchImpl.requests.filter((request) => request.url.pathname.includes(part)).length;
    assert.equal(count("current_user_can_access_course"), 1);
    assert.equal(count("/object/sign/"), 1);
    assert.equal(count("match_course_document_chunks"), 3, "retrieval always runs as the user");
  });

  test("a denied access check is never cached", async () => {
    let allowed = false;
    const fetchImpl = fakeFetch(upstream({ access: () => json(allowed) }));
    await expectStatus(answerCourseQuestion({ settings: baseSettings, user, courseId: COURSE_ID, question: "What is RAG?", fetch: fetchImpl }), 404);
    allowed = true;
    const answer = await answerCourseQuestion({ settings: baseSettings, user, courseId: COURSE_ID, question: "What is RAG?", fetch: fetchImpl });
    assert.equal(answer.insufficient_evidence, false);
  });

  test("access and links are cached per user, not shared", async () => {
    const fetchImpl = fakeFetch(upstream());
    await answerCourseQuestion({ settings: baseSettings, user, courseId: COURSE_ID, question: "What is RAG?", fetch: fetchImpl });
    const other = { ...user, id: randomUUID(), accessToken: "other-jwt" };
    await answerCourseQuestion({ settings: baseSettings, user: other, courseId: COURSE_ID, question: "What is RAG?", fetch: fetchImpl });
    const access = fetchImpl.requests.filter((request) => request.url.pathname.includes("current_user_can_access_course"));
    assert.deepEqual(access.map((request) => request.headers.get("authorization")), ["Bearer student-jwt", "Bearer other-jwt"]);
    assert.equal(fetchImpl.requests.filter((request) => request.url.pathname.includes("/object/sign/")).length, 2);
  });

  test("the relevance margin sends only passages close to the best match", async () => {
    let sent: string[] = [];
    const rows = [sourceRow({ similarity: 0.62, chunk_index: 1, chunk_id: randomUUID() }), sourceRow({ similarity: 0.8 }), sourceRow({ similarity: 0.75, chunk_index: 2, chunk_id: randomUUID() })];
    await ask(
      upstream({
        match: () => json(rows),
        chat: (request) => {
          sent = JSON.parse(JSON.parse(request.body).messages[1].content).sources.map((source: { chunk_index: number }) => `${source.chunk_index}`);
          return chatReply({ answer: "A [S1]", insufficient_evidence: false, citations: ["S1"] });
        },
      }),
      makeSettings({ ...baseSettings, ragRelevanceMargin: 0.1 }),
    ).result;
    assert.deepEqual(sent, ["0", "2"], "best first; 0.62 is dropped");
    assert.deepEqual(selectRelevantChunks([{ similarity: 0.5 }, { similarity: 0.9 }], 1).map((c) => c.similarity), [0.9, 0.5]);
    assert.deepEqual(selectRelevantChunks([], 0.1), []);
  });

  test("sends keep_alive to the providers only when configured", async () => {
    const bodies: Record<string, unknown>[] = [];
    const handler = upstream();
    const record: FakeHandler = (request) => {
      if (request.url.pathname === "/embeddings" || request.url.pathname === "/chat/completions") bodies.push(JSON.parse(request.body));
      return handler(request);
    };
    await ask(record).result;
    assert.ok(bodies.every((body) => !("keep_alive" in body)));
    bodies.length = 0;
    clearAssistantCaches();
    await ask(record, makeSettings({ ...baseSettings, aiKeepAlive: "1h" })).result;
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every((body) => body.keep_alive === "1h"));
  });

  test("passes reasoning effort when configured", async () => {
    let seen: Record<string, unknown> = {};
    await ask(
      upstream({
        chat: (request) => {
          seen = JSON.parse(request.body);
          return chatReply({ answer: "A [S1]", insufficient_evidence: false, citations: ["S1"] });
        },
      }),
      makeSettings({ ...baseSettings, aiChatReasoningEffort: "none" }),
    ).result;
    assert.equal(seen.reasoning_effort, "none");
  });

  test("requires configuration and secure provider endpoints", async () => {
    const cases: [Partial<Settings>, string][] = [
      [{ supabaseUrl: undefined }, "Campus assistant data access is not configured"],
      [{ aiEmbeddingModel: undefined }, "Campus assistant embeddings are not configured"],
      [{ aiChatEndpoint: undefined }, "Campus assistant answer model is not configured"],
    ];
    for (const [overrides, detail] of cases) {
      const { fetchImpl, result } = ask(upstream(), makeSettings({ ...baseSettings, ...overrides }));
      const error = await expectStatus(result, 503);
      assert.equal(error.detail, detail);
      assert.equal(fetchImpl.requests.length, 0);
    }
    const insecure = await expectStatus(ask(upstream(), makeSettings({ ...baseSettings, aiChatEndpoint: "http://ai.example/chat/completions" })).result, 503);
    assert.equal(insecure.detail, "Configured answer provider must use HTTPS");
    await expectStatus(ask(upstream(), makeSettings({ ...baseSettings, aiEmbeddingEndpoint: "http://ai.example/embeddings" })).result, 503);
  });

  test("parseAskRequest enforces 1–1,000 characters of visible text", () => {
    assert.equal(parseAskRequest({ question: "  What is RAG?  " }), "What is RAG?");
    for (const body of [{}, { question: "   " }, { question: "x".repeat(1001) }, { question: 5 }, null]) {
      assert.throws(() => parseAskRequest(body), (error: unknown) => error instanceof HttpError && error.status === 422);
    }
  });
});
