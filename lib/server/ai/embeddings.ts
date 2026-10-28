import { DocumentProcessingError, validateEmbeddings, type EmbeddingProvider } from "../documents/ingestion";
import { isSafeProviderEndpoint, upstreamFetch, type FetchLike } from "../http";
import type { Settings } from "../settings";

export const EMBEDDING_BATCH_SIZE = 48;

export class ProviderConfigurationError extends Error {}

/** Adapter for a configured endpoint with OpenAI-compatible embeddings JSON. */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly keepAlive?: string;

  constructor(settings: Settings, fetchImpl: FetchLike = fetch) {
    const endpoint = settings.aiEmbeddingEndpoint;
    const model = settings.aiEmbeddingModel;
    if (!endpoint || !model) throw new ProviderConfigurationError("AI_EMBEDDING_ENDPOINT and AI_EMBEDDING_MODEL are required");
    const safety = isSafeProviderEndpoint(endpoint);
    if (safety === "credentials") throw new ProviderConfigurationError("Embedding endpoint credentials belong in AI_API_KEY");
    if (safety === "insecure") throw new ProviderConfigurationError("Embedding endpoint must use HTTPS");
    this.endpoint = endpoint;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.keepAlive = settings.aiKeepAlive;
    this.headers = { "Content-Type": "application/json" };
    if (settings.aiApiKey) this.headers.Authorization = `Bearer ${settings.aiApiKey}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      try {
        const response = await upstreamFetch(this.fetchImpl, this.endpoint, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify({ model: this.model, input: batch, ...(this.keepAlive ? { keep_alive: this.keepAlive } : {}) }),
          timeoutMs: 90_000,
        });
        if (!response.ok) throw new Error(`Embedding provider returned ${response.status}`);
        const payload = (await response.json()) as { data: { index: number; embedding: unknown[] }[] };
        const entries = payload.data;
        if (!Array.isArray(entries) || entries.length !== batch.length) {
          throw new DocumentProcessingError("embedding_response_count_mismatch");
        }
        const ordered = [...entries].sort((a, b) => a.index - b.index);
        if (ordered.some((entry, index) => entry.index !== index)) {
          throw new DocumentProcessingError("embedding_response_count_mismatch");
        }
        for (const entry of ordered) {
          if (!Array.isArray(entry.embedding)) throw new Error("Embedding is not a list");
          vectors.push(
            entry.embedding.map((value) => {
              const number = typeof value === "number" ? value : Number.NaN;
              if (Number.isNaN(number)) throw new Error("Embedding value is not numeric");
              return number;
            }),
          );
        }
      } catch (error) {
        if (error instanceof DocumentProcessingError) throw error;
        throw new DocumentProcessingError("embedding_provider_failed", { cause: error });
      }
    }
    validateEmbeddings(vectors, texts.length);
    return vectors;
  }
}

/** pgvector text literal with 9 significant digits, matching Python's format(value, ".9g"). */
export function vectorLiteral(values: number[]): string {
  return `[${values.map((value) => formatG9(value)).join(",")}]`;
}

function formatG9(value: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent < -4 || exponent >= 9) {
    const [mantissa, exp] = value.toExponential(8).split("e");
    const trimmed = mantissa.includes(".") ? mantissa.replace(/\.?0+$/, "") : mantissa;
    const expNumber = Number(exp);
    return `${trimmed}e${expNumber < 0 ? "-" : "+"}${String(Math.abs(expNumber)).padStart(2, "0")}`;
  }
  const fixed = value.toPrecision(9);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}
