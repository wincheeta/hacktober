# 🎃 Spookify

A browser extension (Manifest V3) that makes every web page spooky.

- **Instant theme.** Every page turns dark with an orange and black palette at first paint. This is plain CSS, so it never slows the page down.
- **Model-placed spooks.** A local [Ollama](https://ollama.com) model looks at small batches of page elements near where you're reading. It decides which pre-defined decoration goes where: ghosts, bats, spiders, cobwebs, pumpkins, glowing eyes, tombstones, creepy captions and blood drips.
- **Never blocks the page.** The page loads exactly as it would without the extension. Spooks fade in a few seconds later, and more appear as you scroll.
- **GIFs and decorations.** Some images get a spooky GIF laid over them as you scroll; more images get one at higher intensity. SVG ghosts, bats, pumpkins and tombstones are scattered across the page, with cobwebs in the top corners. These are placed at random locally, without the model.
- **Works offline.** If Ollama isn't running, spooks are placed at random instead.

The model only picks element ids, spook ids and positions, plus a short line of text for tombstones and captions. The extension validates that and builds the decorations itself, so the model never injects markup into the page.

## Setup

### 1. Run Ollama

```
ollama pull llama3.2:3b
ollama serve
```

Smaller models such as `llama3.2:1b` or `qwen2.5:1.5b` reply faster. You can switch models in the popup.

Ollama normally rejects requests from browser extensions with a 403 error. In Chrome, Spookify handles this itself: it rewrites the Origin header on its own requests to Ollama, and only those. Web pages still can't reach Ollama.

Firefox doesn't let extensions rewrite their own requests. There, or if the popup still reports a 403, restart Ollama with:

```
OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ollama serve
```

### 2. Load the extension

**Chrome / Edge / Brave**

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this directory.

Chrome may show a warning that `background.scripts` is ignored. That key is there for Firefox and the warning is harmless.

**Firefox (121+)**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json`.
3. If the popup shows **Allow access to Ollama**, click it. Also allow the extension to run on all sites when Firefox asks.

## Using it

Browse normally. Click the toolbar icon to open the popup:

| Control | What it does |
|---|---|
| Spook every page | Turns the theme and spooks on or off instantly. |
| Ollama model | Any model Ollama has installed. The list fills from `ollama list`. |
| Intensity | Roughly how many spooks appear per three screens of scrolling. |
| Status | Whether Ollama is online, whether the model is loaded, and how many batches are queued for this tab. |
| Re-spook this page | Clears the decorations and asks the model again. |

## How it works

| File | Role |
|---|---|
| `manifest.json` | Registers the theme CSS and scripts on all pages, the background worker and the popup. |
| `theme.css` | The dark orange and black theme, injected at `document_start`. |
| `boot.js` | Tiny `document_start` script that switches the theme off if the extension is disabled. |
| `spooks.js` | The spook catalog, the validator for model output and the random fallback. Shared by the page and the background worker. |
| `spooks.css` | Styles and animations for the spooks. |
| `spooky-components/components.js` | The GIF list, the SVG decorations and `placeRandomly`, which scatters them over the page. |
| `Pictures/` | The GIFs laid over page images. |
| `content.js` | Finds elements lazily as they near the viewport, batches them, asks the background worker for placements and renders them. |
| `background.js` | Per-tab request queue, the Ollama call, the Origin header rule and a cache of past answers. |
| `popup.html`, `popup.js` | Settings and status. |

The flow for a page:

1. The theme applies at first paint.
2. After the page has loaded and the browser is idle, an `IntersectionObserver` picks up headings, images, paragraphs, nav, header, footer, articles and buttons within about 1.5 screens of the viewport.
3. Elements are sent in batches of up to 8. Each batch gets a budget of up to 3 spooks, based on the intensity setting.
4. The background worker queues batches per tab and handles the newest first, because that's nearest where you're looking. Batches older than 10 seconds are dropped, and a request is cancelled when its tab closes or navigates.
5. Ollama gets a short prompt and a JSON schema with one variant per spook, so it must reply with valid placements. The prompt asks for compact JSON because output tokens dominate the response time on CPU, and it lists the spooks the tab already shows so small models vary their picks. Each request times out after 25 seconds and the model is kept loaded for 30 minutes.
6. The page validates the reply and renders the spooks. Anything already on screen is drawn as an overlay, so text you're reading never jumps. Only elements still below the screen get decorations inserted into the page flow.
7. A `MutationObserver` and URL check pick up infinite scroll and single-page-app navigation.

Answers are cached per element for the browser session, so revisiting a page shows the same spooks without asking the model again.

## Developing

There is no build step. Edit the files directly.

- After a change, reload the extension on `chrome://extensions` or `about:debugging`, then refresh the page you're testing.
- Page-side logs appear in the page's DevTools console. Each Ollama batch is logged in the service worker console, with its timing and chosen spooks: click **service worker** on `chrome://extensions`.
- Content scripts don't run on browser-internal pages such as `chrome://` URLs or the Chrome Web Store, so test on a normal website.

## Performance notes

On a CPU-only machine with `llama3.2:3b`, a batch takes roughly 5 to 12 seconds, and the first one after the model loads takes longer. The page doesn't wait for any of it. A GPU or a smaller model brings this down to a second or two.
