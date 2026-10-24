// Pre-made spooky components for "spookifying" a page.
// Loaded as a content script before content.js, so everything here is a global.
//
// - SPOOKY_GIFS:  gif paths (relative to the extension root), meant to be
//                 dropped over the page at random absolute positions.
// - SPOOKY_DECOR: general-purpose divs with inline SVG art, keyed by name.
//
// Styles are inline so the host page's CSS is less likely to interfere, and
// every element ignores the mouse so the page stays usable underneath.

const SPOOKY_GIFS = [
  "Pictures/dancing-skeleton.gif",
  "Pictures/fnaf-freddy.gif",
  "Pictures/skeletonchompontaco.gif",
  "Pictures/skeletonSpider.gif",
  "Pictures/skull.gif",
];

const SPOOKY_DECOR = {
  ghost: `
    <div data-spooky="ghost" style="width:100px;height:120px;pointer-events:none;opacity:0.85;">
      <svg viewBox="0 0 100 120" width="100%" height="100%">
        <path d="M50 5C25 5 10 25 10 50v65l13-10 13 10 14-10 14 10 13-10 13 10V50C90 25 75 5 50 5z"
              fill="#f5f5f5" stroke="#ccc" stroke-width="2"/>
        <ellipse cx="37" cy="45" rx="6" ry="9" fill="#222"/>
        <ellipse cx="63" cy="45" rx="6" ry="9" fill="#222"/>
        <ellipse cx="50" cy="72" rx="8" ry="11" fill="#222"/>
      </svg>
    </div>`,

  bat: `
    <div data-spooky="bat" style="width:120px;height:60px;pointer-events:none;">
      <svg viewBox="0 0 120 60" width="100%" height="100%">
        <path d="M60 18c-4 0-6 3-7 6-6-8-18-14-32-12 6 4 8 10 6 16-6-3-14-2-20 2 10 2 17 9 20 18 5-6 13-8 20-6 4 2 8 5 13 10 5-5 9-8 13-10 7-2 15 0 20 6 3-9 10-16 20-18-6-4-14-5-20-2-2-6 0-12 6-16-14-2-26 4-32 12-1-3-3-6-7-6z
                 M54 22l-2-10 5 6z M66 22l2-10-5 6z"
              fill="#111"/>
        <circle cx="56" cy="24" r="1.5" fill="#e33"/>
        <circle cx="64" cy="24" r="1.5" fill="#e33"/>
      </svg>
    </div>`,

  pumpkin: `
    <div data-spooky="pumpkin" style="width:100px;height:90px;pointer-events:none;">
      <svg viewBox="0 0 100 90" width="100%" height="100%">
        <path d="M48 18c0-8 2-13 8-16l3 3c-4 3-5 7-5 13z" fill="#3a5f1e"/>
        <ellipse cx="30" cy="52" rx="22" ry="32" fill="#e8741c"/>
        <ellipse cx="70" cy="52" rx="22" ry="32" fill="#e8741c"/>
        <ellipse cx="50" cy="52" rx="24" ry="34" fill="#f28a2e"/>
        <path d="M30 40l10 10H20z M70 40l10 10H60z" fill="#2b1500"/>
        <path d="M26 62h48l-6 12-6-5-6 6-6-6-6 6-6-6-6 5z" fill="#2b1500"/>
      </svg>
    </div>`,

  tombstone: `
    <div data-spooky="tombstone" style="width:100px;height:120px;pointer-events:none;">
      <svg viewBox="0 0 100 120" width="100%" height="100%">
        <path d="M15 112V45C15 20 30 8 50 8s35 12 35 37v67z" fill="#7a7a7a" stroke="#444" stroke-width="3"/>
        <text x="50" y="58" text-anchor="middle" font-family="Georgia, serif" font-size="22"
              font-weight="bold" fill="#3a3a3a">R.I.P</text>
        <rect x="5" y="108" width="90" height="12" rx="4" fill="#2e4d1f"/>
      </svg>
    </div>`,

  // Sits in the top-left corner of the viewport; flip with transform:scaleX(-1) for the other side.
  cobweb: `
    <div data-spooky="cobweb" style="position:fixed;top:0;left:0;width:200px;height:200px;pointer-events:none;z-index:2147483647;">
      <svg viewBox="0 0 100 100" width="100%" height="100%" fill="none" stroke="rgba(220,220,220,0.8)" stroke-width="0.8">
        <path d="M0 0L100 0 M0 0L95 35 M0 0L70 70 M0 0L35 95 M0 0L0 100"/>
        <path d="M30 0Q24 6 28 10Q22 14 21 21Q14 22 10 28Q6 24 0 30"/>
        <path d="M60 0Q48 12 56 20Q44 28 42 42Q28 44 20 56Q12 48 0 60"/>
        <path d="M90 0Q72 18 85 31Q66 42 64 64Q42 66 31 85Q18 72 0 90"/>
      </svg>
    </div>`,

  // Stretches across the top of the viewport.
  bloodDrip: `
    <div data-spooky="bloodDrip" style="position:fixed;top:0;left:0;width:100%;height:60px;pointer-events:none;z-index:2147483647;">
      <svg viewBox="0 0 200 30" width="100%" height="100%" preserveAspectRatio="none">
        <path d="M0 0H200V6Q195 6 194 14Q193 20 190 14Q189 6 170 6Q166 6 165 22Q164 28 162 22Q160 6 140 6Q137 6 136 12Q135 16 133 12Q132 6 110 6Q106 6 105 25Q104 30 102 25Q100 6 80 6Q77 6 76 15Q75 19 73 15Q72 6 50 6Q46 6 45 20Q44 26 42 20Q40 6 20 6Q17 6 16 12Q15 16 13 12Q12 6 0 6Z"
              fill="#8a0303"/>
      </svg>
    </div>`,
};

// Builds an <img> for one of SPOOKY_GIFS.
function createSpookyGif(path, size = 150) {
  const img = document.createElement("img");
  img.src = chrome.runtime.getURL(path);
  img.dataset.spooky = "gif";
  img.style.cssText = `width:${size}px;height:auto;pointer-events:none;`;
  return img;
}

// Builds a fresh element from one of SPOOKY_DECOR by name.
function createSpookyDecor(name) {
  const template = document.createElement("template");
  template.innerHTML = SPOOKY_DECOR[name].trim();
  return template.content.firstElementChild;
}

// Absolutely positions an element at a random spot within the page and appends it.
function placeRandomly(el) {
  const maxX = Math.max(document.documentElement.scrollWidth - 150, 0);
  const maxY = Math.max(document.documentElement.scrollHeight - 150, 0);
  el.style.position = "absolute";
  el.style.left = `${Math.floor(Math.random() * maxX)}px`;
  el.style.top = `${Math.floor(Math.random() * maxY)}px`;
  el.style.zIndex = "2147483647";
  document.body.appendChild(el);
  return el;
}
