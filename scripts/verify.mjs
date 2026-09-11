// ─── End-to-end provider verification (spec final checklist) ───────────
// Walks through EVERY provider in the registry and confirms:
//   1. its request builder matches its wire format (asserted by mock upstreams
//      that verify URL, auth headers and body shape of real requests),
//   2. generation through it returns the FULL validated shape from section 4
//      or a clear, specific error — never a partial result, never "something
//      went wrong",
//   3. provider-specific requirements (AgentRouter client rejection, Vyce
//      base-URL error, xKiro single attempt + reported model, Gemini 404
//      replacement handling, strict no-missing-fields validation, opt-in
//      fallback chains).
//
// Run: node scripts/verify.mjs   (expects `next build` output; starts its own
// server on port 3199 and a mock upstream on port 3198)

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const APP_PORT = 3199;
const MOCK_PORT = 3198;
const APP = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✕ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─── Part A: pure-logic unit tests (registry, builders, parsers, validator)
async function unitTests() {
  console.log("\n══ A. Registry / builders / parsers / validator (unit) ══");
  // The lib files are dependency-free ESM; import them via data: URLs so the
  // verify script works regardless of the package's CJS/ESM classification.
  const load = async (file) =>
    (await import(`data:text/javascript,${encodeURIComponent(await (await import("node:fs/promises")).readFile(new URL(`../lib/${file}`, import.meta.url), "utf8"))}`));

  const reg = await load("provider-registry.js");
  const wire = await load("wire.js");
  const vm = await load("validate-metadata.js");

  // A1. Registry matches the spec exactly.
  const byId = Object.fromEntries(reg.PROVIDER_REGISTRY.map((p) => [p.id, p]));
  const expectIds = ["gemini", "anthropic", "openai", "helyx", "vyce", "xkiro", "agentrouter", "seekai"];
  check("registry has exactly the 8 spec'd slots", JSON.stringify(reg.PROVIDER_REGISTRY.map((p) => p.id)) === JSON.stringify(expectIds));

  check("gemini: native wire + query-key auth + v1beta base + models", byId.gemini.wireFormats[0] === "gemini-native"
    && byId.gemini.auth === "query-key"
    && byId.gemini.baseUrl === "https://generativelanguage.googleapis.com/v1beta"
    && JSON.stringify(byId.gemini.models) === JSON.stringify(["gemini-3.6-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"]));
  check("anthropic: anthropic-messages + x-api-key/version auth + /v1 base + models", byId.anthropic.wireFormats[0] === "anthropic-messages"
    && byId.anthropic.auth === "anthropic-headers"
    && byId.anthropic.baseUrl === "https://api.anthropic.com/v1"
    && JSON.stringify(byId.anthropic.models) === JSON.stringify(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]));
  check("openai: openai format + bearer + /v1 base + models + custom allowed", byId.openai.wireFormats[0] === "openai-chat-completions"
    && byId.openai.auth === "bearer"
    && byId.openai.baseUrl === "https://api.openai.com/v1"
    && JSON.stringify(byId.openai.models) === JSON.stringify(["gpt-4o", "gpt-4o-mini"]));
  check("helyx: openai format only, no anthropic route", byId.helyx.wireFormats.length === 1 && byId.helyx.wireFormats[0] === "openai-chat-completions"
    && byId.helyx.baseUrl === "https://helyxai.space/v1");
  check("vyce: both formats, openai default, unverified base flagged", byId.vyce.defaultWireFormat === "openai-chat-completions"
    && byId.vyce.wireFormats.includes("anthropic-messages")
    && byId.vyce.baseUrl === "https://vyceai.com/v1"
    && byId.vyce.trust === "unverified");
  check("xkiro: per-format bases (/v1 vs none), vendor-prefix note, no model fallback", byId.xkiro.baseUrlByFormat["openai-chat-completions"] === "https://api.xkiro.com/v1"
    && byId.xkiro.baseUrlByFormat["anthropic-messages"] === "https://api.xkiro.com"
    && byId.xkiro.modelFallback === false
    && /vendor prefix/i.test(byId.xkiro.modelHint));
  check("agentrouter: per-format bases + models + client-restriction note", byId.agentrouter.baseUrlByFormat["openai-chat-completions"] === "https://agentrouter.org/v1"
    && byId.agentrouter.baseUrlByFormat["anthropic-messages"] === "https://agentrouter.org"
    && JSON.stringify(byId.agentrouter.models) === JSON.stringify(["claude-opus-4-6", "claude-haiku-4-5-20251001", "gpt-5.5"])
    && byId.agentrouter.notes.some((n) => n.includes("UNAUTHORIZED_CLIENT")));
  check("seekai: openai format, seekai.cc/v1 base, unverified + top-up caution", byId.seekai.baseUrl === "https://seekai.cc/v1"
    && byId.seekai.trust === "unverified"
    && byId.seekai.notes.some((n) => n.includes("small top-up")));

  check("defaultBaseUrl: xkiro anthropic → no /v1", reg.defaultBaseUrl(byId.xkiro, "anthropic-messages") === "https://api.xkiro.com");
  check("defaultBaseUrl: agentrouter anthropic → no /v1", reg.defaultBaseUrl(byId.agentrouter, "anthropic-messages") === "https://agentrouter.org");

  // A2. Builders — exact URL / headers / body per spec section 3.
  const SP = "SYS"; const UT = "USER"; const IMG = "QUJD"; const args = ["https://base.example/v1", "KEY123", "model-x", SP, UT, IMG, "image/jpeg"];
  const g = wire.buildGeminiRequest(...args);
  check("buildGeminiRequest: URL path + ?key= query", g.url === "https://base.example/v1/models/model-x:generateContent?key=KEY123");
  const gBody = JSON.parse(g.options.body);
  check("buildGeminiRequest: body shape (system_instruction/contents/inline_data/temp 0.4)", gBody.system_instruction.parts[0].text === SP
    && gBody.contents[0].role === "user"
    && gBody.contents[0].parts[0].text === UT
    && gBody.contents[0].parts[1].inline_data.mime_type === "image/jpeg"
    && gBody.contents[0].parts[1].inline_data.data === IMG
    && gBody.generationConfig.temperature === 0.4);

  const o = wire.buildOpenAIRequest(...args);
  check("buildOpenAIRequest: URL + Bearer header", o.url === "https://base.example/v1/chat/completions" && o.options.headers.Authorization === "Bearer KEY123");
  const oBody = JSON.parse(o.options.body);
  check("buildOpenAIRequest: body shape (system+user, image_url data URL, temp 0.4)", oBody.model === "model-x"
    && oBody.messages[0].role === "system" && oBody.messages[0].content === SP
    && oBody.messages[1].content[0].type === "text" && oBody.messages[1].content[0].text === UT
    && oBody.messages[1].content[1].type === "image_url"
    && oBody.messages[1].content[1].image_url.url === "data:image/jpeg;base64,QUJD"
    && oBody.temperature === 0.4);

  const a = wire.buildAnthropicRequest(...args);
  check("buildAnthropicRequest: URL + x-api-key + anthropic-version headers", a.url === "https://base.example/v1/messages"
    && a.options.headers["x-api-key"] === "KEY123" && a.options.headers["anthropic-version"] === "2023-06-01");
  const aBody = JSON.parse(a.options.body);
  check("buildAnthropicRequest: body shape (max_tokens 2048, system, base64 image)", aBody.model === "model-x"
    && aBody.max_tokens === 2048 && aBody.system === SP
    && aBody.messages[0].content[0].type === "text"
    && aBody.messages[0].content[1].type === "image"
    && aBody.messages[0].content[1].source.type === "base64"
    && aBody.messages[0].content[1].source.media_type === "image/jpeg"
    && aBody.messages[0].content[1].source.data === IMG);

  // A3. Parsers.
  check("parseGeminiText extracts text + reported model", wire.parseGeminiText({ modelVersion: "gemini-x", candidates: [{ content: { parts: [{ text: "HELLO" }] } }] }).text === "HELLO");
  check("parseOpenAIText extracts text + reported model", wire.parseOpenAIText({ model: "gpt-y", choices: [{ message: { content: "HELLO" } }] }).text === "HELLO"
    && wire.parseOpenAIText({ model: "gpt-y", choices: [{ message: { content: "HELLO" } }] }).reportedModel === "gpt-y");
  check("parseOpenAIText handles array content (some gateways)", wire.parseOpenAIText({ choices: [{ message: { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] } }] }).text === "AB");
  check("parseAnthropicText joins text blocks", wire.parseAnthropicText({ model: "claude-z", content: [{ type: "text", text: "HE" }, { type: "text", text: "LLO" }] }).text === "HELLO");
  check("blocked gemini response → specific error", (() => { try { wire.parseGeminiText({ promptFeedback: { blockReason: "SAFETY" } }); return false; } catch (e) { return /blocked this request \(SAFETY\)/.test(e.message); } })());

  // A4. JSON extraction.
  check("extractJsonFromText: fenced ```json block", vm.extractJsonFromText("```json\n{\"a\":1}\n```").a === 1);
  check("extractJsonFromText: prose around JSON", vm.extractJsonFromText("Here you go:\n{\"a\":1}\nDone.").a === 1);
  check("extractJsonFromText: picks the metadata fence among several", vm.extractJsonFromText("`{\"x\":` then ```json\n{\"a\":1}\n```").a === 1);
  check("extractJsonFromText: garbage → throws", (() => { try { vm.extractJsonFromText("no json at all"); return false; } catch { return true; } })());

  // A5. validateMetadataOutput — the no-missing-fields guarantee.
  const good = {
    description: "d",
    platforms: {
      adobe_stock: { title: "t", keywords: ["k1", "k2", "k3", "k4", "k5"] },
      shutterstock: { title: "t", keywords: ["k1", "k2", "k3", "k4", "k5", "k6", "k7"] },
      istock_getty: { title: "t", keywords: ["k1", "k2", "k3", "k4", "k5"] },
      freepik_vecteezy: { title: "t", keywords: ["k1", "k2", "k3", "k4", "k5"] },
    },
    category_suggestion: "c",
    flags: [],
  };
  check("validator: exact required shape passes", vm.validateMetadataOutput(good).ok === true);
  check("validator: returns canonical shape only", JSON.stringify(Object.keys(vm.validateMetadataOutput(good).value)) === JSON.stringify(["description", "platforms", "category_suggestion", "flags"]));

  const clone = () => JSON.parse(JSON.stringify(good));
  let b = clone(); delete b.description;
  check("validator: missing description rejected", !vm.validateMetadataOutput(b).ok && vm.validateMetadataOutput(b).errors.some((e) => e.startsWith("description")));
  b = clone(); delete b.platforms.shutterstock;
  check("validator: missing platform rejected", !vm.validateMetadataOutput(b).ok && vm.validateMetadataOutput(b).errors.some((e) => e.startsWith("platforms.shutterstock")));
  b = clone(); b.platforms.adobe_stock.keywords = ["k1"];
  check("validator: adobe < 5 keywords rejected", vm.validateMetadataOutput(b).errors.some((e) => e.includes("adobe_stock.keywords: need at least 5, got 1")));
  b = clone(); b.platforms.shutterstock.keywords = ["k1", "k2", "k3", "k4", "k5", "k6"];
  check("validator: shutterstock < 7 keywords rejected", vm.validateMetadataOutput(b).errors.some((e) => e.includes("shutterstock.keywords: need at least 7, got 6")));
  b = clone(); b.platforms.istock_getty.title = "";
  check("validator: empty title rejected", vm.validateMetadataOutput(b).errors.some((e) => e.includes("istock_getty.title")));
  b = clone(); delete b.flags;
  check("validator: missing flags rejected (must be array, may be empty)", vm.validateMetadataOutput(b).errors.some((e) => e.startsWith("flags")));
  b = clone(); b.flags = "none";
  check("validator: flags as string rejected", !vm.validateMetadataOutput(b).ok);
  b = clone(); delete b.category_suggestion;
  check("validator: missing category_suggestion rejected", vm.validateMetadataOutput(b).errors.some((e) => e.startsWith("category_suggestion")));
  b = clone(); b.platforms.adobe_stock.keywords = ["k1", "k2", "k3", "k4", ""];
  check("validator: empty-string keyword rejected (no silent substitution)", vm.validateMetadataOutput(b).errors.some((e) => e.includes("empty/non-string keyword")));
  b = clone(); b.extra = "junk";
  check("validator: extra junk fields stripped from canonical output", vm.validateMetadataOutput(b).ok && !("extra" in vm.validateMetadataOutput(b).value));
}

