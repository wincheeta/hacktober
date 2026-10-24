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
      if (node.tagName === "IMG" && Math.random() < settings.intensity / 10 && coverWithGif(node)) continue;
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
    const allowed = Math.ceil((settings.intensity * covered) / (3 * vh));
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
    requestPlacements(batch, budget, gen);
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

  async function requestPlacements(batch, budget, myGen) {
    const reply = await ask({
      type: "spook-batch",
      url: location.href,
      title: document.title.slice(0, 100),
      anchors: batch,
      budget,
    });
    if (myGen !== gen || !running) return;
    reserved -= budget;

    const ids = batch.map((a) => a.id);
    let placements;
    if (reply && reply.status === "ok") {
      placements = S.validate({ placements: reply.placements }, ids, budget);
    } else {
      // Offline, timed out, stale or errored: decorate locally instead.
      placements = S.randomPlacements(batch, budget);
    }
    if (placements.length) requestAnimationFrame(() => placements.forEach((p) => render(p, myGen)));
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
      const block = spook.id === "tombstone" || (spook.id === "creepy_caption" && (position === "before" || position === "after"));
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

  // ---------- components (spooky-components/components.js) ----------

  const DECOR_SCATTER = ["ghost", "bat", "pumpkin", "tombstone"];
  const MAX_DECOR = 12;

  function pickOne(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  // Lay a random GIF over an image. Images that get one aren't sent to the model.
  function coverWithGif(img) {
    let gif;
    try {
      gif = createSpookyGif(pickOne(SPOOKY_GIFS));
    } catch {
      return false; // extension reloaded: getURL throws
    }
    gif.style.cssText = "width:100%;height:100%;object-fit:cover;pointer-events:none;";
    const box = document.createElement("div");
    box.className = "spook-root spook-box spook-gif";
    box.appendChild(gif);
    const l = ensureLayer();
    l.appendChild(box);
    placeBox(box, img.getBoundingClientRect(), l.getBoundingClientRect());
    overlays.push({ box, anchor: img });
    anchors.set(`g${anchorCounter++}`, img);
    img.dataset.spookDone = "gif";
    return true;
  }

  // Scatter SVG decor over the page with placeRandomly, plus the viewport-fixed corner cobwebs.
  function scatterDecor(myGen) {
    if (myGen !== gen || !running || !document.body) return;
    const vh = window.innerHeight || 800;
    const pageHeight = document.documentElement.scrollHeight;
    const count = Math.min(MAX_DECOR, Math.ceil((settings.intensity * pageHeight) / (3 * vh) / 2));
    for (let i = 0; i < count; i++) placeRandomly(createSpookyDecor(pickOne(DECOR_SCATTER)));

    const webLeft = createSpookyDecor("cobweb");
    const webRight = createSpookyDecor("cobweb");
    webRight.style.left = "auto";
    webRight.style.right = "0";
    webRight.style.transform = "scaleX(-1)";
    for (const fixed of [webLeft, webRight]) {
      fixed.classList.add("spook-root");
      document.body.appendChild(fixed);
    }

    showSkeletor(myGen);
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
    fact.textContent = pickOne(DEPRESSING_FACTS);

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
    flushTimer = mutationTimer = null;
    pending = [];
    addedRoots = [];
    placed = reserved = maxBottom = observedCount = 0;
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
    });
  }

  function applyEnabled() {
    document.documentElement.classList.toggle("spookify-off", !settings.enabled);
    if (settings.enabled) idle(start);
    else stop();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.intensity) settings.intensity = Number(changes.intensity.newValue) || 5;
    if (changes.enabled) {
      settings.enabled = changes.enabled.newValue !== false;
      applyEnabled();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "respook") reset();
  });

  chrome.storage.sync
    .get({ enabled: true, intensity: 5 })
    .catch(() => ({ enabled: true, intensity: 5 }))
    .then((s) => {
      settings.enabled = s.enabled !== false;
      settings.intensity = Number(s.intensity) || 5;
      applyEnabled();
    });
})();
