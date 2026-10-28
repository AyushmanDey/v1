# NEXIS Campus AI architecture

## Pilot shape

NEXIS uses a modular monolith: a single Next.js App Router application serves the
web UI and the `/api/v1` route handlers. Feature modules live in server-only
TypeScript code under `lib/server/` and share common authentication,
persistence, and provider interfaces. They are not deployed as independent
microservices.

Supabase provides PostgreSQL, Auth, private object storage, and pgvector. The
browser uses the Supabase public client configuration for sign-in and calls the
API on the same origin with the user's access token. Route handlers validate the
Supabase access token and enforce authorization for every protected operation.
Database row-level security is an additional boundary. Course files remain in a
private bucket; ingestion jobs persist state, attempts, and errors so work can be
retried and observed.

Hosted language-model and embedding APIs are behind server-side provider
interfaces. Retrieved document text is untrusted input. A campus-grounded answer
must cite source identifiers that can be checked by the user, and must say when
the retrieved evidence does not support an answer. The initial release does not
execute arbitrary generated code.

## Project layout

```text
app/                          Next.js pages and layouts
app/api/v1/                   API route handlers (health, me, courses, documents, assistant)
components/                   Shared frontend UI
lib/supabase/                 Browser client and session-refresh proxy helper
lib/server/                   Server-only modules: settings, HTTP errors, auth, courses
lib/server/documents/         Upload validation, storage registration, extraction, chunking
lib/server/ai/                OpenAI-compatible embedding provider
lib/server/assistant/         Retrieval and cited answer generation
lib/server/workers/           Ingestion queue gateway and job processing
scripts/worker.ts             Standalone ingestion worker CLI
tests/unit/                   Unit tests (node:test via tsx)
tests/e2e/                    End-to-end tests against mock Supabase and AI services
supabase/migrations/          SQL schema, RLS, pgvector, and storage policies
```

## Configuration

Use `.env.example` as the variable-name reference and copy it to `.env.local`.
Only `NEXT_PUBLIC_` variables reach the browser; the service role key and AI
provider key are read only by server code. Blank values are treated as unset.
Never commit real credentials.

`proxy.ts` refreshes the Supabase session cookie for page requests. It does not
run for `/api/*`: the API authenticates with Bearer tokens, and skipping the
proxy keeps multipart uploads from being buffered and truncated by the proxy's
request body limit.

## Authentication and course access

The API accepts Supabase access tokens using the Bearer scheme. It verifies the
signature against the project's asymmetric JWKS endpoint (ES256, RS256, or
EdDSA, via `jose`) and checks issuer, audience, expiry, subject, and
authenticated role. Unreachable key servers return 503 rather than 401.
`/api/v1/me` is a protected identity check. The first Supabase migration defines
course owners and members with row-level policies; later feature tables must
have similarly explicit policies before they are exposed to clients.

## Course documents

The second Supabase migration creates a non-public `course-documents` bucket,
course-scoped storage policies, document metadata, and ingestion job records.
Uploads are limited to 25 MiB and PDF, text, or DOCX content. Storage paths
start with the course UUID, and only course managers can upload; course members
can read files. The database creates one queued ingestion job when metadata is
inserted, tracks attempts and retry timing, and exposes failed-document retry
through a manager-checked database function. Ingestion must verify file content
and update document/job state; MIME metadata alone is not trusted. DOCX files
are checked against their ZIP central directory (member count and expanded
size) without decompressing them.

The upload route sends the user's JWT with the project's public API key to both
Storage and PostgREST. The JWT lets the database and Storage policies enforce
course-manager permissions. A failed metadata insert triggers a best-effort
Storage cleanup, with failures logged for reconciliation. The route rejects
requests whose declared size exceeds the limit and checks the 25 MiB file limit
after multipart parsing; deployment ingress should also cap request bodies.

## Deleting course materials

Course managers delete a material through `DELETE /api/v1/courses/{id}/documents/{documentId}`. The
`delete_course_document` database function (migration `20261028000100`) checks, as the signed-in user, that the
document belongs to that course and that the user manages it; non-members get "not found". It deletes the
document row, which cascades to its chunks (embeddings) and ingestion jobs in one transaction, so the content
stops being retrievable immediately. The API then removes the stored file with the user's token under the
storage manager policy, retrying once and logging any orphaned file. Signed links issued earlier stop working
because the object is gone. An indexing job running at the time loses its lease (its job row is gone) and
stops without saving chunks. The UI marks citations to deleted materials as "Source deleted".

## Ingestion

Ingestion runs in one of two ways, both using the same code in
`lib/server/workers/ingestion.ts`:

- **Inline (default):** after an upload response is sent, the route handler uses
  `after()` to drain the queue inside the Next.js server process. Concurrent
  uploads coalesce into one drain loop per process.
- **Standalone:** `npm run worker` polls the queue (`--once` processes at most
  one job). Set `INGESTION_INLINE=false` to use only this mode.

Jobs are claimed through a `SKIP LOCKED` database function, so both modes can
run at once safely. The worker verifies file size and SHA-256, extracts
PDF (per page, via `unpdf`), TXT, and DOCX (via `mammoth`) text, chunks it with
page references where the format supports them, renews its lease between
stages, and calls a configured OpenAI-compatible embeddings endpoint.
Completion stores chunks and embeddings atomically; failures record a safe error
code and use exponential retry timing before the attempt limit. The pgvector
column stores the provider's returned dimension; this pilot uses exact
similarity scans until an embedding model and index dimension are selected.
Worker credentials and embedding keys must be set only in server processes.

## Campus assistant

The campus assistant endpoint checks course access, embeds the question, calls
a course-scoped similarity function as the authenticated user, and only sends
threshold-matching chunks to the answer model. It treats all retrieved fields as
untrusted data, abstains when retrieval or model assessment finds insufficient
evidence, and rejects model citations (including inline `[S#]` references) that
do not identify retrieved chunks. Responses include chunk/document IDs, page or
chunk references, excerpts, and one-hour signed links. The default similarity
threshold (`0.70`) is a pilot starting point and must be calibrated against
representative campus questions before launch.
