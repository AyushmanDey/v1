import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { warmUpModels } from "../../lib/server/ai/warmup";
import { makeSettings } from "../../lib/server/settings";
import { fakeFetch, json } from "../helpers/fake-fetch";

const ollama = makeSettings({
  aiEmbeddingEndpoint: "http://localhost:11434/v1/embeddings",
  aiEmbeddingModel: "nomic-embed-text",
  aiChatEndpoint: "http://localhost:11434/v1/chat/completions",
  aiChatModel: "qwen2.5:7b",
});

describe("warmUpModels", () => {
  test("does nothing unless AI_KEEP_ALIVE is set", async () => {
    const fetchImpl = fakeFetch(() => json({}));
    await warmUpModels(ollama, fetchImpl);
    assert.equal(fetchImpl.requests.length, 0);
  });

  test("loads both models with keep_alive", async () => {
    const fetchImpl = fakeFetch(() => json({}));
    await warmUpModels({ ...ollama, aiKeepAlive: "1h" }, fetchImpl);
    const bodies = fetchImpl.requests.map((request) => JSON.parse(request.body));
    assert.deepEqual(fetchImpl.requests.map((request) => request.url.pathname).sort(), ["/v1/chat/completions", "/v1/embeddings"]);
    assert.ok(bodies.every((body) => body.keep_alive === "1h"));
    assert.equal(bodies.find((body) => body.messages)?.max_tokens, 1);
  });

  test("never throws when a provider is down or insecure", async () => {
    await warmUpModels({ ...ollama, aiKeepAlive: "1h" }, async () => {
      throw new TypeError("connection refused");
    });
    const fetchImpl = fakeFetch(() => json({}));
    await warmUpModels({ ...ollama, aiKeepAlive: "1h", aiChatEndpoint: "http://remote.example/v1/chat" , aiEmbeddingEndpoint: "http://remote.example/v1/e" }, fetchImpl);
    assert.equal(fetchImpl.requests.length, 0);
  });
});
