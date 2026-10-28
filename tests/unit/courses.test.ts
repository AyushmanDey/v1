import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import type { AuthenticatedUser } from "../../lib/server/auth";
import { createUserCourse, listUserCourses, parseCourseCreate } from "../../lib/server/courses";
import { HttpError } from "../../lib/server/http";
import { makeSettings } from "../../lib/server/settings";
import { empty, fakeFetch, json } from "../helpers/fake-fetch";

const USER_ID = randomUUID();
const COURSE_ID = randomUUID();
const COURSE_ROW = { id: COURSE_ID, name: "Foundations of Biology", code: "BIO-101", created_at: new Date().toISOString() };
const settings = makeSettings({ supabaseUrl: "https://campus.example.supabase.co", supabaseAnonKey: "publishable-test-key" });
const user: AuthenticatedUser = { id: USER_ID, email: "student@example.edu", accessToken: "student-jwt" };

async function expectStatus(promise: Promise<unknown>, status: number): Promise<HttpError> {
  const error = await promise.then(
    () => assert.fail(`expected HTTP ${status}`),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, status);
  return error;
}

describe("courses", () => {
  test("list uses the user token and returns RLS-visible courses", async () => {
    const fetchImpl = fakeFetch((request) => {
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "Bearer student-jwt");
      assert.equal(request.headers.get("apikey"), "publishable-test-key");
      assert.equal(request.url.pathname, "/rest/v1/courses");
      assert.equal(request.url.searchParams.get("select"), "id,name,code,created_at");
      assert.equal(request.url.searchParams.get("order"), "name.asc");
      return json([COURSE_ROW]);
    });
    const courses = await listUserCourses({ settings, user, fetch: fetchImpl });
    assert.equal(courses.length, 1);
    assert.equal(courses[0].id, COURSE_ID);
    assert.equal(courses[0].code, "BIO-101");
  });

  test("create derives the owner from the authenticated user, trims fields and reads the row back", async () => {
    let insertedId = "";
    const fetchImpl = fakeFetch((request) => {
      assert.equal(request.headers.get("authorization"), "Bearer student-jwt");
      if (request.method === "POST") {
        // No RETURNING: the SELECT policy cannot see the row during the insert.
        assert.equal(request.headers.get("prefer"), "return=minimal");
        const payload = JSON.parse(request.body);
        insertedId = payload.id;
        assert.deepEqual(payload, { id: insertedId, owner_id: USER_ID, name: "Foundations of Biology", code: "BIO-101" });
        return empty(201);
      }
      assert.equal(request.url.searchParams.get("id"), `eq.${insertedId}`);
      assert.equal(request.url.searchParams.get("select"), "id,name,code,created_at");
      return json([{ ...COURSE_ROW, id: insertedId }]);
    });
    const course = await createUserCourse({
      settings,
      user,
      course: parseCourseCreate({ name: " Foundations of Biology ", code: " BIO-101 " }),
      fetch: fetchImpl,
    });
    assert.equal(course.id, insertedId);
    assert.deepEqual(fetchImpl.requests.map((request) => request.method), ["POST", "GET"]);
  });

  test("create rejects blank, missing, and oversized fields with 422", () => {
    for (const body of [{ name: "  ", code: "BIO-101" }, { name: "Bio" }, { name: "x".repeat(201), code: "B" }, { name: "Bio", code: "x".repeat(41) }, null]) {
      assert.throws(() => parseCourseCreate(body), (error: unknown) => error instanceof HttpError && error.status === 422);
    }
  });

  test("Supabase RLS denial is reported as forbidden", async () => {
    const error = await expectStatus(listUserCourses({ settings, user, fetch: fakeFetch(() => empty(403)) }), 403);
    assert.match(error.detail, /course access policy/);
  });

  test("an expired Supabase session is reported as 401", async () => {
    const error = await expectStatus(listUserCourses({ settings, user, fetch: fakeFetch(() => json({ code: "PGRST301" }, 401)) }), 401);
    assert.match(error.detail, /Sign in again/);
  });

  test("upstream failures and invalid data map to 502, network errors to 503", async () => {
    await expectStatus(listUserCourses({ settings, user, fetch: fakeFetch(() => empty(500)) }), 502);
    await expectStatus(listUserCourses({ settings, user, fetch: fakeFetch(() => json({ not: "a list" })) }), 502);
    await expectStatus(listUserCourses({ settings, user, fetch: fakeFetch(() => json([{ id: "bad" }])) }), 502);
    await expectStatus(createUserCourse({ settings, user, course: { name: "a", code: "b" }, fetch: fakeFetch((request) => (request.method === "POST" ? empty(201) : json([]))) }), 502);
    await expectStatus(createUserCourse({ settings, user, course: { name: "a", code: "b" }, fetch: fakeFetch(() => json({ code: "42501" }, 403)) }), 403);
    const offline = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await expectStatus(listUserCourses({ settings, user, fetch: offline }), 503);
    assert.equal(error.detail, "Course service is unavailable");
  });

  test("missing configuration is 503 without calling Supabase", async () => {
    const fetchImpl = fakeFetch(() => json([]));
    await expectStatus(listUserCourses({ settings: makeSettings(), user, fetch: fetchImpl }), 503);
    assert.equal(fetchImpl.requests.length, 0);
  });
});
