"use client";
// ─── Fine-grained client error boundary ─────────────────────────────────
// A render-time exception inside a child (e.g. the Settings panel hitting a
// malformed saved value) used to bubble to Next's root handler and replace
// the WHOLE page with the white "Application error" screen. This boundary
// contains the blast radius: only the wrapped subtree is swapped for the
// recovery UI, and the rest of the app keeps working.
//
// resetKey: pass something that changes when the wrapped subtree is closed
// and re-opened (e.g. `showSettings`). When it changes, a previously caught
// error is forgotten so the child gets a clean second chance.
import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the real stack in the console for diagnosis; the UI stays clean.
    console.error("[Lightbox] render error caught by boundary:", error, info);
  }

  componentDidUpdate(prev) {
    // Re-opening the wrapped subtree (resetKey change) clears the last error.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (error && this.props.renderFallback) {
      return this.props.renderFallback(error, () => this.setState({ error: null }));
    }
    // No custom fallback provided: never render null silently — show the
    // inline card so a failure is always visible, never a blank region.
    if (error) {
      return (
        <div
          role="alert"
          style={{
            padding: 20, borderRadius: 12, border: "1px solid var(--danger)",
            background: "var(--danger-soft)", color: "var(--danger)",
            fontSize: 13, lineHeight: 1.6,
          }}
        >
          <strong>This section hit an error and was stopped.</strong>
          <div style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 12, wordBreak: "break-word" }}>
            {String(error?.message || error)}
          </div>
          <button onClick={() => this.setState({ error: null })} className="btn btn-ghost" style={{ marginTop: 10 }}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
