// ─── Provider registry — the single source of truth ────────────────────
// One entry per AI provider "slot". NOTHING about a provider's connection
// (URL, auth style, wire format, model list) may be hardcoded anywhere else —
// the API routes, request builders, Settings UI and provider selector all
// read from here. If an endpoint moves, this is the only file to edit.

// Wire formats — one request builder + one response parser exists per format
// (see lib/wire.js); providers that share a format share that code path.
export const WIRE_FORMATS = {
  GEMINI_NATIVE: "gemini-native",
  OPENAI_CHAT: "openai-chat-completions",
  ANTHROPIC_MESSAGES: "anthropic-messages",
};

export const WIRE_FORMAT_LABELS = {
  [WIRE_FORMATS.GEMINI_NATIVE]: "Gemini native",
  [WIRE_FORMATS.OPENAI_CHAT]: "OpenAI-compatible",
  [WIRE_FORMATS.ANTHROPIC_MESSAGES]: "Anthropic Messages",
};

/**
 * Entry fields:
 *   id                 stable slot id (used in localStorage keys + API calls)
 *   label              human name shown in Settings and the provider selector
 *   wireFormats        every wire format this slot can speak
 *   defaultWireFormat  which one the slot uses unless the user changes it
 *   baseUrl            default base URL (for the default format)
 *   baseUrlByFormat    optional per-format default when they differ (xKiro,
 *                      AgentRouter: Anthropic base has no "/v1")
 *   auth               "query-key" | "bearer" | "anthropic-headers"
 *   models             preset model ids (may be [] — user types their own;
 *                      openai/gateway lists go stale fast)
 *   modelHint          placeholder/help text for the model input
 *   modelFallback      whether to retry the slot's other preset models when
 *                      the selected one 404s / rate-limits / 5xx's.
 *                      false for xKiro: it failovers internally already and
 *                      reports the model it actually used — one request is
 *                      enough, retrying would double-spend.
 *   trust              "verified" | "unverified" (drives Settings warnings)
 *   keyHint            where to get a key / how it looks
 *   notes              provider-specific warnings rendered in Settings
 */
