import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import type { AuthenticatedUser } from "../../lib/server/auth";
import { deleteCourseDocument } from "../../lib/server/documents/deletion";
import { HttpError } from "../../lib/server/http";
import { makeSettings } from "../../lib/server/settings";
import { empty, fakeFetch, json, type FakeHandler } from "../helpers/fake-fetch";

const COURSE_ID = randomUUID();
const DOCUMENT_ID = randomUUID();
const STORAGE_PATH = `${COURSE_ID}/${DOCUMENT_ID}/week 1.pdf`;
const settings = makeSettings({ supabaseUrl: "https://campus.example.supabase.co", supabaseAnonKey: "anon" });
const user: AuthenticatedUser = { id: randomUUID(), email: "owner@example.edu", accessToken: "owner-jwt" };
const remove = (handler: FakeHandler, overrides: Partial<Parameters<typeof deleteCourseDocument>[0]> = {}) => {
  const fetchImpl = fakeFetch(handler);
  return { fetchImpl, result: deleteCourseDocument({ settings, user, courseId: COURSE_ID, documentId: DOCUMENT_ID, fetch: fetchImpl, ...overrides }) };
};

async function expectStatus(promise: Promise<unknown>, status: number): Promise<HttpError> {
  const error = await promise.then(() => assert.fail(`expected ${status}`), (caught: unknown) => caught);
  assert.ok(error instanceof HttpError, String(error));
  assert.equal(error.status, status);
  return error;
}

describe("deleteCourseDocument", () => {
  test("deletes the rows through the database function, then the stored file, as the user", async () => {
    const { fetchImpl, result } = remove((request) => (request.url.pathname.endsWith("/rpc/delete_course_document") ? json(STORAGE_PATH) : json([{ name: STORAGE_PATH }])));
    assert.deepEqual(await result, { id: DOCUMENT_ID, deleted: true, file_removed: true });
    const [rpc, storage] = fetchImpl.requests;
    assert.equal(rpc.method, "POST");
    assert.deepEqual(JSON.parse(rpc.body), { target_course_id: COURSE_ID, target_document_id: DOCUMENT_ID });
    assert.equal(rpc.headers.get("authorization"), "Bearer owner-jwt");
    assert.equal(storage.method, "DELETE");
    assert.equal(storage.url.pathname, "/storage/v1/object/course-documents");
    assert.deepEqual(JSON.parse(storage.body), { prefixes: [STORAGE_PATH] });
    assert.equal(storage.headers.get("authorization"), "Bearer owner-jwt");
  });

  test("a document the user cannot see, or that is not in the course, is 404 and nothing is removed", async () => {
    const { fetchImpl, result } = remove(() => json(null));
    const error = await expectStatus(result, 404);
    assert.equal(error.detail, "Course material not found");
    assert.equal(fetchImpl.requests.length, 1);
  });

  test("members who do not manage the course get 403", async () => {
    const { fetchImpl, result } = remove(() => json({ code: "42501", message: "Only course managers can delete course documents" }, 403));
    const error = await expectStatus(result, 403);
    assert.equal(error.detail, "Only course managers can delete course materials");
    assert.equal(fetchImpl.requests.length, 1);
  });

  test("a missing migration is reported clearly", async () => {
    const error = await expectStatus(remove(() => json({ code: "PGRST202", message: "Could not find the function" }, 404)).result, 503);
    assert.match(error.detail, /20261028000100_document_deletion\.sql/);
  });

  test("storage cleanup is retried once and reported when it fails", async () => {
    const { fetchImpl, result } = remove((request) => (request.url.pathname.includes("/rpc/") ? json(STORAGE_PATH) : empty(500)));
    assert.deepEqual(await result, { id: DOCUMENT_ID, deleted: true, file_removed: false });
    assert.equal(fetchImpl.requests.filter((request) => request.method === "DELETE").length, 2);
  });

  test("outages, upstream errors and missing configuration", async () => {
    const offline = async () => {
      throw new TypeError("fetch failed");
    };
    await expectStatus(deleteCourseDocument({ settings, user, courseId: COURSE_ID, documentId: DOCUMENT_ID, fetch: offline }), 503);
    await expectStatus(remove(() => json({}, 500)).result, 502);
    const { fetchImpl, result } = remove(() => json(STORAGE_PATH), { settings: makeSettings() });
    await expectStatus(result, 503);
    assert.equal(fetchImpl.requests.length, 0);
  });
});
