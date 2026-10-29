# NEXIS Campus AI

NEXIS is a pilot campus learning workspace with a course-grounded assistant. The current foundation is a single Next.js and TypeScript application that serves both the web app and the API, with Supabase Auth and PostgreSQL integration, private course document storage, retryable document ingestion, and citation-aware retrieval.

## Architecture

This project is a modular monolith: one Next.js app. The App Router serves the UI and the `/api/v1` route handlers; server-only modules in `lib/server/` implement authentication, courses, document uploads, ingestion, and the campus assistant. Supabase provides authentication, PostgreSQL with row-level security, private object storage, and pgvector. Hosted chat and embedding providers are configured through server-side environment variables.

See [docs/architecture.md](docs/architecture.md) for the system structure and security boundaries.

## Local setup

1. Copy `.env.example` to `.env.local`. Fill in the Supabase URL and public/anonymous key. Add the service role key and AI provider settings as server-only variables (never with a `NEXT_PUBLIC_` prefix).
2. Apply the SQL files in `supabase/migrations/` to your Supabase project in order (paste each into the SQL Editor). Re-run this step when a new migration is added.
3. Install dependencies and start Next.js:

   ```bash
   npm install
   npm run dev
   ```

The web app runs at `http://localhost:3000` and the API at `http://localhost:3000/api/v1` (for example, `http://localhost:3000/api/v1/health`).

Uploaded documents are indexed by the Next.js server right after each upload when `SUPABASE_SERVICE_ROLE_KEY` and the embedding provider are configured. To run ingestion as a separate process instead, set `INGESTION_INLINE=false` and run:

```bash
npm run worker            # poll for queued documents
npm run worker -- --once  # process at most one job and exit
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Liveness check |
| `GET` | `/api/v1/me` | Verified identity for the Bearer token |
| `GET` | `/api/v1/courses` | Courses the user owns or belongs to |
| `POST` | `/api/v1/courses` | Create a course owned by the user (`{ name, code }`) |
| `GET` | `/api/v1/courses/{courseId}/documents` | List the course's materials with indexing status |
| `POST` | `/api/v1/courses/{courseId}/documents` | Upload a PDF, TXT, or DOCX (multipart `title`, `file`); 409 if the same file is already there |
| `DELETE` | `/api/v1/courses/{courseId}/documents/{documentId}` | Delete a material, its search index entries, and its stored file (course managers only) |
| `POST` | `/api/v1/courses/{courseId}/assistant/ask` | Ask a cited question (`{ question }`) |

Every route except health requires `Authorization: Bearer <Supabase access token>`. Errors use `{ "detail": "..." }` bodies.

## Tests

```bash
npm test           # unit tests (auth, courses, uploads, ingestion, retrieval)
npm run test:e2e   # production build + end-to-end API, ingestion, worker, and browser UI tests
```

The end-to-end suite runs the real Next.js server against local mock Supabase and AI services; the browser test uses an installed Google Chrome (set `CHROME_PATH` if it is elsewhere, or it is skipped).

## Security notes

- Do not commit `.env` or `.env.local` files. `.env.example` contains blank placeholders only.
- Keep course storage private. Access is enforced by the API and Supabase row-level security policies.
- Retrieved document content is untrusted input. Campus-grounded answers must cite retrievable sources and abstain when evidence is insufficient.
- The initial release does not execute generated code.
