"use client";
import { useState, useEffect, useRef, useCallback, memo, useMemo } from "react";
import {
  buildAdobeStockCsv, buildShutterstockCsv, buildFreepikCsv, buildVecteezyCsv,
  buildIstockGettyCsv, validateFreepikRows, downloadCsv,
} from "../lib/csv";
import { analyzeKeywords, gradeColor } from "../lib/keywords";
import { PROVIDER_REGISTRY, getProvider } from "../lib/provider-registry";
import {
  loadProviderConfigs, saveProviderField, saveDiscoveredModels,
  loadUiPrefs, saveSelectedProvider, saveFallbackEnabled, saveFallbackOrder,
  buildRequestProviders,
} from "../lib/client-config";
import SettingsPanel from "./components/SettingsPanel";

// Empty slot state used during SSR / before localStorage loads — derived
// from the registry so every provider always has a well-formed config.
const EMPTY_CONFIGS = Object.fromEntries(
  PROVIDER_REGISTRY.map((p) => [
    p.id,
    { key: "", baseUrl: "", model: "", wireFormat: p.defaultWireFormat, status: "not-set", discoveredModels: [] },
  ])
);

const PLATFORM_TABS = [
  { key: "adobe_stock", label: "Adobe Stock" },
  { key: "shutterstock", label: "Shutterstock" },
  { key: "istock_getty", label: "iStock / Getty" },
  { key: "freepik_vecteezy", label: "Freepik / Vecteezy" },
];

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function resizeImage(file, maxDim = 1200) {
  return new Promise((resolve) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => resolve(new File([blob], file.name, { type: "image/jpeg" })),
          "image/jpeg",
          0.82
        );
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

const StatusDot = memo(function StatusDot({ status }) {
  const color =
    status === "done" ? "var(--success)" :
    status === "error" ? "var(--danger)" :
    status === "processing" ? "var(--accent)" : "var(--text-faint)";
  const label =
    status === "done" ? "Ready" :
    status === "error" ? "Failed" :
    status === "processing" ? "Working" : "Queued";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-dim)" }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%", background: color,
        boxShadow: status === "processing" ? `0 0 0 3px ${color}22` : "none",
      }} />
      {label}
    </span>
  );
});