// ─── Mock upstream server ───────────────────────────────────────────────
// One server; the provider baseUrl override selects a scenario via the first
// path segment. Every request is verified against its scenario's wire format
// BEFORE responding, so a builder bug fails the scenario loudly.

function validMetadata() {
  return {
    description: "Minimalist desert scene with coral and navy shapes.",
    platforms: {
      adobe_stock: { title: "Coral and navy abstract desert background", keywords: ["coral", "navy", "desert", "background", "warm", "sand", "gradient", "banner background", "poster design", "phone wallpaper"] },
      shutterstock: { title: "Coral and navy abstract desert background for design", keywords: ["coral", "navy", "desert", "background", "warm", "sand", "gradient", "banner background", "poster design", "phone wallpaper", "desktop wallpaper"] },
      istock_getty: { title: "Coral and navy desert background", keywords: ["coral", "navy", "desert", "background", "warm", "sand"] },
      freepik_vecteezy: { title: "Coral navy desert background", keywords: ["coral", "navy", "desert", "background", "warm"] },
    },
    category_suggestion: "Backgrounds",
    flags: [],
  };
}

const SCENARIOS = {
  "gemini-ok": { format: "gemini", behavior: "valid" },
  "anthropic-ok": { format: "anthropic", behavior: "valid" },
  "openai-ok": { format: "openai", behavior: "valid" },
  "reported-model": { format: "openai", behavior: "valid", reportedModel: "xkiro/auto-routed-model" },
  "missing-fields": { format: "gemini", behavior: "missing-fields" },
  "bad-json": { format: "openai", behavior: "bad-json" },
  "auth-401": { format: "openai", behavior: "http", status: 401, body: { error: { message: "Incorrect API key provided" } } },
  "always-500": { format: "gemini", behavior: "http", status: 503, body: { error: { message: "The model is overloaded" } } },
  "always-404": { format: "openai", behavior: "http", status: 404, body: { error: { message: "The model `x` does not exist" } } },
  "model-404-then-ok": { format: "gemini", behavior: "model-404-then-ok" },
  "unauthorized-client": { format: "openai", behavior: "http", status: 403, body: { message: "UNAUTHORIZED_CLIENT" } },
  "empty-content": { format: "anthropic", behavior: "empty" },
};

