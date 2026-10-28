import { isSafeProviderEndpoint, upstreamFetch, type FetchLike } from "../http";
import type { Settings } from "../settings";

/**
 * Load the embedding and chat models into memory ahead of the first question. Only runs when
 * AI_KEEP_ALIVE is set (a local Ollama setup), so hosted providers are never sent warm-up traffic.
 * Failures are logged and ignored: warm-up only saves time, it is never required.
 */
export async function warmUpModels(settings: Settings, fetchImpl: FetchLike = fetch): Promise<void> {
  if (!settings.aiKeepAlive) return;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.aiApiKey) headers.Authorization = `Bearer ${settings.aiApiKey}`;
  const requests: [string | undefined, string | undefined, unknown][] = [
    [settings.aiEmbeddingEndpoint, settings.aiEmbeddingModel, { model: settings.aiEmbeddingModel, input: ["warm up"], keep_alive: settings.aiKeepAlive }],
    [settings.aiChatEndpoint, settings.aiChatModel, { model: settings.aiChatModel, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, keep_alive: settings.aiKeepAlive }],
  ];
  const started = Date.now();
  await Promise.all(
    requests.map(async ([endpoint, model, body]) => {
      if (!endpoint || !model || isSafeProviderEndpoint(endpoint) !== "ok") return;
      try {
        const response = await upstreamFetch(fetchImpl, endpoint, { method: "POST", headers, body: JSON.stringify(body), timeoutMs: 120_000 });
        if (!response.ok) console.warn("ai_model_warmup_failed", { model, status: response.status });
      } catch {
        console.warn("ai_model_warmup_failed", { model });
      }
    }),
  );
  console.info("ai_models_warmed", { ms: Date.now() - started });
}
