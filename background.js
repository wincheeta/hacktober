// Spookify background worker: per-tab request queue, Ollama client and cache.
// Chrome runs this as a service worker (spooks.js via importScripts);
// Firefox runs it as an event page with spooks.js listed first in the manifest.
if (typeof importScripts === "function" && !self.Spookify) importScripts("spooks.js");

const S = self.Spookify;
const OLLAMA = "http://localhost:11434";
const DEFAULTS = { enabled: true, model: "", intensity: 5 }; // model "" = auto-detect
const PREFERRED_MODEL = "llama3.2:3b";
const AUTO_MODEL_TTL_MS = 60000;
const REQUEST_TIMEOUT_MS = 40000; // a cold model load plus an uncached prompt takes ~25s on CPU
const STALE_MS = 20000; // > one CPU batch (~5-8s) plus the words job ahead of it
const MAX_QUEUED_PER_TAB = 3; // older batches fall back to random spooks at once
const REWARM_AFTER_MS = 25 * 60000; // keep_alive is 30m
const FAILING_RETRY_MS = 20000;
const MAX_GLOBAL = 1; // Ollama works through requests one at a time anyway.
const CACHE_LIMIT = 800;

let settings = { ...DEFAULTS };
const settingsReady = chrome.storage.sync
  .get(DEFAULTS)
  .then((s) => (settings = { ...DEFAULTS, ...s }))
  .catch(() => settings);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue;
  if (changes.model) {
    status.failing = false;
    warmUp();
  }
});

// ---------- status ----------

const status = {
  online: null, // null = unknown, true = reachable, false = unreachable
  failing: false, // recent hard failure: skip the model for FAILING_RETRY_MS
  lastError: "",
  lastFailAt: 0,
  lastLatencyMs: 0,
  lastModelUseAt: 0,
};

function markOk(latencyMs) {
  status.online = true;
  status.lastModelUseAt = Date.now();
  status.failing = false;
  status.lastError = "";
  if (latencyMs) status.lastLatencyMs = latencyMs;
}

function markFailure(err) {
  status.failing = true;
  status.lastFailAt = Date.now();
  status.lastError = err.message || String(err);
  if (err.offline) status.online = false;
}

class OllamaError extends Error {
  constructor(message, { offline = false, httpStatus = 0 } = {}) {
    super(message);
    this.offline = offline;
    this.httpStatus = httpStatus;
  }
}

async function ollamaFetch(path, body, signal) {
  await originRuleReady;
  let res;
  try {
    res = await fetch(`${OLLAMA}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new OllamaError(`Ollama is not reachable at ${OLLAMA}. Is "ollama serve" running?`, { offline: true });
  }
  if (res.status === 403) {
    throw new OllamaError('Ollama rejected the extension (403). Restart it with OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*".');
  }
  if (res.status === 404 && body && body.model) {
    throw new OllamaError(`Model "${body.model}" is not installed. Run: ollama pull ${body.model}`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new OllamaError(`Ollama returned HTTP ${res.status}. ${detail}`, { httpStatus: res.status });
  }
  return res.json();
}

// ---------- model choice ----------
// With no model set, use what's installed: the preferred model if present,
// else the smallest llama, else the smallest chat model (small = fast on CPU).

let autoModel = "";
let autoCheckedAt = 0;

function pickModel(models) {
  const chat = models.filter((m) => {
    const families = (m.details && m.details.families) || [];
    return m.name && !/embed/i.test(m.name) && !families.some((f) => /bert/i.test(f));
  });
  if (chat.some((m) => m.name === PREFERRED_MODEL)) return PREFERRED_MODEL;
  const bySize = (a, b) => (a.size || 0) - (b.size || 0);
  const llamas = chat.filter((m) => /llama/i.test(m.name)).sort(bySize);
  if (llamas.length) return llamas[0].name;
  return chat.sort(bySize).map((m) => m.name)[0] || "";
}

function rememberAutoModel(models) {
  autoModel = pickModel(models);
  autoCheckedAt = Date.now();
}

async function resolveModel(signal) {
  await settingsReady;
  if (settings.model) return settings.model;
  if (!autoModel || Date.now() - autoCheckedAt > AUTO_MODEL_TTL_MS) {
    const tags = await ollamaFetch("/api/tags", null, signal);
    rememberAutoModel(tags.models || []);
  }
  if (!autoModel) throw new OllamaError(`No Ollama models are installed. Run: ollama pull ${PREFERRED_MODEL}`);
  return autoModel;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

// Load the model and evaluate the system prompt once, so Ollama's prompt
// cache makes the first real batch as fast as later ones.
async function warmUp() {
  const t = withTimeout(60000);
  try {
    const model = await resolveModel(t.signal);
    for (const prompt of [SYSTEM_PROMPT, WORDS_PROMPT]) {
      await ollamaFetch(
        "/api/chat",
        {
          model,
          stream: false,
          keep_alive: "30m",
          options: { num_predict: 1 },
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: "{}" },
          ],
        },
        t.signal
      );
    }
    markOk();
  } catch (err) {
    if (err.name !== "AbortError") markFailure(err);
  } finally {
    t.done();
  }
}

// Ollama rejects unknown Origins with 403, and by default that includes
// chrome-extension://. Rewrite the Origin header to Ollama's own address, but
// only for requests this extension's worker makes (initiator = our id, no tab),
// so web pages still can't reach Ollama through this rule.
// Firefox doesn't apply DNR to extension requests; there, set OLLAMA_ORIGINS.
async function installOriginRule() {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr || !dnr.updateSessionRules) return;
  const rules = ["localhost", "127.0.0.1"].map((host, i) => ({
    id: 1 + i,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "origin", operation: "set", value: `http://${host}:11434` }],
    },
    condition: {
      urlFilter: `|http://${host}:11434/`,
      initiatorDomains: [chrome.runtime.id],
      tabIds: [chrome.tabs.TAB_ID_NONE],
      resourceTypes: ["xmlhttprequest", "other"],
    },
  }));
  try {
    await dnr.updateSessionRules({ removeRuleIds: rules.map((r) => r.id), addRules: rules });
  } catch (err) {
    console.warn("Spookify: could not install Origin rule", err);
  }
}
const originRuleReady = installOriginRule();

