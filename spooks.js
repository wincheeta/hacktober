// Spook catalog: the only decorations Spookify can insert.
// The model picks spook ids and anchors; it never supplies markup.
// Loaded by the content script (window) and the background worker (no DOM),
// so render functions only touch `document` when called.
(function (root) {
  "use strict";

  const POSITIONS = ["overlay", "before", "after", "prepend", "append"];
  const MAX_TEXT = 60;
  const MAX_PER_BATCH = 3;

  const EPITAPHS = [
    "Here lies the last tab you closed",
    "Clicked one link too many",
    "Rest in pixels",
    "Gone, but still loading",
    "They read the terms and conditions",
    "Cookies accepted. Soul taken.",
  ];
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

  const catalog = [
    {
      id: "ghost",
      description: "a translucent ghost drifting back and forth across the element",
      positions: ["overlay"],
      needsText: false,
      render() {
        const root = el("span", "spook-ghost");
        // 1 in 100 ghosts is the cursed one.
        const file = Math.random() < 0.01 ? "cursedghost.svg" : "ghost.svg";
        let src;
        try {
          src = chrome.runtime.getURL(`spooky-components/${file}`);
        } catch {
          // Extension reloaded: getURL throws, so fall back to the emoji.
          root.appendChild(el("span", "spook-sprite", "👻"));
          return root;
        }
        const img = el("img", "spook-sprite");
        img.src = src;
        img.alt = "";
        root.appendChild(img);
        return root;
      },
    },
    {
      id: "bat_swarm",
      description: "a few bats bursting out of the element and flying away",
      positions: ["overlay"],
      needsText: false,
      render() {
        const root = el("span", "spook-bats");
        const paths = [
          [-140, -90], [120, -110], [-60, -150], [170, -40], [40, -170],
        ];
        paths.forEach(([dx, dy], i) => {
          const bat = el("span", "spook-bat");
          bat.style.setProperty("--dx", `${dx}px`);
          bat.style.setProperty("--dy", `${dy}px`);
          bat.style.animationDelay = `${i * 0.35}s`;
          bat.appendChild(el("span", "spook-bat-wings", "🦇"));
          root.appendChild(bat);
        });
        return root;
      },
    },
    {
      id: "spider_drop",
      description: "a spider lowering itself on a silk thread from the top of the element",
      positions: ["overlay"],
      needsText: false,
      render() {
        const root = el("span", "spook-spider");
        const thread = el("span", "spook-thread");
        thread.appendChild(el("span", "spook-spider-body", "🕷️"));
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
    {
      id: "jack_o_lantern",
      description: "a flickering carved pumpkin next to the element (good for headings and buttons)",
      positions: ["before", "after", "prepend", "append", "overlay"],
      needsText: false,
      render() {
        const root = el("span", "spook-pumpkin");
        root.appendChild(el("span", "spook-sprite", "🎃"));
        return root;
      },
    },
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
      id: "tombstone",
      description: "a tombstone with a short epitaph that riffs on the element's text (good for footers, old posts, prices)",
      positions: ["after", "before", "overlay"],
      needsText: true,
      render(text) {
        const root = el("span", "spook-tomb");
        root.appendChild(el("span", "spook-tomb-rip", "R.I.P."));
        root.appendChild(el("span", "spook-tomb-text", text || pick(EPITAPHS)));
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
      h1: ["blood_drip", "jack_o_lantern", "creepy_caption", "bat_swarm"],
      h2: ["jack_o_lantern", "spider_drop", "blood_drip", "ghost"],
      h3: ["jack_o_lantern", "spider_drop", "ghost"],
      img: ["glowing_eyes", "cobweb", "creepy_caption", "ghost"],
      p: ["ghost", "spider_drop", "creepy_caption", "bat_swarm"],
      nav: ["cobweb", "bat_swarm"],
      header: ["cobweb", "bat_swarm", "spider_drop"],
      footer: ["tombstone", "cobweb"],
      article: ["cobweb", "ghost", "glowing_eyes"],
      button: ["jack_o_lantern", "cobweb"],
    };
    return byId[pick(fits[tag] || catalog.map((s) => s.id))];
  }

  root.Spookify = {
    catalog,
    byId,
    POSITIONS,
    MAX_TEXT,
    MAX_PER_BATCH,
    validate,
    randomPlacements,
    cleanText,
  };
})(typeof self !== "undefined" ? self : globalThis);
