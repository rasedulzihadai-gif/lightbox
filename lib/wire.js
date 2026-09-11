// ─── Wire format layer ─────────────────────────────────────────────────
// ONE request builder + ONE response parser per wire format — never one per
// provider. Providers that share a format share this exact code path and are
// only parameterized with baseUrl / apiKey / model from the registry.
//
// Every builder returns { url, options } ready for fetch().
// Every parser receives the parsed JSON body and returns
// { text, reportedModel } where `text` is the raw model answer (fed onward
// to the SAME JSON-extraction + validation step regardless of provider) and
// `reportedModel` is the model the provider says actually answered (xKiro
// reports this after its internal failover).

function trimBase(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

// ─── Request builders (exact signatures per spec) ──────────────────────

export function buildGeminiRequest(baseUrl, apiKey, model, systemPrompt, userText, imageBase64, mimeType) {
  const url = `${trimBase(baseUrl)}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const options = {
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
  };
  return { url, options };
}

export function buildOpenAIRequest(baseUrl, apiKey, model, systemPrompt, userText, imageBase64, mimeType) {
  const url = `${trimBase(baseUrl)}/chat/completions`;
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}` } },
          ],
        },
      ],
      temperature: 0.4,
    }),
  };
  return { url, options };
}

export function buildAnthropicRequest(baseUrl, apiKey, model, systemPrompt, userText, imageBase64, mimeType) {
  const url = `${trimBase(baseUrl)}/messages`;
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image", source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 } },
          ],
        },
      ],
    }),
  };
  return { url, options };
}

// Dispatch by wire format — the only place format → builder is mapped.
export function buildRequestForWireFormat(wireFormat, baseUrl, apiKey, model, systemPrompt, userText, imageBase64, mimeType) {
  switch (wireFormat) {
    case "gemini-native":
      return buildGeminiRequest(baseUrl, apiKey, model, systemPrompt, userText, imageBase64, mimeType);
    case "openai-chat-completions":
      return buildOpenAIRequest(baseUrl, apiKey, model, systemPrompt, userText, imageBase64, mimeType);
    case "anthropic-messages":
      return buildAnthropicRequest(baseUrl, apiKey, model, systemPrompt, userText, imageBase64, mimeType);
    default:
      throw new Error(`Unknown wire format: ${wireFormat}`);
  }
}

// ─── Response parsers ──────────────────────────────────────────────────

export class WireResponseError extends Error {
  constructor(message, kind = "bad-response") {
    super(message);
    this.name = "WireResponseError";
    this.kind = kind;
  }
}

export function parseGeminiText(data) {
  if (!data || typeof data !== "object") {
    throw new WireResponseError("Gemini returned an unreadable response.");
  }
  const block = data?.promptFeedback?.blockReason;
  const cand = data?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const text = parts
    .filter((p) => typeof p?.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();
  if (!text) {
    if (block) {
      throw new WireResponseError(`Gemini blocked this request (${block}) — try another image or provider.`, "blocked");
    }
    if (cand?.finishReason && cand.finishReason !== "STOP") {
      throw new WireResponseError(`Gemini stopped early (${cand.finishReason}) without returning text.`, "blocked");
    }
    throw new WireResponseError("Gemini returned no text content.", "empty");
  }
  return { text, reportedModel: data.modelVersion || data.model || null };
}

export function parseOpenAIText(data) {
  const choice = data?.choices?.[0];
  let content = choice?.message?.content;
  // Some gateways return content as an array of typed parts instead of a string.
  if (Array.isArray(content)) {
    content = content
      .filter((p) => typeof p?.text === "string")
      .map((p) => p.text)
      .join("");
  }
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) {
    if (choice?.finish_reason && choice.finish_reason !== "stop" && choice.finish_reason !== "length") {
      throw new WireResponseError(`Provider stopped early (finish_reason: ${choice.finish_reason}) without returning text.`, "blocked");
    }
    throw new WireResponseError("Provider returned no message content.", "empty");
  }
  return { text, reportedModel: typeof data?.model === "string" ? data.model : null };
}

export function parseAnthropicText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks
    .filter((b) => b?.type === "text" && typeof b?.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) {
    if (data?.stop_reason === "refusal" || data?.stop_reason === "max_tokens") {
      throw new WireResponseError(`Claude stopped early (stop_reason: ${data.stop_reason}) without usable text.`, "blocked");
    }
    throw new WireResponseError("Anthropic returned no text content.", "empty");
  }
  return { text, reportedModel: typeof data?.model === "string" ? data.model : null };
}

export function parseResponseForWireFormat(wireFormat, data) {
  switch (wireFormat) {
    case "gemini-native":
      return parseGeminiText(data);
    case "openai-chat-completions":
      return parseOpenAIText(data);
    case "anthropic-messages":
      return parseAnthropicText(data);
    default:
      throw new WireResponseError(`Unknown wire format: ${wireFormat}`);
  }
}

// ─── Error extraction ──────────────────────────────────────────────────
// All three formats put a human-readable message at `error.message`; if the
// body wasn't JSON at all (HTML error page, empty body, …), fall back to a
// truncated slice of the raw body.

export function extractProviderErrorMessage(data, rawBody) {
  const msg = data?.error?.message;
  if (typeof msg === "string" && msg.trim()) return msg.trim();
  if (typeof data?.message === "string" && data.message.trim()) return data.message.trim();
  if (typeof rawBody === "string" && rawBody.trim()) {
    const s = rawBody.trim().replace(/\s+/g, " ");
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  }
  return null;
}