chrome.runtime.onStartup.addListener(warmUp);
chrome.runtime.onInstalled.addListener(warmUp);

// ---------- cache ----------
// Keyed per anchor (URL + tag + text), so revisits hit even if batches differ.
// Values: { spook, position, text } or "none" when the model left it bare.

const cache = new Map();
const session = chrome.storage.session;
const cacheReady = (session ? session.get("cache") : Promise.resolve({}))
  .then((data) => {
    for (const [k, v] of Object.entries((data && data.cache) || {})) cache.set(k, v);
  })
  .catch(() => { });

let cacheSaveTimer = null;
function saveCache() {
  if (!session || cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    session.set({ cache: Object.fromEntries(cache) }).catch(() => { });
  }, 1000);
}

function cacheKey(url, anchor) {
  return `${url.split("#")[0]}|${anchor.tag}|${anchor.text}`;
}

function wordsKey(url) {
  return `w|${url.split("#")[0]}`;
}

// ---------- swap dictionary ----------
// Word swaps carry over from page to page (storage.local), up to
// S.MAX_SWAP_DICT. `seen` adds up how often the word appeared on the pages
// visited; once the dictionary is full, each page's new swaps replace the
// entries with the lowest count.

const swapDict = new Map(); // from -> { to, seen }
const swapDictReady = chrome.storage.local
  .get("swapDict")
  .then((data) => {
    const saved = (data && data.swapDict) || {};
    const valid = S.validateSwaps(
      { swaps: Object.entries(saved).map(([from, v]) => ({ from, to: v && v.to })) },
      null,
      S.MAX_SWAP_DICT
    );
    for (const { from, to } of valid) swapDict.set(from, { to, seen: Math.max(1, saved[from].seen | 0) });
  })
  .catch(() => {});

let swapDictTimer = null;
function saveSwapDict() {
  if (swapDictTimer) return;
  swapDictTimer = setTimeout(() => {
    swapDictTimer = null;
    chrome.storage.local.set({ swapDict: Object.fromEntries(swapDict) }).catch(() => {});
  }, 1000);
}

// Count this page's words toward the swaps we already have.
function noteWords(freq) {
  for (const [word, n] of freq) {
    const entry = swapDict.get(word);
    if (entry) entry.seen += n;
  }
  saveSwapDict();
}

