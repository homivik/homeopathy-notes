import notes from "../../notes.json";

const GROUNDING_RULES = `You are a lookup assistant for one person's private handwritten homeopathy notes.
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
   advice. Do not add dosing advice or safety claims beyond what the notes say.`;

const ANSWER_TOOL = {
  type: "function",
  function: {
    name: "answer_from_notes",
    description:
      "Provide the grounded answer to the user's question based only on the notes.",
    parameters: {
      type: "object",
      properties: {
        answer: {
          type: "string",
          description: "The answer text, in the same language as the question.",
        },
        citations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              condition: { type: "string" },
              page: { type: "integer" },
            },
            required: ["condition", "page"],
          },
        },
        grounded: {
          type: "boolean",
          description:
            "true if the answer was found in the notes, false if it says 'this is not in your notes'.",
        },
      },
      required: ["answer", "citations", "grounded"],
    },
  },
};

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const timestamps = (rateBuckets.get(ip) || []).filter((t) => t > windowStart);
  if (timestamps.length >= RATE_LIMIT) {
    rateBuckets.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  rateBuckets.set(ip, timestamps);
  return false;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const ip = req.headers.get("x-nf-client-connection-ip") || "unknown";
  if (isRateLimited(ip)) {
    return json(
      { error: "Too many requests. Please wait a moment and try again." },
      429
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return json({ error: "Question is required." }, 400);
  }
  if (question.length > 1000) {
    return json({ error: "Question is too long." }, 400);
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return json({ error: "Server is not configured." }, 500);
  }

  const model = process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-4.5";

  try {
    const openRouterResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": process.env.APP_URL || "https://homeopathy-notes.local",
        "X-Title": "Homeopathy Notes Q&A",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [
          {
            role: "system",
            content: [
              { type: "text", text: GROUNDING_RULES },
              {
                type: "text",
                text: "NOTES:\n" + JSON.stringify(notes),
                cache_control: { type: "ephemeral" },
              },
            ],
          },
          { role: "user", content: question },
        ],
        tools: [ANSWER_TOOL],
        tool_choice: { type: "function", function: { name: "answer_from_notes" } },
      }),
    });

    if (!openRouterResponse.ok) {
      const errText = await openRouterResponse.text();
      console.error("OpenRouter API error", openRouterResponse.status, errText);
      return json(
        { error: "The notes assistant is temporarily unavailable. Please try again." },
        502
      );
    }

    const data = await openRouterResponse.json();
    const toolCall = (data.choices?.[0]?.message?.tool_calls || []).find(
      (call) => call.function?.name === "answer_from_notes"
    );

    if (!toolCall) {
      return json(
        { error: "The notes assistant is temporarily unavailable. Please try again." },
        502
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(toolCall.function.arguments);
    } catch {
      return json(
        { error: "The notes assistant is temporarily unavailable. Please try again." },
        502
      );
    }

    const { answer, citations, grounded } = parsed;
    return json({ answer, citations: citations || [], grounded: !!grounded }, 200);
  } catch (err) {
    console.error("Function error", err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
};

export const config = {
  path: "/ask",
};
