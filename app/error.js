"use client";
// ─── Route-level error boundary (App Router) ────────────────────────────
// Without this file, any client-side render exception replaces the page
// with Next.js's unstyled white "Application error" screen — which is
// exactly the "blank page" reported when Settings crashed. This renders a
// styled recovery screen in the app's own look instead, and offers a
// one-click purge of the app's saved browser data as the escape hatch for
// corrupted localStorage (the usual root cause of a crash that survives a
// plain reload).
import { clearAllSettings } from "../lib/client-config";

export default function AppError({ error, reset }) {
  return (
    <div
      style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24, background: "var(--bg, #0d0f14)",
      }}
    >
      <div
        role="alert"
        style={{
          width: 560, maxWidth: "100%", padding: 28,
          background: "var(--panel, #151821)", border: "1px solid var(--border, #2a2e3a)",
          borderRadius: 16, boxShadow: "var(--shadow, 0 10px 40px rgba(0,0,0,.35))",
          fontFamily: "Inter, system-ui, sans-serif", color: "var(--text, #e8eaf0)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>
          Something on this page hit an error
        </h1>
        <p style={{ margin: "10px 0 0", fontSize: 13.5, color: "var(--text-dim, #a6acbd)", lineHeight: 1.6 }}>
          Your images and generated metadata may still be in memory — reloading the app
          usually brings everything back. If the same error keeps coming back, clear the
          saved settings below (it removes only this app&apos;s browser data: API keys,
          provider choices, theme) and start fresh.
        </p>
        <div
          style={{
            marginTop: 12, padding: "10px 12px", borderRadius: 8, fontSize: 12,
            fontFamily: "var(--font-mono, monospace)", wordBreak: "break-word",
            background: "var(--panel-raised, #1a1e2a)", border: "1px solid var(--border-soft, #232838)",
            color: "var(--danger, #ff6b6b)",
          }}
        >
          {String(error?.message || error)}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
          <button
            onClick={() => reset()}
            className="btn btn-primary"
            style={{ padding: "9px 16px", fontSize: 13.5, cursor: "pointer" }}
          >
            ↻ Reload the app
          </button>
          <button
            onClick={() => { clearAllSettings(); window.location.reload(); }}
            className="btn btn-ghost"
            style={{ padding: "9px 16px", fontSize: 13.5, cursor: "pointer" }}
          >
            Clear saved settings &amp; reload
          </button>
        </div>
      </div>
    </div>
  );
}