// Add new swaps, then drop the least seen older entries until it fits.
function addSwaps(swaps, freq) {
  const fresh = new Set();
  for (const { from, to } of swaps) {
    if (swapDict.has(from)) continue;
    swapDict.set(from, { to, seen: freq.get(from) || 1 });
    fresh.add(from);
  }
  const evictable = [...swapDict].filter(([w]) => !fresh.has(w)).sort((a, b) => a[1].seen - b[1].seen);
  while (swapDict.size > S.MAX_SWAP_DICT && evictable.length) swapDict.delete(evictable.shift()[0]);
  saveSwapDict();
}

function dictSwaps() {
  return [...swapDict].map(([from, { to }]) => ({ from, to }));
}

// ---------- prompt ----------

// Output tokens dominate latency on CPU (~7 tokens/s for a 3B model), so
// replies use one-letter keys and leave out `p` when a spook has only one
// position: about 36 tokens for three placements instead of 55. A shorter
// prompt also keeps an uncached first request (~40 prompt tokens/s) quick.
const shortDescription = (d) => d.replace(/ \(good for[^)]*\)/, "");
const SYSTEM_PROMPT = [
  "You decorate web pages for Halloween. You get a few page elements (anchors) near where the user is reading.",
  "Pick at most `budget` anchors and give each a different spook that suits it.",
  "Spooks (id: look [positions], possess = changes the element itself):",
  ...S.catalog.map((s) => {
    const where = s.positions.length > 1 ? ` [${s.positions.join(",")}]` : s.positions[0] === "possess" ? " [possess]" : "";
    return `- ${s.id}: ${shortDescription(s.description)}${where}`;
  }),
  "Rules: avoid spooks in `recently_used`; include one creepy_caption for a heading, image or footer; include one possess spook when the budget allows.",
  `\`t\` (only ${S.catalog.filter((s) => s.needsText).map((s) => s.id).join(", ")}): a playful, family-friendly line of at most 8 words that riffs on the anchor's text.`,
  "If `rewrites` is above 0, also rewrite up to that many h1/h2/h3 anchors into a spooky version of the same idea, about the same length.",
  "Reply as compact JSON. a=anchor, s=spook, p=position (only for spooks with several positions), t=text. Example:",
  '{"placements":[{"a":"a3","s":"ghost"},{"a":"a9","s":"creepy_caption","p":"after","t":"Here lies the comment section"}],"rewrites":[{"a":"a2","t":"The Price of Your Soul"}]}',
].join("\n");

const WORDS_PROMPT = [
  "You rename everyday web page words into Halloween words.",
  "You get the page title, a list of common words from the page, and `count`.",
  "Pick up to `count` words from the list and give each a spooky, family-friendly replacement of one or two words",
  "that keeps the same part of speech and still makes sense in a sentence (cart -> coffin, search -> seance, team -> coven).",
  "Every replacement must be clearly Halloween: ghosts, graves, bones, witches, potions, monsters, curses. Never a plain synonym.",
  "Prefer words that are easy to spot on the page: navigation, buttons, nouns from headings.",
  "Use only words from the list. Reply as compact JSON, f=from, t=to, for example:",
  '{"swaps":[{"f":"cart","t":"coffin"},{"f":"login","t":"summon"}]}',
].join("\n");

// Preferred schema: one variant per spook, so positions are always valid and
// only text spooks can carry text. Older Ollama builds may reject anyOf, in
// which case we fall back to the flat schema for the rest of the session.
let useFlatSchema = false;

function buildSchema(ids, budget, headingIds, rewrites) {
  const a = { type: "string", enum: ids };
  const items = useFlatSchema
    ? {
        type: "object",
        properties: {
          a,
          s: { type: "string", enum: S.catalog.map((s) => s.id) },
          p: { type: "string", enum: S.POSITIONS },
          t: { type: "string" },
        },
        required: ["a", "s"],
      }
    : {
        anyOf: S.catalog.map((s) => {
          const properties = { a, s: { type: "string", const: s.id } };
          const required = ["a", "s"];
          if (s.positions.length > 1) {
            properties.p = { type: "string", enum: s.positions };
            required.push("p");
          }
          if (s.needsText) {
            properties.t = { type: "string", maxLength: S.MAX_TEXT };
            required.push("t");
          }
          return { type: "object", properties, required, additionalProperties: false };
        }),
      };
  const properties = { placements: { type: "array", maxItems: budget, items } };
  if (rewrites > 0 && headingIds.length) {
    properties.rewrites = {
      type: "array",
      maxItems: rewrites,
      items: {
        type: "object",
        properties: { a: { type: "string", enum: headingIds }, t: { type: "string", maxLength: S.MAX_TEXT } },
        required: ["a", "t"],
      },
    };
  }
  return { type: "object", properties, required: ["placements"] };
}

