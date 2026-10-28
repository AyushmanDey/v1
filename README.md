# NEXIS Campus AI

NEXIS is a pilot campus learning workspace with a course-grounded assistant. The current foundation includes a Next.js and TypeScript frontend, a FastAPI backend, Supabase Auth and PostgreSQL integration, private course document storage, retryable document ingestion, and citation-aware retrieval.

## Architecture

This project is a modular monolith: one Next.js app and one FastAPI application. Supabase provides authentication, PostgreSQL with row-level security, private object storage, and pgvector. Hosted chat and embedding providers are configured through server-side environment variables.

See [docs/architecture.md](docs/architecture.md) for the system structure and security boundaries.

## Local setup

1. Copy `.env.example` to `.env.local` for the frontend and to `backend/.env` for the API. Fill in the Supabase URL and public/anonymous key in both files. Keep the service role key and AI provider key only in `backend/.env`.
2. Apply the SQL files in `supabase/migrations/` to your Supabase project in order.
3. Install frontend dependencies and start Next.js:

   ```bash
   npm install
   npm run dev
   ```

4. In a second terminal, install and run the API:

   ```bash
   cd backend
   python -m pip install -e ".[dev]"
   python -m uvicorn app.main:app --reload --port 8000
   ```

The web app runs at `http://localhost:3000`; the API documentation is at `http://localhost:8000/docs`.

## Tests

Run the backend test suite from the repository root:

```bash
python -m pytest backend/tests -q
```

## Security notes

- Do not commit `.env`, `.env.local`, or `backend/.env` files. `.env.example` contains blank placeholders only.
- Keep course storage private. Access is enforced by the API and Supabase row-level security policies.
- Retrieved document content is untrusted input. Campus-grounded answers must cite retrievable sources and abstain when evidence is insufficient.
- The initial release does not execute generated code.
