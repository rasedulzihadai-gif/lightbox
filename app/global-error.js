"use client";
// ─── Root-level error boundary (last resort) ────────────────────────────
// Only fires if the crash happens in the root layout itself, outside
// app/error.js's reach. Must render its own <html>/<body>. Deliberately has
// ZERO imports and plain inline CSS: if the crash came from an app module
// throwing at import time, importing anything here would re-crash the last
// resort. Offers the same settings-purge escape hatch (inlined, for the
// same reason) so even a root-level crash never leaves the user a blank
// page.
export default function GlobalError({ error, reset }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "Inter, system-ui, sans-serif", background: "#0d0f14" }}>
        <div style={{
          minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
        }}>
          <div
            role="alert"
            style={{
              width: 560, maxWidth: "100%", padding: 28, borderRadius: 16,
              background: "#151821", border: "1px solid #2a2e3a", color: "#e8eaf0",
            }}
          >
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>
              The app failed to start
            </h1>
            <p style={{ margin: "10px 0 0", fontSize: 13.5, color: "#a6acbd", lineHeight: 1.6 }}>
              A hard reload usually fixes this. If the error keeps returning, clear the
              saved settings — it removes only this app&apos;s browser data (API keys,
              provider choices, theme).
            </p>
            <div style={{
              marginTop: 12, padding: "10px 12px", borderRadius: 8, fontSize: 12,
              fontFamily: "monospace", wordBreak: "break-word",
              background: "#1a1e2a", border: "1px solid #232838", color: "#ff6b6b",
            }}>
              {String(error?.message || error)}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
              <button
                onClick={() => reset()}
                style={{
                  padding: "9px 16px", fontSize: 13.5, cursor: "pointer", borderRadius: 8,
                  border: "1px solid transparent", background: "#6c5ce7", color: "#fff",
                }}
              >
                ↻ Reload the app
              </button>
              <button
                onClick={() => {
                  try {
                    const doomed = [];
                    for (let i = 0; i < localStorage.length; i++) {
                      const k = localStorage.key(i);
                      if (k && k.startsWith("mstock_")) doomed.push(k);
                    }
                    doomed.forEach((k) => localStorage.removeItem(k));
                  } catch { /* storage unavailable — reload anyway */ }
                  window.location.reload();
                }}
                style={{
                  padding: "9px 16px", fontSize: 13.5, cursor: "pointer", borderRadius: 8,
                  border: "1px solid #2a2e3a", background: "transparent", color: "#e8eaf0",
                }}
              >
                Clear saved settings &amp; reload
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