function wordsSchema(words, count) {
  return {
    type: "object",
    properties: {
      swaps: {
        type: "array",
        maxItems: count,
        items: {
          type: "object",
          properties: {
            f: { type: "string", enum: words },
            t: { type: "string", maxLength: S.MAX_SWAP_TEXT },
          },
          required: ["f", "t"],
        },
      },
    },
    required: ["swaps"],
  };
}

// Expand the model's one-letter keys into the names the validators use.
function expandReply(parsed) {
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
  return {
    placements: list(parsed.placements).map((p) => ({ anchor: p.a, spook: p.s, position: p.p, text: p.t })),
    rewrites: list(parsed.rewrites).map((r) => ({ anchor: r.a, text: r.t })),
    swaps: list(parsed.swaps).map((w) => ({ from: w.f, to: w.t })),
  };
}

function parseJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = /\{[\s\S]*\}/.exec(content || "");
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// Small models repeat themselves; remind them what this tab already shows.
const recentSpooks = new Map(); // tabId -> last few spook ids
function rememberSpooks(tabId, placements) {
  const list = [...(recentSpooks.get(tabId) || []), ...placements.map((p) => p.spook)];
  recentSpooks.set(tabId, [...new Set(list.reverse())].slice(0, 4));
}

async function askModel(job, signal) {
  const ids = job.anchors.map((a) => a.id);
  const headingIds = job.anchors.filter((a) => S.HEADING_TAGS.has(a.tag)).map((a) => a.id);
  const rewrites = headingIds.length ? job.rewrites : 0;
  const started = Date.now();
  const model = await resolveModel(signal);
  const request = () =>
    ollamaFetch(
      "/api/chat",
      {
        model,
        stream: false,
        keep_alive: "30m",
        format: buildSchema(ids, job.budget, headingIds, rewrites),
        options: { temperature: 0.9, num_predict: rewrites ? 170 : 120 },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              page_title: job.title,
              budget: job.budget,
              rewrites,
              recently_used: recentSpooks.get(job.tabId) || [],
              anchors: job.anchors,
            }),
          },
        ],
      },
      signal
    );
  let data;
  try {
    data = await request();
  } catch (err) {
    if (useFlatSchema || !err.httpStatus || err.httpStatus === 403 || err.httpStatus === 404) throw err;
    console.info("[Spookify] Ollama rejected the anyOf schema; retrying with the flat schema");
    useFlatSchema = true;
    data = await request();
  }
  markOk(Date.now() - started);
  const parsed = parseJson(data && data.message && data.message.content);
  if (!parsed || typeof parsed !== "object") return null; // cut off at num_predict, or not JSON
  const reply = expandReply(parsed);
  return {
    placements: S.validate(reply, ids, job.budget),
    rewrites: S.validateRewrites(reply, headingIds, rewrites),
  };
}

async function askWords(job, signal) {
  const started = Date.now();
  const model = await resolveModel(signal);
  const data = await ollamaFetch(
    "/api/chat",
    {
      model,
      stream: false,
      keep_alive: "30m",
      format: wordsSchema(job.words, job.count),
      options: { temperature: 0.9, num_predict: 120 },
      messages: [
        { role: "system", content: WORDS_PROMPT },
        { role: "user", content: JSON.stringify({ page_title: job.title, count: job.count, words: job.words }) },
      ],
    },
    signal
  );
  markOk(Date.now() - started);
  const parsed = parseJson(data && data.message && data.message.content);
  if (!parsed || typeof parsed !== "object") return null;
  return S.validateSwaps(expandReply(parsed), job.words, job.count);
}

// ---------- queue ----------

const queues = new Map(); // tabId -> [job]
const inflight = new Map(); // tabId -> AbortController
let active = 0;
let activeTabId = null;

chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  pump();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  dropTab(tabId);
  recentSpooks.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "loading") return;
  dropTab(tabId);
  // The model unloads after keep_alive; reload it while the page is still loading.
  if (status.lastModelUseAt && Date.now() - status.lastModelUseAt > REWARM_AFTER_MS) {
    status.lastModelUseAt = Date.now();
    warmUp();
  }
});

