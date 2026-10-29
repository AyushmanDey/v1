/**
 * In-process stand-ins for Supabase (Auth JWKS, PostgREST, Storage, ingestion RPCs) and an
 * OpenAI-compatible provider, so the real Next.js server can be exercised end to end.
 * Row-level security is approximated: owners manage courses, members can read them.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, decodeJwt, exportJWK, generateKeyPair } from "jose";

export const SERVICE_ROLE_KEY = "service-role-secret";
export const ANON_KEY = "anon-public-key";
export const AI_API_KEY = "ai-provider-secret";
export const EMBEDDING_MODEL = "mock-embedding-1";
const DIMENSIONS = 256;

interface Course { id: string; owner_id: string; name: string; code: string; created_at: string }
interface Document { id: string; course_id: string; title: string; file_name: string; mime_type: string; size_bytes: number; sha256: string; storage_path: string; created_by: string; status: string; created_at: string; updated_at: string }
interface Job { id: string; document_id: string; status: string; attempt_count: number; max_attempts: number; lease_token: string | null; last_error: string | null; next_attempt_at: number; created_at: string }
interface Chunk { id: string; document_id: string; course_id: string; chunk_index: number; content: string; embedding: number[]; embedding_model: string; page_start: number | null; page_end: number | null }

export interface MockUser { id: string; email: string; password: string; confirmed: boolean }

export function embed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (word.length < 3) continue;
    let hash = 2166136261;
    for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    vector[Math.abs(hash) % DIMENSIONS] += 1;
  }
  if (!vector.some((value) => value !== 0)) vector[0] = 1e-3;
  return vector;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    na += a[index] ** 2;
    nb += b[index] ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version, x-upsert",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

function send(response: ServerResponse, status: number, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const headers = { ...CORS, ...extraHeaders };
  if (body === undefined) {
    response.writeHead(status, headers).end();
  } else if (Buffer.isBuffer(body)) {
    response.writeHead(status, headers).end(body);
  } else {
    response.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
  }
}

export class MockServices {
  courses: Course[] = [];
  memberships: { course_id: string; user_id: string }[] = [];
  documents: Document[] = [];
  jobs: Job[] = [];
  chunks: Chunk[] = [];
  storage = new Map<string, { bytes: Buffer; contentType: string }>();
  signedTokens = new Map<string, string>();
  requestLog: { method: string; path: string }[] = [];
  users: MockUser[] = [];
  /** Sign-up verification codes by email; every send is logged so tests can assert when codes go out. */
  signupCodes = new Map<string, string>();
  emailsSent: { email: string; kind: string }[] = [];
  /** Simulates a broken SMTP configuration. */
  failEmailSends = false;
  /** Base retry delay; the real database uses 5 s doubling per attempt, tests scale it down. */
  retryBaseMs = 50;
  /** Number of upcoming embedding requests that fail with HTTP 500 (simulates a provider outage). */
  failEmbeddings = 0;
  /** When set, embedding requests wait for this promise (holds a job mid-indexing). */
  embeddingGate: Promise<void> | null = null;
  url = "";
  private server?: Server;
  private privateKey?: CryptoKey;
  private jwks?: object;

  async start(): Promise<void> {
    const pair = await generateKeyPair("ES256", { extractable: true });
    this.privateKey = pair.privateKey;
    this.jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "mock-key", alg: "ES256", use: "sig" }] };
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        console.error("mock_service_error", error);
        send(response, 500, { message: String(error) });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  addUser(email: string, password = "correct-horse-battery"): MockUser {
    const user = { id: randomUUID(), email, password, confirmed: true };
    this.users.push(user);
    return user;
  }

  async tokenFor(user: MockUser, overrides: { expiresIn?: string; role?: string } = {}): Promise<string> {
    return new SignJWT({ email: user.email, role: overrides.role ?? "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "mock-key" })
      .setSubject(user.id)
      .setIssuer(`${this.url}/auth/v1`)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? "1h")
      .sign(this.privateKey!);
  }

  private caller(request: IncomingMessage): { service: boolean; userId: string | null } {
    const token = (request.headers.authorization ?? "").replace(/^Bearer /i, "");
    if (token === SERVICE_ROLE_KEY) return { service: true, userId: null };
    try {
      const claims = decodeJwt(token);
      return { service: false, userId: typeof claims.sub === "string" ? claims.sub : null };
    } catch {
      return { service: false, userId: null };
    }
  }

  private sendSignupCode(email: string) {
    const code = String(Math.floor(10_000_000 + Math.random() * 89_999_999));
    this.signupCodes.set(email, code);
    this.emailsSent.push({ email, kind: "signup-code" });
  }

  private async sessionFor(user: MockUser) {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: await this.tokenFor(user), token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: randomUUID(),
      user: { id: user.id, aud: "authenticated", role: "authenticated", email: user.email, app_metadata: { provider: "email" }, user_metadata: {}, created_at: new Date().toISOString(), email_confirmed_at: new Date().toISOString() },
    };
  }

  canAccess(courseId: string, userId: string | null): boolean {
    const course = this.courses.find((item) => item.id === courseId);
    return Boolean(course && userId && (course.owner_id === userId || this.memberships.some((m) => m.course_id === courseId && m.user_id === userId)));
  }

  canManage(courseId: string, userId: string | null): boolean {
    return Boolean(userId && this.courses.find((item) => item.id === courseId)?.owner_id === userId);
  }

  documentStatus(documentId: string): string | undefined {
    return this.documents.find((document) => document.id === documentId)?.status;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url!, this.url);
    const path = url.pathname;
    const method = request.method!;
    this.requestLog.push({ method, path });
    if (method === "OPTIONS") return send(response, 204);
    const raw = await readBody(request);
    const body = () => (raw.length ? JSON.parse(raw.toString("utf8")) : {});

    // ---------- OpenAI-compatible provider ----------
    if (path.startsWith("/v1/")) {
      if (request.headers.authorization !== `Bearer ${AI_API_KEY}`) return send(response, 401, { error: "bad key" });
      if (path === "/v1/embeddings" && method === "POST") {
        const { model, input } = body();
        if (model !== EMBEDDING_MODEL) return send(response, 400, { error: "unknown model" });
        if (this.embeddingGate) await this.embeddingGate;
        if (this.failEmbeddings > 0) {
          this.failEmbeddings--;
          return send(response, 500, { error: "provider temporarily unavailable" });
        }
        return send(response, 200, { data: (input as string[]).map((text, index) => ({ index, embedding: embed(text) })) });
      }
      if (path === "/v1/chat/completions" && method === "POST") {
        const payload = body();
        const { question, sources } = JSON.parse(payload.messages[1].content) as { question: string; sources: { source_id: string; content: string }[] };
        if (/unanswerable/i.test(question) || sources.length === 0) {
          return send(response, 200, { choices: [{ message: { content: JSON.stringify({ answer: "", insufficient_evidence: true, citations: [] }) } }] });
        }
        const top = sources[0];
        const sentence = top.content.split(/(?<=\.)\s/)[0];
        const content = JSON.stringify({ answer: `From the course materials: ${sentence} [${top.source_id}]`, insufficient_evidence: false, citations: [top.source_id] });
        return send(response, 200, { choices: [{ message: { content } }] });
      }
    }

    // ---------- Supabase Auth ----------
    if (path === "/auth/v1/.well-known/jwks.json") return send(response, 200, this.jwks);
    if (path === "/auth/v1/token" && method === "POST") {
      const { email, password } = body();
      const user = this.users.find((item) => item.email === email && item.password === password);
      if (!user) return send(response, 400, { error: "invalid_grant", error_description: "Invalid login credentials", msg: "Invalid login credentials", code: "invalid_credentials" });
      if (!user.confirmed) return send(response, 400, { code: 400, error_code: "email_not_confirmed", msg: "Email not confirmed" });
      return send(response, 200, await this.sessionFor(user));
    }
    if (path === "/auth/v1/signup" && method === "POST") {
      // "Confirm email" on: create an unconfirmed user, email an 8-digit code, return no session.
      const { email, password } = body();
      let user = this.users.find((item) => item.email === email);
      // Existing confirmed account: Supabase sends nothing and returns a user with no identities.
      if (user?.confirmed) {
        return send(response, 200, { id: randomUUID(), aud: "authenticated", role: "", email, phone: "", app_metadata: {}, user_metadata: {}, identities: [], created_at: new Date().toISOString() });
      }
      // SMTP failure: Supabase rolls the new account back and reports the send error.
      if (this.failEmailSends) {
        return send(response, 500, { code: 500, error_code: "unexpected_failure", msg: "Error sending confirmation email" });
      }
      if (!user) {
        user = { id: randomUUID(), email, password, confirmed: false };
        this.users.push(user);
      }
      if (!user.confirmed) this.sendSignupCode(email);
      const identity = { identity_id: randomUUID(), id: user.id, user_id: user.id, provider: "email", identity_data: { email, sub: user.id }, created_at: new Date().toISOString() };
      return send(response, 200, { id: user.id, aud: "authenticated", role: "", email, phone: "", confirmation_sent_at: new Date().toISOString(), app_metadata: { provider: "email" }, user_metadata: {}, identities: [identity], created_at: new Date().toISOString() });
    }
    if (path === "/auth/v1/verify" && method === "POST") {
      const { email, token, type } = body();
      const user = this.users.find((item) => item.email === email);
      if (!user || !["email", "signup"].includes(type) || !this.signupCodes.has(email) || this.signupCodes.get(email) !== token) {
        return send(response, 403, { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" });
      }
      user.confirmed = true;
      this.signupCodes.delete(email);
      return send(response, 200, await this.sessionFor(user));
    }
    if (path === "/auth/v1/resend" && method === "POST") {
      const { email, type } = body();
      const user = this.users.find((item) => item.email === email);
      if (type === "signup" && user && !user.confirmed) this.sendSignupCode(email);
      return send(response, 200, {});
    }
    if (path === "/auth/v1/user" && method === "GET") {
      const { userId } = this.caller(request);
      const user = this.users.find((item) => item.id === userId);
      if (!user) return send(response, 401, { msg: "invalid JWT" });
      return send(response, 200, { id: user.id, aud: "authenticated", role: "authenticated", email: user.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() });
    }
    if (path === "/auth/v1/logout") return send(response, 204);

    const signedDownload = method === "GET" && path.startsWith("/storage/v1/object/sign/");
    if ((path.startsWith("/rest/") || path.startsWith("/storage/")) && !signedDownload && !request.headers.apikey) {
      return send(response, 401, { message: "No API key found in request" });
    }
    const caller = this.caller(request);

    // ---------- Storage ----------
    const signMatch = path.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
    if (signMatch) {
      const objectPath = decodeURIComponent(signMatch[2]);
      if (method === "GET") {
        const token = url.searchParams.get("token");
        const stored = this.storage.get(objectPath);
        if (!token || this.signedTokens.get(token) !== objectPath || !stored) return send(response, 400, { message: "invalid signature" });
        return send(response, 200, stored.bytes, { "Content-Type": stored.contentType });
      }
      if (!this.canAccess(objectPath.split("/")[0], caller.userId)) return send(response, 400, { statusCode: "403", message: "Object not found" });
      const token = randomBytes(12).toString("hex");
      this.signedTokens.set(token, objectPath);
      return send(response, 200, { signedURL: `/object/sign/${signMatch[1]}/${signMatch[2]}?token=${token}` });
    }
    const bucketMatch = path.match(/^\/storage\/v1\/object\/([^/]+)$/);
    if (bucketMatch && method === "DELETE") {
      const { prefixes } = body() as { prefixes: string[] };
      // Storage delete policy: only course managers (or the service role) may remove objects.
      const allowed = prefixes.filter((prefix) => caller.service || this.canManage(prefix.split("/")[0], caller.userId));
      for (const prefix of allowed) this.storage.delete(prefix);
      return send(response, 200, allowed.map((name) => ({ name })));
    }
    const objectMatch = path.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (objectMatch) {
      const objectPath = decodeURIComponent(objectMatch[2]);
      if (method === "POST") {
        if (!this.canManage(objectPath.split("/")[0], caller.userId)) return send(response, 403, { statusCode: "403", message: "new row violates row-level security policy" });
        if (this.storage.has(objectPath)) return send(response, 409, { message: "The resource already exists" });
        this.storage.set(objectPath, { bytes: raw, contentType: String(request.headers["content-type"]) });
        return send(response, 200, { Key: `${objectMatch[1]}/${objectPath}` });
      }
      if (method === "GET") {
        if (!caller.service) return send(response, 403, { message: "forbidden" });
        const stored = this.storage.get(objectPath);
        return stored ? send(response, 200, stored.bytes, { "Content-Type": stored.contentType }) : send(response, 404, { message: "not found" });
      }
    }

    // ---------- PostgREST ----------
    if (path === "/rest/v1/courses" && method === "GET") {
      if (!caller.userId) return send(response, 401, { code: "PGRST301", message: "JWT invalid" });
      const idFilter = url.searchParams.get("id")?.replace(/^eq\./, "");
      const visible = this.courses
        .filter((course) => this.canAccess(course.id, caller.userId) && (!idFilter || course.id === idFilter))
        .sort((a, b) => a.name.localeCompare(b.name));
      return send(response, 200, visible.map(({ id, name, code, created_at }) => ({ id, name, code, created_at })));
    }
    if (path === "/rest/v1/courses" && method === "POST") {
      const row = body();
      if (!caller.userId || row.owner_id !== caller.userId) return send(response, 403, { code: "42501", message: "new row violates row-level security policy" });
      // Like the real SELECT policy, RETURNING the new row is rejected during the insert.
      if (String(request.headers.prefer).includes("return=representation")) {
        return send(response, 403, { code: "42501", message: 'new row violates row-level security policy for table "courses"' });
      }
      const course: Course = { id: row.id ?? randomUUID(), owner_id: row.owner_id, name: row.name, code: row.code, created_at: new Date().toISOString() };
      this.courses.push(course);
      return send(response, 201);
    }
    if (path === "/rest/v1/course_documents" && method === "POST") {
      const row = body();
      if (!this.canManage(row.course_id, caller.userId) || row.created_by !== caller.userId) return send(response, 403, { code: "42501", message: "row-level security" });
      const now = new Date().toISOString();
      this.documents.push({ ...row, status: "queued", created_at: now, updated_at: now });
      this.jobs.push({ id: randomUUID(), document_id: row.id, status: "queued", attempt_count: 0, max_attempts: 5, lease_token: null, last_error: null, next_attempt_at: Date.now(), created_at: now });
      return send(response, 201);
    }
    if (path === "/rest/v1/course_documents" && method === "GET") {
      const filter = (name: string) => url.searchParams.get(name);
      const eq = (name: string) => filter(name)?.replace(/^eq\./, "");
      const neq = filter("status")?.startsWith("neq.") ? filter("status")!.slice(4) : undefined;
      const rows = this.documents
        .filter((document) => caller.service || this.canAccess(document.course_id, caller.userId))
        .filter((document) => (!eq("course_id") || document.course_id === eq("course_id")) && (!eq("id") || document.id === eq("id")))
        .filter((document) => (!eq("sha256") || document.sha256 === eq("sha256")) && (!neq || document.status !== neq))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const withJobs = (filter("select") ?? "").includes("document_ingestion_jobs(");
      return send(response, 200, rows.map((document) => ({
        id: document.id, title: document.title, file_name: document.file_name, mime_type: document.mime_type, size_bytes: document.size_bytes,
        status: document.status, created_at: document.created_at, updated_at: document.updated_at, sha256: document.sha256,
        ...(withJobs ? {
          // Like RLS on document_ingestion_jobs: only course managers see job rows.
          document_ingestion_jobs: this.canManage(document.course_id, caller.userId) || caller.service
            ? this.jobs.filter((job) => job.document_id === document.id).map(({ status, attempt_count, max_attempts, last_error, created_at }) => ({ status, attempt_count, max_attempts, last_error, created_at }))
            : [],
        } : {}),
      })));
    }

    const rpc = path.match(/^\/rest\/v1\/rpc\/(\w+)$/)?.[1];
    if (rpc && method === "POST") return this.rpc(rpc, body(), caller, response);
    return send(response, 404, { message: `mock: no route for ${method} ${path}` });
  }

  private rpc(name: string, args: Record<string, unknown>, caller: { service: boolean; userId: string | null }, response: ServerResponse) {
    const serviceOnly = ["claim_document_ingestion_job", "complete_document_ingestion", "fail_document_ingestion", "renew_document_ingestion_job"];
    if (serviceOnly.includes(name) && !caller.service) return send(response, 403, { code: "42501", message: "permission denied" });
    switch (name) {
      case "delete_course_document": {
        // Mirrors 20261028000100_document_deletion.sql.
        const courseId = String(args.target_course_id);
        if (!this.canAccess(courseId, caller.userId)) return send(response, 200, null);
        const document = this.documents.find((item) => item.id === args.target_document_id && item.course_id === courseId);
        if (!document) return send(response, 200, null);
        if (!this.canManage(courseId, caller.userId)) return send(response, 403, { code: "42501", message: "Only course managers can delete course documents" });
        // ON DELETE CASCADE: chunks and ingestion jobs go with the document row.
        this.documents = this.documents.filter((item) => item.id !== document.id);
        this.chunks = this.chunks.filter((chunk) => chunk.document_id !== document.id);
        this.jobs = this.jobs.filter((job) => job.document_id !== document.id);
        return send(response, 200, document.storage_path);
      }
      case "current_user_can_access_course":
        return send(response, 200, this.canAccess(String(args.target_course_id), caller.userId));
      case "match_course_document_chunks": {
        const courseId = String(args.target_course_id);
        if (!this.canAccess(courseId, caller.userId)) return send(response, 200, []);
        const query = JSON.parse(String(args.query_embedding)) as number[];
        const rows = this.chunks
          .filter((chunk) => chunk.course_id === courseId && chunk.embedding_model === args.target_embedding_model)
          .map((chunk) => ({ chunk, similarity: cosine(query, chunk.embedding) }))
          .filter((row) => row.similarity >= Number(args.minimum_similarity))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, Number(args.maximum_results))
          .map(({ chunk, similarity }) => {
            const document = this.documents.find((item) => item.id === chunk.document_id)!;
            return { chunk_id: chunk.id, document_id: chunk.document_id, chunk_index: chunk.chunk_index, title: document.title, file_name: document.file_name, storage_path: document.storage_path, content: chunk.content, page_start: chunk.page_start, page_end: chunk.page_end, similarity };
          });
        return send(response, 200, rows);
      }
      case "claim_document_ingestion_job": {
        const job = this.jobs.filter((item) => item.status === "queued" && item.next_attempt_at <= Date.now()).sort((a, b) => a.next_attempt_at - b.next_attempt_at)[0];
        if (!job) return send(response, 200, []);
        job.status = "processing";
        job.attempt_count++;
        job.lease_token = randomUUID();
        const document = this.documents.find((item) => item.id === job.document_id)!;
        document.status = "processing";
        return send(response, 200, [{ job_id: job.id, lease_token: job.lease_token, document_id: document.id, attempt_count: job.attempt_count, max_attempts: job.max_attempts, title: document.title, file_name: document.file_name, mime_type: document.mime_type, storage_path: document.storage_path, size_bytes: document.size_bytes, sha256: document.sha256 }]);
      }
      case "renew_document_ingestion_job": {
        const job = this.jobs.find((item) => item.id === args.target_job_id);
        return send(response, 200, Boolean(job && job.status === "processing" && job.lease_token === args.target_lease_token));
      }
      case "complete_document_ingestion": {
        const job = this.jobs.find((item) => item.id === args.target_job_id && item.lease_token === args.target_lease_token && item.status === "processing");
        if (!job) return send(response, 409, { message: "lease lost" });
        const document = this.documents.find((item) => item.id === job.document_id)!;
        for (const payload of args.chunk_payloads as Omit<Chunk, "id" | "document_id" | "course_id">[]) {
          this.chunks.push({ ...payload, id: randomUUID(), document_id: document.id, course_id: document.course_id });
        }
        job.status = "succeeded";
        job.lease_token = null;
        document.status = "ready";
        document.updated_at = new Date().toISOString();
        return send(response, 204);
      }
      case "fail_document_ingestion": {
        const job = this.jobs.find((item) => item.id === args.target_job_id && item.lease_token === args.target_lease_token);
        if (!job) return send(response, 409, { message: "lease lost" });
        // Mirrors fail_document_ingestion: requeue with exponential backoff until the attempt limit.
        const nextStatus = job.attempt_count >= job.max_attempts ? "failed" : "queued";
        job.last_error = String(args.error_message);
        job.lease_token = null;
        job.status = nextStatus;
        job.next_attempt_at = Date.now() + this.retryBaseMs * 2 ** Math.min(job.attempt_count - 1, 6);
        const document = this.documents.find((item) => item.id === job.document_id)!;
        document.status = nextStatus;
        document.updated_at = new Date().toISOString();
        return send(response, 200, nextStatus);
      }
      default:
        return send(response, 404, { message: `unknown rpc ${name}` });
    }
  }
}
