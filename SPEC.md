# Build Brief: Homeopathy Notes Q&A Portal

For: Claude Code
Owner: KK
Status: ready to build

---

## 1. What this is

A single-page web app where my father types a question about a condition or a
medicine and gets back an answer drawn **only** from his own scanned homeopathy
notes (already OCR'd into `notes.json`). Not a general homeopathy chatbot. It
answers from his notes and nothing else.

Users ask in **English or Hindi (Devanagari) or Hinglish**. Answers should match
the language of the question.

## 2. The one rule that matters

The model answers strictly from `notes.json`. If the answer is not in the notes,
it says so. It must **never** fall back on generic homeopathy knowledge, because
that produces confident, made-up prescriptions. Every answer names the exact
medicine + potency and cites the page number and condition it came from.

This is the whole point of the app. Do not relax it for "helpfulness."

## 3. Do NOT over-engineer

The corpus is tiny (currently ~11 pages, max ~106 when complete). It fits in one
model context. So:

- **No vector DB, no embeddings, no RAG pipeline, no chunking.**
- Load the entire `notes.json` into the system prompt on every request.
- Use **prompt caching** on the notes block so re-sending it is nearly free.

If you find yourself reaching for a database, stop. It is not needed.

## 4. Data

`notes.json` is an array of page objects. Bundle it with the app. Schema:

```json
{
  "id": "hp1-p001",
  "source_pdf": "Homeopathy_1",
  "page": 1,
  "date": "1995-02-27",
  "date_raw": "February 27 Monday 1995",
  "condition": "Diabetes",
  "remedies": [
    { "name": "Syzygium Jambolanum", "potency": null, "note": "...", "flag": null }
  ],
  "raw_text": "full transcription of the page",
  "needs_review": false
}
```

Notes on fields:
- `potency` may be null, a number ("6", "30", "200"), "1M", or "mother tincture".
- `flag` on a remedy = the OCR read was uncertain; surface it as "verify" in the UI.
- `needs_review: true` on a page = the whole page has shaky transcription; badge it.
- The file grows over time (more pages get transcribed). The app must not assume a
  fixed size. Read it dynamically.

## 5. Architecture

```
[ static single-page frontend ]  --POST /ask-->  [ serverless proxy ]  -->  [ Anthropic API ]
        (HTML/JS or one React file)                 (hides API key)
        bundles notes.json                          bundles notes.json
```

- **Frontend**: one page. Vanilla HTML+JS is fine; a single React file is fine.
  No build complexity.
- **Proxy**: Cloudflare Worker (preferred, free tier) or Vercel serverless
  function. Its only jobs are: hold the API key, inject the notes, call the model,
  return the answer. Never expose the API key client-side.
- **Hosting**: Cloudflare Pages / Vercel free tier.

## 6. Backend spec (the proxy)

Endpoint: `POST /ask`
Request: `{ "question": "string" }`
Response: `{ "answer": "string", "citations": [ { "condition": "...", "page": N } ], "grounded": true|false }`

Model call (Anthropic Messages API):
- Default model: `claude-haiku-4-5-20251001` (cheap, fine for grounded extraction).
  Bump to `claude-sonnet-5` if grounding quality or Hindi handling needs it.
- `max_tokens`: 1024.
- **System prompt**: the grounding rules (section 7) + the full `notes.json`
  serialized as text. Put the notes in their own content block with
  `cache_control: { "type": "ephemeral" }` so it is cached across requests.
- **User message**: the raw question.
- API key from env var `ANTHROPIC_API_KEY`. Never hardcode.

Add a light rate limit (e.g. 30 req/min per IP) so a stuck loop can't run up cost.

## 7. Grounding system prompt (use verbatim, then append the notes)

```
You are a lookup assistant for one person's private handwritten homeopathy notes.
You answer ONLY from the NOTES provided below. The NOTES are the complete and only
source of truth. You have no other knowledge of homeopathy and must not use any.

RULES:
1. Answer only using the NOTES. Never add medicines, potencies, indications, or
   claims that are not written in the NOTES.
2. If the question is not covered by the NOTES, say plainly: "This is not in your
   notes." Do not guess or substitute general homeopathy knowledge.
3. For every medicine you mention, give its exact name and potency AS WRITTEN in
   the notes, and cite the condition heading and page number, e.g. "(Diabetes, p.1)".
4. Answer in the same language as the question (English, Hindi/Devanagari, or a
   mix). Keep answers short and direct.
5. If a note or a medicine name is marked as uncertain (flag / needs_review), still
   report it, but add a short caution that the transcription is unverified.
6. You are surfacing what is written in the notes. You are not giving medical
   advice. Do not add dosing advice or safety claims beyond what the notes say.

NOTES:
<the full notes.json serialized here>
```

## 8. Frontend spec

Layout (top to bottom):
- Title, plain: "Homeopathy Notes" (with a Hindi subtitle is fine).
- A large search box + "Ask" button. Big touch target, large font (the user is
  older; readability first).
- Answer area below: the model's answer, with each cited page shown as a small
  chip like "Diabetes · p.1". Clicking a chip expands the full `raw_text` of that
  page so he can read the original note.
- A persistent one-line disclaimer at the bottom, bilingual:
  "Yeh sirf aapke notes se jawab deta hai, medical advice nahi. / Answers come only
  from your notes, not medical advice."

Required UI states (implement all):
- **Loading**: spinner / "Searching your notes..." while awaiting the proxy.
- **Empty**: before first query, show 3-4 example questions as tappable chips
  (e.g. "Diabetes ki medicine?", "What did notes say about jaundice?").
- **Not found**: when `grounded` is false, show the "not in your notes" message
  clearly, not as an error.
- **Error**: network/API failure gets a friendly retry message, not a stack trace.
- **Unverified**: if the answer draws on a flagged/`needs_review` item, show a small
  amber "verify" badge next to it.

Rendering:
- Support Devanagari (use a system font stack that includes it, or Noto Sans
  Devanagari via CDN).
- Preserve line breaks in `raw_text` when expanded.

## 9. Cost expectations (sanity check, not a feature)

- Full corpus ~40-60k tokens. With prompt caching, cached reads are ~10% of input
  cost, so each question is a fraction of a cent.
- Hosting: free tier.
- Target: a couple of dollars a month even with heavy daily use. If your design
  implies more, you have over-built something.

## 10. Non-goals for v1 (do not build)

- No login / auth.
- No voice input.
- No note editing in the UI.
- No multi-user accounts.
- No analytics beyond basic error logging.

## 11. Build order

1. Scaffold repo: `/public` (frontend), `/worker` (proxy), `notes.json` at root,
   this brief as `SPEC.md`.
2. Proxy first: `/ask` endpoint, grounding prompt, prompt caching, env var key,
   rate limit. Test with curl.
3. Frontend: search box + answer + citation chips + all UI states + disclaimer.
4. Wire them together. Test the four states end to end.
5. Deploy to Cloudflare (Pages + Worker) or Vercel. Document the deploy steps and
   how to set `ANTHROPIC_API_KEY` in `README.md`.

## 12. Acceptance criteria

- Asking about a condition in the notes (e.g. "diabetes") returns the exact
  medicines + potencies from that page, with a page citation.
- Asking about something NOT in the notes (e.g. "migraine") returns "not in your
  notes", never an invented remedy.
- A Hindi question gets a Hindi answer; an English question gets English.
- Clicking a citation chip shows the original page transcription.
- Flagged/unverified content is visibly marked.
- API key is never present in any client-side response or bundle.
- Adding new pages to `notes.json` and redeploying requires no code change.

## 13. Handing over more data

`notes.json` currently holds ~11 pages. More pages will be appended in the same
schema as transcription continues. The app must treat the file as the source of
truth and work at any size from 1 page to the full ~106.
