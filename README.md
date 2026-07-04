# Homeopathy Notes Q&A Portal

A single-page app that answers questions about a condition or medicine **strictly**
from `notes.json` (OCR'd homeopathy notes). It never falls back on general
homeopathy knowledge. See [SPEC.md](SPEC.md) for the full brief.

## Project structure

```
notes.json                  # source of truth, one JSON array of page objects
public/                     # static frontend (index.html) + a copy of notes.json
netlify/functions/ask.mjs   # serverless proxy (/ask endpoint)
netlify.toml                # publish dir + functions dir config
```

The frontend and the function each need their own copy of `notes.json`:
the function imports the root file directly at build time (bundled in by
esbuild), but `public/notes.json` is a separate copy so the static frontend
can show original page text when a citation chip is expanded, without an
extra network round trip.

**Whenever you edit or append to the root `notes.json`, re-copy it before
deploying the frontend:**

```
cp notes.json public/notes.json
```

## How it's wired

- Model provider: **OpenRouter** (not Anthropic directly), calling
  `anthropic/claude-haiku-4.5` through OpenRouter's OpenAI-compatible
  `/chat/completions` endpoint.
- Grounding: the full `notes.json` + grounding rules are sent as the system
  message on every request, with the notes block marked
  `cache_control: { type: "ephemeral" }` so repeated requests are cheap.
- The model is forced (via `tool_choice`) to call a structured
  `answer_from_notes` tool, so the response is always well-formed JSON
  (`answer`, `citations`, `grounded`) rather than free text we'd have to parse.
- Backend runtime: a **Netlify Function** (`netlify/functions/ask.mjs`) using
  the standard Fetch API (`Request`/`Response`), mapped to the `/ask` path via
  `export const config = { path: "/ask" }` in the function file — so the
  frontend's relative `fetch('/ask')` works same-origin with no CORS needed
  once deployed.

## Local development

Install the Netlify CLI (used for `netlify dev`, which serves the static
site and the function together, respecting the `/ask` path mapping):

```
npm install -g netlify-cli   # or use `npx netlify-cli` for one-off commands
```

Create `.env` at the repo root (git-ignored, never commit it):

```
OPENROUTER_API_KEY=sk-or-...
```

Run it:

```
netlify dev
```

This serves the whole app (frontend + function) on one local port. Test the
function directly:

```
curl -X POST http://localhost:8888/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"Diabetes ki medicine?"}'
```

## Deploying (Netlify)

1. Push this repo to GitHub.
2. In the Netlify dashboard: **Add new site → Import an existing project**,
   pick the repo. Netlify reads `netlify.toml` automatically (publish
   directory `public`, functions directory `netlify/functions`) — no build
   command needed.
3. Set environment variables under **Site configuration → Environment
   variables**:
   - `OPENROUTER_API_KEY` — required.
   - `OPENROUTER_MODEL` — optional, defaults to `anthropic/claude-haiku-4.5`.
     Bump to a Sonnet model if grounding quality or Hindi handling needs it.
   - `ALLOWED_ORIGIN` — optional, restricts CORS instead of `*` (not needed
     for the default same-origin setup).
   - `APP_URL` — optional, sent as `HTTP-Referer` to OpenRouter (attribution
     only).
4. Deploy. `cp notes.json public/notes.json` before each push if you've
   updated the notes.

## Rate limiting

The function keeps an in-memory per-IP request count (30 req/min) to guard
against a stuck loop running up cost. This is best-effort: serverless
functions are stateless and cold-start frequently, so it's not a hard global
limit — just enough friction for a single-user app.

## Cost

With prompt caching, the ~11-106 page notes corpus is cached after the first
request in a cache window, so each subsequent question only pays full price
for the question + answer tokens. Netlify's free tier covers hosting; expect
well under a few dollars/month on the model side even with heavy daily use,
per the spec's cost target.

## Secrets checklist

- `.env` is git-ignored — never commit it.
- The API key is only ever read server-side (`process.env.OPENROUTER_API_KEY`)
  and is never present in the frontend bundle or any `/ask` response.
