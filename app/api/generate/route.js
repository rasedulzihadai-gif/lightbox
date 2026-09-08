import { SYSTEM_PROMPT, FALLBACK_REMINDER } from "../../../lib/prompt";

// Ask Vercel for more execution time per request — relevant on Pro/
// Enterprise plans (up to 60s here). On the free Hobby plan, Vercel caps
// every serverless function at 10s regardless of this setting — see the
// note in the chat about what that means for large batches.
export const maxDuration = 60;

// Tried in order. If one is overloaded/rate-limited/unavailable, the next
// one is used automatically — the user never has to switch models manually.
const MODEL_FALLBACK_CHAIN = [
  "gemini-3.6-flash",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
];

// Only fall through to the next model for transient/capacity errors.
// A bad API key (401/403) or a bad request (400) should fail immediately —
// retrying with another model won't fix those.
function isRetryableStatus(status) {
  return status === 429 || status === 503 || status >= 500;
}

async function callModel(modelId, apiKey, systemPrompt, userText, mimeType, imageBase64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: userText },
            { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0.4 },
    }),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

export async function POST(req) {
  const apiKey = req.headers.get("x-provider-key");
  if (!apiKey) {
    return Response.json(
      { error: "Missing API key. Add your Gemini key in Settings first." },
      { status: 400 }
    );
  }

  const { imageBase64, mimeType, context } = await req.json();
  if (!imageBase64) {
    return Response.json({ error: "No image provided." }, { status: 400 });
  }

  const baseUserText = context
    ? `Context/theme hint from the user: ${context}. Now analyze this image.`
    : "Analyze this image.";

  let lastError = null;
  let lastStatus = 500;

  for (let i = 0; i < MODEL_FALLBACK_CHAIN.length; i++) {
    const modelId = MODEL_FALLBACK_CHAIN[i];
    // Every model after the first (i.e. any fallback) gets the compact
    // rule-reminder appended to the user turn as well as the system prompt —
    // lighter/older models weight the user message more heavily, so this
    // measurably improves rule A-D compliance on them.
    const userText = i === 0 ? baseUserText : `${baseUserText}\n${FALLBACK_REMINDER}`;

    try {
      const { ok, status, data } = await callModel(
        modelId, apiKey, SYSTEM_PROMPT, userText, mimeType, imageBase64
      );

      if (!ok) {
        lastError = data?.error?.message || `${modelId} request failed.`;
        lastStatus = status === 400 ? 401 : status; // treat bad key as 401-ish
        if (!isRetryableStatus(status)) {
          return Response.json(
            { error: lastError, modelTried: modelId },
            { status: lastStatus }
          );
        }
        continue;
      }

      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const cleaned = rawText.replace(/```json|```/g, "").trim();

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (e) {
        lastError = "Model returned invalid JSON.";
        lastStatus = 502;
        continue;
      }

      return Response.json({
        ...parsed,
        _meta: { modelUsed: modelId, fellBack: i > 0 },
      });
    } catch (err) {
      lastError = String(err);
      lastStatus = 500;
      continue;
    }
  }

  return Response.json(
    { error: `All models unavailable. Last error: ${lastError}` },
    { status: lastStatus }
  );
}
