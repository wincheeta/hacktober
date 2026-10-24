# 🎃 Spookify

A browser extension (Manifest V3) that makes every web page spooky.

- **Instant theme.** Every page turns dark with an orange and black palette at first paint. This is plain CSS, so it never slows the page down.
- **Model-placed spooks.** A local [Ollama](https://ollama.com) model looks at small batches of page elements near where you're reading. It decides which pre-defined decoration goes where: ghosts, bats, spiders, cobwebs, pumpkins, glowing eyes, creepy captions and blood drips.
- **Haunted words.** The model picks up to 10 common words on the page and swaps them for spooky ones everywhere they appear ("cart" becomes "coffin", "team" becomes "coven"). It also rewrites a few headings into spooky versions; hover a rewritten heading to see the original. Turning Spookify off restores the original text.
- **Never blocks the page.** The page loads exactly as it would without the extension. Spooks fade in a few seconds later, and more appear as you scroll.
- **GIFs and decorations.** Some images get a spooky GIF laid over them as you scroll, each in its own spot: covering the image, peeking from a corner, or dangling from the top. SVG ghosts, bats and pumpkins are scattered across the page, with cobwebs in the top corners. Very occasionally a jump-scare flashes up. These are placed at random locally, without the model.
- **Works offline.** If Ollama isn't running, spooks are placed at random instead.

The model only picks element ids, spook ids and positions, plus a short line of text for captions. The extension validates that and builds the decorations itself, so the model never injects markup into the page.

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
| Intensity | Master volume for every kind of spook. At the middle position, the levels in `config.js` apply as written. |
| Tuning | One slider per value in `config.js`: each kind of spook, max decorations and the jump-scare timings. |
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
| `spooky-components/config.js` | How much of each kind of spook to show. See [Tuning](#tuning). |
| `spooky-components/components.js` | The GIFs and SVG decorations with their attributes, and `placeRandomly`, which scatters decorations over the page. |
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
8. Once per page, the 40 most common words on it go to the model in a separate request, which runs before any queued batch. The schema only lets the model pick words from that list. The swaps are applied by changing text node values, never markup, and new content gets them too. Headings are rewritten from the same batch request as the spooks, and only when their text is in a single text node.

Answers are cached per element for the browser session, so revisiting a page shows the same spooks without asking the model again.

## Tuning

Open **Tuning** in the popup to change any of these with a slider while you browse. The page re-spooks as soon as you let go. Your slider values are saved in the browser, and **Reset to config.js** goes back to the file's values.

The defaults live in [spooky-components/config.js](spooky-components/config.js); edit it and reload the extension to change them. Each kind of spook has its own level from 0 (off) to 10:

| Level | Controls |
|---|---|
| `modelSpooks` | Spooks placed by Ollama, about this many per three screens. |
| `wordSwaps` | Words Ollama swaps for spooky ones on each page: level × 1.6, up to 10. Offline, a built-in word list is used. |
| `headingRewrites` | Headings Ollama rewrites per batch: level ÷ 4 rounded, up to 2. |
| `gifOverlays` | Chance that an image gets a GIF: level ÷ 10. |
| `decor` | Scattered SVG decorations, about half this many per three screens, up to `maxDecor`. |
| `cornerCobwebs` | 0 hides the corner cobwebs. |
| `jumpscare` | Chance of one jump-scare per page: (level ÷ 10)². 3 is about 9%, 10 is every page. |

The popup slider scales all of them: effective level = level × slider ÷ 5. The `jumpscare` block sets the earliest time, the cooldown (shared across tabs) and how long it shows.

### Adding a GIF or decoration

Drop the GIF in `Pictures/` and add one line to `SPOOKY_GIFS` in [components.js](spooky-components/components.js):

```js
{ id: "witch", path: "Pictures/witch.gif", use: "overlay", placement: "bottom-left", size: 0.35, weight: 1 },
```

| Attribute | Meaning |
|---|---|
| `use` | `overlay` goes over page images. `jumpscare` flashes full screen. |
| `placement` | For overlays: `cover`, `center`, `bottom-left`, `bottom-right`, `peek-corner` or `hang-top`. |
| `size` | Width as a share of the image, for every placement except `cover`. |
| `minSize` | Smallest image width in px the GIF may go on. |
| `weight` | Relative chance of being picked within its use. |

Decorations in `SPOOKY_DECOR` have a `use` too. `scatter` decorations are placed at random over the page, `corner` ones are fixed in the top corners, and `edge` is currently unused, which is how the blood drip is kept off.

## Developing

There is no build step. Edit the files directly.

- After a change, reload the extension on `chrome://extensions` or `about:debugging`, then refresh the page you're testing.
- Page-side logs appear in the page's DevTools console. Each Ollama batch is logged in the service worker console, with its timing and chosen spooks: click **service worker** on `chrome://extensions`.
- Content scripts don't run on browser-internal pages such as `chrome://` URLs or the Chrome Web Store, so test on a normal website.

## Performance notes

On a CPU-only machine with `llama3.2:3b`, a batch takes roughly 5 to 12 seconds, and the first one after the model loads takes longer. The page doesn't wait for any of it. A GPU or a smaller model brings this down to a second or two.
