// Tuning for each kind of spookification. Edit, then reload the extension.
// Loaded as a content script before components.js and content.js.
//
// Levels run 0 (off) to 10 (max). The popup's intensity slider scales every
// level as a master volume: effective = level * slider / 5, so at the default
// slider position (5) these numbers apply as written.

const SPOOKY_CONFIG = {
  levels: {
    modelSpooks: 5, // Ollama-placed catalog spooks: about `level` per three screens
    wordSwaps: 5, // Ollama-chosen word swaps per page: level * 1.6, up to 10
    headingRewrites: 5, // Ollama heading rewrites per batch: level / 4 rounded, up to 2
    gifOverlays: 5, // chance an eligible image gets a GIF: level / 10
    decor: 5, // scattered SVG decor: about level / 2 per three screens, capped by maxDecor
    cornerCobwebs: 4, // 0 hides the corner cobwebs, anything else shows them
    jumpscare: 3, // chance per page of one jump-scare: (level / 10)^2, so 3 = 9%, 5 = 25%, 10 = always
  },
  maxDecor: 12,
  jumpscare: {
    minDelayMs: 8000, // never sooner than this after the page is spooked
    cooldownMs: 120000, // at most one jump-scare per this long, across all tabs
    durationMs: 1200,
  },
};
