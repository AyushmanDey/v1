# Run NEXIS locally with Ollama

This guide takes a new developer from a fresh machine to asking cited questions about course
material, with the AI running locally and for free through [Ollama](https://ollama.com).
It takes about 20 minutes, most of it downloading models.

`npm install` installs only the JavaScript packages. Ollama and its models are installed separately
(steps 2–3).

## What you need

| Requirement | Notes |
| --- | --- |
| macOS, Windows, or Linux | Apple Silicon Macs run the models on the GPU and are fastest |
| 16 GB RAM recommended | 8 GB works, but answers are slower and other apps may suffer |
| About 6 GB free disk | For the two models |
| Node.js 20.9 or newer | Check with `node -v`. Install the LTS from [nodejs.org](https://nodejs.org) |
| Git | To clone the repository |
| Supabase access | Either the team's project keys (ask the project owner) or your own project (step 5) |

## 1. Get the code

```bash
git clone https://github.com/AyushmanDey/v1.git nexis
cd nexis
git checkout real-ayushman
npm install
```

## 2. Install Ollama

- **macOS:** download from [ollama.com/download](https://ollama.com/download) and open the app,
  or with Homebrew: `brew install ollama && brew services start ollama`.
- **Windows:** run the installer from [ollama.com/download](https://ollama.com/download). Ollama
  then runs in the system tray.
- **Linux:** `curl -fsSL https://ollama.com/install.sh | sh` (installs and starts a service).

Check it is running:

```bash
curl http://localhost:11434
# → Ollama is running
```

If it is not running, start it with `ollama serve` in a separate terminal and leave that open.

## 3. Download the models

```bash
ollama pull nomic-embed-text   # embeddings, ~270 MB
ollama pull qwen2.5:7b         # answers, ~4.7 GB
```

Quick check:

```bash
ollama run qwen2.5:7b "Reply with OK"
```

## 4. Create `.env.local`

```bash
cp .env.example .env.local
```

Fill it in like this (the Supabase values come from step 5):

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable / anon key>

SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=<secret / service_role key>
SUPABASE_STORAGE_BUCKET=course-documents

AI_API_KEY=
AI_EMBEDDING_ENDPOINT=http://localhost:11434/v1/embeddings
AI_EMBEDDING_MODEL=nomic-embed-text
AI_CHAT_ENDPOINT=http://localhost:11434/v1/chat/completions
AI_CHAT_MODEL=qwen2.5:7b
AI_CHAT_REASONING_EFFORT=
AI_KEEP_ALIVE=1h

RAG_MIN_SIMILARITY=0.5
RAG_MAX_CHUNKS=4
RAG_RELEVANCE_MARGIN=0.10

INGESTION_INLINE=true
```

Notes:

- Leave `SUPABASE_URL` and `SUPABASE_ANON_KEY` blank; they default to the public values.
- `AI_API_KEY` stays blank for Ollama. `AI_KEEP_ALIVE` keeps the model loaded between questions and
  warms it up when the server starts.
- `RAG_MIN_SIMILARITY=0.5` suits `nomic-embed-text`; the `.env.example` default (0.70) is meant for
  OpenAI embeddings.
- `.env.local` is gitignored. Never commit it, and never put the secret key in a `NEXT_PUBLIC_`
  variable.

## 5. Supabase

### Option A: use the team's project (simplest)

Ask the project owner for the project URL, the publishable key, and the secret key. The database
is already set up, so there is nothing to run. Share the secret key privately; it has full admin
access.

### Option B: your own Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. In **Project Settings → API Keys**, copy the project URL, the publishable key, and the secret key
   into `.env.local`.
3. In the **SQL Editor**, run each file in `supabase/migrations/` **in this order**, one at a time:
   1. `20261027000100_course_access.sql`
   2. `20261027000200_course_documents.sql`
   3. `20261027000300_document_ingestion.sql`
   4. `20261027000400_course_retrieval.sql`
   5. `20261028000100_document_deletion.sql`
4. In **Authentication → Sign In / Providers → User Signups**, decide on **Confirm email**:
   - **Off** (easiest for local development): sign-up logs you in immediately.
   - **On**: sign-up emails a verification code. This needs custom SMTP under
     **Authentication → Emails → SMTP Settings** and the **Confirm signup** template set to show
     `{{ .Token }}`. See the "Sign-up codes" section below.

## 6. Start the app

```bash
npm run dev
```

Open <http://localhost:3000>. The API is served by the same app at <http://localhost:3000/api/v1>.
<http://localhost:3000/api/v1/health> should return `{"status":"ok"}`.

The terminal logs `ai_models_warmed` once Ollama has loaded the models in the background.

## 7. Try it

1. Click **New here? Create an account** and sign up.
2. Click **New course** and create a course.
3. Click **Add course material** and upload a PDF, DOCX, or TXT file (up to 25 MiB).
4. Wait for the **“… is ready”** notification. Indexing usually takes a few seconds.
5. Ask a question about the material. The answer cites its sources with page numbers and links.

Off-topic questions (for example, "How do I make pizza?") are answered with "I couldn't find enough
relevant evidence…". That is expected.

## Everyday use

- **Ollama must be running** whenever you index documents or ask questions. Uploads made while it is
  off wait in the queue and are indexed once it is back (keep the course's materials list open).
- **Optional separate worker:** set `INGESTION_INLINE=false` and run `npm run worker` in a second
  terminal to index outside the web server.
- **Tests:** `npm test` (unit) and `npm run test:e2e` (production build, API, and browser tests; needs
  Google Chrome or `CHROME_PATH`). Neither needs Ollama or Supabase; they use local mocks.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Campus embeddings provider is unavailable" or "The AI indexing service was unavailable" | Ollama isn't running, or a model is missing. Run `curl http://localhost:11434` and `ollama list` |
| The first answer takes 10–20 s | The model was loading. Later answers take about 3–6 s. `AI_KEEP_ALIVE=1h` keeps it loaded |
| A document stays **Queued** | Keep the materials list open (it re-triggers indexing), and check that Ollama is running |
| Every question says it couldn't find enough evidence | Check that `RAG_MIN_SIMILARITY=0.5` is set, and that `AI_EMBEDDING_MODEL` matches the model the documents were indexed with |
| Documents uploaded by teammates are not found | Everyone sharing a Supabase project must use the **same embedding model** (`nomic-embed-text`). The chat model can differ |
| "Your sign-in to Supabase is invalid or expired" | Sign out and in again; check that the URL and keys in `.env.local` belong to the same project |
| "Document deletion is not set up" | Run `20261028000100_document_deletion.sql` in the SQL Editor |
| Sign-up says "We couldn't send the verification email" | Confirm email is on but SMTP is failing. Check **Logs → Auth** for the SMTP error, or turn Confirm email off |
| "Another next dev server is already running" | Next allows one dev server per folder. Stop the other one, or use the URL it prints |
| Answers are slow on a machine with less memory | Try `AI_CHAT_MODEL=qwen2.5:3b` (faster, less reliable with citations), after `ollama pull qwen2.5:3b` |

## Sign-up codes (optional)

To require a code when someone signs up (sign-in stays password only):

1. **Authentication → Emails → SMTP Settings**: enable custom SMTP. With Gmail, use host
   `smtp.gmail.com`, port `465`, your full Gmail address as username and sender, and a Google
   **App password** (needs 2-Step Verification) as the password. A normal Gmail password fails with
   `535 Username and Password not accepted`.
2. **Authentication → Emails → Templates → Confirm signup**: put `{{ .Token }}` in the body.
3. **Authentication → Sign In / Providers → User Signups**: turn **Confirm email** on and save.

The app already shows the code screen when Supabase asks for a code. No code changes are needed.
