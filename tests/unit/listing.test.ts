import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import type { AuthenticatedUser } from "../../lib/server/auth";
import { describeIngestionError, listCourseDocuments } from "../../lib/server/documents/listing";
import { HttpError } from "../../lib/server/http";
import { makeSettings } from "../../lib/server/settings";
import { fakeFetch, json, type FakeHandler } from "../helpers/fake-fetch";

const COURSE_ID = randomUUID();
const settings = makeSettings({ supabaseUrl: "https://campus.example.supabase.co", supabaseAnonKey: "anon" });
const user: AuthenticatedUser = { id: randomUUID(), email: "s@example.edu", accessToken: "user-jwt" };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    title: "Week 1",
    file_name: "week1.pdf",
    mime_type: "application/pdf",
    size_bytes: 1234,
    status: "ready",
    created_at: "2026-10-28T10:00:00Z",
    updated_at: "2026-10-28T10:01:00Z",
    document_ingestion_jobs: [],
    ...overrides,
  };
}

const job = (overrides: Record<string, unknown> = {}) => ({ status: "succeeded", attempt_count: 1, max_attempts: 5, last_error: null, created_at: "2026-10-28T10:00:00Z", ...overrides });

function upstream(rows: unknown[], access: unknown = true): FakeHandler {
  return (request) => (request.url.pathname.endsWith("/current_user_can_access_course") ? json(access) : json(rows));
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  const error = await promise.then(() => assert.fail(`expected ${status}`), (caught: unknown) => caught);
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, status);
}

describe("listCourseDocuments", () => {
  test("checks access, then lists the course's documents newest first with job details", async () => {
    const fetchImpl = fakeFetch(upstream([row({ document_ingestion_jobs: [job()] })]));
    const [document] = await listCourseDocuments({ settings, user, courseId: COURSE_ID, fetch: fetchImpl });
    assert.equal(document.status, "ready");
    assert.equal(document.attempts, 1);
    assert.equal(document.error, null);
    assert.equal(document.retrying, false);
    assert.ok(!("document_ingestion_jobs" in document));
    assert.equal(document.can_delete, true, "managers see jobs and may delete");
    const list = fetchImpl.requests[1];
    assert.equal(list.url.searchParams.get("course_id"), `eq.${COURSE_ID}`);
    assert.equal(list.url.searchParams.get("order"), "created_at.desc");
    assert.match(list.url.searchParams.get("select")!, /document_ingestion_jobs\(/);
    assert.equal(list.headers.get("authorization"), "Bearer user-jwt");
  });

  test("reports retries and final failures with friendly messages from the latest job", async () => {
    const documents = await listCourseDocuments({
      settings,
      user,
      courseId: COURSE_ID,
      fetch: fakeFetch(
        upstream([
          row({ status: "queued", document_ingestion_jobs: [job({ status: "queued", attempt_count: 2, last_error: "embedding_provider_failed" })] }),
          row({ status: "failed", document_ingestion_jobs: [job({ status: "failed", attempt_count: 5, last_error: "document_contains_no_extractable_text" })] }),
          row({ status: "failed", document_ingestion_jobs: [job({ created_at: "2026-10-28T09:00:00Z", last_error: "old" }), job({ status: "failed", created_at: "2026-10-28T11:00:00Z", last_error: "document_parse_failed" })] }),
          row({ status: "processing", document_ingestion_jobs: [] }),
        ]),
      ),
    });
    assert.equal(documents[0].retrying, true);
    assert.equal(documents[0].error, "The AI indexing service was unavailable.");
    assert.equal(documents[0].attempts, 2);
    assert.equal(documents[1].retrying, false);
    assert.match(documents[1].error!, /Scanned PDFs/);
    assert.match(documents[2].error!, /couldn't be read/);
    assert.equal(documents[3].attempts, null, "non-managers cannot see jobs");
    assert.equal(documents[3].can_delete, false);
    assert.equal(documents[3].error, null);
  });

  test("non-members get 404 and upstream problems map to 403/502/503", async () => {
    await expectStatus(listCourseDocuments({ settings, user, courseId: COURSE_ID, fetch: fakeFetch(upstream([], false)) }), 404);
    await expectStatus(listCourseDocuments({ settings, user, courseId: COURSE_ID, fetch: fakeFetch(() => json({}, 403)) }), 403);
    await expectStatus(listCourseDocuments({ settings, user, courseId: COURSE_ID, fetch: fakeFetch(upstream([{ id: "bad" }])) }), 502);
    const offline = async () => {
      throw new TypeError("fetch failed");
    };
    await expectStatus(listCourseDocuments({ settings, user, courseId: COURSE_ID, fetch: offline }), 503);
    await expectStatus(listCourseDocuments({ settings: makeSettings(), user, courseId: COURSE_ID, fetch: offline }), 503);
  });

  test("every worker error code has a specific message", () => {
    for (const code of ["document_parse_failed", "document_contains_no_extractable_text", "document_text_limit_exceeded", "document_chunk_limit_exceeded", "pdf_page_limit_exceeded", "embedding_provider_failed", "stored_file_integrity_check_failed", "worker_lease_lost"]) {
      assert.notEqual(describeIngestionError(code), "Indexing failed unexpectedly.", code);
    }
    assert.equal(describeIngestionError("something_new"), "Indexing failed unexpectedly.");
    assert.equal(describeIngestionError(null), null);
  });
});
