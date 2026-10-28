import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import type { AuthenticatedUser } from "../../lib/server/auth";
import { createCourseDocument } from "../../lib/server/documents/uploads";
import { MAX_DOCUMENT_BYTES, readZipMembers, validateDocument } from "../../lib/server/documents/validation";
import { HttpError } from "../../lib/server/http";
import { makeSettings } from "../../lib/server/settings";
import { makeDocx, makePdf, makeZip } from "../helpers/fixtures";
import { empty, fakeFetch, json } from "../helpers/fake-fetch";

const SUPABASE_URL = "https://campus.example.supabase.co";
const SUPABASE_KEY = "public-test-key";
const COURSE_ID = randomUUID();
const USER_ID = randomUUID();
const PDF = new TextEncoder().encode("%PDF-1.7 sample");
const settings = makeSettings({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_KEY });
const user: AuthenticatedUser = { id: USER_ID, email: "staff@example.edu", accessToken: "user-jwt" };

function expectHttp(run: () => unknown, status: number, detail?: string | RegExp) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof HttpError, String(error));
    assert.equal(error.status, status);
    if (typeof detail === "string") assert.equal(error.detail, detail);
    if (detail instanceof RegExp) assert.match(error.detail, detail);
    return true;
  });
}

async function expectHttpAsync(promise: Promise<unknown>, status: number): Promise<HttpError> {
  const error = await promise.then(
    () => assert.fail(`expected HTTP ${status}`),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof HttpError, String(error));
  assert.equal(error.status, status);
  return error;
}