const mockLog = {}; // scenario -> { count, models: [], assertions: [] }

function assertWireShape(scenario, format, req, body, query) {
  const errs = [];
  const sysStart = "You are an expert microstock metadata strategist";
  if (format === "gemini") {
    if (!/\/models\/[^:]+:generateContent$/.test(req.path || "")) errs.push(`path must end /models/{model}:generateContent, got ${req.path}`);
    if (query.get("key") !== req.expectedKey) errs.push(`?key= must carry the API key`);
    if (body.system_instruction?.parts?.[0]?.text?.startsWith(sysStart) !== true) errs.push("system_instruction.parts[0].text must carry the system prompt");
    const c = body.contents?.[0];
    if (c?.role !== "user") errs.push("contents[0].role must be user");
    if (c?.parts?.[0]?.text == null) errs.push("contents[0].parts[0] must be the user text");
    if (c?.parts?.[1]?.inline_data?.mime_type !== "image/jpeg" || !c?.parts?.[1]?.inline_data?.data) errs.push("contents[0].parts[1] must be inline_data image");
    if (body.generationConfig?.temperature !== 0.4) errs.push("generationConfig.temperature must be 0.4");
  } else if (format === "openai") {
    if (!req.path.endsWith("/chat/completions")) errs.push(`path must end /chat/completions, got ${req.path}`);
    if (req.headers.authorization !== `Bearer ${req.expectedKey}`) errs.push("Authorization: Bearer <key> required");
    if (body.messages?.[0]?.role !== "system" || body.messages?.[0]?.content?.startsWith(sysStart) !== true) errs.push("messages[0] must be system prompt");
    const u = body.messages?.[1];
    if (u?.role !== "user" || u?.content?.[0]?.type !== "text") errs.push("messages[1].content[0] must be text");
    if (u?.content?.[1]?.type !== "image_url" || !String(u?.content?.[1]?.image_url?.url || "").startsWith("data:image/jpeg;base64,")) errs.push("messages[1].content[1] must be image_url data URL");
    if (body.temperature !== 0.4) errs.push("temperature must be 0.4");
    if (!body.model) errs.push("model required");
  } else if (format === "anthropic") {
    if (!req.path.endsWith("/messages")) errs.push(`path must end /messages, got ${req.path}`);
    if (req.headers["x-api-key"] !== req.expectedKey) errs.push("x-api-key header required");
    if (req.headers["anthropic-version"] !== "2023-06-01") errs.push("anthropic-version: 2023-06-01 required");
    if (body.max_tokens !== 2048) errs.push("max_tokens must be 2048");
    if (typeof body.system !== "string" || !body.system.startsWith(sysStart)) errs.push("system must be the system prompt string");
    const u = body.messages?.[0];
    if (u?.role !== "user" || u?.content?.[0]?.type !== "text") errs.push("messages[0].content[0] must be text");
    if (u?.content?.[1]?.type !== "image" || u?.content?.[1]?.source?.type !== "base64" || u?.content?.[1]?.source?.media_type !== "image/jpeg" || !u?.content?.[1]?.source?.data) errs.push("messages[0].content[1] must be base64 image");
    if (!body.model) errs.push("model required");
  }
  return errs;
}

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const url = new URL(req.url, "http://x");
        const scenarioId = url.pathname.split("/")[1];
        const sc = SCENARIOS[scenarioId];
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch { /* noop */ }
        const log = (mockLog[scenarioId] = mockLog[scenarioId] || { count: 0, models: [], assertionErrors: [] });
        log.count += 1;
        log.models.push(body.model || (url.pathname.match(/\/models\/([^:]+)/) || [])[1] || null);

        const key = new URL(req.url, "http://x").searchParams.get("key") || req.headers.authorization?.replace("Bearer ", "") || req.headers["x-api-key"];

        // GET /models = connection test from /api/test-provider. Assert the
        // auth STYLE, then answer with a format-appropriate model list (or
        // the scenario's canned error, e.g. 401 / UNAUTHORIZED_CLIENT).
        if (req.method === "GET") {
          const sendG = (status, obj) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(obj));
          };
          if (!sc) { sendG(404, { error: { message: "unknown mock scenario" } }); return; }
          const authErrs = [];
          if (sc.format === "gemini" && !url.searchParams.get("key")) authErrs.push("gemini auth must be ?key= query param");
          if (sc.format === "openai" && !req.headers.authorization?.startsWith("Bearer ")) authErrs.push("openai auth must be Authorization: Bearer");
          if (sc.format === "anthropic" && (!req.headers["x-api-key"] || req.headers["anthropic-version"] !== "2023-06-01")) authErrs.push("anthropic auth must be x-api-key + anthropic-version");
          if (authErrs.length > 0) {
            mockLog[scenarioId].assertionErrors.push(authErrs.join("; "));
            sendG(500, { error: { message: `MOCK AUTH ASSERTION FAILED: ${authErrs.join("; ")}` } });
            return;
          }
          if (sc.behavior === "http") { sendG(sc.status, sc.body); return; }
          if (sc.format === "gemini") {
            sendG(200, { models: [{ name: "models/fake-gemini-a" }, { name: "models/fake-gemini-b" }] });
          } else {
            sendG(200, { data: [{ id: "fake-model-a" }, { id: "fake-model-b" }] });
          }
          return;
        }

        if (sc) {
          const errs = assertWireShape(scenarioId, sc.format, {
            path: url.pathname, headers: req.headers, expectedKey: key || "",
          }, body, url.searchParams);
          if (errs.length > 0) {
            log.assertionErrors.push(errs.join("; "));
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: `MOCK WIRE-SHAPE ASSERTION FAILED: ${errs.join("; ")}` } }));
            return;
          }
        }

        const send = (status, obj) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        const meta = validMetadata();

        if (!sc) { send(404, { error: { message: "unknown mock scenario" } }); return; }
        switch (sc.behavior) {
          case "valid":
            if (sc.format === "gemini") {
              send(200, { modelVersion: "gemini-reported", candidates: [{ content: { parts: [{ text: JSON.stringify(meta) }] } }] });
            } else if (sc.format === "openai") {
              send(200, { model: sc.reportedModel || "gpt-reported", choices: [{ message: { content: JSON.stringify(meta) }, finish_reason: "stop" }] });
            } else {
              send(200, { model: "claude-reported", content: [{ type: "text", text: JSON.stringify(meta) }] });
            }
            return;
          case "missing-fields": {
            const bad = JSON.parse(JSON.stringify(meta));
            delete bad.platforms.shutterstock;
            bad.platforms.istock_getty.keywords = ["a", "b"];
            bad.description = "";
            send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(bad) }] } }] });
            return;
          }
          case "bad-json":
            send(200, { choices: [{ message: { content: "Sorry, I cannot help with that request." }, finish_reason: "stop" }] });
            return;
          case "http":
            send(sc.status, sc.body);
            return;
          case "model-404-then-ok": {
            // First call (any model) → Google-style 404 naming a replacement;
            // subsequent calls → success.
            if (log.count === 1) {
              send(404, { error: { message: "models/gemini-3.6-flash is not found for API version v1beta, or is not supported for generateContent. Use gemini-9.9-flash instead. Call ListModels to see the list of available models." } });
            } else {
              send(200, { modelVersion: "gemini-reported", candidates: [{ content: { parts: [{ text: JSON.stringify(meta) }] } }] });
            }
            return;
          }
          case "empty":
            send(200, { model: "claude-reported", content: [] });
            return;
          default:
            send(500, { error: { message: "mock misconfigured" } });
        }
      });
    });
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ─── HTTP helpers against the app ───────────────────────────────────────
const IMG64 = Buffer.from("fake-image-bytes").toString("base64");

