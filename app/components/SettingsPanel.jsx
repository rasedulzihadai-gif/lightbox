"use client";
import { useRef, useState } from "react";
import { PROVIDER_REGISTRY, getProvider, WIRE_FORMAT_LABELS } from "../../lib/provider-registry";

function noteTone(text) {
  if (/KNOWN RESTRICTION|UNAUTHORIZED_CLIENT/.test(text)) return "danger";
  if (/Unverified|Trust caution|deprecates|stale|small top-up/.test(text)) return "warn";
  return "info";
}

export function StatusBadge({ status }) {
  const map = {
    "not-set":   { label: "Not set",    cls: "badge-neutral" },
    unverified:  { label: "Unverified", cls: "badge-warn" },
    testing:     { label: "Testing…",   cls: "badge-info" },
    connected:   { label: "Connected",  cls: "badge-ok" },
    invalid:     { label: "Invalid",    cls: "badge-bad" },
  };
  const s = map[status] || map["not-set"];
  return <span className={`status-badge ${s.cls}`}>{s.label}</span>;
}

function ProviderCard({ id, config, testMsg, testing, onChange, onClear, onTest }) {
  const reg = getProvider(id);
  const [showKey, setShowKey] = useState(false);
  if (!reg) return null;
  // Respect the slot's chosen wire format when showing the default —
  // xKiro/AgentRouter use a different default base per format (/v1 vs none).
  const effectiveBaseUrl = config.baseUrl || defaultBaseUrl(reg, config.wireFormat);
  const datalistModels = [...new Set([...(reg.models || []), ...(config.discoveredModels || [])])];
  const datalistId = `models-${id}`;

  return (
    <div className="provider-card">
      <div className="provider-card-head">
        <span className="provider-name">{reg.label}</span>
        <StatusBadge status={config.status} />
      </div>

      <label className="field-label" htmlFor={`key-${id}`}>API key</label>
      <div className="key-row">
        <input
          id={`key-${id}`}
          type={showKey ? "text" : "password"}
          value={config.key}
          onChange={(e) => onChange(id, "key", e.target.value)}
          placeholder={reg.keyHint}
          className="context-input input-sm"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setShowKey((v) => !v)}
          className="btn btn-ghost eye-btn"
          aria-label={showKey ? "Hide key" : "Show key"}
          title={showKey ? "Hide key" : "Show key"}
        >
          {showKey ? "🙈" : "👁"}
        </button>
      </div>

      <label className="field-label" htmlFor={`baseurl-${id}`}>
        Base URL <span className="field-hint">(editable — gateways move paths; pre-filled with the registry default)</span>
      </label>
      <div className="key-row">
        <input
          id={`baseurl-${id}`}
          type="text"
          value={effectiveBaseUrl}
          onChange={(e) => onChange(id, "baseUrl", e.target.value)}
          className="context-input input-sm input-mono"
          spellCheck={false}
        />
        {config.baseUrl && config.baseUrl !== reg.baseUrl && (
          <button
            type="button"
            onClick={() => onChange(id, "baseUrl", "")}
            className="btn btn-ghost eye-btn"
            title="Reset to registry default"
          >
            ↺
          </button>
        )}
      </div>

      <div className="field-row-2">
        {reg.wireFormats.length > 1 ? (
          <div>
            <label className="field-label" htmlFor={`wire-${id}`}>API format</label>
            <select
              id={`wire-${id}`}
              value={config.wireFormat}
              onChange={(e) => onChange(id, "wireFormat", e.target.value)}
              className="context-input input-sm"
            >
              {reg.wireFormats.map((f) => (
                <option key={f} value={f}>{WIRE_FORMAT_LABELS[f]}</option>
              ))}
            </select>
          </div>
        ) : (
          <div>
            <label className="field-label">API format</label>
            <div className="wire-fixed">{WIRE_FORMAT_LABELS[reg.defaultWireFormat]}</div>
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <label className="field-label" htmlFor={`model-${id}`}>Model</label>
          <input
            id={`model-${id}`}
            type="text"
            list={datalistModels.length ? datalistId : undefined}
            value={config.model}
            onChange={(e) => onChange(id, "model", e.target.value)}
            placeholder={reg.modelHint}
            className="context-input input-sm input-mono"
            spellCheck={false}
          />
          {datalistModels.length > 0 && (
            <datalist id={datalistId}>
              {datalistModels.map((m) => <option key={m} value={m} />)}
            </datalist>
          )}
        </div>
      </div>

      <div className="provider-actions">
        <button onClick={() => onTest(id)} disabled={testing || !config.key} className="btn btn-ghost">
          {testing ? "Testing…" : "Test connection"}
        </button>
        <button onClick={() => onClear(id)} disabled={!config.key && !config.baseUrl && !config.model} className="btn btn-ghost">
          Clear
        </button>
        {config.status === "unverified" && config.key && (
          <span className="unverified-hint">key saved — not tested yet</span>
        )}
      </div>

      {testMsg && (
        <div className={`test-msg test-${testMsg.tone || (testMsg.ok ? "ok" : "bad")}`}>{testMsg.message}</div>
      )}

      {reg.notes.length > 0 && (
        <div className="provider-notes">
          {reg.notes.map((n, i) => (
            <div key={i} className={`note-box note-${noteTone(n)}`}>{n}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function FallbackRow({ id, index, dragging, onDragStart, onDragOver, onDrop, onDragEnd, configured, selected }) {
  const reg = getProvider(id);
  return (
    <div
      className={`fallback-row${dragging ? " dragging" : ""}${selected ? " selected" : ""}`}
      draggable={configured}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <span className={`drag-handle${configured ? "" : " disabled"}`} aria-hidden>⋮⋮</span>
      <span className="fallback-label">
        {index + 1}. {reg.label}
        {selected && <em className="fallback-tag">answering now</em>}
        {!configured && <em className="fallback-tag muted">no key — skipped</em>}
      </span>
    </div>
  );
}

export default function SettingsPanel({
  open, onClose, configs, testMsgs, testingId,
  onChange, onClear, onTest,
  fallbackEnabled, onFallbackToggle, fallbackOrder, onFallbackOrderChange, selectedProvider,
}) {
  const dragState = useRef({ from: -1, over: -1 });
  const [, force] = useState(0);

  if (!open) return null;

  function handleDragStart(id, index) {
    dragState.current = { from: index, over: -1 };
  }
  function handleDragOver(e, id, index) {
    e.preventDefault();
    dragState.current.over = index;
  }
  function handleDrop() {
    const { from, over } = dragState.current;
    if (from < 0 || over < 0 || from === over) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(over, 0, moved);
    onFallbackOrderChange(next);
    dragState.current = { from: -1, over: -1 };
    force((n) => n + 1);
  }
  function handleDragEnd() {
    dragState.current = { from: -1, over: -1 };
    force((n) => n + 1);
  }

  const order = fallbackOrder && fallbackOrder.length
    ? fallbackOrder
    : PROVIDER_REGISTRY.map((p) => p.id);
  const configuredCount = PROVIDER_REGISTRY.filter((p) => configs[p.id]?.key).length;

  return (
    <div onClick={onClose} className="modal-backdrop">
      <div
        onClick={(e) => e.stopPropagation()}
        className="settings-panel"
        role="dialog"
        aria-label="Provider settings"
      >
        <div className="settings-head">
          <h3>Provider slots</h3>
          <button onClick={onClose} className="btn btn-ghost" aria-label="Close settings">✕ Close</button>
        </div>
        <p className="settings-sub">
          Each slot is fully independent — its own key, base URL, model and test result, stored only in this
          browser under its own name (e.g. <code>mstock_key_xkiro</code>). Pick the answering provider per batch
          from the selector in the generation bar; configure automatic fallback below if you want it.
        </p>

        {PROVIDER_REGISTRY.map((p) => (
          <ProviderCard
            key={p.id}
            id={p.id}
            config={configs[p.id]}
            testMsg={testMsgs[p.id]}
            testing={testingId === p.id}
            onChange={onChange}
            onClear={onClear}
            onTest={onTest}
          />
        ))}

        <div className="fallback-section">
          <div className="settings-head" style={{ marginTop: 8 }}>
            <h3>Automatic fallback <span className="opt-in-tag">opt-in</span></h3>
          </div>
          <label className="fallback-toggle">
            <input
              type="checkbox"
              checked={fallbackEnabled}
              onChange={(e) => onFallbackToggle(e.target.checked)}
              style={{ width: 15, height: 15, accentColor: "var(--accent)" }}
            />
            If the selected provider fails, try my other configured providers in this order
          </label>
          <div className="fallback-list">
            {order.map((id, index) => (
              <FallbackRow
                key={id}
                id={id}
                index={index}
                configured={!!configs[id]?.key}
                selected={id === selectedProvider}
                dragging={dragState.current.from === index}
                onDragStart={() => handleDragStart(id, index)}
                onDragOver={(e) => handleDragOver(e, id, index)}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
              />
            ))}
          </div>
          <p className="field-hint" style={{ marginTop: 6 }}>
            Drag to reorder. {configuredCount === 0
              ? "Add a key to at least one provider above first."
              : `At runtime your manually selected provider always answers first; the others are tried in this order only if it fails and the toggle is on.`}
          </p>
        </div>
      </div>
    </div>
  );
}
