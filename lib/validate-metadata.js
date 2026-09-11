// ─── Strict metadata output validation (spec section 4) ────────────────
// EVERY provider's raw text answer goes through the SAME two steps:
//   1. extractJsonFromText()  — strip ```json fences / surrounding prose,
//                               parse the JSON object
//   2. validateMetadataOutput() — enforce the exact required shape
//
// If anything is missing or the wrong type, the generation counts as FAILED
// (retryable — next model/provider in the fallback chain if configured,
// otherwise a clear "incomplete response, please regenerate" error).
// A partially-filled object is NEVER passed to the UI, and a missing field
// is NEVER silently substituted with an empty string/array.

export class JsonExtractionError extends Error {
  constructor(message) {
    super(message);
    this.name = "JsonExtractionError";
  }
}

// Pull the metadata JSON object out of the model's raw text answer.
// Handles: clean JSON, ```json-fenced JSON, prose around the JSON, and
// multiple fenced blocks (picks the first one that parses).
export function extractJsonFromText(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new JsonExtractionError("Model returned an empty response.");
  }
  const full = raw.trim();
  const candidates = [];

  // 1. Whole response as-is.
  candidates.push(full);

  // 2. Every fenced code block (```json … ``` or ``` … ```).
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(full)) !== null) {
    if (m[1] && m[1].trim()) candidates.push(m[1].trim());
  }

  // 3. Outermost { … } slice (prose like "Here is the JSON:" around it).
  const start = full.indexOf("{");
  const end = full.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(full.slice(start, end + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // try the next candidate
    }
  }

  const snippet = full.replace(/\s+/g, " ").slice(0, 160);
  throw new JsonExtractionError(`Model response did not contain parseable JSON. Snippet: "${snippet}"`);
}

// The exact required shape, with per-platform minimum keyword counts.
export const METADATA_PLATFORMS = [
  { key: "adobe_stock", minKeywords: 5 },
  { key: "shutterstock", minKeywords: 7 },
  { key: "istock_getty", minKeywords: 5 },
  { key: "freepik_vecteezy", minKeywords: 5 },
];

/**
 * Validate a parsed object against the required shape.
 * Returns { ok: true, value } with a CANONICAL object (exactly the required
 * fields, trimmed) — or { ok: false, errors: [...] } listing every problem,
 * so the failure can be shown/retried instead of shipping gaps to the UI.
 */
export function validateMetadataOutput(obj) {
  const errors = [];

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["Response is not a JSON object."] };
  }

  // description — required, non-empty string
  if (typeof obj.description !== "string" || !obj.description.trim()) {
    errors.push("description: required (non-empty string)");
  }

  // platforms — all four, each with non-empty title + keyword array ≥ min
  const platforms = obj.platforms;
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    errors.push("platforms: required object with adobe_stock, shutterstock, istock_getty, freepik_vecteezy");
  } else {
    for (const { key, minKeywords } of METADATA_PLATFORMS) {
      const p = platforms[key];
      if (!p || typeof p !== "object" || Array.isArray(p)) {
        errors.push(`platforms.${key}: missing (needs title + keywords)`);
        continue;
      }
      if (typeof p.title !== "string" || !p.title.trim()) {
        errors.push(`platforms.${key}.title: required (non-empty string)`);
      }
      if (!Array.isArray(p.keywords)) {
        errors.push(`platforms.${key}.keywords: required (array of strings)`);
      } else {
        const badEntries = p.keywords.filter((k) => typeof k !== "string" || !k.trim()).length;
        if (badEntries > 0) {
          errors.push(`platforms.${key}.keywords: ${badEntries} empty/non-string keyword${badEntries > 1 ? "s" : ""}`);
        }
        if (p.keywords.length < minKeywords) {
          errors.push(`platforms.${key}.keywords: need at least ${minKeywords}, got ${p.keywords.length}`);
        }
      }
    }
  }

  // category_suggestion — required string (may be brief, must exist)
  if (typeof obj.category_suggestion !== "string") {
    errors.push("category_suggestion: required (string)");
  }

  // flags — must be an array (empty array is fine); entries must be strings
  if (!Array.isArray(obj.flags)) {
    errors.push("flags: required (array, may be empty)");
  } else if (obj.flags.some((f) => typeof f !== "string")) {
    errors.push("flags: every entry must be a string");
  }

  if (errors.length > 0) return { ok: false, errors };

  // Canonical output — exactly the required shape, trimmed. Unknown extra
  // fields the model added are dropped so the UI always gets the same keys.
  const value = {
    description: obj.description.trim(),
    platforms: Object.fromEntries(
      METADATA_PLATFORMS.map(({ key }) => [
        key,
        {
          title: platforms[key].title.trim(),
          keywords: platforms[key].keywords.map((k) => k.trim()),
        },
      ])
    ),
    category_suggestion: obj.category_suggestion,
    flags: obj.flags,
  };
  return { ok: true, value };
}
