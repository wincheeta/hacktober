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
  const NO_SWAP = "script, style, noscript, code, pre, kbd, samp, textarea, input, select, option, svg, [contenteditable=''], [contenteditable='true'], .spook-root, .spook-letters, #spook-layer";
  const MAX_TEXT_NODES = 3000;
  const STOPWORDS = new Set(
    ("that this with from have your will more about what when which their there them they been were would " +
      "could should into than then also only just some other such like make most over very here these those " +
      "where while after before because each does done many much must need being both every same even ever").split(" ")
  );

  const idle = window.requestIdleCallback
    ? (fn) => window.requestIdleCallback(fn, { timeout: 2000 })
    : (fn) => setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: true }), 50);

  const settings = { enabled: true, intensity: 5, dragMode: false };
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
  let possessions = []; // undo functions for spooks that changed page elements
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
  let metaOf = new WeakMap(); // wrapper -> { sig, spook, text, tag, kind }
  let pinned = new Map(); // wrapper -> meta, for spooks the user has dragged
  let pinnedSigs = new Set(); // anchor signatures whose spook was dragged away
  let drag = null;

  // ---------- moodle removal ----------
  // Grep for any mention within the HTML of "moodle.ecs.soton.ac.uk" and remove it.
  const MOODLE_PATTERN = /moodle\.ecs\.soton\.ac\.uk/i;
  const MOODLE_GLOBAL = /moodle\.ecs\.soton\.ac\.uk/gi;

  function grepAndRemoveMoodle(rootNode = document.body) {
    if (!rootNode || !rootNode.isConnected) return;

    // Check if rootNode itself is a matching link/resource element
    if (rootNode.matches && rootNode.matches("a, img, iframe, form, [data-url], [data-href]") && !isOurs(rootNode)) {
      const target =
        (rootNode.getAttribute("href") || "") +
        " " +
        (rootNode.getAttribute("src") || "") +
        " " +
        (rootNode.getAttribute("action") || "") +
        " " +
        (rootNode.getAttribute("data-url") || "") +
        " " +
        (rootNode.getAttribute("data-href") || "");
      if (MOODLE_PATTERN.test(target)) {
        rootNode.remove();
        return;
      }
    }

    // 1. Remove elements whose links/attributes mention moodle.ecs.soton.ac.uk
    if (rootNode.querySelectorAll) {
      rootNode.querySelectorAll("a, img, iframe, form, [data-url], [data-href]").forEach((el) => {
        if (isOurs(el)) return;
        const target =
          (el.getAttribute("href") || "") +
          " " +
          (el.getAttribute("src") || "") +
          " " +
          (el.getAttribute("action") || "") +
          " " +
          (el.getAttribute("data-url") || "") +
          " " +
          (el.getAttribute("data-href") || "");
        if (MOODLE_PATTERN.test(target)) el.remove();
      });

      // Also clean up any mentions in title, alt, or aria-label attributes
      rootNode.querySelectorAll("[title], [alt], [aria-label]").forEach((el) => {
        if (isOurs(el)) return;
        for (const attr of ["title", "alt", "aria-label"]) {
          const val = el.getAttribute(attr);
          if (val && MOODLE_PATTERN.test(val)) {
            el.setAttribute(attr, val.replace(MOODLE_GLOBAL, ""));
          }
        }
      });
    }

    // 2. Grep text nodes for any text mention and remove it
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
    const toClean = [];
    let n;
    while ((n = walker.nextNode())) {
      if (MOODLE_PATTERN.test(n.nodeValue)) {
        toClean.push(n);
      }
    }

    for (const textNode of toClean) {
      textNode.nodeValue = textNode.nodeValue.replace(MOODLE_GLOBAL, "");
      let parent = textNode.parentElement;
      while (
        parent &&
        !parent.textContent.trim() &&
        !isOurs(parent) &&
        parent !== document.body &&
        parent !== document.documentElement
      ) {
        const next = parent.parentElement;
        parent.remove();
        parent = next;
      }
    }
  }

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
    const desc = describe(anchor, p.anchor);
    const sig = `${desc.tag}|${desc.text}`;
    // The user already moved this anchor's spook somewhere; it was restored there.
    if (pinnedSigs.has(sig)) {
      anchor.dataset.spookDone = "pinned";
      return;
    }
    const rect = anchor.getBoundingClientRect();
    let position = p.position;

    if (position === "possess") {
      const undo = spook.possess ? spook.possess(anchor, p.text) : null;
      if (!undo) return; // e.g. haunted_letters on an image
      possessions.push(undo);
      anchor.dataset.spookDone = spook.id;
      placed++;
      return;
    }

    // Never shift content the reader can see: in-flow insertion is only
    // allowed for anchors still below the viewport.
    if (position !== "overlay" && rect.top <= window.innerHeight) position = "overlay";
    if (VOID_TAGS.has(tag)) {
      if (position === "prepend") position = "before";
      if (position === "append") position = "after";
    }

    const node = spook.render(p.text);
    const shownText = spook.needsText ? node.textContent : "";
    let wrapper;
    let kind = "box";
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
      kind = block ? "block" : "inline";
      wrapper = document.createElement(block ? "div" : "span");
      wrapper.className = `spook-root spook-${kind} spook-${spook.id}`;
      wrapper.setAttribute("aria-hidden", "true");
      wrapper.appendChild(node);
      anchor[position](wrapper);
    }

    metaOf.set(wrapper, { sig, spook: spook.id, text: shownText, tag, kind });
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
    if (texts.length !== 1 || texts[0].parentElement.closest(".spook-root, .spook-letters")) return;
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

    showSkeletor(myGen);

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

  const DEPRESSING_FACTS = [
    "Every atom in your body came from an exploding star, just to end up sitting here scrolling.",
    "In about 5 billion years, the Sun will expand and boil Earth's oceans, erasing all evidence of humanity.",
    "You have already met almost everyone who will ever genuinely remember your existence.",
    "One day, someone will say your name out loud for the very last time, and then you'll be completely forgotten.",
    "Sharks are older than trees, Saturn's rings, and any sense of accomplishment you felt today.",
    "Over 99% of all species that have ever lived on Earth are now extinct. We're on the list!",
    "Your skeleton is completely wet right now, and it will remain so until long after you're gone.",
    "There are over 3 trillion trees on Earth, and not a single one cares about your deadlines.",
    "Sloths sometimes mistake their own arms for tree branches, grab them, and plunge to their doom.",
    "Your brain decides what you do up to 10 seconds before you are even aware of making the decision.",
    "Every second, your cells accumulate mutations that your body will eventually fail to repair.",
    "The universe is expanding into a freezing, completely silent void of eternal nothingness.",
    "One day, your parents put you down as a child and never picked you up again.",
    "Somewhere on the calendar is the anniversary of your death, and you pass it every year without knowing.",
    "In about 4.5 billion years, Andromeda will collide with the Milky Way, dismantling the solar system.",
    "Elephants will mourn other elephants in their group dying and will hold funerals for them and will even recognize the bones of said elephant and cry out in sadness",
    "Your dog will mourn you when you die, but your cats will be indifferent",
    "You share 50% of your DNA with a banana",
    "Your body contains more bacterial cells than human cells",
    "There is a single whale that is unable to communicate with any other whale of it's kind due to different frequencies",
    "if a sheep is not sheared, it will be weighed down and eventually fall over, and ends up starving to death",
    "Many people go through the last years of their life sad and chronically lonely",
    "Every 60 seconds, a minute passes - Ali",
    "If a panda has more than one cub, she often cannot care for both of the babies, and must choose one to survive."
  ];

  function showSkeletor(myGen) {
    if (myGen !== gen || !running || !document.body) return;
    if (document.getElementById("spook-skeletor")) return;

    let gifUrl;
    try {
      gifUrl = chrome.runtime.getURL("Pictures/skeletor.gif");
    } catch {
      return;
    }

    const container = document.createElement("div");
    container.id = "spook-skeletor";
    container.className = "spook-root spook-skeletor-container";

    const bubble = document.createElement("div");
    bubble.className = "spook-skeletor-bubble";

    const fact = document.createElement("p");
    fact.className = "spook-skeletor-fact";
    fact.textContent = DEPRESSING_FACTS[Math.floor(Math.random() * DEPRESSING_FACTS.length)];

    const signoff = document.createElement("div");
    signoff.className = "spook-skeletor-signoff";
    signoff.textContent = "— Until we meet again!";

    bubble.appendChild(fact);
    bubble.appendChild(signoff);

    const img = document.createElement("img");
    img.className = "spook-skeletor-img";
    img.src = gifUrl;
    img.alt = "Skeletor";

    container.appendChild(bubble);
    container.appendChild(img);

    document.body.appendChild(container);
  }

  // Maybe arm one jump-scare at a random depth of the page (20-80% of the way
  // down); it fires when the reader scrolls past it, but never before minDelayMs.
  function maybeJumpscare(myGen) {
    const scares = assetsFor(SPOOKY_GIFS, "jumpscare");
    const chance = Math.min(1, level("jumpscare") / 10) ** 2;
    if (!scares.length || Math.random() >= chance) return;
    if (typeof JUMPSCARE_NEVER_MS !== "undefined" && JUMPSCARE.cooldownMs >= JUMPSCARE_NEVER_MS) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const depth = 0.2 + Math.random() * 0.6;
    jumpTimer = setTimeout(() => {
      jumpTimer = null;
      // Captured on document so pages that scroll an inner container count too.
      let target = null;
      const onScroll = (e) => {
        const el = e.target === document ? document.scrollingElement || document.documentElement : e.target;
        if (!el || el.clientHeight < window.innerHeight / 2) return; // a small scrolling widget, not the page
        // Fixed in pixels on the first scroll, so infinite feeds that grow as
        // they're scrolled don't keep pushing it out of reach.
        if (target === null) target = depth * (el.scrollHeight - el.clientHeight);
        if (el.scrollTop < target) return;
        jumpUnlisten();
        if (myGen === gen && running) jumpscare(pickWeighted(scares));
      };
      document.addEventListener("scroll", onScroll, { capture: true, passive: true });
      jumpUnlisten = () => {
        document.removeEventListener("scroll", onScroll, { capture: true });
        jumpUnlisten = null;
      };
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

  // ---------- dragging ----------
  // In drag mode spooks take the mouse (see spooks.css). A dragged spook is
  // detached from its anchor into the layer, so it stays where it was dropped
  // and scrolls with the page. Positions are saved per URL and restored on load.

  function pinKey() {
    return `pins:${location.href.split("#")[0]}`;
  }

  // Detach a spook from its anchor so it can be moved freely. Component GIFs and
  // decor have no meta, so they move but aren't saved.
  function unanchor(wrapper) {
    if (pinned.has(wrapper)) return;
    const l = ensureLayer();
    if (wrapper.classList.contains("spook-box")) {
      overlays = overlays.filter((o) => o.box !== wrapper);
    } else {
      const rect = wrapper.getBoundingClientRect();
      // Keep em-sized sprites the size they were next to the anchor.
      wrapper.style.fontSize = getComputedStyle(wrapper).fontSize;
      wrapper.style.right = "auto"; // right-hand corner cobweb
      l.appendChild(wrapper);
      placeBox(wrapper, rect, l.getBoundingClientRect());
    }
    wrapper.classList.add("spook-free");
    pinned.set(wrapper, metaOf.get(wrapper));
  }

  function onPointerDown(e) {
    if (e.button !== 0 || !running) return;
    const wrapper = e.target.closest && e.target.closest(".spook-root");
    if (!wrapper || wrapper.classList.contains("spook-jumpscare")) return;
    e.preventDefault();
    e.stopPropagation();
    unanchor(wrapper);
    drag = {
      wrapper,
      pointerId: e.pointerId,
      startX: e.pageX,
      startY: e.pageY,
      left: parseFloat(wrapper.style.left) || 0,
      top: parseFloat(wrapper.style.top) || 0,
    };
    document.documentElement.classList.add("spookify-dragging");
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    drag.wrapper.style.left = `${drag.left + e.pageX - drag.startX}px`;
    drag.wrapper.style.top = `${drag.top + e.pageY - drag.startY}px`;
  }

  function endDrag() {
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerUp, true);
    document.documentElement.classList.remove("spookify-dragging");
    drag = null;
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    endDrag();
    savePins();
  }

  // Spooks can sit inside links and buttons; don't let a drag click them.
  function onClick(e) {
    if (e.target.closest && e.target.closest(".spook-root")) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function applyDragMode() {
    const on = settings.enabled && settings.dragMode;
    document.documentElement.classList.toggle("spookify-drag", on);
    const method = on ? "addEventListener" : "removeEventListener";
    window[method]("pointerdown", onPointerDown, true);
    window[method]("click", onClick, true);
    if (!on && drag) endDrag();
  }

  function savePins() {
    const list = [...pinned]
      .filter(([w, meta]) => w.isConnected && meta)
      .map(([w, meta]) => ({
        ...meta,
        x: parseFloat(w.style.left) || 0,
        y: parseFloat(w.style.top) || 0,
        w: parseFloat(w.style.width) || 0,
        h: parseFloat(w.style.height) || 0,
        fontSize: w.style.fontSize || "",
      }));
    const key = pinKey();
    try {
      (list.length ? chrome.storage.local.set({ [key]: list }) : chrome.storage.local.remove(key)).catch(() => {});
    } catch {
      // extension reloaded: nowhere to save
    }
  }

  // Recreate the spooks the user moved on this page, where they left them.
  // Stored data is re-validated, since only catalog spooks may be rendered.
  async function restorePins(myGen) {
    const key = pinKey();
    let list;
    try {
      list = (await chrome.storage.local.get(key))[key];
    } catch {
      return;
    }
    if (myGen !== gen || !running || !Array.isArray(list)) return;
    const l = ensureLayer();
    for (const p of list) {
      const spook = p && S.byId[p.spook];
      if (!spook || ![p.x, p.y, p.w, p.h].every(Number.isFinite)) continue;
      const kind = ["box", "block", "inline"].includes(p.kind) ? p.kind : "box";
      const tag = /^[a-z][a-z0-9]{0,9}$/.test(p.tag) ? p.tag : "div";
      const text = S.cleanText(p.text);
      const wrapper = document.createElement(kind === "inline" ? "span" : "div");
      wrapper.className =
        kind === "box" ? `spook-root spook-box spook-${spook.id} spook-on-${tag}` : `spook-root spook-${kind} spook-${spook.id}`;
      wrapper.classList.add("spook-free");
      wrapper.setAttribute("aria-hidden", "true");
      wrapper.appendChild(spook.render(text));
      placeBox(wrapper, { left: p.x, top: p.y, width: p.w, height: p.h }, { left: 0, top: 0 });
      if (/^\d+(\.\d+)?px$/.test(p.fontSize)) wrapper.style.fontSize = p.fontSize;
      l.appendChild(wrapper);
      const meta = { sig: String(p.sig || ""), spook: spook.id, text, tag, kind };
      metaOf.set(wrapper, meta);
      pinned.set(wrapper, meta);
      pinnedSigs.add(meta.sig);
      animIo.observe(wrapper);
    }
  }

  async function unpinAll() {
    try {
      await chrome.storage.local.remove(pinKey());
    } catch {
      // extension reloaded
    }
    reset();
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
        roots.forEach((root) => {
          grepAndRemoveMoodle(root);
          scanRoot(root);
          applySwaps(root, gen);
        });
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

  // Restore moved spooks first, so their anchors aren't decorated twice.
  function rescan() {
    const myGen = gen;
    grepAndRemoveMoodle(document.body);
    restorePins(myGen).finally(() => {
      if (myGen !== gen) return;
      {
        idle(() => {
        {
          scanRoot(document.body);
        idle(() => scatterDecor(myGen));
        idle(() => collectWords(myGen));
      };
          idle(() => scatterDecor(myGen));
          idle(() => collectWords(myGen));
        });
        maybeJumpscare(myGen);
      }
    });
    maybeJumpscare(myGen);
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
    possessions.forEach((undo) => undo());
    possessions = [];
    if (drag) endDrag();
    restoreText();
    document.querySelectorAll(".spook-root").forEach((n) => n.remove());
    if (layer) layer.remove();
    layer = null;
    overlays = [];
    metaOf = new WeakMap();
    pinned = new Map();
    pinnedSigs = new Set();
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



  function applyEnabled() {
    document.documentElement.classList.toggle("spookify-off", !settings.enabled);
    if (settings.enabled) idle(start);
    else stop();
    applyDragMode();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.intensity) settings.intensity = Number(changes.intensity.newValue) || 5;
    if (changes.tuning) applyTuning(changes.tuning.newValue);
    // Apply new levels now, not just to spooks placed later.
    if ((changes.intensity || changes.tuning) && !changes.enabled) reset();
    if (changes.dragMode) {
      settings.dragMode = changes.dragMode.newValue === true;
      applyDragMode();
    }
    if (changes.enabled) {
      settings.enabled = changes.enabled.newValue !== false;
      applyEnabled();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "respook") reset();
    if (msg && msg.type === "unpin") unpinAll();
  });

  const STORED = { enabled: true, intensity: 5, dragMode: false, tuning: null };
  chrome.storage.sync
    .get(STORED)
    .catch(() => STORED)
    .then((s) => {
      settings.enabled = s.enabled !== false;
      settings.intensity = Number(s.intensity) || 5;
      settings.dragMode = s.dragMode === true;
      applyTuning(s.tuning);
      applyEnabled();
    });
})();
