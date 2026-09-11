// ─── jsdom hydration + interaction smoke test ──────────────────────────
// Loads the REAL built page (scripts included) like a browser would, seeds
// localStorage like different kinds of users, waits for React hydration,
// then interacts (opens Settings) — any client-side exception fails the test.
//
// Why this exists: a missing import in a client component once shipped to
// production because it only threw at render time in the BROWSER
// (ReferenceError → white "Application error" page). SSR + `next build` do
// not catch that class of bug; this harness does, by actually hydrating and
// clicking.
//
// jsdom gaps that must be bridged (all present in real browsers):
//   - web streams (Next's RSC flight reader needs a REAL ReadableStream —
//     node:stream/web's genuine classes work; a fake one that returns
//     done immediately makes React throw "Connection closed." at hydration)
//   - TextEncoder/TextDecoder (react-dom references TextEncoder at chunk
//     init; without it the event system never attaches)
//
// Run: node scripts/hydration-test.mjs   (app must be running on :3000 —
//       `npm run dev` or `next start` after `next build`)
import { JSDOM, VirtualConsole, ResourceLoader } from "jsdom";
import * as webStreams from "node:stream/web";

const URL_APP = process.env.HYDRATION_TEST_URL || "http://127.0.0.1:3000/";

const scenarios = [
  { name: "fresh visitor (empty localStorage)", seed: {} },
  {
    name: "returning user (pre-registry mstock_gemini_key + light theme)",
    seed: { mstock_gemini_key: "AIzaFAKEKEY123", mstock_theme: "light" },
  },
  {
    name: "power user (gemini + xkiro, last provider + fallback saved)",
    seed: {
      mstock_gemini_key: "AIzaFAKEKEY123",
      mstock_key_xkiro: "xkiro-key",
      mstock_model_xkiro: "anthropic/claude-opus-5",
      mstock_provider: "xkiro",
      mstock_fallback_enabled: "1",
      mstock_fallback_order: JSON.stringify(["xkiro", "gemini", "openai"]),
      mstock_theme: "dark",
    },
  },
];

let failures = 0;

