# NEXIS Campus AI architecture

## Pilot shape

NEXIS uses a modular monolith: a Next.js App Router frontend and one Python
FastAPI application. Feature modules live in the API process and share common
authentication, persistence, and provider interfaces. They are not deployed as
independent microservices.

Supabase provides PostgreSQL, Auth, private object storage, and pgvector. The
browser uses the Supabase public client configuration for sign-in. FastAPI
validates the user's Supabase access token and enforces authorization for every
protected operation. Database row-level security is an additional boundary.
Course files remain in a private bucket; ingestion jobs persist state, attempts,
and errors so work can be retried and observed.

Hosted language-model and embedding APIs are behind server-side provider
interfaces. Retrieved document text is untrusted input. A campus-grounded answer
must cite source identifiers that can be checked by the user, and must say when
the retrieved evidence does not support an answer. The initial release does not
execute arbitrary generated code.

## Project layout

```text
app/                         Next.js routes and layouts
components/                  Shared frontend UI
lib/                         Frontend helpers and API client
backend/app/api/              FastAPI routers and dependencies
backend/app/core/             Settings, authentication, and logging
backend/app/modules/          Assistant, study guides, coding, documents
backend/app/services/         Model, embedding, and storage interfaces
backend/tests/                API and domain tests
supabase/migrations/          SQL schema, RLS, pgvector, and storage policies
```

Feature modules and migrations are added as their slices are implemented.

## Local API setup

Install the API and development dependencies from `backend/` with
`python -m pip install -e ".[dev]"`, then run `uvicorn app.main:app --reload`
from that directory. The health check is available at
`http://localhost:8000/api/v1/health`. No Supabase or model credentials are
needed for this foundation milestone.

Use `.env.example` as the variable-name reference. Configure the backend's
variables in its process environment or deployment secret manager; configure
frontend variables through the Next.js environment. Never commit real
credentials.

## Authentication and course access

The API accepts Supabase access tokens using the Bearer scheme. It verifies the
signature against the project's asymmetric JWKS endpoint and checks issuer,
audience, expiry, subject, and authenticated role. `/api/v1/me` is a protected
identity check. The first Supabase migration defines course owners and members
with row-level policies; later feature tables must have similarly explicit
policies before they are exposed to clients.

## Course documents

The second Supabase migration creates a non-public `course-documents` bucket,
course-scoped storage policies, document metadata, and ingestion job records.
Uploads are limited to 25 MiB and PDF, text, or DOCX MIME types. Storage paths
start with the course UUID, and only course managers can upload; course members
can read files. The database creates one queued ingestion job when metadata is
inserted, tracks attempts and retry timing, and exposes failed-document retry
through a manager-checked database function. Ingestion workers must verify file
content and update document/job state; MIME metadata alone is not trusted.

The authenticated API upload route sends the user's JWT with the project's
public API key to both Storage and PostgREST. The JWT lets the database and
Storage policies enforce course-manager permissions. A failed metadata insert
triggers a best-effort Storage cleanup, with failures logged for reconciliation.
The API checks a 25 MiB file limit after multipart parsing; deployment ingress
must also cap request bodies (including multipart overhead) to protect temporary
storage from oversized uploads.

The ingestion worker is part of the same backend package and runs as a separate
process with `python -m app.workers.ingestion` (or `--once` for one job). It
From `backend/`, run the worker with `python -m app.workers.ingestion` or
`python -m app.workers.ingestion --once`. It claims jobs through a `SKIP LOCKED` database function, verifies file size and
SHA-256, extracts PDF/TXT/DOCX text, chunks it with page references where the
format supports them, and calls a configured OpenAI-compatible embeddings
endpoint. Completion stores chunks and embeddings atomically; failures record a
safe error code and use exponential retry timing before the attempt limit. The
pgvector column stores the provider's returned dimension; this pilot uses exact
similarity scans until an embedding model and index dimension are selected.
Worker credentials and embedding keys must be set only in its server process.

The campus assistant endpoint embeds the question, calls a course-scoped
similarity function as the authenticated user, and only sends threshold-matching
chunks to the answer model. It treats all retrieved fields as untrusted data,
abstains when retrieval or model assessment finds insufficient evidence, and
rejects model citations that do not identify retrieved chunks. Responses include
chunk/document IDs, page or chunk references, excerpts, and one-hour signed
links. The default similarity threshold (`0.70`) is a pilot starting point and
must be calibrated against representative campus questions before launch.