async function generate(payload) {
  const res = await fetch(`${APP}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64: IMG64, mimeType: "image/jpeg", context: "", ...payload }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, data: await res.json() };
}

function slot(providerId, { key = "test-key", model, baseUrl, wireFormat } = {}) {
  return { providerId, apiKey: key, model, baseUrl, wireFormat };
}

async function testProvider(payload) {
  const res = await fetch(`${APP}/api/test-provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, data: await res.json() };
}

function assertFullShape(t, data) {
  check(`${t}: full validated shape returned`, typeof data.description === "string" && data.description.length > 0
    && data.platforms && typeof data.platforms.adobe_stock?.title === "string" && data.platforms.adobe_stock.keywords.length >= 5
    && typeof data.platforms.shutterstock?.title === "string" && data.platforms.shutterstock.keywords.length >= 7
    && typeof data.platforms.istock_getty?.title === "string" && data.platforms.istock_getty.keywords.length >= 5
    && typeof data.platforms.freepik_vecteezy?.title === "string" && data.platforms.freepik_vecteezy.keywords.length >= 5
    && typeof data.category_suggestion === "string" && Array.isArray(data.flags), JSON.stringify(data).slice(0, 220));
  check(`${t}: no partial/undefined platform slots`, ["adobe_stock", "shutterstock", "istock_getty", "freepik_vecteezy"].every((k) => data.platforms?.[k]?.title && Array.isArray(data.platforms?.[k]?.keywords)));
}

