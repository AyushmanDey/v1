/** Server-side configuration. Blank values in .env files are treated as unset. */

export interface Settings {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  supabaseServiceRoleKey?: string;
  supabaseStorageBucket: string;
  aiEmbeddingEndpoint?: string;
  aiEmbeddingModel?: string;
  aiApiKey?: string;
  aiChatEndpoint?: string;
  aiChatModel?: string;
  aiChatReasoningEffort?: string;
  /** Ollama only: how long to keep models loaded between requests (e.g. "1h"). Unset = provider default. */
  aiKeepAlive?: string;
  ragMinSimilarity: number;
  ragMaxChunks: number;
  /** Drop retrieved passages scoring more than this below the best match (1 = keep all above the minimum). */
  ragRelevanceMargin: number;
  /** Process queued ingestion jobs inside the Next.js server after uploads. */
  ingestionInline: boolean;
}

type Env = Record<string, string | undefined>;

function value(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const raw = env[name]?.trim();
    if (raw) return raw;
  }
  return undefined;
}

function boundedNumber(raw: string | undefined, fallback: number, name: string, min: number, max: number, integer = false): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
  }
  return parsed;
}

export function loadSettings(env: Env = process.env): Settings {
  return {
    supabaseUrl: value(env, "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"),
    supabaseAnonKey: value(env, "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: value(env, "SUPABASE_SERVICE_ROLE_KEY"),
    supabaseStorageBucket: value(env, "SUPABASE_STORAGE_BUCKET") ?? "course-documents",
    aiEmbeddingEndpoint: value(env, "AI_EMBEDDING_ENDPOINT"),
    aiEmbeddingModel: value(env, "AI_EMBEDDING_MODEL"),
    aiApiKey: value(env, "AI_API_KEY"),
    aiChatEndpoint: value(env, "AI_CHAT_ENDPOINT"),
    aiChatModel: value(env, "AI_CHAT_MODEL"),
    aiChatReasoningEffort: value(env, "AI_CHAT_REASONING_EFFORT"),
    aiKeepAlive: value(env, "AI_KEEP_ALIVE"),
    ragMinSimilarity: boundedNumber(value(env, "RAG_MIN_SIMILARITY"), 0.7, "RAG_MIN_SIMILARITY", 0, 1),
    ragMaxChunks: boundedNumber(value(env, "RAG_MAX_CHUNKS"), 8, "RAG_MAX_CHUNKS", 1, 10, true),
    ragRelevanceMargin: boundedNumber(value(env, "RAG_RELEVANCE_MARGIN"), 1, "RAG_RELEVANCE_MARGIN", 0, 1),
    ingestionInline: !["0", "false", "no", "off"].includes((value(env, "INGESTION_INLINE") ?? "true").toLowerCase()),
  };
}

/** Build settings for tests and scripts from partial overrides. */
export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...loadSettings({}), ingestionInline: false, ...overrides };
}

export function getSettings(): Settings {
  return loadSettings(process.env);
}
