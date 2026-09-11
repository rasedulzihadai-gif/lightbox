import { getProvider, defaultBaseUrl, supportsWireFormat } from "../../../lib/provider-registry";

// Server-side "Test connection" for any provider slot. Running it here (not
// in the browser) means CORS policies of the various providers/gateways can
// never block or distort the test.
export const maxDuration = 30;

const TEST_TIMEOUT_MS = 15_000;

function agentRouterClientRejection() {
  return "AgentRouter rejected this app as an unrecognized client — this is a known restriction on their side, not a bug in your key or this app.";
}

function vyceConnectionError(baseUrl) {
  return `Vyce connection failed — verify the base URL in Vyce's own docs, then correct it in Settings (currently trying: ${baseUrl}).`;
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, status: "unreachable", message: "Invalid request body." });
  }

  const { apiKey, baseUrl: baseUrlOverride, wireFormat: wireFormatOverride } = body;
  const reg = getProvider(typeof body.providerId === "string" ? body.providerId : "");
  if (!reg) {
    return Response.json({ ok: false, status: "unreachable", message: "Unknown provider." });
  }
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) {
    return Response.json({ ok: false, status: "not-set", message: "No API key entered yet." });
  }

  const wireFormat = supportsWireFormat(reg, wireFormatOverride)
    ? wireFormatOverride
    : reg.defaultWireFormat;
  const baseUrl = (typeof baseUrlOverride === "string" && baseUrlOverride.trim())
    || defaultBaseUrl(reg, wireFormat);

  // Cheap authenticated list-models call per auth style.
  let url, headers;
  if (reg.auth === "query-key") {
    url = `${baseUrl.replace(/\/+$/, "")}/models?key=${encodeURIComponent(key)}`;
    headers = { "Content-Type": "application/json" };
  } else if (reg.auth === "bearer") {
    url = `${baseUrl.replace(/\/+$/, "")}/models`;
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  } else {
    // anthropic-headers: x-api-key + anthropic-version; api.anthropic.com
    // serves GET /v1/models.
    url = `${baseUrl.replace(/\/+$/, "")}/models`;
    headers = { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method: "GET", headers, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err?.name === "AbortError";
    const message = aborted
      ? `No response within ${TEST_TIMEOUT_MS / 1000}s — endpoint unreachable.`
      : `Connection failed (${String(err?.message || err)}).`;
    return Response.json({
      ok: false,
      status: "unreachable",
      message: reg.id === "vyce" ? vyceConnectionError(baseUrl) : message,
    });
  }
  clearTimeout(timer);

  const rawBody = await res.text();
  let data = null;
  try { data = JSON.parse(rawBody); } catch { /* non-JSON */ }

  // AgentRouter client allow-listing — same distinct surface as generation.
  if (reg.id === "agentrouter" && typeof rawBody === "string" && rawBody.includes("UNAUTHORIZED_CLIENT")) {
    return Response.json({ ok: false, status: "invalid", message: agentRouterClientRejection() });
  }

  if (res.ok) {
    // OpenAI-compatible gateways usually list models as { data: [{id}, …] }.
    let models;
    if (Array.isArray(data?.data)) {
      models = data.data
        .map((m) => (typeof m?.id === "string" ? m.id : null))
        .filter(Boolean)
        .slice(0, 100);
    } else if (Array.isArray(data?.models)) {
      models = data.models
        .map((m) => (typeof m?.name === "string" ? m.name.replace(/^models\//, "") : typeof m === "string" ? m : null))
        .filter(Boolean)
        .slice(0, 100);
    }
    return Response.json({
      ok: true,
      status: "connected",
      message: `Connected to ${reg.label}.`,
      models: models && models.length > 0 ? models : undefined,
    });
  }

  if (res.status === 401 || res.status === 403) {
    const detail = data?.error?.message || data?.message;
    return Response.json({
      ok: false,
      status: "invalid",
      message: `API key rejected (${res.status})${detail ? `: ${detail}` : "."}`,
    });
  }

  const detail = data?.error?.message || data?.message || `HTTP ${res.status}`;
  return Response.json({
    ok: false,
    status: "unreachable",
    message: reg.id === "vyce"
      ? vyceConnectionError(baseUrl)
      : `${reg.label} responded with an error (${detail}). If this persists, the endpoint path may have changed — adjust the Base URL in Settings.`,
  });
}
