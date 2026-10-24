const DEFAULTS = { enabled: true, model: "", intensity: 5, dragMode: false }; // model "" = auto-detect
const OLLAMA_ORIGINS = ["http://localhost:11434/*"];

const $ = (id) => document.getElementById(id);
const enabledEl = $("enabled");
const modelEl = $("model");
const intensityEl = $("intensity");
const dragModeEl = $("drag-mode");

let tabId = null;

// One slider per value in spooky-components/config.js. Saved as `tuning` in
// storage.sync with the same shape as SPOOKY_CONFIG; content.js merges it over the file.
const BASE_CONFIG = typeof SPOOKY_CONFIG !== "undefined" ? SPOOKY_CONFIG : { levels: {}, jumpscare: {} };
const seconds = (ms) => `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s`;
const TUNING = [
  { path: ["levels", "modelSpooks"], label: "Model spooks (Ollama)", min: 0, max: 10, step: 1 },
  { path: ["levels", "gifOverlays"], label: "GIFs over images", min: 0, max: 10, step: 1 },
  { path: ["levels", "decor"], label: "Scattered decorations", min: 0, max: 10, step: 1 },
  { path: ["levels", "cornerCobwebs"], label: "Corner cobwebs", min: 0, max: 10, step: 1 },
  { path: ["levels", "jumpscare"], label: "Jump-scare chance", min: 0, max: 10, step: 1 },
  { path: ["maxDecor"], label: "Max decorations per page", min: 0, max: 40, step: 1 },
  { path: ["jumpscare", "minDelayMs"], label: "Jump-scare earliest after", min: 0, max: 60000, step: 500, format: seconds },
  { path: ["jumpscare", "cooldownMs"], label: "Jump-scare cooldown", min: 0, max: 600000, step: 5000, format: seconds },
  { path: ["jumpscare", "durationMs"], label: "Jump-scare length", min: 200, max: 5000, step: 100, format: seconds },
];

const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

function buildTuning(saved) {
  const rows = $("tuning-rows");
  rows.replaceChildren();
  for (const spec of TUNING) {
    const id = `tune-${spec.path.join("-")}`;
    const value = getPath(saved, spec.path) ?? getPath(BASE_CONFIG, spec.path) ?? spec.min;
    const row = document.createElement("div");
    row.className = "tune";
    const label = Object.assign(document.createElement("label"), { htmlFor: id, textContent: spec.label });
    const input = Object.assign(document.createElement("input"), { type: "range", id, min: spec.min, max: spec.max, step: spec.step, value });
    const out = document.createElement("output");
    const show = () => (out.textContent = (spec.format || String)(Number(input.value)));
    show();
    input.addEventListener("input", show);
    input.addEventListener("change", saveTuning);
    row.append(label, input, out);
    rows.append(row);
    spec.input = input;
  }
}

function saveTuning() {
  const tuning = { levels: {}, jumpscare: {} };
  for (const spec of TUNING) {
    const [head, key] = spec.path;
    if (key) tuning[head][key] = Number(spec.input.value);
    else tuning[head] = Number(spec.input.value);
  }
  chrome.storage.sync.set({ tuning });
}

async function init() {
  const s = await chrome.storage.sync.get({ ...DEFAULTS, tuning: null });
  buildTuning(s.tuning);
  enabledEl.checked = s.enabled !== false;
  dragModeEl.checked = s.dragMode === true;
  modelEl.value = s.model;
  intensityEl.value = s.intensity;
  $("intensity-value").textContent = s.intensity;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;

  // Firefox may not grant host permissions at install time.
  const granted = await chrome.permissions.contains({ origins: OLLAMA_ORIGINS }).catch(() => true);
  $("grant").hidden = granted;

  chrome.runtime.sendMessage({ type: "warmup" }).catch(() => {});
  refresh();
  setInterval(refresh, 1500);
}

async function refresh() {
  let st;
  try {
    st = await chrome.runtime.sendMessage({ type: "status", tabId });
  } catch {
    return;
  }
  if (!st) return;

  const dot = $("dot");
  dot.className = "dot " + (st.online ? "ok" : st.online === false ? "bad" : "");
  modelEl.placeholder = st.auto && st.model ? `Auto: ${st.model}` : "Auto-detect";
  if (st.online) {
    const which = st.model ? `${st.model}${st.auto ? " (auto)" : ""}` : "no model";
    $("status-text").textContent = `Ollama online · ${which} · ${st.loaded ? "loaded" : "not loaded yet"}`;
  } else if (st.online === false) {
    $("status-text").textContent = "Offline mode: spooks are placed at random";
  } else {
    $("status-text").textContent = "Checking Ollama…";
  }

  const latency = st.lastLatencyMs ? ` · last reply ${(st.lastLatencyMs / 1000).toFixed(1)}s` : "";
  $("queue-text").textContent = `Batches queued for this tab: ${st.queued}${latency}`;

  $("error-text").hidden = !st.error;
  $("error-text").textContent = st.error || "";

  const list = $("models");
  const names = st.models || [];
  if (list.childElementCount !== names.length) {
    list.replaceChildren(...names.map((n) => Object.assign(document.createElement("option"), { value: n })));
  }
}

enabledEl.addEventListener("change", () => chrome.storage.sync.set({ enabled: enabledEl.checked }));
dragModeEl.addEventListener("change", () => chrome.storage.sync.set({ dragMode: dragModeEl.checked }));

modelEl.addEventListener("change", () => {
  // Leaving the field empty switches back to auto-detect.
  const model = modelEl.value.trim();
  modelEl.value = model;
  chrome.storage.sync.set({ model });
});

intensityEl.addEventListener("input", () => {
  $("intensity-value").textContent = intensityEl.value;
});
intensityEl.addEventListener("change", () => chrome.storage.sync.set({ intensity: Number(intensityEl.value) }));

$("respook").addEventListener("click", () => {
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "respook" }).catch(() => {});
});

$("unpin").addEventListener("click", () => {
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "unpin" }).catch(() => {});
});

$("tuning-reset").addEventListener("click", () => {
  chrome.storage.sync.remove("tuning");
  buildTuning(null);
});

$("grant").addEventListener("click", async () => {
  const ok = await chrome.permissions.request({ origins: OLLAMA_ORIGINS }).catch(() => false);
  $("grant").hidden = ok;
});

init();