// Memoized filmstrip row. Because processOne() only replaces the object for
// the item that actually changed (see setItems below), unrelated rows keep
// the same object reference across renders — React.memo bails out and skips
// re-rendering them. This turns a full-list re-render on every status
// change (O(n) work per update, O(n²) over a whole batch) into O(1) work
// per update, which is the main fix for batch-mode lag.
const FilmstripRow = memo(function FilmstripRow({ item, idx, isActive, onSelect, onRemove }) {
  return (
    <div className={`filmstrip-row${isActive ? " active" : ""}`}>
      <button
        onClick={() => onSelect(idx)}
        style={{
          display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0,
          padding: "8px", background: "none", border: "none",
          cursor: "pointer", textAlign: "left", color: "var(--text)",
        }}
      >
        <span style={{
          width: 34, height: 34, borderRadius: 8, background: "var(--panel-raised)",
          flexShrink: 0, overflow: "hidden", border: "1px solid var(--border-soft)",
        }}>
          <img
            src={item.previewUrl}
            alt=""
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {item.filename}
          </div>
          <StatusDot status={item.status} />
        </span>
      </button>
      <button
        onClick={() => onRemove(idx)}
        aria-label={`Remove ${item.filename}`}
        style={{
          background: "none", border: "none", color: "var(--text-faint)",
          cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "6px 8px", flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  );
});

function KeywordChip({ text, verdict, reasons, onRemove }) {
  return (
    <span className={`kw-chip ${verdict}`} title={reasons.join(" · ")}>
      <span className="kw-dot" />
      {text}
      <button onClick={onRemove} aria-label={`Remove ${text}`}>×</button>
    </span>
  );
}

function ScoreBadge({ analysis }) {
  const c = gradeColor(analysis.grade);
  return (
    <div className="score-badge">
      <span className="score-ring" style={{ background: c }}>{analysis.score}</span>
      <span>
        SEO Score <span style={{ color: c }}>{analysis.grade}</span>
        <span style={{ fontWeight: 400, color: "var(--text-faint)", marginLeft: 8, fontSize: 11.5 }}>
          ✓ {analysis.counts.good} good · ⚠ {analysis.counts.weak} weak · ✕ {analysis.counts.bad} bad
        </span>
      </span>
    </div>
  );
}

export default function Home() {
  // null until localStorage loads on the client (this component also SSRs,
  // where localStorage doesn't exist) — `cfgs` below substitutes empties.
  const [configs, setConfigs] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  // Manual provider choice (persisted — defaults to whichever was used last).
  const [selectedProvider, setSelectedProvider] = useState(null);
  // Opt-in automatic fallback chain (off by default; manual pick is the norm).
  const [fallbackEnabled, setFallbackEnabled] = useState(false);
  const [fallbackOrder, setFallbackOrder] = useState(null);
  const [testMsgs, setTestMsgs] = useState({});
  const [testingId, setTestingId] = useState(null);
  const [context, setContext] = useState("");
  const [items, setItems] = useState([]);
  const [activeIndex, setActiveIndex] = useState(null);
  const [activeTab, setActiveTab] = useState("adobe_stock");
  const [running, setRunning] = useState(false);
  const [theme, setTheme] = useState("dark");
  const [copiedField, setCopiedField] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  // Freepik export dialog state
  const [showFreepik, setShowFreepik] = useState(false);
  const [aiGenerated, setAiGenerated] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiModel, setAiModel] = useState("");

  useEffect(() => {
    const savedTheme = localStorage.getItem("mstock_theme") || "dark";
    setTheme(savedTheme);
    document.documentElement.setAttribute("data-theme", savedTheme);
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("mstock_theme", next);
  }

  // Stable identity across renders (empty dep array), so passing it as a
  // prop to memoized FilmstripRow never breaks the memo comparison.
  const selectItem = useCallback((idx) => {
    setActiveIndex(idx);
    setActiveTab("adobe_stock");
  }, []);
  const fileInputRef = useRef(null);
  const filmstripRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    const loaded = loadProviderConfigs();
    setConfigs(loaded);
    const prefs = loadUiPrefs();
    const configured = Object.keys(loaded).filter((id) => loaded[id].key);
    const sel = prefs.selectedProvider && configured.includes(prefs.selectedProvider)
      ? prefs.selectedProvider
      : configured[0] || null;
    setSelectedProvider(sel);
    setFallbackEnabled(prefs.fallbackEnabled);
    setFallbackOrder(prefs.fallbackOrder);
  }, []);

  const cfgs = configs || EMPTY_CONFIGS;
  const configuredIds = PROVIDER_REGISTRY.filter((p) => cfgs[p.id]?.key).map((p) => p.id);

  function handleConfigChange(id, field, value) {
    setConfigs((prev) => {
      const slot = { ...prev[id], [field]: value };
      // Changing the key invalidates any previous test verdict.
      if (field === "key") slot.status = value ? "unverified" : "not-set";
      const next = { ...prev, [id]: slot };
      saveProviderField(id, field, value);
      if (field === "key") saveProviderField(id, "status", slot.status);
      return next;
    });
  }

  function handleClearProvider(id) {
    setConfigs((prev) => ({
      ...prev,
      [id]: { ...prev[id], key: "", baseUrl: "", model: "", status: "not-set", discoveredModels: [] },
    }));
    saveProviderField(id, "key", "");
    saveProviderField(id, "baseUrl", "");
    saveProviderField(id, "model", "");
    saveProviderField(id, "status", "not-set");
    saveDiscoveredModels(id, []);
    setTestMsgs((m) => ({ ...m, [id]: null }));
    if (selectedProvider === id) setSelectedProvider(null);
  }

  async function handleTestProvider(id) {
    if (testingId || !cfgs[id]?.key) return;
    setTestingId(id);
    setTestMsgs((m) => ({ ...m, [id]: null }));
    try {
      const res = await fetch("/api/test-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: id,
          apiKey: cfgs[id].key,
          baseUrl: cfgs[id].baseUrl || undefined,
          wireFormat: cfgs[id].wireFormat,
        }),
      });
      const data = await res.json();
      const status = data.status === "unreachable" ? "unverified" : (data.status || "unverified");
      setConfigs((prev) => ({ ...prev, [id]: { ...prev[id], status } }));
      saveProviderField(id, "status", status);
      if (Array.isArray(data.models) && data.models.length > 0) {
        saveDiscoveredModels(id, data.models);
        setConfigs((prev) => ({ ...prev, [id]: { ...prev[id], discoveredModels: data.models } }));
      }
      setTestMsgs((m) => ({
        ...m,
        [id]: { ok: !!data.ok, message: data.message || (data.ok ? "Connected." : "Test failed."), tone: data.ok ? "ok" : "bad" },
      }));
    } catch (err) {
      setTestMsgs((m) => ({ ...m, [id]: { ok: false, message: `Test request failed: ${String(err.message || err)}`, tone: "bad" } }));
    } finally {
      setTestingId(null);
    }
  }

  function handleSelectProvider(id) {
    setSelectedProvider(id);
    saveSelectedProvider(id); // per-session/per-batch choice persists as "last used"
  }

  function handleFiles(fileList) {
    const newItems = Array.from(fileList).map((file) => ({
      filename: file.name,
      file,
      previewUrl: URL.createObjectURL(file),
      status: "pending",
      result: null,
      error: null,
    }));
    setItems((prev) => {
      const merged = [...prev, ...newItems];
      if (activeIndex === null && merged.length > 0) setActiveIndex(prev.length);
      return merged;
    });
  }

  function removeItem(index) {
    setItems((prev) => {
      const copy = [...prev];
      const [removed] = copy.splice(index, 1);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return copy;
    });
    setActiveIndex((prev) => {
      if (prev === null) return prev;
      if (prev === index) return null;
      if (prev > index) return prev - 1;
      return prev;
    });
  }

  function copyToClipboard(text, field) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    setCopiedField(field);
    setTimeout(() => setCopiedField((f) => (f === field ? null : f)), 1500);
  }

  // Drag counter avoids the flicker from dragenter/dragleave firing on
  // every child element as the pointer moves across the drop zone —
  // only the balanced 0->1 and 1->0 transitions toggle the highlight.
  function handleDragEnter(e) {
    e.preventDefault();
    dragCounter.current += 1;
    setIsDragging(true);
  }
  function handleDragOver(e) {
    e.preventDefault();
  }
  function handleDragLeave(e) {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  }
  function handleDrop(e) {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) handleFiles(files);
  }

  // Revoke object URLs when the component unmounts, to avoid leaking memory
  // over a long batch session.
  useEffect(() => {
    return () => {
      itemsRef.current.forEach((it) => it.previewUrl && URL.revokeObjectURL(it.previewUrl));
    };
  }, []);

  async function processOne(index) {
    // Clear any previous error the instant a new attempt starts —
    // fixes the "stale error stays visible after a later success" bug.
    setItems((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], status: "processing", error: null, attempts: null };
      return copy;
    });
    try {
      const resized = await resizeImage(itemsRef.current[index].file);
      const base64 = await fileToBase64(resized);
      // Manual pick first; the other configured providers follow ONLY if the
      // user opted in to automatic fallback (in their drag-ordered sequence).
      const providers = buildRequestProviders(cfgs, selectedProvider, fallbackEnabled, fallbackOrder);
      if (providers.length === 0) {
        throw new Error("No provider with a saved API key — open Settings and configure a slot first.");
      }
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64, mimeType: "image/jpeg", context, providers }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err = new Error(data.error || "Generation failed");
        err.attempts = data.attempts;
        throw err;
      }
      setItems((prev) => {
        const copy = [...prev];
        copy[index] = { ...copy[index], status: "done", result: data, error: null, attempts: null };
        return copy;
      });
    } catch (err) {
      setItems((prev) => {
        const copy = [...prev];
        copy[index] = {
          ...copy[index],
          status: "error",
          error: String(err.message || err),
          attempts: err.attempts || null,
        };
        return copy;
      });
    }
  }

  async function runBatch() {
    if (!selectedProvider || !cfgs[selectedProvider]?.key) {
      setShowSettings(true);
      return;
    }
    setRunning(true);
    const pending = items
      .map((it, idx) => ({ it, idx }))
      .filter((x) => x.it.status === "pending" || x.it.status === "error");

    // Scale concurrency down for larger batches. At 3 parallel requests,
    // a 50-100 image batch can burn through Gemini's free-tier per-minute
    // rate limit fast, which cascades through the whole model fallback
    // chain on every image instead of just the busy one. 2 parallel is
    // slower per-image but noticeably more stable for big batches.
    const concurrency = pending.length > 30 ? 2 : 3;
    let cursor = 0;

    async function runner() {
      while (cursor < pending.length) {
        const { idx } = pending[cursor++];
        await processOne(idx);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, runner));
    setRunning(false);
  }

  function removeKeyword(itemIndex, platformKey, keywordIndex) {
    setItems((prev) => {
      const copy = [...prev];
      const platforms = { ...copy[itemIndex].result.platforms };
      const list = [...platforms[platformKey].keywords];
      list.splice(keywordIndex, 1);
      platforms[platformKey] = { ...platforms[platformKey], keywords: list };
      copy[itemIndex] = { ...copy[itemIndex], result: { ...copy[itemIndex].result, platforms } };
      return copy;
    });
  }

  const doneItems = items.filter((it) => it.status === "done");
  const active = activeIndex !== null ? items[activeIndex] : null;

  // Keyword quality analysis for the visible platform tab — recomputed
  // whenever the result, tab, or selection changes (incl. chip removal).
  const analysis = useMemo(() => {
    if (!active?.result?.platforms?.[activeTab]) return null;
    const meta = active.result.platforms[activeTab];
    return analyzeKeywords(activeTab, meta.title, meta.keywords);
  }, [active, activeTab]);

  const verdictByIndex = useMemo(() => {
    const map = {};
    if (!analysis) return map;
    analysis.good.forEach((g) => { map[g.index] = { verdict: "good", reasons: g.reasons }; });
    analysis.weak.forEach((w) => { map[w.index] = { verdict: "weak", reasons: w.reasons }; });
    analysis.bad.forEach((b) => { map[b.index] = { verdict: "bad", reasons: b.reasons }; });
    return map;
  }, [analysis]);

  // Freepik pre-upload validation — recomputed live as AI toggle changes.
  const freepikIssues = useMemo(
    () => (showFreepik ? validateFreepikRows(doneItems, { aiGenerated }) : []),
    [showFreepik, doneItems, aiGenerated]
  );
  const freepikErrors = freepikIssues.filter((i) => i.level === "error");
  const freepikWarnings = freepikIssues.filter((i) => i.level === "warning");
  const freepikErrorRows = useMemo(() => new Set(freepikErrors.map((e) => e.row)), [freepikErrors]);

  function downloadFreepikCsv(onlyValid) {
    const rows = onlyValid
      ? doneItems.filter((_, i) => !freepikErrorRows.has(i + 1))
      : doneItems;
    const csv = buildFreepikCsv(rows, { aiGenerated, prompt: aiPrompt, model: aiModel });
    downloadCsv(csv, aiGenerated ? "freepik_ai.csv" : "freepik.csv");
    setShowFreepik(false);
  }

  function exportCsv(platform) {
    let csv, name;
    if (platform === "adobe_stock") { csv = buildAdobeStockCsv(doneItems); name = "adobe_stock.csv"; }
    else if (platform === "shutterstock") { csv = buildShutterstockCsv(doneItems); name = "shutterstock.csv"; }
    else if (platform === "vecteezy") { csv = buildVecteezyCsv(doneItems); name = "vecteezy.csv"; }
    else if (platform === "istock_getty") { csv = buildIstockGettyCsv(doneItems); name = "istock_getty.csv"; }
    else { csv = ""; name = `${platform}.csv`; }
    downloadCsv(csv, name);
  }

  return (
    <div style={{ display: "flex", gap: 16, height: "100vh", padding: 16 }}>
      <aside style={{
        width: 236, flexShrink: 0,
        background: "var(--panel)", border: "1px solid var(--border)",
        borderRadius: 14, boxShadow: "var(--shadow)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ padding: "16px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="logo-badge">
            <svg width="14" height="11" viewBox="0 0 18 14" fill="none">
              <path d="M1 1L9 7L1 13" stroke="currentColor" strokeWidth="1.6" />
              <path d="M9 1L17 7L9 13" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            Lightbox
          </div>
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            style={{
              width: 30, height: 30, borderRadius: 8, cursor: "pointer",
              background: "var(--panel-raised)", border: "1px solid var(--border)",
              color: "var(--text-dim)", fontSize: 13, display: "flex",
              alignItems: "center", justifyContent: "center",
            }}
          >
            {theme === "dark" ? "☾" : "☀"}
          </button>
        </div>
        <div style={{ padding: "0 16px 12px", fontSize: 11, color: "var(--text-faint)" }}>
          microstock metadata
        </div>

        <div style={{ padding: "0 12px 12px" }}>
          <button onClick={() => fileInputRef.current.click()} className="btn btn-ghost" style={{ width: "100%" }}>
            + Add images
          </button>
          <input
            ref={fileInputRef} type="file" multiple accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        <div
          ref={filmstripRef}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}
        >
          {items.length === 0 && (
            <div style={{ padding: "24px 12px", color: "var(--text-faint)", fontSize: 12.5, lineHeight: 1.6 }}>
              No images yet. Add a few to start generating metadata.
            </div>
          )}
          {items.length > 0 && (() => {
            // Manual windowing: only mount rows currently in/near the
            // visible scroll range. At 50-100 images this is the difference
            // between ~100 live DOM nodes+images and ~15-20 — noticeably
            // less scroll jank than rendering the whole batch at once.
            const ROW_H = 50; // approx row height incl. margin
            const containerH = filmstripRef.current?.clientHeight || 600;
            const overscan = 6;
            const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - overscan);
            const endIdx = Math.min(
              items.length,
              Math.ceil((scrollTop + containerH) / ROW_H) + overscan
            );
            const visible = items.slice(startIdx, endIdx);
            return (
              <div style={{ height: items.length * ROW_H, position: "relative" }}>
                <div style={{ position: "absolute", top: startIdx * ROW_H, left: 0, right: 0 }}>
                  {visible.map((it, i) => {
                    const idx = startIdx + i;
                    return (
                      <FilmstripRow
                        key={idx}
                        item={it}
                        idx={idx}
                        isActive={activeIndex === idx}
                        onSelect={selectItem}
                        onRemove={removeItem}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>

        <div style={{ padding: 12, borderTop: "1px solid var(--border-soft)" }}>
          <button
            onClick={runBatch}
            disabled={running || items.length === 0}
            className="btn btn-primary"
            style={{ width: "100%", padding: "10px 14px", fontSize: 13.5 }}
          >
            {running ? "Generating…" : "✦ Generate all"}
          </button>
          {items.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8, textAlign: "center" }}>
              {doneItems.length} of {items.length} ready
            </div>
          )}
        </div>
      </aside>

      <main style={{
        flex: 1, display: "flex", flexDirection: "column", minWidth: 0,
        background: "var(--panel)", border: "1px solid var(--border)",
        borderRadius: 14, boxShadow: "var(--shadow)", overflow: "hidden",
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "14px 24px", borderBottom: "1px solid var(--border-soft)",
        }}>
          <div style={{ position: "relative", flex: 1 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{
              position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
              color: "var(--text-faint)", pointerEvents: "none",
            }}>
              <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
            <input
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Optional context — e.g. corporate, wedding, nature/travel"
              className="context-input"
              style={{ width: "100%", paddingLeft: 32 }}
            />
          </div>
          <div className="provider-picker" style={{ marginLeft: 12 }} title="Which provider's AI answers this batch">
            <span className={`picker-dot dot-${(selectedProvider && cfgs[selectedProvider]?.status) || "not-set"}`} />
            <select
              value={selectedProvider || ""}
              onChange={(e) => handleSelectProvider(e.target.value)}
              className="provider-select"
              disabled={configuredIds.length === 0}
              aria-label="AI provider for this batch"
            >
              {configuredIds.length === 0 && (
                <option value="">No provider configured</option>
              )}
              {configuredIds.map((id) => (
                <option key={id} value={id}>
                  {getProvider(id).label}{cfgs[id].model ? ` · ${cfgs[id].model}` : ""}
                </option>
              ))}
            </select>
            {configuredIds.length === 0 && (
              <button onClick={() => setShowSettings(true)} className="link-btn">Set up a provider</button>
            )}
          </div>

          <button onClick={() => setShowSettings(true)} className="btn btn-ghost" style={{ marginLeft: 8 }}>
            <span style={{
              display: "inline-block", width: 6, height: 6, borderRadius: "50%",
              background: configuredIds.length > 0 ? "var(--success)" : "var(--text-faint)",
            }} />
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" strokeWidth="1.6" />
              <path d="M19.4 13a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V19a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H4a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H10a1.65 1.65 0 001-1.51V4a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V10a1.65 1.65 0 001.51 1H20a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            Settings
          </button>
        </div>

        <div
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{ flex: 1, overflowY: "auto", padding: 24, position: "relative" }}
        >
          {!active && items.length === 0 && (
            <div style={{
              height: "100%", minHeight: 420, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", textAlign: "center",
              border: `1.5px dashed ${isDragging ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 14, padding: 24,
              background: isDragging ? "var(--accent-soft)" : "transparent",
              transition: "border-color .15s ease, background .15s ease",
            }}>
              <div style={{
                width: 44, height: 44, borderRadius: 10, background: "var(--accent-gradient)",
                display: "flex", alignItems: "center",
                justifyContent: "center", marginBottom: 16, color: "#fff",
                boxShadow: "var(--glow)",
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M12 16V4M12 4l-4 4M12 4l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M5 16v2a2 2 0 002 2h10a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 18, color: "var(--text)", marginBottom: 8 }}>
                Drop images to get started
              </div>
              <div style={{ fontSize: 13, color: "var(--text-faint)", maxWidth: 340, lineHeight: 1.6, marginBottom: 18 }}>
                Drag JPG or PNG files anywhere on this canvas. We resize them locally before analysis.
              </div>
              <button onClick={() => fileInputRef.current.click()} className="btn btn-ghost">
                Browse files
              </button>
            </div>
          )}

          {!active && items.length > 0 && (
            <div style={{
              height: "100%", display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", color: "var(--text-faint)",
            }}>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 20, color: "var(--text-dim)", marginBottom: 6 }}>
                Nothing selected
              </div>
              <div style={{ fontSize: 13 }}>Add images on the left, then pick one to inspect.</div>
            </div>
          )}

          {active && (
            <div key={activeIndex} style={{ animation: "rise-in 0.25s ease" }}>
              <div style={{ display: "flex", gap: 16 }}>
                <img
                  src={active.previewUrl}
                  alt={active.filename}
                  style={{
                    width: 160, height: 160, objectFit: "cover", borderRadius: 12,
                    border: "1px solid var(--border-soft)", flexShrink: 0,
                    boxShadow: "var(--shadow)",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 400, fontSize: 22, margin: 0, wordBreak: "break-word" }}>
                      {active.filename}
                    </h2>
                    <StatusDot status={active.status} />
                  </div>

                  {active.result && active.status !== "processing" && (
                    <button
                      onClick={() => processOne(activeIndex)}
                      className="btn btn-ghost"
                      style={{ marginTop: 10 }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                        <path d="M20 11a8 8 0 10-2.34 5.66M20 4v6h-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Regenerate
                    </button>
                  )}

              {active.status === "error" && (
                <div style={{
                  marginTop: 12, padding: 12, borderRadius: 8,
                  background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger)", fontSize: 13,
                }}>
                  {active.error}
                  {active.attempts?.length > 1 && (
                    <div className="attempt-list">
                      {active.attempts.map((a, i) => (
                        <div key={i} className={`attempt-line ${a.ok ? "ok" : "fail"}`}>
                          {a.ok ? "✓" : "✕"} {a.provider} · <span style={{ fontFamily: "var(--font-mono)" }}>{a.model}</span>
                          {a.error ? ` — ${a.error}` : ""}
                          {a.info ? ` — ${a.info}` : ""}
                        </div>
                      ))}
                    </div>
                  )}
                  <button onClick={() => processOne(activeIndex)} className="btn btn-ghost" style={{ marginLeft: 12, padding: "4px 10px" }}>
                    Retry
                  </button>
                </div>
              )}

              {active.status === "processing" && (
                <div style={{ marginTop: 20, color: "var(--text-dim)", fontSize: 13 }}>Analyzing image…</div>
              )}
                </div>
              </div>

              {active.result && analysis && (
                <div style={{ marginTop: 20 }}>
                  <div style={{
                    display: "inline-flex", gap: 4, marginBottom: 18, flexWrap: "wrap",
                    background: "var(--panel-raised)", border: "1px solid var(--border)",
                    borderRadius: 999, padding: 5,
                  }}>
                    {PLATFORM_TABS.map((t) => (
                      <button
                        key={t.key}
                        onClick={() => setActiveTab(t.key)}
                        className={`tab-pill${activeTab === t.key ? " active" : ""}`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <ScoreBadge analysis={analysis} />
                  </div>

                  <div style={{ marginBottom: 18 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label className="section-label">Title</label>
                      <button
                        onClick={() => copyToClipboard(active.result.platforms[activeTab]?.title || "", "title")}
                        className="copy-btn"
                      >
                        {copiedField === "title" ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <div className="field-box" style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>
                      {active.result.platforms[activeTab]?.title}
                    </div>
                    {analysis.titleChecks.map((c, i) => (
                      <div key={i} style={{ fontSize: 12, marginTop: 4, color: c.ok ? "var(--success)" : "var(--danger)" }}>
                        {c.ok ? "✓" : "✕"} {c.text}
                      </div>
                    ))}
                  </div>

                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label className="section-label">
                        Keywords ({active.result.platforms[activeTab]?.keywords.length})
                        <span style={{ marginLeft: 8 }}>
                          <span style={{ color: "var(--success)" }}>●</span> good{" "}
                          <span style={{ color: "var(--warning)", marginLeft: 4 }}>●</span> weak{" "}
                          <span style={{ color: "var(--danger)", marginLeft: 4 }}>●</span> bad
                        </span>
                      </label>
                      <button
                        onClick={() => copyToClipboard((active.result.platforms[activeTab]?.keywords || []).join(", "), "keywords")}
                        className="copy-btn"
                      >
                        {copiedField === "keywords" ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                      {active.result.platforms[activeTab]?.keywords.map((kw, i) => {
                        const v = verdictByIndex[i] || { verdict: "good", reasons: ["Relevant tag"] };
                        return (
                          <KeywordChip key={`${kw}-${i}`} text={kw} verdict={v.verdict} reasons={v.reasons} onRemove={() => removeKeyword(activeIndex, activeTab, i)} />
                        );
                      })}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 6 }}>
                      Hover any tag to see why it passed or failed. Colors: {analysis.colorHits} · use-case phrases: {analysis.useHits}
                    </div>
                  </div>

                  {analysis.suggestions.length > 0 && (
                    <div style={{
                      marginTop: 16, padding: "12px 14px", borderRadius: 10,
                      background: "var(--accent-soft)", border: "1px solid var(--border)",
                      fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.7,
                    }}>
                      <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>💡 How to get more downloads</div>
                      {analysis.suggestions.map((s, i) => (
                        <div key={i}>• {s}</div>
                      ))}
                    </div>
                  )}

                  {active.result.flags?.length > 0 && (
                    <div style={{ marginTop: 18, fontSize: 12.5, color: "var(--warning)" }}>
                      ⚠ {active.result.flags.join(", ")}
                    </div>
                  )}

                  {active.result._meta && (
                    <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-faint)", lineHeight: 1.6 }}>
                      Answered by <strong style={{ color: "var(--text-dim)" }}>{active.result._meta.providerLabel}</strong>
                      {" · "}
                      <span style={{ fontFamily: "var(--font-mono)" }}>{active.result._meta.modelUsed}</span>
                      {active.result._meta.fellBack && " — after a fallback (first choice was unavailable)"}
                      {active.result._meta.modelReportedByProvider &&
                        active.result._meta.modelReportedByProvider !== active.result._meta.modelRequested &&
                        ` — provider reports it actually routed to ${active.result._meta.modelReportedByProvider}`}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {doneItems.length > 0 && (
          <div style={{ borderTop: "1px solid var(--border-soft)", padding: "12px 24px" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{
                fontSize: 11.5, fontWeight: 700, color: "var(--tag-text)",
                background: "var(--tag-bg)", borderRadius: 6, padding: "5px 10px", marginRight: 4,
              }}>
                {doneItems.length} ready
              </span>
              <span style={{ fontSize: 12, color: "var(--text-faint)", marginRight: 2 }}>Export:</span>
              <button onClick={() => exportCsv("adobe_stock")} className="btn btn-export">Adobe Stock CSV</button>
              <button onClick={() => exportCsv("shutterstock")} className="btn btn-export">Shutterstock CSV</button>
              <button onClick={() => exportCsv("istock_getty")} className="btn btn-export">iStock CSV</button>
              <button onClick={() => setShowFreepik(true)} className="btn btn-freepik">⬆ Freepik CSV</button>
              <button onClick={() => exportCsv("vecteezy")} className="btn btn-export">Vecteezy CSV</button>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 6 }}>
              Note: iStock/Getty validates keywords against their own controlled vocabulary — review that CSV in their submission tool before final upload.
            </div>
          </div>
        )}
      </main>

      <SettingsPanel
        open={showSettings}
        onClose={() => setShowSettings(false)}
        configs={cfgs}
        testMsgs={testMsgs}
        testingId={testingId}
        onChange={handleConfigChange}
        onClear={handleClearProvider}
        onTest={handleTestProvider}
        fallbackEnabled={fallbackEnabled}
        onFallbackToggle={(on) => { setFallbackEnabled(on); saveFallbackEnabled(on); }}
        fallbackOrder={fallbackOrder}
        onFallbackOrderChange={(order) => { setFallbackOrder(order); saveFallbackOrder(order); }}
        selectedProvider={selectedProvider}
      />

      {showFreepik && (
        <div
          onClick={() => setShowFreepik(false)}
          style={{ position: "fixed", inset: 0, background: "#00000070", zIndex: 10, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 560, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto",
              background: "var(--panel)", border: "1px solid var(--border)",
              borderRadius: 16, boxShadow: "var(--shadow)",
              padding: 24, animation: "rise-in 0.2s ease",
            }}
          >
            <h3 style={{ fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 20, marginTop: 0, marginBottom: 4 }}>
              Freepik CSV export
            </h3>
            <p style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: 0 }}>
              Pre-checked against Freepik&apos;s upload rules — header, title length, keyword count — so the file imports cleanly.
            </p>

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={aiGenerated}
                onChange={(e) => setAiGenerated(e.target.checked)}
                style={{ width: 15, height: 15, accentColor: "var(--accent)" }}
              />
              My images are AI-generated
              <span style={{ fontSize: 11, color: "var(--text-faint)" }}>(adds _ai_generated tag + Prompt/Model columns)</span>
            </label>
            {aiGenerated && (
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <input
                  value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="Prompt (applied to all rows)"
                  className="context-input" style={{ fontSize: 12 }}
                />
                <input
                  value={aiModel} onChange={(e) => setAiModel(e.target.value)}
                  placeholder="Model e.g. Midjourney 6"
                  className="context-input" style={{ fontSize: 12, maxWidth: 170 }}
                />
              </div>
            )}

            <div style={{ marginTop: 12, marginBottom: 12 }}>
              {freepikIssues.length === 0 && (
                <div style={{
                  padding: "12px 14px", borderRadius: 10, fontSize: 13,
                  background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success)",
                }}>
                  ✓ All {doneItems.length} rows passed — ready for Freepik upload.
                </div>
              )}
              {freepikErrors.length > 0 && (
                <div style={{
                  padding: "12px 14px", borderRadius: 10, fontSize: 13, marginBottom: 8,
                  background: "var(--danger-soft)", border: "1px solid var(--danger)",
                }}>
                  <div style={{ fontWeight: 600, color: "var(--danger)", marginBottom: 6 }}>
                    ✕ {freepikErrors.length} problem{freepikErrors.length > 1 ? "s" : ""} that Freepik will reject
                  </div>
                  {freepikErrors.map((e, i) => (
                    <div key={i} style={{ color: "var(--text-dim)", marginBottom: 4 }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>row {e.row} · {e.filename}</span>
                      <br />{e.message}
                    </div>
                  ))}
                </div>
              )}
              {freepikWarnings.length > 0 && (
                <div style={{
                  padding: "12px 14px", borderRadius: 10, fontSize: 13,
                  background: "var(--warning-soft)", border: "1px solid var(--warning)",
                }}>
                  <div style={{ fontWeight: 600, color: "var(--warning)", marginBottom: 6 }}>
                    ⚠ {freepikWarnings.length} auto-fixed / advisory note{freepikWarnings.length > 1 ? "s" : ""}
                  </div>
                  <div style={{ maxHeight: 150, overflowY: "auto" }}>
                    {freepikWarnings.map((w, i) => (
                      <div key={i} style={{ color: "var(--text-dim)", marginBottom: 4 }}>
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>row {w.row} · {w.filename}</span>
                        <br />{w.message}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {freepikErrors.length > 0 ? (
                <>
                  <button
                    onClick={() => downloadFreepikCsv(true)}
                    disabled={doneItems.length - freepikErrorRows.size === 0}
                    className="btn btn-primary"
                  >
                    Download valid rows ({doneItems.length - freepikErrorRows.size})
                  </button>
                  <button onClick={() => downloadFreepikCsv(false)} className="btn btn-ghost">
                    Download all anyway
                  </button>
                </>
              ) : (
                <button onClick={() => downloadFreepikCsv(false)} className="btn btn-primary">
                  ⬇ Download Freepik CSV ({doneItems.length} rows)
                </button>
              )}
              <button onClick={() => setShowFreepik(false)} className="btn btn-ghost">Cancel</button>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 10, lineHeight: 1.6 }}>
              Upload tip: in the Freepik contributor panel, file names in the CSV must match your uploaded files exactly (including .jpg).
              If a row fails there, check for renamed files first.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