function dropTab(tabId) {
  for (const job of queues.get(tabId) || []) job.respond({ status: "dropped" });
  queues.delete(tabId);
  const controller = inflight.get(tabId);
  if (controller) controller.abort();
}

// Newest batch first (it is nearest where the user is looking), active tab first.
function nextJob() {
  const tabIds = [...queues.keys()].sort((a, b) => (b === activeTabId) - (a === activeTabId));
  const now = Date.now();
  for (const tabId of tabIds) {
    let queue = queues.get(tabId);
    const stale = queue.filter((job) => job.kind !== "words" && now - job.t > STALE_MS);
    stale.forEach((job) => job.respond({ status: "stale" }));
    if (stale.length) queues.set(tabId, (queue = queue.filter((job) => !stale.includes(job))));
    if (!queue.length) {
      queues.delete(tabId);
      continue;
    }
    if (inflight.has(tabId)) continue;
    // One words job per page; it changes the most text, so it goes first.
    const words = queue.findIndex((job) => job.kind === "words");
    return words >= 0 ? queue.splice(words, 1)[0] : queue.pop();
  }
  return null;
}

function pump() {
  while (active < MAX_GLOBAL) {
    const job = nextJob();
    if (!job) return;
    run(job);
  }
}

async function run(job) {
  active++;
  const controller = new AbortController();
  inflight.set(job.tabId, controller);
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1);
  try {
    if (job.kind === "words") {
      const swaps = await askWords(job, controller.signal);
      if (!swaps) {
        console.warn(`[Spookify] tab ${job.tabId}: unreadable words reply after ${secs()}s; page uses its word list`);
        job.respond({ status: "error", error: "unreadable reply", swaps: dictSwaps() });
        return;
      }
      addSwaps(swaps, job.freq);
      console.info(
        `[Spookify] tab ${job.tabId}: ${job.words.length} words -> ${swaps.length} new swaps in ${secs()}s (${swapDict.size} kept)`,
        swaps.map((s) => `${s.from}->${s.to}`).join(", ")
      );
      cache.set(wordsKey(job.url), swaps);
      saveCache();
      job.respond({ status: "ok", swaps: dictSwaps() });
      return;
    }
    const result = await askModel(job, controller.signal);
    if (!result) {
      // Don't cache: these anchors deserve another try, and the page falls back now.
      console.warn(`[Spookify] tab ${job.tabId}: unreadable batch reply after ${secs()}s; page uses fallback`);
      job.respond({ status: "error", error: "unreadable reply" });
      return;
    }
    const { placements, rewrites } = result;
    console.info(
      `[Spookify] tab ${job.tabId}: ${job.anchors.length} anchors -> ${placements.length} spooks in ${secs()}s`,
      [
        ...placements.map((p) => `${p.spook}@${p.anchor}${p.text ? ` "${p.text}"` : ""}`),
        ...rewrites.map((r) => `rewrite@${r.anchor} "${r.text}"`),
      ].join(", ")
    );
    rememberSpooks(job.tabId, placements);
    const chosen = new Map(placements.map((p) => [p.anchor, p]));
    const rewritten = new Map(rewrites.map((r) => [r.anchor, r.text]));
    for (const a of job.anchors) {
      const p = chosen.get(a.id);
      cache.set(cacheKey(job.url, a), p ? { spook: p.spook, position: p.position, text: p.text } : "none");
      if (job.rewrites && S.HEADING_TAGS.has(a.tag)) cache.set(`r|${cacheKey(job.url, a)}`, rewritten.get(a.id) || "none");
    }
    saveCache();
    job.respond({
      status: "ok",
      placements: [...job.cached, ...placements],
      rewrites: [...job.cachedRewrites, ...rewrites],
    });
  } catch (err) {
    if (err.name === "AbortError") {
      console.info(`[Spookify] tab ${job.tabId}: ${job.kind || "batch"} timed out or cancelled after ${secs()}s; page uses fallback`);
      job.respond({ status: "timeout", swaps: job.kind === "words" ? dictSwaps() : undefined });
    } else {
      console.warn(`[Spookify] tab ${job.tabId}: ${err.message}`);
      markFailure(err);
      job.respond({ status: "error", error: status.lastError, swaps: job.kind === "words" ? dictSwaps() : undefined });
    }
  } finally {
    clearTimeout(timer);
    if (inflight.get(job.tabId) === controller) inflight.delete(job.tabId);
    // The words job jumped the queue; time spent on it doesn't make batches stale.
    if (job.kind === "words") for (const queued of queues.get(job.tabId) || []) queued.t += Date.now() - started;
    active--;
    pump();
  }
}

