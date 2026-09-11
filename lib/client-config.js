// ─── Client-side provider config (localStorage) ────────────────────────
// Every provider's key / base URL / model / wire format / status is stored
// independently under its own namespaced key, so slots never interfere:
//   mstock_key_{id}        API key
//   mstock_baseurl_{id}    base-URL override (empty = registry default)
//   mstock_model_{id}      chosen model id (empty = registry default)
//   mstock_wire_{id}       wire-format choice for multi-format slots
//   mstock_status_{id}     last test status: not-set|unverified|testing|connected|invalid
//   mstock_models_{id}     JSON array of model ids discovered via Test connection
// Session-level prefs:
//   mstock_provider          last provider used (selection persists)
//   mstock_fallback_enabled  opt-in automatic fallback toggle
//   mstock_fallback_order    JSON array of provider ids (drag-reordered)
import { PROVIDER_REGISTRY, getProvider } from "./provider-registry";

export const lsKey = {
  key: (id) => `mstock_key_${id}`,
  baseUrl: (id) => `mstock_baseurl_${id}`,
  model: (id) => `mstock_model_${id}`,
  wire: (id) => `mstock_wire_${id}`,
  status: (id) => `mstock_status_${id}`,
  models: (id) => `mstock_models_${id}`,
  lastProvider: () => "mstock_provider",
  fallbackEnabled: () => "mstock_fallback_enabled",
  fallbackOrder: () => "mstock_fallback_order",
};

function safeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* private mode etc. */ }
}
function safeRemove(k) {
  try { localStorage.removeItem(k); } catch { /* noop */ }
}

// Load all provider slots from localStorage. Also migrates the pre-registry
// single-slot key (mstock_gemini_key) into the namespaced mstock_key_gemini.
export function loadProviderConfigs() {
  // One-time migration from the old single-provider build.
  const legacy = safeGet("mstock_gemini_key");
  if (legacy && !safeGet(lsKey.key("gemini"))) {
    safeSet(lsKey.key("gemini"), legacy);
  }
  safeRemove("mstock_gemini_key");

  const configs = {};
  for (const p of PROVIDER_REGISTRY) {
    const key = safeGet(lsKey.key(p.id)) || "";
    const baseUrl = safeGet(lsKey.baseUrl(p.id)) || "";
    const model = safeGet(lsKey.model(p.id)) || "";
    const wire = safeGet(lsKey.wire(p.id));
    let models = [];
    try { models = JSON.parse(safeGet(lsKey.models(p.id)) || "[]"); } catch { models = []; }
    let status = safeGet(lsKey.status(p.id)) || "not-set";
    if (!key) status = "not-set";
    else if (status === "not-set" || status === "testing") status = "unverified";
    configs[p.id] = {
      key,
      baseUrl, // "" = use registry default (filled into the input as the default)
      model,
      wireFormat: wire && p.wireFormats.includes(wire) ? wire : p.defaultWireFormat,
      status,
      discoveredModels: Array.isArray(models) ? models : [],
    };
  }
  return configs;
}

export function saveProviderField(id, field, value) {
  const reg = getProvider(id);
  if (!reg) return;
  const map = {
    key: lsKey.key(id),
    baseUrl: lsKey.baseUrl(id),
    model: lsKey.model(id),
    wireFormat: lsKey.wire(id),
    status: lsKey.status(id),
  };
  if (!map[field]) return;
  if (value === "" || value === null || value === undefined) {
    if (field === "key" || field === "baseUrl" || field === "model") safeRemove(map[field]);
    else safeSet(map[field], "");
  } else {
    safeSet(map[field], String(value));
  }
}

export function saveDiscoveredModels(id, models) {
  try { safeSet(lsKey.models(id), JSON.stringify(models || [])); } catch { /* noop */ }
}

export function loadUiPrefs() {
  const fallbackOrderRaw = safeGet(lsKey.fallbackOrder());
  let fallbackOrder = null;
  if (fallbackOrderRaw) {
    try {
      const arr = JSON.parse(fallbackOrderRaw);
      if (Array.isArray(arr)) {
        fallbackOrder = arr.filter((id) => getProvider(id));
      }
    } catch { fallbackOrder = null; }
  }
  return {
    selectedProvider: safeGet(lsKey.lastProvider()) || null,
    fallbackEnabled: safeGet(lsKey.fallbackEnabled()) === "1",
    fallbackOrder, // null = never ordered → use registry order
  };
}

export function saveSelectedProvider(id) { safeSet(lsKey.lastProvider(), id); }
export function saveFallbackEnabled(on) { safeSet(lsKey.fallbackEnabled(), on ? "1" : "0"); }
export function saveFallbackOrder(order) { safeSet(lsKey.fallbackOrder(), JSON.stringify(order || [])); }

// Providers the user has saved a key for, in registry order — this drives
// the manual provider selector in the generation UI.
export function configuredProviderIds(configs) {
  return PROVIDER_REGISTRY.filter((p) => configs[p.id]?.key).map((p) => p.id);
}

// Build the `providers` array for /api/generate: the manual pick FIRST, then
// — only when the user opted in — the other configured providers in the
// user's drag-ordered fallback sequence. Manual choice is the default mode;
// the fallback chain is strictly opt-in.
export function buildRequestProviders(configs, selectedId, fallbackEnabled, fallbackOrder) {
  const configured = configuredProviderIds(configs);
  if (!selectedId || !configs[selectedId]?.key) return [];
  const chain = [selectedId];
  if (fallbackEnabled) {
    const order = fallbackOrder && fallbackOrder.length
      ? fallbackOrder
      : PROVIDER_REGISTRY.map((p) => p.id);
    for (const id of order) {
      if (id !== selectedId && configured.includes(id) && !chain.includes(id)) chain.push(id);
    }
  }
  return chain.map((id) => {
    const c = configs[id];
    return {
      providerId: id,
      apiKey: c.key,
      baseUrl: c.baseUrl || undefined,
      model: c.model || undefined,
      wireFormat: c.wireFormat,
    };
  });
}
