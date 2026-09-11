import { SYSTEM_PROMPT, FALLBACK_REMINDER } from "../../../lib/prompt";
import {
  getProvider, defaultBaseUrl, supportsWireFormat, WIRE_FORMATS,
} from "../../../lib/provider-registry";
import {
  buildRequestForWireFormat, parseResponseForWireFormat,
  extractProviderErrorMessage, WireResponseError,
} from "../../../lib/wire";
import { extractJsonFromText, validateMetadataOutput, JsonExtractionError } from "../../../lib/validate-metadata";

// Ask Vercel for more execution time per request — relevant on Pro/
// Enterprise plans (up to 60s here). On the free Hobby plan, Vercel caps
// every serverless function at 10s regardless of this setting.
export const maxDuration = 60;

const REQUEST_TIMEOUT_MS = 50_000;
const MAX_TOTAL_ATTEMPTS = 6;

// ─── Provider-specific error surfaces ──────────────────────────────────
// These messages are contractual (spec section 1) — do not genericize them.

function agentRouterClientRejection() {
  return "AgentRouter rejected this app as an unrecognized client — this is a known restriction on their side, not a bug in your key or this app.";
}

function vyceConnectionError(baseUrl) {
  return `Vyce connection failed — verify the base URL in Vyce's own docs, then correct it in Settings (currently trying: ${baseUrl}).`;
}