describe("validateDocument", () => {
  test("validates PDF content and sanitizes Windows paths", () => {
    assert.deepEqual(validateDocument("C:\\fakepath\\lecture.pdf", PDF), { safeName: "lecture.pdf", mimeType: "application/pdf" });
    assert.equal(validateDocument("../../etc/notes.TXT", new TextEncoder().encode("hi")).safeName, "notes.TXT");
  });

  test("rejects a mismatched file extension", () => {
    expectHttp(() => validateDocument("lecture.pdf", new TextEncoder().encode("not a pdf")), 415, "File content does not match PDF format");
  });

  test("rejects invalid names, empty files and oversized files", () => {
    expectHttp(() => validateDocument("", PDF), 422, "Invalid file name");
    expectHttp(() => validateDocument("bad\u0007name.pdf", PDF), 422, "Invalid file name");
    expectHttp(() => validateDocument(`${"a".repeat(252)}.pdf`, PDF), 422, "Invalid file name");
    expectHttp(() => validateDocument("lecture.pdf", new Uint8Array()), 422, "The uploaded file is empty");
    const large = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    large.set(PDF);
    expectHttp(() => validateDocument("lecture.pdf", large), 413);
  });

  test("allows only PDF, TXT and DOCX extensions", () => {
    for (const name of ["image.png", "noextension", "script.exe", "notes.doc"]) {
      expectHttp(() => validateDocument(name, PDF), 415, "Only PDF, TXT, and DOCX files are supported");
    }
  });

  test("text files must be UTF-8 without NUL bytes", () => {
    assert.equal(validateDocument("notes.txt", new TextEncoder().encode("naïve café ☕")).mimeType, "text/plain");
    expectHttp(() => validateDocument("notes.txt", new Uint8Array([0xff, 0xfe, 0x41])), 415, "Text files must use UTF-8 encoding");
    expectHttp(() => validateDocument("notes.txt", new Uint8Array([0x41, 0x00, 0x42])), 415, "Text file contains binary data");
  });

  test("accepts a well-formed DOCX", async () => {
    const docx = await makeDocx(["Hello"]);
    assert.equal(validateDocument("notes.docx", docx).mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  test("rejects non-zip, incomplete and oversized DOCX files", async () => {
    expectHttp(() => validateDocument("notes.docx", new TextEncoder().encode("plain text")), 415, "File content does not match DOCX format");
    const missingDocument = await makeZip({ "[Content_Types].xml": "<Types/>" });
    expectHttp(() => validateDocument("notes.docx", missingDocument), 415, "Invalid or oversized DOCX file");
    // Zip bomb: 101 MiB of zeros compresses to a tiny archive.
    const bomb = await makeZip({ "[Content_Types].xml": "<Types/>", "word/document.xml": new Uint8Array(101 * 1024 * 1024) });
    assert.ok(bomb.length < 1024 * 1024);
    expectHttp(() => validateDocument("notes.docx", bomb), 415, "Invalid or oversized DOCX file");
  });

  test("rejects DOCX archives with too many members", async () => {
    const files: Record<string, string> = { "[Content_Types].xml": "<Types/>", "word/document.xml": "<w/>" };
    for (let index = 0; index < 10_001; index++) files[`f/${index}`] = "";
    const archive = await makeZip(files);
    expectHttp(() => validateDocument("notes.docx", archive), 415, "Invalid or oversized DOCX file");
  });

  test("reads ZIP central directory sizes without decompressing", async () => {
    const archive = await makeZip({ "a.txt": "hello", "dir/b.bin": new Uint8Array(4096) });
    assert.deepEqual(
      readZipMembers(archive).map((member) => [member.name, member.uncompressedSize]),
      [["a.txt", 5], ["dir/", 0], ["dir/b.bin", 4096]],
    );
  });

  test("real PDF fixtures pass validation", () => {
    assert.equal(validateDocument("lecture.pdf", makePdf(["Page one"])).mimeType, "application/pdf");
  });
});

describe("createCourseDocument", () => {
  test("uploads to private storage and registers metadata with the user JWT", async () => {
    const fetchImpl = fakeFetch((request) => {
      if (request.method === "GET") return json([]);
      return request.url.pathname.startsWith("/storage/v1/object/") ? json({ Key: "stored" }) : empty(201);
    });
    const result = await createCourseDocument({ settings, user, courseId: COURSE_ID, title: " Week 1 lecture ", filename: "lecture.pdf", data: PDF, fetch: fetchImpl });

    assert.equal(result.course_id, COURSE_ID);
    assert.equal(result.status, "queued");
    assert.equal(result.title, "Week 1 lecture");
    assert.equal(result.size_bytes, PDF.length);
    assert.ok(!("sha256" in result));
    const [lookup, upload, metadata] = fetchImpl.requests;
    assert.equal(fetchImpl.requests.length, 3);
    assert.equal(lookup.method, "GET");
    assert.equal(lookup.url.pathname, "/rest/v1/course_documents");
    assert.equal(lookup.url.searchParams.get("course_id"), `eq.${COURSE_ID}`);
    assert.equal(lookup.url.searchParams.get("sha256"), `eq.${createHash("sha256").update(PDF).digest("hex")}`);
    assert.equal(lookup.url.searchParams.get("status"), "neq.failed");
    assert.equal(lookup.headers.get("authorization"), "Bearer user-jwt");
    assert.equal(upload.method, "POST");
    assert.equal(upload.headers.get("authorization"), "Bearer user-jwt");
    assert.equal(upload.headers.get("apikey"), SUPABASE_KEY);
    assert.equal(upload.headers.get("content-type"), "application/pdf");
    assert.equal(upload.headers.get("x-upsert"), "false");
    assert.equal(upload.url.pathname, `/storage/v1/object/course-documents/${COURSE_ID}/${result.id}/lecture.pdf`);
    assert.deepEqual(upload.bytes, PDF);
    assert.equal(metadata.url.pathname, "/rest/v1/course_documents");
    assert.equal(metadata.headers.get("prefer"), "return=minimal");
    const body = JSON.parse(metadata.body);
    assert.equal(body.id, result.id);
    assert.equal(body.created_by, USER_ID);
    assert.equal(body.sha256, createHash("sha256").update(PDF).digest("hex"));
    assert.equal(body.storage_path, `${COURSE_ID}/${result.id}/lecture.pdf`);
  });

  test("encodes storage paths with special characters", async () => {
    const fetchImpl = fakeFetch(() => empty(200));
    await createCourseDocument({ settings, user, courseId: COURSE_ID, title: "t", filename: "week 1 #notes?.pdf", data: PDF, fetch: fetchImpl });
    assert.match(fetchImpl.requests[1].url.pathname, /\/week%201%20%23notes%3F\.pdf$/);
  });

  test("metadata failure cleans up the uploaded object", async () => {
    const fetchImpl = fakeFetch((request) => {
      if (request.method === "POST" && request.url.pathname.startsWith("/storage/")) return empty(200);
      if (request.method === "POST") return json({ message: "row-level security" }, 403);
      return json([]);
    });
    await expectHttpAsync(
      createCourseDocument({ settings, user, courseId: COURSE_ID, title: "Week 1 lecture", filename: "lecture notes.pdf", data: PDF, fetch: fetchImpl }),
      403,
    );
    assert.deepEqual(fetchImpl.requests.map((request) => request.method), ["GET", "POST", "POST", "DELETE"]);
    const cleanup = JSON.parse(fetchImpl.requests[3].body);
    assert.ok(cleanup.prefixes[0].startsWith(`${COURSE_ID}/`));
    assert.ok(cleanup.prefixes[0].endsWith("/lecture notes.pdf"), "cleanup uses the raw object name");
    assert.equal(fetchImpl.requests[3].url.pathname, "/storage/v1/object/course-documents");
  });

  test("refuses to call Supabase without configuration", async () => {
    const fetchImpl = fakeFetch(() => empty(200));
    await expectHttpAsync(createCourseDocument({ settings: makeSettings(), user, courseId: COURSE_ID, title: "t", filename: "lecture.pdf", data: PDF, fetch: fetchImpl }), 503);
    assert.equal(fetchImpl.requests.length, 0);
  });

  test("validates the title before uploading", async () => {
    const fetchImpl = fakeFetch(() => empty(200));
    for (const title of ["   ", "x".repeat(201)]) {
      await expectHttpAsync(createCourseDocument({ settings, user, courseId: COURSE_ID, title, filename: "lecture.pdf", data: PDF, fetch: fetchImpl }), 422);
    }
    assert.equal(fetchImpl.requests.length, 0);
  });

  test("maps storage rejections and outages", async () => {
    const cases: [number, number][] = [[401, 403], [403, 403], [413, 413], [415, 415], [500, 502]];
    for (const [upstream, expected] of cases) {
      await expectHttpAsync(
        createCourseDocument({ settings, user, courseId: COURSE_ID, title: "t", filename: "lecture.pdf", data: PDF, fetch: fakeFetch(() => empty(upstream)) }),
        expected,
      );
    }
    const offline = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await expectHttpAsync(createCourseDocument({ settings, user, courseId: COURSE_ID, title: "t", filename: "lecture.pdf", data: PDF, fetch: offline }), 503);
    assert.equal(error.detail, "Document storage is unavailable");
  });

  test("rejects a file already in the course with 409 before uploading", async () => {
    const fetchImpl = fakeFetch((request) => (request.method === "GET" ? json([{ title: "Week 1 lecture" }]) : empty(200)));
    const error = await expectHttpAsync(createCourseDocument({ settings, user, courseId: COURSE_ID, title: "Copy", filename: "copy.pdf", data: PDF, fetch: fetchImpl }), 409);
    assert.equal(error.detail, "This file is already in the course as “Week 1 lecture”.");
    assert.deepEqual(fetchImpl.requests.map((request) => request.method), ["GET"]);
  });

  test("metadata outage cleans up and reports 503", async () => {
    let calls = 0;
    const fetchImpl = fakeFetch((request) => {
      calls++;
      if (calls === 3) throw new TypeError("fetch failed");
      return request.method === "DELETE" ? json([]) : empty(200);
    });
    const error = await expectHttpAsync(createCourseDocument({ settings, user, courseId: COURSE_ID, title: "t", filename: "lecture.pdf", data: PDF, fetch: fetchImpl }), 503);
    assert.equal(error.detail, "Document registration is unavailable");
    assert.equal(fetchImpl.requests.at(-1)!.method, "DELETE");
  });
});
