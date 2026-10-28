/** Shared HTTP helpers for the NEXIS API route handlers and server services. */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly headers: Record<string, string>;

  constructor(status: number, detail: string, headers: Record<string, string> = {}) {
    super(detail);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

/** Raised when a network request to an upstream service fails before a response arrives. */
export class UpstreamConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpstreamConnectionError";
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json({ detail: error.detail }, { status: error.status, headers: error.headers });
  }
  console.error("unhandled_api_error", error instanceof Error ? error.name : typeof error);
  return Response.json({ detail: "Internal server error" }, { status: 500 });
}

/** Run a route handler body and translate thrown HttpErrors into JSON error responses. */
export async function handleRoute(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return errorResponse(error);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

/** Canonical lowercase hyphenated UUID, matching Python's str(UUID(value)). */
export function normalizeUuid(value: string): string {
  const hex = value.trim().replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function requireUuidParam(value: string, name: string): string {
  if (!isUuid(value)) throw new HttpError(422, `${name} must be a valid UUID`);
  return normalizeUuid(value);
}

/** Percent-encode a value like Python's urllib.parse.quote, optionally keeping slashes. */
export function encodePath(value: string, preserveSlashes = false): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return preserveSlashes ? encoded.replace(/%2F/g, "/") : encoded;
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(422, "Request body must be valid JSON");
  }
}

/** Wrap fetch so connection failures become UpstreamConnectionError and requests time out. */
export async function upstreamFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  try {
    return await fetchImpl(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new UpstreamConnectionError("Upstream request failed", { cause: error });
  }
}

/** Reject provider URLs that embed credentials or use plaintext HTTP off localhost. */
export function isSafeProviderEndpoint(endpoint: string): "ok" | "credentials" | "insecure" {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return "insecure";
  }
  if (parsed.username || parsed.password) return "credentials";
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(host)) return "insecure";
  return "ok";
}