async function runScenario(sc, attempt = 1) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => {
    const msg = String(e?.detail?.message || e.message || e);
    if (/favicon/i.test(msg)) return;
    errors.push(msg);
  });
  vc.on("error", (...a) => errors.push(a.map(String).join(" ")));

  const dom = await JSDOM.fromURL(URL_APP, {
    runScripts: "dangerously",
    resources: new ResourceLoader(),
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      for (const [k, v] of Object.entries(sc.seed)) window.localStorage.setItem(k, v);
      // Stubs for APIs jsdom lacks (real browsers always have these).
      window.HTMLCanvasElement.prototype.getContext = () => null;
      if (!window.matchMedia) {
        window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      }
      if (typeof window.ReadableStream === "undefined") {
        window.ReadableStream = webStreams.ReadableStream;
        window.WritableStream = webStreams.WritableStream;
        window.TransformStream = webStreams.TransformStream;
        window.ByteLengthQueuingStrategy = webStreams.ByteLengthQueuingStrategy;
        window.CountQueuingStrategy = webStreams.CountQueuingStrategy;
      }
      if (typeof window.TextEncoder === "undefined") {
        window.TextEncoder = class {
          encode(s = "") { const b = Buffer.from(String(s), "utf8"); const u = new Uint8Array(b.length); u.set(b); return u; }
          get encoding() { return "utf-8"; }
        };
        window.TextDecoder = class {
          constructor(label) { this.encoding = String(label || "utf-8").toLowerCase(); }
          decode(input) {
            if (input === undefined) return "";
            if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("utf8");
            if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input)).toString("utf8");
            return String(input);
          }
          stream = "";
        };
      }
      window.addEventListener("error", (e) => {
        const msg = e?.message || String(e?.error || "unknown error event");
        if (/favicon/i.test(msg)) return;
        errors.push(`window error: ${msg}`);
      });
      window.addEventListener("unhandledrejection", (e) => errors.push(`unhandledrejection: ${e.reason}`));
    },
  });

  await new Promise((resolve) => {
    const t = setTimeout(resolve, 12_000); // hard cap
    dom.window.addEventListener("load", () => {
      setTimeout(() => { clearTimeout(t); resolve(); }, 3_000); // hydration settle
    });
  });

  const doc = dom.window.document;
  const bodyText = doc.body.textContent || "";
  const checks = [];
  const ok = (name, cond, detail = "") => {
    checks.push({ name, cond, detail });
    if (!cond) failures++;
  };

  // jsdom's resource loader occasionally drops chunk requests
  // ("Connection closed" at the transport level). If that's the ONLY reason
  // hydration failed, retry from scratch before blaming the app.
  const connectionFlake = errors.length > 0 && errors.every((e) => /Connection closed|favicon|TLS|socket/i.test(e));
  if (connectionFlake && !bodyText.includes("Generate all") && attempt < 3) {
    console.log(`  ↻ ${sc.name}: jsdom transport flake on attempt ${attempt} — retrying`);
    dom.window.close();
    return runScenario(sc, attempt + 1);
  }

  // Errors caused by jsdom's own environment gaps (NOT app bugs): the
  // sandbox also blocks fonts.googleapis.com, which jsdom reports loudly.
  const envNoise = (e) => /fonts\.googleapis|favicon|socket|TLS/i.test(e);
  const appErrors = errors.filter((e) => !envNoise(e));

  ok("no app-level client-side exceptions during load/hydration", appErrors.length === 0, appErrors.join(" | ").slice(0, 500));
  ok("app shell rendered (Lightbox logo)", bodyText.includes("Lightbox"));
  ok("hydration completed (generation bar live)", bodyText.includes("Generate all"));

  const select = doc.querySelector(".provider-select");
  ok("provider selector exists", !!select);
  const hasConfigured = Object.keys(sc.seed).some((k) => k.startsWith("mstock_key_") || k === "mstock_gemini_key");
  if (select && hasConfigured) {
    const optionCount = select.querySelectorAll("option").length;
    const selected = select.selectedOptions?.[0]?.textContent || "";
    ok("selector lists configured provider(s)", optionCount >= 1, `${optionCount} option(s)`);
    if (sc.seed.mstock_provider) {
      ok("selector defaults to last-used provider", selected.includes("xKiro"), selected);
    }
  }

  // Theme toggle proves React's event system is actually attached.
  const themeBtn = [...doc.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Toggle theme");
  if (themeBtn) {
    const before = doc.documentElement.getAttribute("data-theme");
    themeBtn.click();
    await new Promise((r) => setTimeout(r, 400));
    const after = doc.documentElement.getAttribute("data-theme");
    ok("react events attached (theme toggle works)", before !== after, `${before} -> ${after}`);
  }

  // Open Settings and confirm all 8 provider slot cards render — this is
  // the check that catches render-time ReferenceErrors inside the panel.
  const settingsBtn = [...doc.querySelectorAll("button")].find((b) => b.textContent.includes("Settings"));
  ok("Settings button exists", !!settingsBtn);
  if (settingsBtn) {
    settingsBtn.click();
    await new Promise((r) => setTimeout(r, 800));
    const settingsText = doc.body.textContent || ""; // re-read AFTER the panel opens
    const cards = doc.querySelectorAll(".provider-card");
    ok("8 provider cards render in Settings", cards.length === 8, `got ${cards.length}`);
    const names = [...doc.querySelectorAll(".provider-name")].map((n) => n.textContent);
    ok("all provider labels present",
      ["Google Gemini", "Anthropic Claude (official)", "OpenAI (official)", "Helyx AI", "Vyce AI", "xKiro", "AgentRouter", "SeekAi"].every((l) => names.includes(l)),
      names.join(", "));
    ok("fallback section renders", settingsText.includes("Automatic fallback"));
    ok("fallback toggle renders", !!doc.querySelector(".fallback-toggle input[type='checkbox']"));
    ok("API key input renders (password-style)", !!doc.querySelector('input[type="password"]'));
    ok("base URL input renders", !!doc.querySelector('input[id^="baseurl-"]'));
  }

  console.log(`\n── ${sc.name} ──`);
  for (const c of checks) console.log(` ${c.cond ? "✓" : "✕"} ${c.name}${c.cond ? "" : ` — ${c.detail}`}`);
  if (appErrors.length) console.log(`  app errors: ${appErrors.slice(0, 3).join(" | ").slice(0, 600)}`);
  dom.window.close();
}

for (const sc of scenarios) {
  await runScenario(sc);
}

console.log(`\n══ HYDRATION SMOKE: ${failures === 0 ? "ALL PASS" : `${failures} failure(s)`} ══`);
process.exit(failures === 0 ? 0 : 1);
