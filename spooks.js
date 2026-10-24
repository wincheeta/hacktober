// Spook catalog: the only decorations Spookify can insert.
// The model picks spook ids and anchors; it never supplies markup.
// Loaded by the content script (window) and the background worker (no DOM),
// so render functions only touch `document` when called.
(function (root) {
  "use strict";

  // "possess" changes the anchor itself instead of adding a decoration near it.
  const POSITIONS = ["overlay", "before", "after", "prepend", "append", "possess"];
  const MAX_TEXT = 60;
  const MAX_PER_BATCH = 3;

  const CAPTIONS = [
    "Something is reading this with you...",
    "Don't look behind the scrollbar.",
    "This page was here before you.",
    "It knows what you clicked.",
    "The ink is still wet. It isn't ink.",
    "Keep scrolling. It's closer now.",
  ];

  const SVG_NS = "http://www.w3.org/2000/svg";

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    return node;
  }

  // <img> for an SVG in spooky-components/. If the extension was reloaded,
  // getURL throws, so fall back to an emoji in the same class.
  function assetImg(file, className, fallbackEmoji) {
    let src;
    try {
      src = chrome.runtime.getURL(`spooky-components/${file}`);
    } catch {
      return el("span", className, fallbackEmoji);
    }
    const img = el("img", className);
    img.src = src;
    img.alt = "";
    return img;
  }

  // Cobweb anchored in the top-right corner of a 100x100 viewBox.
  function cobwebSvg() {
    const s = svg("svg", { viewBox: "0 0 100 100", class: "spook-web-svg", "aria-hidden": "true" });
    const cx = 100, cy = 0;
    const angles = [0, 22.5, 45, 67.5, 90].map((a) => (a * Math.PI) / 180);
    const point = (a, r) => [cx - Math.cos(a) * r, cy + Math.sin(a) * r];
    let d = "";
    for (const a of angles) {
      const [x, y] = point(a, 100);
      d += `M${cx} ${cy}L${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    for (const r of [18, 36, 56, 78]) {
      for (let i = 0; i < angles.length - 1; i++) {
        const [x1, y1] = point(angles[i], r);
        const [x2, y2] = point(angles[i + 1], r);
        // Sag each strand slightly toward the corner.
        const mx = (x1 + x2) / 2 + (cx - (x1 + x2) / 2) * 0.15;
        const my = (y1 + y2) / 2 + (cy - (y1 + y2) / 2) * 0.15;
        d += `M${x1.toFixed(1)} ${y1.toFixed(1)}Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      }
    }
    s.appendChild(svg("path", { d, fill: "none", stroke: "rgba(235,230,220,0.75)", "stroke-width": 1.2 }));
    return s;
  }

  function eyesSvg() {
    const s = svg("svg", { viewBox: "0 0 60 24", class: "spook-eyes-svg", "aria-hidden": "true" });
    for (const x of [16, 44]) {
      s.appendChild(svg("ellipse", { cx: x, cy: 12, rx: 9, ry: 6, fill: "#ff7518" }));
      s.appendChild(svg("ellipse", { cx: x, cy: 12, rx: 2, ry: 5, fill: "#120800" }));
    }
    return s;
  }

  // ---------- possessions ----------
  // possess(anchor, text) alters the page element and returns an undo function,
  // or null when it doesn't suit the element. Effects only use transforms,
  // opacity, filters and shadows, so the page never reflows.

  function possessWithClass(cls) {
    return (anchor) => {
      anchor.classList.add("spook-fx", cls);
      return () => anchor.classList.remove("spook-fx", cls);
    };
  }

  // Splits the anchor's text into letters and lets a few of them come loose.
  function hauntLetters(anchor) {
    const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        !n.nodeValue.trim() || n.parentElement.closest(".spook-root, .spook-letters")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    let chars = 0;
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
      chars += walker.currentNode.nodeValue.length;
    }
    if (!nodes.length || chars > 120) return null;

    const swaps = nodes.map((textNode) => {
      const wrap = el("span", "spook-letters");
      for (const part of textNode.nodeValue.split(/(\s+)/)) {
        if (!part) continue;
        if (!part.trim()) {
          wrap.appendChild(document.createTextNode(part));
          continue;
        }
        // Words stay unbreakable so loose letters can't change line wrapping.
        const word = el("span", "spook-word");
        for (const ch of part) {
          const letter = el("span", "spook-letter", ch);
          if (/\S/.test(ch) && Math.random() < 0.3) {
            letter.classList.add("spook-letter-loose");
            letter.style.animationDelay = `${(Math.random() * 5).toFixed(2)}s`;
          }
          word.appendChild(letter);
        }
        wrap.appendChild(word);
      }
      textNode.replaceWith(wrap);
      return [wrap, textNode];
    });
    return () => swaps.forEach(([wrap, textNode]) => wrap.isConnected && wrap.replaceWith(textNode));
  }

  // Shows the model's line under (or above) the element while it's hovered.
  function whisperOnHover(anchor, text) {
    const line = text || pick(CAPTIONS);
    let tip = null;
    const hide = () => {
      if (tip) tip.remove();
      tip = null;
    };
    const show = () => {
      if (tip) return;
      const r = anchor.getBoundingClientRect();
      tip = el("div", "spook-root spook-whisper", line);
      tip.setAttribute("aria-hidden", "true");
      tip.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 260))}px`;
      if (r.bottom + 48 > window.innerHeight) {
        tip.style.top = `${r.top - 6}px`;
        tip.classList.add("spook-whisper-above");
      } else {
        tip.style.top = `${r.bottom + 6}px`;
      }
      document.body.appendChild(tip);
    };
    anchor.addEventListener("mouseenter", show);
    anchor.addEventListener("mouseleave", hide);
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    anchor.classList.add("spook-fx", "spook-fx-whisper");
    return () => {
      anchor.removeEventListener("mouseenter", show);
      anchor.removeEventListener("mouseleave", hide);
      window.removeEventListener("scroll", hide, { capture: true });
      anchor.classList.remove("spook-fx", "spook-fx-whisper");
      hide();
    };
  }

  const catalog = [
    // {
    //   id: "ghost",
    //   description: "a translucent ghost drifting back and forth across the element",
    //   positions: ["overlay"],
    //   needsText: false,
    //   render() {
    //     const root = el("span", "spook-ghost");
    //     // 1 in 100 ghosts is the cursed one.
    //     const file = Math.random() < 0.01 ? "cursedghost.svg" : "ghost.svg";
    //     root.appendChild(assetImg(file, "spook-sprite", "👻"));
    //     return root;
    //   },
    // },
    // {
    //   id: "bat_swarm",
    //   description: "a few bats bursting out of the element and flying away",
    //   positions: ["overlay"],
    //   needsText: false,
    //   render() {
    //     const root = el("span", "spook-bats");
    //     const paths = [
    //       [-140, -90], [120, -110], [-60, -150], [170, -40], [40, -170],
    //     ];
    //     paths.forEach(([dx, dy], i) => {
    //       const bat = el("span", "spook-bat");
    //       bat.style.setProperty("--dx", `${dx}px`);
    //       bat.style.setProperty("--dy", `${dy}px`);
    //       bat.style.animationDelay = `${i * 0.35}s`;
    //       bat.appendChild(el("span", "spook-bat-wings", "🦇"));
    //       root.appendChild(bat);
    //     });
    //     return root;
    //   },
    // },
    {
      id: "spider_drop",
      description: "a spider lowering itself on a silk thread from the top of the element",
      positions: ["overlay"],
      needsText: false,
      render() {
        const root = el("span", "spook-spider");
        const thread = el("span", "spook-thread");
        thread.appendChild(assetImg("spider.svg", "spook-spider-body", "🕷️"));
        root.appendChild(thread);
        return root;
      },
    },
    {
      id: "cobweb",
      description: "a dusty cobweb in the corner of the element (good for boxes, images, navigation, headers)",
      positions: ["overlay"],
      needsText: false,
      render() {
        const root = el("span", "spook-cobweb");
        root.appendChild(cobwebSvg());
        return root;
      },
    },
    // {
    //   id: "jack_o_lantern",
    //   description: "a flickering carved pumpkin next to the element (good for headings and buttons)",
    //   positions: ["before", "after", "prepend", "append", "overlay"],
    //   needsText: false,
    //   render() {
    //     const root = el("span", "spook-pumpkin");
    //     root.appendChild(el("span", "spook-sprite", "🎃"));
    //     return root;
    //   },
    // },
    {
      id: "glowing_eyes",
      description: "a pair of glowing orange eyes that blink, as if something is watching (good for images and dark areas)",
      positions: ["overlay", "append"],
      needsText: false,
      render() {
        const root = el("span", "spook-eyes");
        root.appendChild(eyesSvg());
        return root;
      },
    },
    {
      id: "creepy_caption",
      description: "a whispered, unsettling caption under the element that riffs on its text (good for headlines and images)",
      positions: ["after", "append", "overlay"],
      needsText: true,
      render(text) {
        return el("span", "spook-caption", text || pick(CAPTIONS));
      },
    },
    {
      id: "blood_drip",
      description: "red drips running down from the bottom of the element (good for big headings)",
      positions: ["overlay"],
      needsText: false,
      render() {
        const root = el("span", "spook-blood");
        [8, 23, 41, 57, 76, 91].forEach((left, i) => {
          const drip = el("span", "spook-drip");
          drip.style.left = `${left}%`;
          drip.style.setProperty("--len", `${14 + ((i * 37) % 30)}px`);
          drip.style.animationDelay = `${(i * 0.45) % 2}s`;
          root.appendChild(drip);
        });
        return root;
      },
    },
    {
      id: "possessed_shake",
      description: "the element itself trembles every few seconds, as if something is inside it (good for buttons, headings, images)",
      positions: ["possess"],
      needsText: false,
      possess: possessWithClass("spook-fx-shake"),
    },
    {
      id: "crooked_hang",
      description: "the element itself hangs crooked from one nail and slowly sways (good for images, headers, navigation, footers)",
      positions: ["possess"],
      needsText: false,
      possess: possessWithClass("spook-fx-hang"),
    },
    {
      id: "flicker_out",
      description: "the element itself flickers like a dying light bulb (good for headers, navigation, images)",
      positions: ["possess"],
      needsText: false,
      possess: possessWithClass("spook-fx-flicker"),
    },
    {
      id: "bleeding_text",
      description: "the element's own text glows and bleeds red (good for big headings)",
      positions: ["possess"],
      needsText: false,
      possess: possessWithClass("spook-fx-bleed"),
    },
    {
      id: "haunted_letters",
      description: "a few letters of the element's own text come loose, wobble and drop (good for short headings and buttons, not images)",
      positions: ["possess"],
      needsText: false,
      possess: hauntLetters,
    },
    {
      id: "hover_whisper",
      description: "when the reader hovers over the element, a creepy line about it appears just below it (good for links, buttons, images, paragraphs)",
      positions: ["possess"],
      needsText: true,
      possess: whisperOnHover,
    },
  ];

  const byId = Object.fromEntries(catalog.map((s) => [s.id, s]));

  function cleanText(value) {
    if (typeof value !== "string") return "";
    return value
      .replace(/[\u0000-\u001f\u007f<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TEXT);
  }

  // Turn untrusted model output into safe placements.
  // Drops unknown anchors and spook ids, de-duplicates anchors, clamps to the
  // budget, and moves a disallowed position to the spook's first allowed one.
  function validate(raw, anchorIds, budget) {
    const ids = anchorIds instanceof Set ? anchorIds : new Set(anchorIds);
    const limit = Math.max(0, Math.min(MAX_PER_BATCH, budget | 0));
    const list = raw && Array.isArray(raw.placements) ? raw.placements : [];
    const out = [];
    const used = new Set();
    for (const p of list) {
      if (out.length >= limit) break;
      if (!p || typeof p !== "object") continue;
      const anchor = String(p.anchor);
      const spook = byId[p.spook];
      if (!ids.has(anchor) || used.has(anchor) || !spook) continue;
      const position = spook.positions.includes(p.position) ? p.position : spook.positions[0];
      out.push({ anchor, spook: spook.id, position, text: spook.needsText ? cleanText(p.text) : "" });
      used.add(anchor);
    }
    return out;
  }

  // Local fallback when the model is offline, slow or wrong.
  function randomPlacements(anchors, budget) {
    const limit = Math.max(0, Math.min(MAX_PER_BATCH, budget | 0));
    const pool = anchors.slice().sort(() => Math.random() - 0.5);
    return pool.slice(0, limit).map((a) => {
      const spook = suggestSpook(a.tag);
      return { anchor: a.id, spook: spook.id, position: pick(spook.positions), text: "" };
    });
  }

  function suggestSpook(tag) {
    const fits = {
      h1: ["blood_drip", "jack_o_lantern", "creepy_caption", "bat_swarm", "bleeding_text", "haunted_letters"],
      h2: ["jack_o_lantern", "spider_drop", "blood_drip", "ghost", "haunted_letters", "possessed_shake"],
      h3: ["jack_o_lantern", "spider_drop", "ghost", "bleeding_text", "haunted_letters"],
      img: ["glowing_eyes", "cobweb", "creepy_caption", "ghost", "crooked_hang", "flicker_out", "possessed_shake"],
      p: ["ghost", "spider_drop", "creepy_caption", "bat_swarm", "hover_whisper"],
      nav: ["cobweb", "bat_swarm", "flicker_out"],
      header: ["cobweb", "bat_swarm", "spider_drop", "flicker_out", "crooked_hang"],
      footer: ["creepy_caption", "cobweb", "crooked_hang"],
      article: ["cobweb", "ghost", "glowing_eyes", "hover_whisper"],
      button: ["jack_o_lantern", "cobweb", "possessed_shake", "haunted_letters", "hover_whisper"],
    };
    return byId[pick(fits[tag] || catalog.map((s) => s.id))];
  }

  // ---------- word swaps and heading rewrites ----------

  const MAX_SWAP_TEXT = 24;
  const MAX_SWAPS = 10; // new swaps per page
  const MAX_SWAP_DICT = 50; // swaps kept across pages
  const MAX_REWRITES = 2;
  const HEADING_TAGS = new Set(["h1", "h2", "h3"]);

  // Local fallback swaps, used when the model is offline or slow.
  const WORD_SWAPS = {
    home: "tomb", search: "séance", cart: "coffin", basket: "cauldron", account: "crypt",
    login: "summon", sign: "omen", menu: "grimoire", news: "omens", comments: "wails",
    comment: "wail", share: "curse", subscribe: "join the coven", help: "exorcism",
    settings: "rituals", profile: "haunt", contact: "séance", about: "lore",
    blog: "diary of the damned", shop: "apothecary", store: "apothecary", price: "toll",
    prices: "tolls", free: "cursed", sale: "sacrifice", offer: "bargain", deals: "bargains",
    email: "raven", message: "spirit message", messages: "spirit messages", friends: "familiars",
    people: "spirits", user: "mortal", users: "mortals", team: "coven", members: "coven",
    community: "graveyard", video: "apparition", videos: "apparitions", photo: "portrait",
    photos: "portraits", today: "tonight", update: "resurrection", updates: "resurrections",
    download: "unearth", upload: "bury", delete: "banish", history: "ancient lore",
    privacy: "secrecy", terms: "pacts", cookies: "soul cakes", password: "incantation",
  };

  function swapText(value) {
    return cleanText(value).slice(0, MAX_SWAP_TEXT);
  }

  // `from` must be one of the page words we sent (or any plain word when
  // `words` is null); `to` is short plain text.
  function validateSwaps(raw, words, max) {
    const allowed = words === null ? null : words instanceof Set ? words : new Set(words);
    const limit = Math.max(0, Math.min(MAX_SWAP_DICT, max | 0));
    const list = raw && Array.isArray(raw.swaps) ? raw.swaps : [];
    const out = [];
    const used = new Set();
    for (const s of list) {
      if (out.length >= limit) break;
      if (!s || typeof s !== "object") continue;
      const from = String(s.from || "").toLowerCase();
      const to = swapText(s.to);
      // Words only: small models sometimes leak JSON punctuation into the string.
      if (!/^\p{L}[\p{L}'’ -]*$/u.test(to)) continue;
      if (allowed ? !allowed.has(from) : !/^[\p{L}'-]{3,20}$/u.test(from)) continue;
      if (used.has(from) || to.toLowerCase() === from) continue;
      out.push({ from, to });
      used.add(from);
    }
    return out;
  }

  function localSwaps(words, max) {
    const raw = { swaps: words.filter((w) => WORD_SWAPS[w]).map((w) => ({ from: w, to: WORD_SWAPS[w] })) };
    return validateSwaps(raw, words, max);
  }

  function validateRewrites(raw, headingIds, max) {
    const ids = headingIds instanceof Set ? headingIds : new Set(headingIds);
    const limit = Math.max(0, Math.min(MAX_REWRITES, max | 0));
    const list = raw && Array.isArray(raw.rewrites) ? raw.rewrites : [];
    const out = [];
    const used = new Set();
    for (const r of list) {
      if (out.length >= limit) break;
      if (!r || typeof r !== "object") continue;
      const anchor = String(r.anchor);
      const text = cleanText(r.text);
      if (!ids.has(anchor) || used.has(anchor) || !text) continue;
      out.push({ anchor, text });
      used.add(anchor);
    }
    return out;
  }

  root.Spookify = {
    catalog,
    byId,
    POSITIONS,
    MAX_TEXT,
    MAX_PER_BATCH,
    MAX_SWAP_TEXT,
    MAX_SWAPS,
    MAX_SWAP_DICT,
    MAX_REWRITES,
    HEADING_TAGS,
    validate,
    randomPlacements,
    cleanText,
    validateSwaps,
    localSwaps,
    validateRewrites,
  };
})(typeof self !== "undefined" ? self : globalThis);
