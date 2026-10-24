// Pre-made spooky components for "spookifying" a page.
// Loaded as a content script before content.js, so everything here is a global.
//
// - SPOOKY_GIFS:  gif descriptors. `use` says which system shows the gif:
//                   overlay   - laid over a page image, at `placement`, and also scattered over the page
//                   jumpscare - flashed full screen, rarely
//                 placement: cover | center | bottom-left | bottom-right | peek-corner | hang-top
//                 size:      fraction of the image width (all placements but cover)
//                 minSize:   smallest image width (px) the gif may go on
//                 weight:    relative chance of being picked within its use
// - SPOOKY_DECOR: divs with inline SVG art, keyed by name, each with a `use`:
//                   scatter - placed at random over the page (placeRandomly)
//                   corner  - fixed in the top corners of the viewport
//                   edge    - fixed along the top edge (currently unused)
//
// Intensity per use lives in config.js.
//
// Styles are inline so the host page's CSS is less likely to interfere, and
// every element ignores the mouse so the page stays usable underneath.

const SPOOKY_GIFS = [
  { id: "freddy", path: "Pictures/fnaf-freddy.gif", use: "jumpscare" },
  { id: "taco", path: "Pictures/skeletonchompontaco.gif", use: "overlay", placement: "bottom-left", size: 0.45, minSize: 200, weight: 2 },
  { id: "dancer", path: "Pictures/dancing-skeleton.gif", use: "overlay", placement: "bottom-right", size: 0.45, weight: 2 },
  { id: "spider", path: "Pictures/skeletonSpider.gif", use: "overlay", placement: "hang-top", size: 0.3, weight: 1 },
  { id: "spider2", path: "Pictures/spider2.gif", use: "overlay", placement: "bottom-right", size: 0.3, weight: 1 },
  // Only 40px, so kept small to stay sharp.
  { id: "spider3", path: "Pictures/spider3.gif", use: "overlay", placement: "peek-corner", size: 0.12, weight: 1 },
  { id: "skull", path: "Pictures/skull.gif", use: "overlay", placement: "peek-corner", size: 0.3, weight: 1 },
  { id: "dancer1", path: "Pictures/dancing-skeleton1.gif", use: "overlay", placement: "bottom-right", size: 0.4, weight: 1 },
  { id: "dancer2", path: "Pictures/dancing-skeleton2.gif", use: "overlay", placement: "bottom-left", size: 0.4, weight: 1 },
  { id: "dancer3", path: "Pictures/dancing-skeleton3.gif", use: "overlay", placement: "bottom-right", size: 0.4, weight: 1 },
  { id: "dancer4", path: "Pictures/dancing-skeleton4.gif", use: "overlay", placement: "bottom-left", size: 0.35, weight: 1 },
  { id: "pumpkin1", path: "Pictures/pumpkin1.gif", use: "overlay", placement: "bottom-left", size: 0.25, weight: 1 },
  { id: "pumpkin2", path: "Pictures/pumpkin2.gif", use: "overlay", placement: "bottom-right", size: 0.3, weight: 1 },
  { id: "pumpkin3", path: "Pictures/pumpkin3.gif", use: "overlay", placement: "bottom-left", size: 0.3, weight: 1 },
  { id: "pumpkin4", path: "Pictures/pumpkin4.gif", use: "overlay", placement: "bottom-right", size: 0.3, weight: 1 },
  { id: "bat-hang", path: "Pictures/bat1.gif", use: "overlay", placement: "hang-top", size: 0.2, weight: 1 },
  { id: "bat-fly", path: "Pictures/bat2.gif", use: "overlay", placement: "peek-corner", size: 0.35, weight: 1 },
  { id: "bat-swarm", path: "Pictures/batgroup.gif", use: "overlay", placement: "center", size: 0.6, weight: 1 },
  { id: "witch", path: "Pictures/witch1.gif", use: "overlay", placement: "bottom-left", size: 0.4, minSize: 200, weight: 1 },
  { id: "witch-cauldron", path: "Pictures/witch2.gif", use: "overlay", placement: "bottom-right", size: 0.35, weight: 1 },
  { id: "crawler", path: "Pictures/creeper.gif", use: "overlay", placement: "bottom-left", size: 0.35, weight: 1 },
  { id: "spooky-guys", path: "Pictures/guys.gif", use: "overlay", placement: "center", size: 0.6, minSize: 250, weight: 1 },
  { id: "skull-small", path: "Pictures/skull1.gif", use: "overlay", placement: "peek-corner", size: 0.15, weight: 1 },
  { id: "spider-small", path: "Pictures/spider.gif", use: "overlay", placement: "hang-top", size: 0.15, weight: 1 },
];