export const PROVIDER_REGISTRY = [
  {
    id: "gemini",
    label: "Google Gemini",
    wireFormats: [WIRE_FORMATS.GEMINI_NATIVE],
    defaultWireFormat: WIRE_FORMATS.GEMINI_NATIVE,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    auth: "query-key", // ?key=API_KEY query param — NOT a header
    models: ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"],
    modelHint: "gemini-3.6-flash",
    modelFallback: true,
    trust: "verified",
    keyHint: "Get a free key at aistudio.google.com/app/apikey (starts with AIza…).",
    notes: [
      "Google occasionally deprecates model IDs with no advance warning beyond a 404 naming the replacement. If that happens, this app surfaces the 404 (and tries your other saved models) but never silently rewrites your config — pick the new ID yourself after reviewing it.",
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude (official)",
    wireFormats: [WIRE_FORMATS.ANTHROPIC_MESSAGES],
    defaultWireFormat: WIRE_FORMATS.ANTHROPIC_MESSAGES,
    baseUrl: "https://api.anthropic.com/v1",
    auth: "anthropic-headers", // x-api-key + anthropic-version: 2023-06-01
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    modelHint: "claude-sonnet-5",
    modelFallback: true,
    trust: "verified",
    keyHint: "console.anthropic.com → API keys (starts with sk-ant-…).",
    notes: [],
  },
  {
    id: "openai",
    label: "OpenAI (official)",
    wireFormats: [WIRE_FORMATS.OPENAI_CHAT],
    defaultWireFormat: WIRE_FORMATS.OPENAI_CHAT,
    baseUrl: "https://api.openai.com/v1",
    auth: "bearer", // Authorization: Bearer API_KEY
    models: ["gpt-4o", "gpt-4o-mini"],
    modelHint: "gpt-4o — or type any current model ID; this list goes stale fast",
    modelFallback: true,
    trust: "verified",
    keyHint: "platform.openai.com → API keys (starts with sk-…).",
    notes: [
      "The preset model list goes stale quickly — you can type any current model ID instead of picking from the list.",
    ],
  },
  {
    id: "helyx",
    label: "Helyx AI",
    wireFormats: [WIRE_FORMATS.OPENAI_CHAT],
    defaultWireFormat: WIRE_FORMATS.OPENAI_CHAT,
    baseUrl: "https://helyxai.space/v1",
    auth: "bearer",
    models: [],
    modelHint: "e.g. gpt-4o — check Helyx's docs or press Test connection to load their model list",
    modelFallback: false, // no preset list to fall back through
    trust: "verified",
    keyHint: "Get a key from your Helyx AI dashboard.",
    notes: [
      "OpenAI-compatible only — Helyx has no Anthropic-format route.",
    ],
  },
  {
    id: "vyce",
    label: "Vyce AI",
    wireFormats: [WIRE_FORMATS.OPENAI_CHAT, WIRE_FORMATS.ANTHROPIC_MESSAGES],
    defaultWireFormat: WIRE_FORMATS.OPENAI_CHAT, // kept consistent with the other gateway slots
    baseUrl: "https://vyceai.com/v1", // ⚠ not independently verified character-for-character — overridable in Settings
    auth: "bearer",
    models: [],
    modelHint: "e.g. claude-sonnet-5 — check Vyce's docs or press Test connection",
    modelFallback: false,
    trust: "unverified",
    keyHint: "Get a key from your Vyce AI dashboard.",
    notes: [
      "Unverified base URL — the default (https://vyceai.com/v1) was not confirmed against Vyce's own docs. If a request fails with a connection error, verify the exact path in Vyce's docs and correct the Base URL field below. The app will show a clear 'verify base URL' error instead of treating Vyce as dead.",
      "Vyce also speaks the Anthropic Messages format — switch it under API format if you prefer.",
    ],
  },
  {
    id: "xkiro",
    label: "xKiro",
    wireFormats: [WIRE_FORMATS.OPENAI_CHAT, WIRE_FORMATS.ANTHROPIC_MESSAGES],
    defaultWireFormat: WIRE_FORMATS.OPENAI_CHAT,
    baseUrlByFormat: {
      [WIRE_FORMATS.OPENAI_CHAT]: "https://api.xkiro.com/v1",
      [WIRE_FORMATS.ANTHROPIC_MESSAGES]: "https://api.xkiro.com",
    },
    baseUrl: "https://api.xkiro.com/v1",
    auth: "bearer",
    models: ["anthropic/claude-opus-5", "openai/gpt-5.6-terra"],
    modelHint: "MUST include a vendor prefix, e.g. anthropic/claude-opus-5 or openai/gpt-5.6-terra — bare model names are rejected or mis-routed",
    modelFallback: false, // xKiro failovers internally and reports the model it actually used
    trust: "verified",
    keyHint: "Get a key from your xKiro dashboard.",
    notes: [
      "Model IDs need a vendor prefix (e.g. \"anthropic/claude-opus-5\", \"openai/gpt-5.6-terra\"). A bare model name will be rejected or mis-routed.",
      "xKiro has its own automatic failover and reports the model actually used — this app sends exactly one request per image here and shows you the model xKiro answered with. No extra retry logic is layered on top.",
    ],
  },
  {
    id: "agentrouter",
    label: "AgentRouter",
    wireFormats: [WIRE_FORMATS.OPENAI_CHAT, WIRE_FORMATS.ANTHROPIC_MESSAGES],
    defaultWireFormat: WIRE_FORMATS.OPENAI_CHAT,
    baseUrlByFormat: {
      [WIRE_FORMATS.OPENAI_CHAT]: "https://agentrouter.org/v1",
      [WIRE_FORMATS.ANTHROPIC_MESSAGES]: "https://agentrouter.org",
    },
    baseUrl: "https://agentrouter.org/v1",
    auth: "bearer",
    models: ["claude-opus-4-6", "claude-haiku-4-5-20251001", "gpt-5.5"],
    modelHint: "claude-opus-4-6",
    modelFallback: true,
    trust: "verified",
    keyHint: "Get a key from your AgentRouter dashboard.",
    notes: [
      "KNOWN RESTRICTION: AgentRouter has been reported to reject requests from non-whitelisted clients with {\"message\":\"UNAUTHORIZED_CLIENT\"} even with a valid key — they appear to allow-list specific known tools (Claude Code, Codex, Cursor, …). If that happens, this app shows a distinct error saying so; it is a restriction on their side, not a bug in your key or this app.",
    ],
  },
  {
    id: "seekai",
    label: "SeekAi",
    wireFormats: [WIRE_FORMATS.OPENAI_CHAT],
    defaultWireFormat: WIRE_FORMATS.OPENAI_CHAT,
    baseUrl: "https://seekai.cc/v1", // ⚠ not independently verified (docs are a JS-rendered SPA) — overridable in Settings
    auth: "bearer",
    models: [],
    modelHint: "e.g. gpt-4o — check SeekAi's docs or press Test connection",
    modelFallback: false,
    trust: "unverified",
    keyHint: "Get a key from your SeekAi dashboard.",
    notes: [
      "Unverified endpoint — test before relying on it.",
      "Trust caution: SeekAi's domain is very new (a few months old) with hidden WHOIS registration. Start with a small top-up, not a large one, until you've confirmed it works and you trust the operator.",
    ],
  },
];

// ─── Registry helpers ───────────────────────────────────────────────────

export function getProvider(id) {
  return PROVIDER_REGISTRY.find((p) => p.id === id) || null;
}

export function supportsWireFormat(provider, wireFormat) {
  return provider.wireFormats.includes(wireFormat);
}

// Default base URL for a slot under a given wire format. Providers with a
// dedicated Anthropic route (xKiro, AgentRouter) drop the "/v1" there.
export function defaultBaseUrl(provider, wireFormat) {
  if (wireFormat && provider.baseUrlByFormat?.[wireFormat]) {
    return provider.baseUrlByFormat[wireFormat];
  }
  return provider.baseUrl;
}

export function isValidWireFormat(provider, wireFormat) {
  return typeof wireFormat === "string" && supportsWireFormat(provider, wireFormat);
}
