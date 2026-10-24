// Spookify content script (document_idle).
//
// The page is never held up: the theme is static CSS, and everything here runs
// in idle time after load. Anchors are discovered lazily as they come near the
// viewport, sent to the background worker in small batches, and whatever the
// model decides is faded in when (and if) the reply arrives.
(() => {
  "use strict";
  if (window.__spookifyLoaded) return;
  window.__spookifyLoaded = true;

  const S = self.Spookify;
  const CANDIDATES = "h1, h2, h3, img, p, nav, header, footer, article, button";
  const VOID_TAGS = new Set(["img", "input", "video", "iframe", "canvas", "br", "hr", "textarea", "select"]);
  const BATCH_MAX = 8;
  const FLUSH_QUIET_MS = 300;
  const LOOKAHEAD = "0px 0px 150% 0px";
  const MAX_CANDIDATES = 1500;
  const REPLY_TIMEOUT_MS = 45000; // > background stale window + request timeout
  // Text we never rewrite: code, form fields, editors and our own spooks.
  const NO_SWAP = "script, style, noscript, code, pre, kbd, samp, textarea, input, select, option, svg, [contenteditable=''], [contenteditable='true'], .spook-root, #spook-layer";
  const MAX_TEXT_NODES = 3000;
  const STOPWORDS = new Set(
    ("that this with from have your will more about what when which their there them they been were would " +
      "could should into than then also only just some other such like make most over very here these those " +
      "where while after before because each does done many much must need being both every same even ever").split(" ")
  );

  const idle = window.requestIdleCallback
    ? (fn) => window.requestIdleCallback(fn, { timeout: 2000 })
    : (fn) => setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: true }), 50);

  const settings = { enabled: true, intensity: 5 };
  let running = false;
  let gen = 0; // bumped on every reset; replies from an older generation are ignored
  let anchorCounter = 0;
  let anchors = new Map(); // anchor id -> element
  let seen = new WeakSet(); // elements already observed
  let observedCount = 0;
  let pending = [];
  let flushTimer = null;
  let placed = 0;
  let reserved = 0;
  let maxBottom = 0;
  let overlays = []; // { box, anchor }
  let layer = null;
  let io = null;
  let animIo = null;
  let mo = null;
  let ro = null;
  let urlTimer = null;
  let lastUrl = location.href;
  let addedRoots = [];
  let mutationTimer = null;
  let repositionQueued = false;
  let originals = new Map(); // text node -> { text: before we touched it, ours: what we set }
  let rewritten = []; // { el, title } headings we rewrote, to restore their title
  let swapRegex = null;
  let swapMap = null; // lowercase word -> replacement

  // ---------- discovery ----------

  function isOurs(node) {
    return !!(node.closest && node.closest(".spook-root, #spook-layer"));
  }

  function scanRoot(rootNode) {
    if (!running || !rootNode || !rootNode.isConnected) return;
    const found = [];
    if (rootNode.matches && rootNode.matches(CANDIDATES)) found.push(rootNode);
    if (rootNode.querySelectorAll) found.push(...rootNode.querySelectorAll(CANDIDATES));
    const myGen = gen;
    let i = 0;
    // Process in idle chunks so a huge page never causes a long task.
    const step = (deadline) => {
      if (myGen !== gen || !running) return;
      while (i < found.length && observedCount < MAX_CANDIDATES) {
        const node = found[i++];
        if (!seen.has(node) && !isOurs(node)) {
          seen.add(node);
          observedCount++;
          io.observe(node);
        }
        if (i % 50 === 0 && deadline.timeRemaining() < 2) break;
      }
      if (i < found.length && observedCount < MAX_CANDIDATES) idle(step);
    };
    idle(step);
  }

  function collapse(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function qualifies(node, rect) {
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (node.closest("[contenteditable=''], [contenteditable='true']")) return false;
    const tag = node.tagName.toLowerCase();
    if (tag === "img") return rect.width >= 100 && rect.height >= 80;
    if (tag === "p") return collapse(node.textContent).length >= 40;
    if (tag === "button") return collapse(node.textContent).length >= 2;
    return true;
  }

  function describe(node, id) {
    const tag = node.tagName.toLowerCase();
    const text =
      tag === "img"
        ? collapse(node.alt || node.title || "image")
        : collapse(node.textContent);
    return { id, tag, text: text.slice(0, 80) };
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const node = entry.target;
      io.unobserve(node);
      if (!qualifies(node, entry.boundingClientRect)) continue;
      if (node.tagName === "IMG" && Math.random() < level("gifOverlays") / 10 && coverWithGif(node)) continue;
      const id = `a${anchorCounter++}`;
      node.dataset.spookAnchor = id;
      anchors.set(id, node);
      pending.push(describe(node, id));
      maxBottom = Math.max(maxBottom, entry.boundingClientRect.bottom + window.scrollY);
    }
    if (pending.length >= BATCH_MAX) {
      flush();
    } else if (pending.length) {
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, FLUSH_QUIET_MS);
    }
  }

  // ---------- batching ----------

  // Intensity is a density: about N spooks per three viewport-heights seen.
  function budgetLeft() {
    const vh = window.innerHeight || 800;
    const covered = Math.max(maxBottom, window.scrollY + vh);
    const allowed = Math.ceil((level("modelSpooks") * covered) / (3 * vh));
    return allowed - placed - reserved;
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!running || !pending.length) return;
    const batch = pending.splice(0, BATCH_MAX);
    if (pending.length) flushTimer = setTimeout(flush, FLUSH_QUIET_MS);
    const budget = Math.min(S.MAX_PER_BATCH, budgetLeft());
    if (budget <= 0) return;
    reserved += budget;
    const rewrites = Math.min(S.MAX_REWRITES, Math.round(level("headingRewrites") / 4));
    requestPlacements(batch, budget, rewrites, gen);
  }

  function ask(message) {
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), REPLY_TIMEOUT_MS));
    let reply;
    try {
      reply = chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      reply = Promise.resolve(null); // extension reloaded: context invalidated
    }
    return Promise.race([reply, timeout]);
  }

  async function requestPlacements(batch, budget, rewrites, myGen) {
    const reply = await ask({
      type: "spook-batch",
      url: location.href,
      title: document.title.slice(0, 100),
      anchors: batch,
      budget,
      rewrites,
    });
    if (myGen !== gen || !running) return;
    reserved -= budget;

    const ids = batch.map((a) => a.id);
    let placements;
    let headings = [];
    if (reply && reply.status === "ok") {
      placements = S.validate({ placements: reply.placements }, ids, budget);
      const headingIds = batch.filter((a) => S.HEADING_TAGS.has(a.tag)).map((a) => a.id);
      headings = S.validateRewrites({ rewrites: reply.rewrites }, headingIds, rewrites);
    } else {
      // Offline, timed out, stale or errored: decorate locally instead.
      placements = S.randomPlacements(batch, budget);
    }
    if (placements.length || headings.length) {
      requestAnimationFrame(() => {
        placements.forEach((p) => render(p, myGen));
        headings.forEach((r) => rewriteHeading(r, myGen));
      });
    }
  }

  // ---------- rendering ----------

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement("div");
    layer.id = "spook-layer";
    layer.setAttribute("aria-hidden", "true");
    (document.body || document.documentElement).appendChild(layer);
    return layer;
  }

  function placeBox(box, rect, layerRect) {
    box.style.left = `${rect.left - layerRect.left}px`;
    box.style.top = `${rect.top - layerRect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  function render(p, myGen) {
    if (myGen !== gen || !running) return;
    const anchor = anchors.get(p.anchor);
    const spook = S.byId[p.spook];
    if (!anchor || !anchor.isConnected || !spook || anchor.dataset.spookDone) return;

    const tag = anchor.tagName.toLowerCase();
    const rect = anchor.getBoundingClientRect();
    let position = p.position;

    // Never shift content the reader can see: in-flow insertion is only
    // allowed for anchors still below the viewport.
    if (position !== "overlay" && rect.top <= window.innerHeight) position = "overlay";
    if (VOID_TAGS.has(tag)) {
      if (position === "prepend") position = "before";
      if (position === "append") position = "after";
    }

    const node = spook.render(p.text);
    let wrapper;
    if (position === "overlay") {
      wrapper = document.createElement("div");
      wrapper.className = `spook-root spook-box spook-${spook.id} spook-on-${tag}`;
      wrapper.appendChild(node);
      const l = ensureLayer();
      l.appendChild(wrapper);
      placeBox(wrapper, rect, l.getBoundingClientRect());
      overlays.push({ box: wrapper, anchor });
    } else {
      const block = spook.id === "creepy_caption" && (position === "before" || position === "after");
      wrapper = document.createElement(block ? "div" : "span");
      wrapper.className = `spook-root ${block ? "spook-block" : "spook-inline"} spook-${spook.id}`;
      wrapper.setAttribute("aria-hidden", "true");
      wrapper.appendChild(node);
      anchor[position](wrapper);
    }

    anchor.dataset.spookDone = spook.id;
    placed++;
    animIo.observe(wrapper);
  }

  // ---------- word swaps and heading rewrites ----------
  // Only text node values change (no wrapping spans), so frameworks that hold
  // references to these nodes keep working. `originals` restores them.

  function swappable(node) {
    const parent = node.parentElement;
    return !!parent && !parent.closest(NO_SWAP) && !originals.has(node);
  }

  // Walk text nodes in idle chunks, calling fn on each eligible one.
  function walkText(rootNode, myGen, fn, done) {
    if (!rootNode || !rootNode.isConnected) return;
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
    let count = 0;
    const step = (deadline) => {
      if (myGen !== gen || !running) return;
      let node;
      while ((node = walker.nextNode()) && count < MAX_TEXT_NODES) {
        count++;
        if (node.nodeValue.trim() && swappable(node)) fn(node);
        if (count % 100 === 0 && deadline.timeRemaining() < 2) return idle(step);
      }
      if (done) done();
    };
    idle(step);
  }

  function collectWords(myGen) {
    const count = Math.min(S.MAX_SWAPS, Math.round(level("wordSwaps") * 1.6));
    if (count <= 0 || !document.body) return;
    const freq = new Map();
    walkText(
      document.body,
      myGen,
      (node) => {
        for (const m of node.nodeValue.toLowerCase().matchAll(/\p{L}[\p{L}'-]*/gu)) {
          const w = m[0];
          if (w.length < 4 || w.length > 14 || STOPWORDS.has(w)) continue;
          freq.set(w, (freq.get(w) || 0) + 1);
        }
      },
      () => {
        const words = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([w]) => w);
        if (words.length) requestSwaps(words, count, myGen);
      }
    );
  }

  async function requestSwaps(words, count, myGen) {
    const reply = await ask({ type: "spook-words", url: location.href, title: document.title.slice(0, 100), words, count });
    if (myGen !== gen || !running) return;
    const swaps =
      reply && reply.status === "ok" ? S.validateSwaps({ swaps: reply.swaps }, words, count) : S.localSwaps(words, count);
    if (!swaps.length) return;
    swapMap = new Map(swaps.map((s) => [s.from, s.to]));
    const escaped = swaps.map((s) => s.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    swapRegex = new RegExp(`(?<![\\p{L}])(${escaped.join("|")})(?![\\p{L}])`, "giu");
    applySwaps(document.body, myGen);
  }

  function matchCase(source, to) {
    if (source.length > 1 && source === source.toUpperCase()) return to.toUpperCase();
    if (source[0] !== source[0].toLowerCase()) return to[0].toUpperCase() + to.slice(1);
    return to;
  }

  function applySwaps(rootNode, myGen) {
    if (!swapRegex) return;
    walkText(rootNode, myGen, (node) => {
      const before = node.nodeValue;
      swapRegex.lastIndex = 0;
      if (!swapRegex.test(before)) return;
      swapRegex.lastIndex = 0;
      node.nodeValue = before.replace(swapRegex, (m) => matchCase(m, swapMap.get(m.toLowerCase())));
      originals.set(node, { text: before, ours: node.nodeValue });
    });
  }

  // Only headings whose text sits in one text node, so links and markup inside stay intact.
  function rewriteHeading(r, myGen) {
    if (myGen !== gen || !running) return;
    const heading = anchors.get(r.anchor);
    if (!heading || !heading.isConnected || heading.classList.contains("spook-rewritten")) return;
    const texts = [];
    const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); ) if (n.nodeValue.trim()) texts.push(n);
    if (texts.length !== 1 || texts[0].parentElement.closest(".spook-root")) return;
    const node = texts[0];
    const original = originals.has(node) ? originals.get(node).text : node.nodeValue;
    rewritten.push({ el: heading, title: heading.getAttribute("title") });
    heading.title = collapse(original);
    node.nodeValue = r.text;
    originals.set(node, { text: original, ours: node.nodeValue });
    heading.classList.add("spook-rewritten");
  }

  function restoreText() {
    // Skip nodes the page has rewritten since; its text is newer than ours.
    originals.forEach(({ text, ours }, node) => {
      if (node.nodeValue === ours) node.nodeValue = text;
    });
    for (const { el, title } of rewritten) {
      el.classList.remove("spook-rewritten");
      if (title === null) el.removeAttribute("title");
      else el.setAttribute("title", title);
    }
    originals = new Map();
    rewritten = [];
    swapRegex = swapMap = null;
  }

  // ---------- components (spooky-components/components.js) ----------

  // Per-type levels from config.js, overridden by the popup's tuning sliders,
  // then scaled by the master intensity slider (5 = as written).
  const BASE_CONFIG = typeof SPOOKY_CONFIG !== "undefined" ? SPOOKY_CONFIG : {};
  let CONFIG = BASE_CONFIG;
  let JUMPSCARE = null;
  applyTuning(null);
  let jumpTimer = null;
  let jumpUnlisten = null;

  function applyTuning(tuning) {
    const t = tuning || {};
    CONFIG = {
      ...BASE_CONFIG,
      ...t,
      levels: { ...BASE_CONFIG.levels, ...t.levels },
      jumpscare: { ...BASE_CONFIG.jumpscare, ...t.jumpscare },
    };
    JUMPSCARE = { minDelayMs: 8000, cooldownMs: 120000, durationMs: 1200, ...CONFIG.jumpscare };
  }

  function level(name) {
    const base = CONFIG.levels && typeof CONFIG.levels[name] === "number" ? CONFIG.levels[name] : 5;
    return (base * settings.intensity) / 5;
  }

  // Lay an `overlay` GIF over an image, at the GIF's placement. Images that get one aren't sent to the model.
  function coverWithGif(img) {
    const rect = img.getBoundingClientRect();
    const fits = assetsFor(SPOOKY_GIFS, "overlay").filter((g) => !g.minSize || rect.width >= g.minSize);
    if (!fits.length) return false;
    const entry = pickWeighted(fits);
    let gif;
    try {
      gif = createSpookyGif(entry);
    } catch {
      return false; // extension reloaded: getURL throws
    }
    const placement = entry.placement || "cover";
    gif.style.cssText = "pointer-events:none;"; // size and position come from spook-gif--<placement>
    const box = document.createElement("div");
    box.className = `spook-root spook-box spook-gif spook-gif--${placement}`;
    box.dataset.spookGif = entry.id;
    box.style.setProperty("--spook-gif-size", `${(entry.size || 0.4) * 100}%`);
    box.appendChild(gif);
    const l = ensureLayer();
    l.appendChild(box);
    placeBox(box, rect, l.getBoundingClientRect());
    overlays.push({ box, anchor: img });
    anchors.set(`g${anchorCounter++}`, img);
    img.dataset.spookDone = "gif";
    return true;
  }

  // Scatter `scatter` decor over the page with placeRandomly, plus the viewport-fixed `corner` cobwebs.
  function scatterDecor(myGen) {
    if (myGen !== gen || !running || !document.body) return;
    const vh = window.innerHeight || 800;
    const pageHeight = document.documentElement.scrollHeight;
    const scatter = assetsFor(SPOOKY_DECOR, "scatter");
    const maxDecor = CONFIG.maxDecor ?? 12;
    const count = Math.min(maxDecor, Math.ceil((level("decor") * pageHeight) / (3 * vh) / 2));
    if (scatter.length) for (let i = 0; i < count; i++) placeRandomly(createSpookyDecor(pickWeighted(scatter)));

    if (level("cornerCobwebs") <= 0) return;
    for (const name of assetsFor(SPOOKY_DECOR, "corner")) {
      const left = createSpookyDecor(name);
      const right = createSpookyDecor(name);
      right.style.left = "auto";
      right.style.right = "0";
      right.style.transform = "scaleX(-1)";
      for (const fixed of [left, right]) {
        fixed.classList.add("spook-root");
        document.body.appendChild(fixed);
      }
    }
  }

  // Maybe arm one jump-scare: after minDelayMs, it fires on the next scroll.
  function maybeJumpscare(myGen) {
    const scares = assetsFor(SPOOKY_GIFS, "jumpscare");
    const chance = Math.min(1, level("jumpscare") / 10) ** 2;
    if (!scares.length || Math.random() >= chance) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    jumpTimer = setTimeout(() => {
      jumpTimer = null;
      const fire = () => {
        jumpUnlisten = null;
        if (myGen === gen && running) jumpscare(pickWeighted(scares));
      };
      window.addEventListener("scroll", fire, { once: true, passive: true });
      jumpUnlisten = () => window.removeEventListener("scroll", fire);
    }, JUMPSCARE.minDelayMs);
  }

  function cancelJumpscare() {
    clearTimeout(jumpTimer);
    jumpTimer = null;
    if (jumpUnlisten) jumpUnlisten();
    jumpUnlisten = null;
  }

  async function jumpscare(entry) {
    // Cooldown is shared across tabs so browsing doesn't become a string of scares.
    try {
      const { lastJumpscare = 0 } = await chrome.storage.local.get("lastJumpscare");
      if (Date.now() - lastJumpscare < JUMPSCARE.cooldownMs) return;
      await chrome.storage.local.set({ lastJumpscare: Date.now() });
    } catch {
      return; // extension reloaded
    }
    if (!running) return;
    let gif;
    try {
      gif = createSpookyGif(entry);
    } catch {
      return;
    }
    gif.style.cssText = "pointer-events:none;";
    const scare = document.createElement("div");
    scare.className = "spook-root spook-jumpscare";
    scare.dataset.spookGif = entry.id;
    scare.style.setProperty("--spook-jump-ms", `${JUMPSCARE.durationMs}ms`);
    scare.appendChild(gif);
    document.body.appendChild(scare);
    setTimeout(() => scare.remove(), JUMPSCARE.durationMs);
  }

  function repositionAll() {
    repositionQueued = false;
    if (!layer || !overlays.length) return;
    overlays = overlays.filter(({ box, anchor }) => {
      if (anchor.isConnected) return true;
      box.remove();
      return false;
    });
    // Read everything first, then write, to avoid layout thrash.
    const layerRect = layer.getBoundingClientRect();
    const rects = overlays.map(({ anchor }) => anchor.getBoundingClientRect());
    overlays.forEach(({ box }, i) => placeBox(box, rects[i], layerRect));
  }

  function queueReposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(repositionAll);
  }

  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(queueReposition, 150);
  }

  // Pages that scroll an inner container move anchors without moving the layer.
  function onInnerScroll(e) {
    if (e.target !== document && overlays.length) queueReposition();
  }

  // ---------- dynamic pages ----------

  function onMutations(records) {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && !isOurs(n) && n.id !== "spook-layer") addedRoots.push(n);
      }
    }
    if (addedRoots.length && !mutationTimer) {
      mutationTimer = setTimeout(() => {
        mutationTimer = null;
        const roots = addedRoots;
        addedRoots = [];
        roots.forEach(scanRoot);
        roots.forEach((root) => applySwaps(root, gen));
      }, 500);
    }
  }

  function checkUrl() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      reset();
    }
  }

  // ---------- lifecycle ----------

  function start() {
    if (running || !document.body) return;
    running = true;
    io = new IntersectionObserver(onIntersect, { rootMargin: LOOKAHEAD });
    animIo = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.target.classList.toggle("spook-paused", !e.isIntersecting)),
      { rootMargin: "100px" }
    );
    mo = new MutationObserver(onMutations);
    mo.observe(document.body, { childList: true, subtree: true });
    ro = new ResizeObserver(onResize);
    ro.observe(document.body);
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("scroll", onInnerScroll, { capture: true, passive: true });
    window.addEventListener("popstate", checkUrl);
    urlTimer = setInterval(checkUrl, 1000);
    rescan();
  }

  function clearSpooks() {
    gen++;
    // Free the model for fresh batches instead of finishing ones we'll ignore.
    try {
      chrome.runtime.sendMessage({ type: "spook-cancel" }).catch(() => {});
    } catch {
      // extension reloaded: nothing to cancel
    }
    clearTimeout(flushTimer);
    clearTimeout(mutationTimer);
    cancelJumpscare();
    flushTimer = mutationTimer = null;
    pending = [];
    addedRoots = [];
    placed = reserved = maxBottom = observedCount = 0;
    restoreText();
    document.querySelectorAll(".spook-root").forEach((n) => n.remove());
    if (layer) layer.remove();
    layer = null;
    overlays = [];
    anchors.forEach((n) => {
      delete n.dataset.spookAnchor;
      delete n.dataset.spookDone;
    });
    anchors = new Map();
    seen = new WeakSet();
    if (io) io.disconnect();
    if (animIo) animIo.disconnect();
  }

  function stop() {
    if (!running) return;
    clearSpooks();
    running = false;
    if (mo) mo.disconnect();
    if (ro) ro.disconnect();
    clearInterval(urlTimer);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("scroll", onInnerScroll, { capture: true });
    window.removeEventListener("popstate", checkUrl);
  }

  // Start over on the current DOM (SPA navigation or "re-spook").
  function reset() {
    if (!running) return;
    clearSpooks();
    rescan();
  }

  function rescan() {
    const myGen = gen;
    idle(() => {
      scanRoot(document.body);
      idle(() => scatterDecor(myGen));
      idle(() => collectWords(myGen));
    });
    maybeJumpscare(myGen);
  }

  function applyEnabled() {
    document.documentElement.classList.toggle("spookify-off", !settings.enabled);
    if (settings.enabled) idle(start);
    else stop();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.intensity) settings.intensity = Number(changes.intensity.newValue) || 5;
    if (changes.tuning) applyTuning(changes.tuning.newValue);
    // Apply new levels now, not just to spooks placed later.
    if ((changes.intensity || changes.tuning) && !changes.enabled) reset();
    if (changes.enabled) {
      settings.enabled = changes.enabled.newValue !== false;
      applyEnabled();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "respook") reset();
  });

  chrome.storage.sync
    .get({ enabled: true, intensity: 5, tuning: null })
    .catch(() => ({ enabled: true, intensity: 5, tuning: null }))
    .then((s) => {
      settings.enabled = s.enabled !== false;
      settings.intensity = Number(s.intensity) || 5;
      applyTuning(s.tuning);
      applyEnabled();
    });
})();
