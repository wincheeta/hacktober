const DEFAULTS = { enabled: true, model: "llama3.2:3b", intensity: 5 };
const OLLAMA_ORIGINS = ["http://localhost:11434/*"];

const $ = (id) => document.getElementById(id);
const enabledEl = $("enabled");
const modelEl = $("model");
const intensityEl = $("intensity");

let tabId = null;

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  enabledEl.checked = s.enabled !== false;
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
  if (st.online) {
    $("status-text").textContent = `Ollama online · ${st.loaded ? "model loaded" : "model not loaded yet"}`;
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

modelEl.addEventListener("change", () => {
  const model = modelEl.value.trim() || DEFAULTS.model;
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

$("grant").addEventListener("click", async () => {
  const ok = await chrome.permissions.request({ origins: OLLAMA_ORIGINS }).catch(() => false);
  $("grant").hidden = ok;
});

init();