function sanitizeBatch(msg) {
  const anchors = (Array.isArray(msg.anchors) ? msg.anchors : [])
    .slice(0, 8)
    .filter((a) => a && /^a\d{1,7}$/.test(a.id))
    .map((a) => ({
      id: a.id,
      tag: String(a.tag || "").slice(0, 10),
      text: S.cleanText(String(a.text || "")).slice(0, 80),
    }));
  return {
    url: String(msg.url || ""),
    title: S.cleanText(String(msg.title || "")),
    anchors,
    budget: Math.max(0, Math.min(S.MAX_PER_BATCH, msg.budget | 0)),
    rewrites: Math.max(0, Math.min(S.MAX_REWRITES, msg.rewrites | 0)),
  };
}

async function handleBatch(tabId, msg, respond) {
  await Promise.all([settingsReady, cacheReady]);
  const batch = sanitizeBatch(msg);
  if (!batch.anchors.length || !batch.budget) return respond({ status: "ok", placements: [] });

  // Serve what we can from the cache; only uncached anchors go to the model.
  const cached = [];
  const cachedRewrites = [];
  const uncached = [];
  for (const a of batch.anchors) {
    const key = cacheKey(batch.url, a);
    const hit = cache.get(key);
    if (hit === undefined) uncached.push(a);
    else if (hit !== "none" && cached.length < batch.budget) cached.push({ anchor: a.id, ...hit });
    const rewrite = batch.rewrites ? cache.get(`r|${key}`) : undefined;
    if (typeof rewrite === "string" && rewrite !== "none" && cachedRewrites.length < batch.rewrites) {
      cachedRewrites.push({ anchor: a.id, text: rewrite });
    }
  }
  const budget = batch.budget - cached.length;
  const rewrites = batch.rewrites - cachedRewrites.length;
  if (!uncached.length || budget <= 0) {
    return respond({ status: "ok", placements: cached, rewrites: cachedRewrites, cached: true });
  }

  // Ollama failed hard very recently: answer at once so the page falls back.
  if (status.failing && Date.now() - status.lastFailAt < FAILING_RETRY_MS) {
    return respond({ status: "offline", error: status.lastError });
  }

  if (!queues.has(tabId)) queues.set(tabId, []);
  const queue = queues.get(tabId);
  queue.push({ ...batch, anchors: uncached, budget, rewrites, cached, cachedRewrites, tabId, respond, t: Date.now() });
  // Only the newest few batches are worth waiting for; answer the rest now.
  const batches = queue.filter((job) => job.kind !== "words");
  for (const job of batches.slice(0, Math.max(0, batches.length - MAX_QUEUED_PER_TAB))) {
    queue.splice(queue.indexOf(job), 1);
    job.respond({ status: "stale" });
  }
  pump();
}