// ─── Part B: integration tests ──────────────────────────────────────────
async function integrationTests() {
  console.log("\n══ B. Per-provider walkthrough through /api/generate ══");

  // B1. Happy path for every slot — full shape + wire conformance.
  // helyx/vyce/seekai have no preset model list — as configured users we
  // type one (the app fails fast with instructions if it's missing).
  const happy = [
    ["gemini", "gemini-ok", "test-key-gemini", undefined],
    ["anthropic", "anthropic-ok", "test-key-anthropic", undefined],
    ["openai", "openai-ok", "test-key-openai", undefined],
    ["helyx", "openai-ok", "test-key-helyx", "gpt-4o"],
    ["vyce", "openai-ok", "test-key-vyce", "claude-sonnet-5"],
    ["xkiro", "reported-model", "test-key-xkiro", undefined],
    ["agentrouter", "openai-ok", "test-key-agentrouter", undefined],
    ["seekai", "openai-ok", "test-key-seekai", "gpt-4o"],
  ];
  for (const [pid, scenario, key, model] of happy) {
    const t = `slot ${pid}`;
    const { status, data } = await generate({ providers: [slot(pid, { key, baseUrl: `${MOCK}/${scenario}`, model })] });
    check(`${t}: HTTP 200`, status === 200, `got ${status}: ${JSON.stringify(data).slice(0, 200)}`);
    assertFullShape(t, data);
    check(`${t}: provenance (_meta.providerId)`, data._meta?.providerId === pid);
    if (pid === "xkiro") {
      check("slot xkiro: reports the model xKiro actually used", data._meta?.modelUsed === "xkiro/auto-routed-model", data._meta?.modelUsed);
    }
    const mockHit = mockLog[scenario];
    check(`${t}: mock received wire-format-conformant request`, mockHit && mockHit.assertionErrors.length === 0, mockHit?.assertionErrors?.join("; "));
  }

  // B2. xKiro anthropic-format route (per-slot format switch).
  {
    const { status, data } = await generate({ providers: [slot("xkiro", { key: "test-key-xkiro", baseUrl: `${MOCK}/anthropic-ok`, wireFormat: "anthropic-messages", model: "anthropic/claude-opus-5" })] });
    check("slot xkiro (anthropic format): 200 + full shape", status === 200 && !!data.platforms, `got ${status}: ${JSON.stringify(data).slice(0, 160)}`);
    check("slot xkiro (anthropic format): mock saw /messages + anthropic headers", mockLog["anthropic-ok"]?.assertionErrors.length === 0, mockLog["anthropic-ok"]?.assertionErrors?.join("; "));
  }

  // B3. Strict validation — no missing fields, ever.
  {
    const { status, data } = await generate({ providers: [slot("gemini", { key: "k", baseUrl: `${MOCK}/missing-fields` })] });
    check("missing fields: fails (no 200)", status !== 200, `got ${status}`);
    check("missing fields: NO partial metadata in response", !data.platforms && !data.description, JSON.stringify(data).slice(0, 160));
    check("missing fields: clear 'incomplete response' headline", /Incomplete response from Google Gemini/.test(data.error || ""), data.error);
    check("missing fields: exact missing fields listed", (data.attempts?.[0]?.error || "").includes("platforms.shutterstock: missing")
      && (data.attempts?.[0]?.error || "").includes("istock_getty.keywords: need at least 5, got 2")
      && (data.attempts?.[0]?.error || "").includes("description: required"), data.attempts?.[0]?.error);
  }
  {
    const { status, data } = await generate({ providers: [slot("openai", { key: "k", baseUrl: `${MOCK}/bad-json` })] });
    check("invalid JSON: fails with specific error", status !== 200 && /not valid JSON|parseable JSON/i.test(data.error || ""), `${status}: ${data.error}`);
    check("invalid JSON: no partial metadata", !data.platforms);
  }
  {
    const { status, data } = await generate({ providers: [slot("anthropic", { key: "k", baseUrl: `${MOCK}/empty-content` })] });
    check("empty content: specific error (no text content)", status !== 200 && /no text content/i.test(data.error || ""), `${status}: ${data.error}`);
  }

  // B4. Auth failures surface the provider's own message.
  {
    const { status, data } = await generate({ providers: [slot("openai", { key: "wrong", baseUrl: `${MOCK}/auth-401` })] });
    check("bad key: 401 + provider's message, no generic error", status === 401 && /Incorrect API key provided/.test(data.error || ""), `${status}: ${data.error}`);
  }

  // B5. AgentRouter client rejection — distinct, immediate, not hidden.
  {
    const { status, data } = await generate({
      providers: [
        slot("agentrouter", { key: "k", baseUrl: `${MOCK}/unauthorized-client` }),
        slot("openai", { key: "k", baseUrl: `${MOCK}/openai-ok` }), // fallback must NOT run
      ],
    });
    check("agentrouter rejection: HTTP 403", status === 403, `got ${status}`);
    check("agentrouter rejection: exact spec message", data.error === "AgentRouter rejected this app as an unrecognized client — this is a known restriction on their side, not a bug in your key or this app.", data.error);
    const before = mockLog["openai-ok"]?.count || 0;
    await generate({ providers: [slot("agentrouter", { key: "k", baseUrl: `${MOCK}/unauthorized-client` }), slot("openai", { key: "k", baseUrl: `${MOCK}/openai-ok` })] });
    check("agentrouter rejection: fallback provider received ZERO extra requests", (mockLog["openai-ok"]?.count || 0) === before, `before=${before} after=${mockLog["openai-ok"]?.count}`);
  }

  // B6. Vyce — unreachable endpoint → verify-base-URL error, never "dead provider".
  {
    const { status, data } = await generate({ providers: [slot("vyce", { key: "k", baseUrl: "http://127.0.0.1:9/v1", model: "claude-sonnet-5" })] });
    check("vyce unreachable: connection error mentions verifying Vyce's docs", status !== 200 && /verify the base URL in Vyce's own docs/.test(data.error || ""), `${status}: ${data.error}`);
  }

  // B7. Gemini deprecation 404: informational, next preset tried, NOT auto-adopted.
  {
    mockLog["model-404-then-ok"] = { count: 0, models: [], assertionErrors: [] };
    const { status, data } = await generate({ providers: [slot("gemini", { key: "k", baseUrl: `${MOCK}/model-404-then-ok` })] });
    check("gemini 404+replacement: recovers via next preset model", status === 200 && data._meta?.modelRequested === "gemini-2.5-flash", `${status} modelRequested=${data._meta?.modelRequested}`);
    check("gemini 404+replacement: exactly 2 attempts, 2nd model is the PRESET (no auto-adopt)", mockLog["model-404-then-ok"].count === 2 && mockLog["model-404-then-ok"].models[0] === "gemini-3.6-flash" && mockLog["model-404-then-ok"].models[1] === "gemini-2.5-flash", JSON.stringify(mockLog["model-404-then-ok"].models));
    check("gemini 404+replacement: replacement ID surfaced as info, not adopted", (data._meta?.attempts?.[0]?.info || "").includes("gemini-9.9-flash") && (data._meta?.attempts?.[0]?.info || "").includes("never rewrites"), data._meta?.attempts?.[0]?.info);
  }

  // B8. xKiro: exactly ONE request even on failure (its own failover handles retries).
  {
    const { status, data } = await generate({ providers: [slot("xkiro", { key: "k", baseUrl: `${MOCK}/always-404` })] });
    check("xkiro failure: single attempt only", mockLog["always-404"].count === 1, `count=${mockLog["always-404"].count}`);
    check("xkiro failure: provider's message surfaced", status !== 200 && /xKiro request failed \(404\)/.test(data.error || ""), `${status}: ${data.error}`);
  }

  // B9. Opt-in fallback chain: selected provider fails → configured backup answers.
  {
    const { status, data } = await generate({
      providers: [
        slot("gemini", { key: "k", baseUrl: `${MOCK}/always-500` }),
        slot("anthropic", { key: "k", baseUrl: `${MOCK}/anthropic-ok` }),
      ],
    });
    check("fallback chain: backup provider answers", status === 200 && data._meta?.providerId === "anthropic", `${status} provider=${data._meta?.providerId}`);
    check("fallback chain: fellBack flagged + attempt trail", data._meta?.fellBack === true && (data._meta?.attempts?.length || 0) >= 2, JSON.stringify(data._meta?.attempts?.map((a) => [a.provider, a.model, a.ok])));
  }

  // B10. Manual pick is respected: only the chosen provider is called.
  {
    const before = mockLog["anthropic-ok"]?.count || 0;
    const { status } = await generate({ providers: [slot("anthropic", { key: "test-key-anthropic", baseUrl: `${MOCK}/anthropic-ok` })] });
    check("manual selection: only chosen provider called", status === 200 && (mockLog["anthropic-ok"]?.count || 0) === before + 1);
  }

  console.log("\n══ C. /api/test-provider walkthrough ══");
  {
    const { data } = await testProvider({ providerId: "openai", apiKey: "test-key-openai", baseUrl: `${MOCK}/openai-ok` });
    check("test openai: connected via GET /models", data.status === "connected" && data.ok === true, JSON.stringify(data));
    check("test openai: discovers the provider's model list for the Model dropdown", Array.isArray(data.models) && data.models.includes("fake-model-a"), JSON.stringify(data.models));
  }
  {
    const { status, data } = await generate({ providers: [slot("helyx", { key: "k", baseUrl: `${MOCK}/openai-ok`, model: "" })] });
    check("empty-preset gateway with no model: fails fast with instructions (never an opaque error)", status !== 200 && /no model set/.test(data.error || "") && /Settings/.test(data.error || ""), `${status}: ${data.error}`);
  }
  {
    const { data } = await testProvider({ providerId: "openai", apiKey: "wrong", baseUrl: `${MOCK}/auth-401` });
    check("test openai: bad key → status invalid + reason", data.status === "invalid" && /rejected \(401\)/.test(data.message || ""), JSON.stringify(data));
  }
  {
    const { data } = await testProvider({ providerId: "gemini", apiKey: "k", baseUrl: `${MOCK}/gemini-ok` });
    check("test gemini: connected", data.status === "connected", JSON.stringify(data));
    check("test gemini: model list discovered (models/ prefix stripped)", Array.isArray(data.models) && data.models.includes("fake-gemini-a"), JSON.stringify(data.models));
  }
  {
    const { data } = await testProvider({ providerId: "anthropic", apiKey: "test-key-anthropic", baseUrl: `${MOCK}/anthropic-ok` });
    check("test anthropic: connected (x-api-key + version headers asserted by mock)", data.status === "connected" && mockLog["anthropic-ok"].assertionErrors.length === 0, JSON.stringify(data));
  }
  {
    const { data } = await testProvider({ providerId: "vyce", apiKey: "k", baseUrl: "http://127.0.0.1:9/v1" });
    check("test vyce: unreachable → verify-base-URL guidance", data.ok === false && /verify the base URL in Vyce's own docs/.test(data.message || ""), JSON.stringify(data));
  }
  {
    const { data } = await testProvider({ providerId: "agentrouter", apiKey: "k", baseUrl: `${MOCK}/unauthorized-client` });
    check("test agentrouter: client rejection surfaced distinctly", data.ok === false && data.message?.startsWith("AgentRouter rejected this app as an unrecognized client"), JSON.stringify(data));
  }
}

// ─── Boot: mock upstream + built Next server, then run everything ───────
async function waitFor(url, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch (err) {
      if (err?.name === "AbortError") continue; // connected but slow — retry
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

async function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => { s.destroy(); resolve(false); });
  });
}