// Only fall through to the next model within a provider for transient /
// capacity errors, or a model 404 (deprecated ID). A bad API key (401/403)
// or a bad request (400) should skip straight to the next provider —
// retrying with another model won't fix those.
function isRetryableStatus(status) {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

function statusForFailure(kind, httpStatus) {
  switch (kind) {
    case "auth": return 401;
    case "client-rejection": return 403;
    case "connection": return 504;
    case "incomplete": return 502;
    default: return httpStatus && httpStatus >= 400 && httpStatus < 500 ? httpStatus : 502;
  }
}

function fail(headline, detail) {
  const status = statusForFailure(detail.kind, detail.httpStatus);
  return Response.json(
    {
      error: headline,
      kind: detail.kind || "error",
      providerId: detail.providerId || null,
      attempts: detail.attempts || [],
    },
    { status }
  );
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { imageBase64, mimeType, context } = body;
  const slots = Array.isArray(body.providers) ? body.providers : [];

  if (!imageBase64) {
    return Response.json({ error: "No image provided." }, { status: 400 });
  }
  if (slots.length === 0) {
    return Response.json(
      { error: "No provider selected. Pick a provider in the generation bar (configure one in Settings first)." },
      { status: 400 }
    );
  }

  const baseUserText = context
    ? `Context/theme hint from the user: ${context}. Now analyze this image.`
    : "Analyze this image.";

  // ─── Resolve every requested slot against the registry ────────────────
  // The client sends its manual pick first, then (only if the user opted in
  // to automatic fallback) the other configured providers in their chosen
  // order. Keys/base URLs come from the client's localStorage — they are
  // never persisted server-side.
  const chains = [];
  for (const slot of slots.slice(0, 8)) {
    const providerId = typeof slot?.providerId === "string" ? slot.providerId : "";
    const reg = getProvider(providerId);
    if (!reg) {
      return Response.json({ error: `Unknown provider: ${providerId}` }, { status: 400 });
    }
    const apiKey = typeof slot.apiKey === "string" ? slot.apiKey.trim() : "";
    if (!apiKey) {
      return fail(`${reg.label} has no API key saved. Add it in Settings first.`, {
        kind: "auth", providerId, attempts: [],
      });
    }
    const wireFormat = supportsWireFormat(reg, slot.wireFormat)
      ? slot.wireFormat
      : reg.defaultWireFormat;
    const baseUrl = (typeof slot.baseUrl === "string" && slot.baseUrl.trim())
      || defaultBaseUrl(reg, wireFormat);
    const requestedModel = typeof slot.model === "string" && slot.model.trim()
      ? slot.model.trim()
      : reg.models[0] || "";
    if (!requestedModel) {
      // Gateways without preset models (Helyx, Vyce, SeekAi, …) REQUIRE a
      // user-typed model — sending an empty model would fail opaquely.
      return fail(
        `${reg.label}: no model set. This slot has no preset model list — type a model ID in Settings (press "Test connection" there to load the provider's model list), then retry.`,
        { kind: "error", providerId, attempts: [] }
      );
    }

    // Model retry order: the user's pick first, then the provider's other
    // presets — unless the provider handles failover itself (xKiro: exactly
    // one request, it reports the model it actually used).
    const modelOrder = [requestedModel];
    if (reg.modelFallback !== false) {
      for (const m of reg.models) {
        if (m && !modelOrder.includes(m)) modelOrder.push(m);
      }
    }
    chains.push({ reg, apiKey, wireFormat, baseUrl, requestedModel, modelOrder });
  }

  // ─── Walk the chain: provider slots in order, models within each ──────
  const attempts = [];
  let lastHeadline = "Generation failed.";
  let lastDetail = { kind: "error" };

  for (let p = 0; p < chains.length; p++) {
    const { reg, apiKey, wireFormat, baseUrl, requestedModel, modelOrder } = chains[p];
    const isFallbackSlot = p > 0;

    for (let m = 0; m < modelOrder.length; m++) {
      if (attempts.length >= MAX_TOTAL_ATTEMPTS) break;
      const model = modelOrder[m];
      const isFallbackModel = isFallbackSlot || m > 0;

      // Every model after the first (i.e. any fallback) gets the compact
      // rule-reminder appended to the user turn as well as the system
      // prompt — lighter/older models weight the user message more heavily,
      // so this measurably improves rule A-G compliance on them.
      const userText = isFallbackModel ? `${baseUserText}\n${FALLBACK_REMINDER}` : baseUserText;

      const attempt = {
        providerId: reg.id, providerLabel: reg.label, model,
        wireFormat, baseUrl, ok: false, kind: "error", error: null, info: null,
      };

      // ── Build + send (builder chosen by wire format, not provider) ──
      const { url, options } = buildRequestForWireFormat(
        wireFormat, baseUrl, apiKey, model, SYSTEM_PROMPT, userText, imageBase64, mimeType
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, { ...options, signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        const aborted = err?.name === "AbortError";
        attempt.kind = "connection";
        attempt.error = aborted
          ? `${reg.label} timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`
          : `${reg.label} is unreachable (network error: ${String(err?.message || err)}).`;
        if (reg.id === "vyce") attempt.error = vyceConnectionError(baseUrl);
        attempts.push(attempt);
        lastHeadline = attempt.error;
        lastDetail = { kind: "connection", providerId: reg.id, attempts };
        continue; // transient — next model/provider
      }
      clearTimeout(timer);

      const rawBody = await res.text();
      let data = null;
      try { data = JSON.parse(rawBody); } catch { /* non-JSON body */ }

      // ── AgentRouter client allow-listing: a distinct, non-retryable,
      //    non-hideable rejection. Return immediately — never retry it and
      //    never bury it under a generic failure message.
      if (reg.id === "agentrouter" && typeof rawBody === "string" && rawBody.includes("UNAUTHORIZED_CLIENT")) {
        attempt.kind = "client-rejection";
        attempt.error = agentRouterClientRejection();
        attempts.push(attempt);
        return fail(agentRouterClientRejection(), {
          kind: "client-rejection", providerId: reg.id, httpStatus: 403, attempts,
        });
      }

      if (!res.ok) {
        const providerMsg = extractProviderErrorMessage(data, rawBody);
        attempt.kind = res.status === 401 || res.status === 403 ? "auth" : "http";
        attempt.error = `${reg.label} request failed (${res.status})${providerMsg ? `: ${providerMsg}` : "."}`;

        // Google deprecation 404s name the replacement model. That is
        // information for the developer console — log it and pass it
        // through as info, but never silently auto-adopt the new ID.
        if (res.status === 404 && providerMsg) {
          attempt.info = `Model not found — provider said: ${providerMsg}. Update the Model field in Settings after reviewing; this app never rewrites your saved model automatically.`;
          console.error(`[provider-404] ${reg.id} model "${model}" → ${providerMsg}`);
        }

        attempts.push(attempt);
        lastHeadline = attempt.error;
        lastDetail = { kind: attempt.kind, providerId: reg.id, httpStatus: res.status, attempts };

        if (isRetryableStatus(res.status) && m < modelOrder.length - 1) continue; // next model
        break; // non-retryable, or out of models → next provider
      }

      // ── Parse the raw text answer (per wire format) ──────────────────
      let rawText, reportedModel;
      try {
        ({ text: rawText, reportedModel } = parseResponseForWireFormat(wireFormat, data));
      } catch (err) {
        const msg = err instanceof WireResponseError ? err.message : `${reg.label} returned an unreadable response.`;
        attempt.kind = "bad-response";
        attempt.error = msg;
        attempts.push(attempt);
        lastHeadline = msg;
        lastDetail = { kind: "bad-response", providerId: reg.id, attempts };
        continue; // next model/provider
      }

      // ── THE SAME validation step for every provider (spec section 4) ──
      let parsed;
      try {
        parsed = extractJsonFromText(rawText);
      } catch (err) {
        const msg = err instanceof JsonExtractionError
          ? err.message
          : "Model returned invalid JSON.";
        attempt.kind = "incomplete";
        attempt.error = msg;
        attempts.push(attempt);
        lastHeadline = `Incomplete response from ${reg.label} (${model}) — the answer was not valid JSON. Please regenerate.`;
        lastDetail = { kind: "incomplete", providerId: reg.id, attempts };
        continue; // retryable — next model/provider
      }

      const verdict = validateMetadataOutput(parsed);
      if (!verdict.ok) {
        attempt.kind = "incomplete";
        attempt.error = `Missing/invalid fields: ${verdict.errors.join("; ")}`;
        attempts.push(attempt);
        lastHeadline = `Incomplete response from ${reg.label} (${model}) — required metadata fields were missing, so nothing partial is shown. Please regenerate.`;
        lastDetail = { kind: "incomplete", providerId: reg.id, attempts };
        continue; // retryable — next model/provider
      }

      // ── Success: full validated shape, with provenance metadata ──────
      attempt.ok = true;
      attempts.push(attempt);
      const modelUsed = reportedModel || model;
      return Response.json({
        ...verdict.value,
        _meta: {
          providerId: reg.id,
          providerLabel: reg.label,
          wireFormat,
          modelRequested: model,
          modelUsed,
          modelReportedByProvider: reportedModel || null,
          fellBack: isFallbackSlot || isFallbackModel || modelUsed !== model,
          attempts: attempts.map(({ ok, providerLabel, model: am, error, info }) => ({
            ok, provider: providerLabel, model: am, error: error || undefined, info: info || undefined,
          })),
        },
      });
    }
  }

  return fail(lastHeadline, { ...lastDetail, attempts });
}