const SPOOKY_DECOR = {
  // Sits in the top-left corner of the viewport; flip with transform:scaleX(-1) for the other side.
  cobweb: {
    use: "corner",
    html: `
    <div data-spooky="cobweb" style="position:fixed;top:0;left:0;width:200px;height:200px;pointer-events:none;z-index:2147483647;">
      <svg viewBox="0 0 100 100" width="100%" height="100%" fill="none" stroke="rgba(220,220,220,0.8)" stroke-width="0.8">
        <path d="M0 0L100 0 M0 0L95 35 M0 0L70 70 M0 0L35 95 M0 0L0 100"/>
        <path d="M30 0Q24 6 28 10Q22 14 21 21Q14 22 10 28Q6 24 0 30"/>
        <path d="M60 0Q48 12 56 20Q44 28 42 42Q28 44 20 56Q12 48 0 60"/>
        <path d="M90 0Q72 18 85 31Q66 42 64 64Q42 66 31 85Q18 72 0 90"/>
      </svg>
    </div>`,
  },

  // Stretches across the top of the viewport.
  bloodDrip: {
    use: "edge",
    html: `
    <div data-spooky="bloodDrip" style="position:fixed;top:0;left:0;width:100%;height:60px;pointer-events:none;z-index:2147483647;">
      <svg viewBox="0 0 200 30" width="100%" height="100%" preserveAspectRatio="none">
        <path d="M0 0H200V6Q195 6 194 14Q193 20 190 14Q189 6 170 6Q166 6 165 22Q164 28 162 22Q160 6 140 6Q137 6 136 12Q135 16 133 12Q132 6 110 6Q106 6 105 25Q104 30 102 25Q100 6 80 6Q77 6 76 15Q75 19 73 15Q72 6 50 6Q46 6 45 20Q44 26 42 20Q40 6 20 6Q17 6 16 12Q15 16 13 12Q12 6 0 6Z"
              fill="#8a0303"/>
      </svg>
    </div>`,
  },
};

// Entries of a SPOOKY_GIFS-style list, or the names of a SPOOKY_DECOR-style map, with the given use.
function assetsFor(assets, use) {
  if (Array.isArray(assets)) return assets.filter((a) => a.use === use);
  return Object.keys(assets).filter((name) => assets[name].use === use);
}

// Picks one entry at random, favouring higher `weight` (default 1).
// Works on gif entries and on decor names.
function pickWeighted(list) {
  const weightOf = (item) => (typeof item === "string" ? SPOOKY_DECOR[item].weight : item.weight) || 1;
  let roll = Math.random() * list.reduce((sum, item) => sum + weightOf(item), 0);
  for (const item of list) {
    roll -= weightOf(item);
    if (roll < 0) return item;
  }
  return list[list.length - 1];
}

// Builds an <img> for one of SPOOKY_GIFS.
function createSpookyGif(gif, size = 150) {
  const img = document.createElement("img");
  img.src = chrome.runtime.getURL(gif.path);
  img.dataset.spooky = "gif";
  img.style.cssText = `width:${size}px;height:auto;pointer-events:none;`;
  return img;
}

// Builds a fresh element from one of SPOOKY_DECOR by name.
function createSpookyDecor(name) {
  const template = document.createElement("template");
  template.innerHTML = SPOOKY_DECOR[name].html.trim();
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
  // spook-root: skipped by the theme, hidden when disabled, removed on re-spook.
  el.classList.add("spook-root");
  document.body.appendChild(el);
  return el;
}