async function main() {
  // Global watchdog so the script can never wedge silently.
  const watchdog = setTimeout(() => {
    console.error("\nWATCHDOG: verification exceeded 150s — aborting.");
    process.exit(2);
  }, 150_000);
  watchdog.unref();

  await unitTests();

  if (await portBusy(MOCK_PORT)) {
    console.error(`Port ${MOCK_PORT} already in use — kill the stale process and re-run.`);
    process.exit(2);
  }
  await startMock();

  if (await portBusy(APP_PORT)) {
    console.error(`Port ${APP_PORT} already in use — kill the stale Next server and re-run.`);
    process.exit(2);
  }
  console.log(`\n(mock upstream on :${MOCK_PORT}, starting Next server on :${APP_PORT})`);
  const server = spawn("npx", ["next", "start", "-p", String(APP_PORT), "-H", "127.0.0.1"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group so the kill below takes the child too
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (d) => process.stderr.write(d));
  try {
    const up = await waitFor(`${APP}/api/test-provider`);
    if (!up) throw new Error("Next server did not start");
    await integrationTests();
  } finally {
    try { process.kill(-server.pid, "SIGKILL"); } catch { /* already gone */ }
    try { server.kill("SIGKILL"); } catch { /* already gone */ }
  }

  console.log(`\n══ RESULT: ${passed} passed, ${failed} failed ══`);
  if (failed > 0) {
    console.log("Failures:");
    failures.forEach((f) => console.log(`  • ${f}`));
    process.exit(1);
  }
  process.exit(0); // mock server would otherwise keep the loop alive
}

main().catch((e) => {
  console.error("VERIFY SCRIPT CRASHED:", e);
  process.exit(1);
});
