import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { GET as health } from "../../app/api/v1/health/route";
import { config as proxyConfig } from "../../proxy";
import { HttpError, encodePath, errorResponse, isSafeProviderEndpoint, requireUuidParam } from "../../lib/server/http";
import { loadSettings } from "../../lib/server/settings";

describe("API surface", () => {
  test("health endpoint reports API status", async () => {
    const response = health();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  test("all README endpoints are implemented as route handlers", async () => {
    const routes: [string, string[]][] = [
      ["app/api/v1/health/route.ts", ["GET"]],
      ["app/api/v1/me/route.ts", ["GET"]],
      ["app/api/v1/courses/route.ts", ["GET", "POST"]],
      ["app/api/v1/courses/[courseId]/documents/route.ts", ["GET", "POST"]],
      ["app/api/v1/courses/[courseId]/documents/[documentId]/route.ts", ["DELETE"]],
      ["app/api/v1/courses/[courseId]/assistant/ask/route.ts", ["POST"]],
    ];
    for (const [file, methods] of routes) {
      assert.ok(existsSync(file), file);
      const routeModule = await import(`../../${file}`);
      for (const method of methods) assert.equal(typeof routeModule[method], "function", `${method} ${file}`);
    }
  });

  test("the Python backend has been removed", () => {
    assert.ok(!existsSync("backend"));
  });

  test("API routes bypass the proxy so uploads are not truncated", () => {
    const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`);
    assert.ok(!matcher.test("/api/v1/courses/123/documents"));
    assert.ok(matcher.test("/"));
  });

  test("frontend calls same-origin API routes", () => {
    const source = readFileSync("components/campus/campus-chat.tsx", "utf8");
    assert.ok(!source.includes("localhost:8000"));
    assert.ok(!source.includes("NEXT_PUBLIC_API_BASE_URL"));
    assert.ok(source.includes("`/api/v1/courses`"));
  });
});

describe("settings", () => {
  test("blank .env values are treated as unset and defaults apply", () => {
    const settings = loadSettings({ SUPABASE_URL: "", AI_CHAT_ENDPOINT: " ", RAG_MIN_SIMILARITY: "", RAG_MAX_CHUNKS: "" });
    assert.equal(settings.supabaseUrl, undefined);
    assert.equal(settings.aiChatEndpoint, undefined);
    assert.equal(settings.ragMinSimilarity, 0.7);
    assert.equal(settings.ragMaxChunks, 8);
    assert.equal(settings.supabaseStorageBucket, "course-documents");
    assert.equal(settings.ingestionInline, true);
  });

  test("falls back to public Supabase values and parses overrides", () => {
    const settings = loadSettings({ NEXT_PUBLIC_SUPABASE_URL: "https://p.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", RAG_MIN_SIMILARITY: "0.5", RAG_MAX_CHUNKS: "3", INGESTION_INLINE: "false" });
    assert.equal(settings.supabaseUrl, "https://p.supabase.co");
    assert.equal(settings.supabaseAnonKey, "anon");
    assert.equal(settings.ragMinSimilarity, 0.5);
    assert.equal(settings.ragMaxChunks, 3);
    assert.equal(settings.ingestionInline, false);
  });

  test("rejects out-of-range retrieval settings", () => {
    assert.throws(() => loadSettings({ RAG_MIN_SIMILARITY: "1.5" }));
    assert.throws(() => loadSettings({ RAG_MAX_CHUNKS: "11" }));
    assert.throws(() => loadSettings({ RAG_MAX_CHUNKS: "2.5" }));
  });
});

describe("http helpers", () => {
  test("errorResponse renders FastAPI-style detail bodies", async () => {
    const response = errorResponse(new HttpError(401, "Authentication required", { "WWW-Authenticate": "Bearer" }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(await response.json(), { detail: "Authentication required" });
    const hidden = errorResponse(new Error("secret internals"));
    assert.equal(hidden.status, 500);
    assert.deepEqual(await hidden.json(), { detail: "Internal server error" });
  });

  test("encodePath matches Python quote()", () => {
    assert.equal(encodePath("a b/c#?.pdf", true), "a%20b/c%23%3F.pdf");
    assert.equal(encodePath("a/b"), "a%2Fb");
    assert.equal(encodePath("it's(1)*!"), "it%27s%281%29%2A%21");
  });

  test("requireUuidParam normalizes UUIDs and rejects others", () => {
    assert.equal(requireUuidParam("A1B2C3D4E5F60718293A4B5C6D7E8F90", "id"), "a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90");
    assert.throws(() => requireUuidParam("../etc", "id"), (error: unknown) => error instanceof HttpError && error.status === 422);
  });

  test("provider endpoint safety", () => {
    assert.equal(isSafeProviderEndpoint("https://api.example/v1"), "ok");
    assert.equal(isSafeProviderEndpoint("http://[::1]:8080/v1"), "ok");
    assert.equal(isSafeProviderEndpoint("http://api.example/v1"), "insecure");
    assert.equal(isSafeProviderEndpoint("not a url"), "insecure");
    assert.equal(isSafeProviderEndpoint("https://k:s@api.example"), "credentials");
  });
});