// msg.words: [word, count] pairs, most common first. The model only sees the
// top 40 that have no swap yet; the counts keep the dictionary's tallies.
async function handleWords(tabId, msg, respond) {
  await Promise.all([settingsReady, cacheReady, swapDictReady]);
  const freq = new Map();
  for (const pair of Array.isArray(msg.words) ? msg.words : []) {
    if (!Array.isArray(pair)) continue;
    const w = String(pair[0]).toLowerCase();
    if (/^[\p{L}'-]{3,20}$/u.test(w) && !freq.has(w)) freq.set(w, Math.max(1, Math.min(10000, pair[1] | 0)));
    if (freq.size >= 300) break;
  }
  const count = Math.max(0, Math.min(S.MAX_SWAPS, msg.count | 0));
  const url = String(msg.url || "");
  if (!freq.size || !count) return respond({ status: "ok", swaps: [] });
  noteWords(freq);

  const hit = cache.get(wordsKey(url));
  if (Array.isArray(hit)) {
    addSwaps(S.validateSwaps({ swaps: hit }, null, count), freq);
    return respond({ status: "ok", swaps: dictSwaps(), cached: true });
  }

  const words = [...freq.keys()].filter((w) => !swapDict.has(w)).slice(0, 40);
  if (!words.length) return respond({ status: "ok", swaps: dictSwaps() });

  if (status.failing && Date.now() - status.lastFailAt < FAILING_RETRY_MS) {
    return respond({ status: "offline", error: status.lastError, swaps: dictSwaps() });
  }

  if (!queues.has(tabId)) queues.set(tabId, []);
  const title = S.cleanText(String(msg.title || ""));
  queues.get(tabId).push({ kind: "words", url, title, words, freq, count, tabId, respond, t: Date.now() });
  pump();
}

async function getStatus(tabId) {
  await settingsReady;
  const t = withTimeout(2500);
  let models = [];
  let loaded = false;
  let model = settings.model || autoModel;
  try {
    const [tags, ps] = await Promise.all([
      ollamaFetch("/api/tags", null, t.signal),
      ollamaFetch("/api/ps", null, t.signal).catch(() => ({ models: [] })),
    ]);
    models = (tags.models || []).map((m) => m.name);
    if (!settings.model) rememberAutoModel(tags.models || []);
    model = settings.model || autoModel;
    loaded = (ps.models || []).some((m) => m.name === model || m.model === model);
    status.online = true;
    if (!model) {
      status.lastError = `No Ollama models are installed. Run: ollama pull ${PREFERRED_MODEL}`;
    } else if (!models.includes(model)) {
      status.lastError = `Model "${model}" is not installed. Run: ollama pull ${model}`;
    } else if (status.lastError.startsWith("Ollama is not reachable") || status.lastError.startsWith("No Ollama models")) {
      status.lastError = "";
      status.failing = false;
    }
  } catch (err) {
    if (err.name === "AbortError") err = new OllamaError(`Ollama is not reachable at ${OLLAMA}.`, { offline: true });
    status.online = false;
    status.lastError = err.message;
  } finally {
    t.done();
  }
  const queued = (queues.get(tabId) || []).length + (inflight.has(tabId) ? 1 : 0);
  return {
    online: status.online,
    error: status.lastError,
    model,
    auto: !settings.model,
    models,
    loaded,
    queued,
    lastLatencyMs: status.lastLatencyMs,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "spook-batch") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    handleBatch(tabId, msg, sendResponse);
    return true;
  }
  if (msg.type === "spook-words") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    handleWords(tabId, msg, sendResponse);
    return true;
  }
  if (msg.type === "spook-cancel") {
    if (sender.tab) dropTab(sender.tab.id);
    return;
  }
  if (msg.type === "status") {
    getStatus(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.type === "warmup") {
    warmUp().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "spook-preload-sound") {
    ensureOffscreenDoc().catch(() => {});
    return;
  }
  if (msg.type === "spook-play-sound") {
    playOffscreenSound(msg.url, msg.durationMs);
    return;
  }
  if (msg.type === "spook-stop-sound") {
    stopOffscreenSound();
    return;
  }
});

let offscreenCreating = null;
async function ensureOffscreenDoc() {
  if (typeof Audio !== "undefined") return; // Firefox / event page with DOM
  if (!chrome.offscreen) return;
  try {
    if (typeof chrome.offscreen.hasDocument === "function" && await chrome.offscreen.hasDocument()) {
      return;
    }
  } catch {}
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Preload and play jumpscare sound"
  }).catch(() => {}).finally(() => { offscreenCreating = null; });
  await offscreenCreating;
}

// Pre-warm offscreen document on service worker start
ensureOffscreenDoc().catch(() => {});

async function playOffscreenSound(url, durationMs) {
  if (typeof Audio !== "undefined") {
    try {
      const a = new Audio(url);
      a.volume = 1.0;
      a.play().catch(() => {});
      if (durationMs) setTimeout(() => { a.pause(); a.currentTime = 0; }, durationMs);
    } catch {}
    return;
  }
  if (chrome.offscreen) {
    try {
      await ensureOffscreenDoc();
      chrome.runtime.sendMessage({ type: "play-offscreen-audio", url, durationMs }).catch(() => {});
    } catch (e) {
      console.warn("Spookify offscreen audio error:", e);
    }
  }
}

async function stopOffscreenSound() {
  if (chrome.offscreen) {
    try {
      chrome.runtime.sendMessage({ type: "stop-offscreen-audio" }).catch(() => {});
    } catch {}
  }
}
