# Plan: "Spookify" browser extension (Hacktober hackathon)

## Context
The repo is a minimal Manifest V3 extension ([manifest.json](manifest.json), [content.js](content.js)) that just logs page HTML. We're turning it into an extension that makes every page spooky:
1. A local Ollama model reads small summaries of the page and decides **which pre-defined spook elements go where**.
2. The extension validates that decision and inserts the elements itself (the model never writes HTML).
3. A stylesheet re-themes the page dark with an orange/black palette.

**Core constraint: the model is slow, so it must never hold up the page.** The page loads and is usable exactly as it would without the extension. The theme is pure CSS and applies instantly. Model-chosen spooks are added progressively, in small batches, as the user browses and scrolls.

Assumptions (defaults, changeable): Chrome first, Firefox kept working; default model `llama3.2:3b` (configurable in popup, with `llama3.2:1b` / `qwen2.5:1.5b` as faster options); Ollama at `http://localhost:11434`.

## Timeline of a page load

```
t=0      page starts loading       theme.css applies (static CSS, no model) → dark orange/black at once
t≈load   page fully usable         content.js runs at document_idle; does nothing heavy yet
idle     requestIdleCallback       scan only the anchors in/near the viewport → batch #1 sent to background
+1–5s    model replies             spooks for batch #1 fade in
scroll   IntersectionObserver      anchors entering the "lookahead" zone are queued → batch #2, #3 …
new DOM  MutationObserver          infinite scroll / SPA content gets anchors registered → batched the same way
```

## Architecture

```
content.js (page)                         background.js (service worker)              Ollama
 ├─ theme.css already applied
 ├─ IntersectionObserver lookahead
 ├─ batch of ≤8 anchors ──msg──▶  per-tab queue (1 in flight, newest-first)
 │                                  check per-URL cache
 │                                  POST /api/chat (JSON schema)  ─────────────────────▶ model
 ◀──────── placements for batch ───┘                               ◀── JSON placements ──┘
 ├─ validate (anchor ids, spook ids, positions)
 └─ render with fade-in, no layout shift above the reader
```

The Ollama call goes through the background worker because content scripts are bound by the page's CORS/CSP. The worker gets `host_permissions` for `http://localhost:11434/*`.

## Files

| File | Change |
|---|---|
| [manifest.json](manifest.json) | Rename to "Spookify". Add `background` (`service_worker` for Chrome + `scripts` for Firefox), `permissions: ["storage"]`, `host_permissions: ["http://localhost:11434/*"]`, `action` popup. Content scripts: `theme.css` + `spooks.css` at `document_start` (CSS only, never blocks), `spooks.js` + `content.js` at `document_idle`. |
| `content.js` | Rewrite: lazy anchor discovery, batching, messaging, validation, rendering, fallback. |
| `background.js` | New: per-tab request queue, Ollama client, prompt, schema, per-URL cache, model warm-up. |
| `spooks.js` | New: the spook catalog (id, description for the model, allowed positions, render function). |
| `theme.css` | New: dark orange/black theme. |
| `spooks.css` | New: spook element styles, fade-in and animations, all classes prefixed `spook-`. |
| `popup.html` / `popup.js` | New: on/off toggle, model name, intensity, Ollama status, "re-spook" button. |
| [README.md](README.md) | Rewrite for the new extension, including Ollama setup. |

## 1. Never block the page
- No content script work at `document_start` except the static CSS. No JS ever waits on Ollama before the page renders.
- `content.js` runs at `document_idle` and defers all scanning to `requestIdleCallback` (with a `setTimeout` fallback for Firefox/Safari), in small chunks so it never causes a long task.
- All messaging is fire-and-forget: the content script sends a batch and renders whenever a reply arrives. If no reply ever arrives, the page is simply themed without model spooks.

## 2. Progressive, scroll-driven anchor discovery (content.js)
- Candidate selector: `h1–h3`, `img` larger than 100px, `p` with text, `nav`, `header`, `footer`, `article`, `button`.
- One `IntersectionObserver` with `rootMargin: "0px 0px 150% 0px"` watches candidates. Only anchors in the viewport or the next ~1.5 screens are processed. Far-down content is never sent until the user scrolls toward it.
- When an anchor enters the zone: tag it `data-spook-anchor="a12"`, collect `{id, tag, text (first 80 chars), alt}`, push it to a pending list, then unobserve it.
- Flush the pending list as a batch when it reaches 8 anchors or after 300ms of quiet, whichever comes first. Small batches keep each prompt short, so each reply is fast.
- A `MutationObserver` on `body` (debounced ~500ms) registers new candidates added by infinite scroll or SPA navigation. SPA URL changes (`popstate` plus a periodic `location.href` check) reset the anchor set.
- Budget: intensity N is a per-screen density (e.g. about N spooks per 3 viewport-heights), so long pages don't get overloaded and short pages still get spooks.

## 3. Spook catalog (spooks.js)
Each entry: `{ id, description, positions, render(text) }`. All visuals are inline SVG/emoji + CSS, so no `web_accessible_resources` are needed. Starter set:
- `ghost`: floats across near the anchor.
- `bat_swarm`: small bats flap out from the anchor.
- `spider_drop`: spider descends on a thread from the anchor's top.
- `cobweb`: corner cobweb on the anchor.
- `jack_o_lantern`: glowing pumpkin beside the anchor.
- `glowing_eyes`: pair of eyes that blink in the dark.
- `tombstone`: tombstone with a short epitaph (model supplies `text`).
- `creepy_caption`: whispered spooky caption under a heading or image (model supplies `text`).
- `blood_drip`: dripping effect on a heading.

Positions: `before`, `after`, `prepend`, `append`, `overlay` (absolute over the anchor).

## 4. Ollama call and queue (background.js)
- **Per-tab queue:** one request in flight per tab, newest batch first, because the newest batch is nearest where the user is looking. Stale batches older than ~10s are dropped. A tab closing or navigating aborts its request via `AbortController` (`chrome.tabs.onRemoved` / `onUpdated`).
- **Global concurrency of 1–2 requests.** Ollama processes them serially anyway, and this keeps the active tab responsive.
- `POST /api/chat` with `stream: false` and `format` set to a JSON schema (Ollama structured outputs), which forces valid JSON:
  ```json
  {"placements":[{"anchor":"a12","spook":"ghost","position":"after","text":"optional ≤60 chars"}]}
  ```
- **Speed settings:** `keep_alive: "30m"` so the model stays loaded; a warm-up request on extension startup and when the popup opens; `num_predict` around 200; temperature around 0.7; a short system prompt listing the catalog (id, one-line description, allowed positions) plus the batch's budget (0–3 spooks).
- **Timeout:** 15s per batch. On timeout or error, that batch falls back to local random placement.
- **Cache:** results keyed by URL + anchor text hash in `chrome.storage.session`. Revisits and back-navigation render instantly with no model call.

## 5. Validation and rendering (content.js)
- Drop any placement whose anchor isn't in the batch, whose spook isn't in the catalog, or whose position isn't allowed for that spook. Clamp to the batch budget.
- Model `text` is inserted with `textContent` only, truncated to 60 chars. Never `innerHTML`.
- **No jumping content while reading:** late arrivals must not shift what the user is looking at.
  - If the anchor is above or inside the viewport, use only `overlay` (absolutely positioned) or fixed-size inline spooks that reserve no new space.
  - In-flow positions (`before`/`after`) are used only for anchors still below the viewport.
- Render into a wrapper `<span class="spook-root">` with a CSS fade-in (opacity 0→1 over ~600ms) so spooks "materialise" instead of popping.
- `overlay` sets the anchor to `position: relative` only if it is `static`.
- `pointer-events: none` on decorative spooks so the page stays usable. Off-screen animations pause via `animation-play-state` driven by the same IntersectionObserver.
- **Offline fallback:** if Ollama is unreachable, every batch gets random valid placements locally and immediately. The popup shows "offline mode".

## 6. Dark orange/black theme (theme.css)
- Static CSS injected at `document_start`: applies at first paint with no white flash and no dependence on the model.
- CSS variables: `--spook-bg #0b0a09`, `--spook-surface #1a1410`, `--spook-text #e9e2d6`, `--spook-orange #ff7518`, `--spook-orange-dim #b34f0f`.
- `html, body` get the dark background. `body *` gets `background-color: transparent`, light text and orange-dim borders, all `!important`. Inputs/buttons get the surface colour with orange borders.
- Links and `h1–h3` in orange. `::selection` orange on black. Orange scrollbar.
- Images and videos get a mild `sepia + contrast + brightness` filter, not inverted.
- A subtle vignette overlay via `html::after` with `pointer-events: none`.
- Theme is gated by a class on `<html>` (`spookify-on`) so the popup toggle can switch it off instantly.

## 7. Popup and settings
- `chrome.storage.sync`: `enabled`, `model`, `intensity` (1–10, default 5).
- Popup shows Ollama status (reachable or not, model loaded or not) and the models `GET /api/tags` reports, so the model field can be a dropdown.
- Popup shows the current tab's queue length, which is useful during the demo to show batches being processed.

## Ollama setup note (README)
```
ollama pull llama3.2:3b
OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ollama serve
```
Ollama rejects unknown origins with 403. Setting `OLLAMA_ORIGINS` guarantees the extension's background worker is allowed.

## Build order (for hackathon time-boxing)
1. Theme CSS + manifest changes: instant visible win, zero load impact.
2. Spook catalog + IntersectionObserver batching + random fallback placement: fully working progressive demo without the model.
3. Background worker with queue + Ollama structured output call + warm-up.
4. Cache, MutationObserver/SPA support, popup, polish.

## Verification
1. **Load time:** compare a page's load time (DevTools Performance or the Network tab's "Load" figure) with the extension off, on with Ollama stopped, and on with Ollama running. All three should be within noise. No long tasks attributable to `content.js`.
2. Load unpacked in `chrome://extensions`. Visit Wikipedia, a news site and GitHub. The page goes dark orange/black at first paint and is immediately clickable and scrollable.
3. With Ollama running, watch the service worker console. Batch #1 is sent shortly after load, and spooks fade in a few seconds later. Scroll down a long article: new batches are sent only as you approach new sections.
4. While a reply is pending, keep reading near the top. Confirm nothing shifts the text in view when spooks arrive.
5. Scroll quickly to the bottom: stale batches are dropped and the batch nearest the viewport is processed first. Close a tab mid-request: its request is aborted.
6. With Ollama stopped: spooks still appear via fallback, and the popup shows offline mode.
7. On an infinite-scroll page (e.g. Reddit), new posts get spooks as they load.
8. Feed a hand-crafted bad response (unknown anchor, bogus spook id, `<script>` in text) through the validator and confirm it is dropped or rendered as plain text.
9. Toggle off in popup: theme and spooks disappear. Links and buttons stay clickable with spooks present.
10. Load as a temporary add-on in Firefox via `about:debugging` and repeat step 2.

## Implementation notes (deviations found while building)
- **Origin rule.** Ollama 0.40 rejects `chrome-extension://` origins with 403 by default. The background worker installs a session-scoped `declarativeNetRequest` rule that rewrites the Origin header to Ollama's own address, limited to requests initiated by this extension with no tab. Verified that a web page on another origin is still blocked. Firefox doesn't apply DNR to extension requests, so Firefox users still need `OLLAMA_ORIGINS`.
- **Schema.** `items` is an `anyOf` with one variant per spook (const id, allowed positions, `text` only for tombstone/caption). Falls back to the flat schema if Ollama rejects it. The validator still coerces a disallowed position to the spook's first allowed one instead of dropping the placement.
- **Speed.** Output tokens dominate (~8 tokens/s for 3B on CPU). The prompt asks for compact single-line JSON (~50 tokens instead of ~100), and the warm-up evaluates the system prompt so Ollama's prompt cache is primed. Measured 5–12s per batch on this machine.
- **Timeouts.** Request timeout raised from 15s to 25s, since a cold model load plus the first batch exceeded 15s. The page-side safety timeout is 45s.
- **Variety.** The user message includes `recently_used` (last 4 spooks on the tab) and the prompt asks for one text spook when a heading, image or footer is present. Without this the 3B model chose cobweb almost every time.
- **Disable/reset.** The content script sends `spook-cancel` so the background drops that tab's queued and in-flight batches.
- **boot.js.** The theme is on by default (`:root:not(.spookify-off)`); a tiny `document_start` script adds `spookify-off` asynchronously when disabled, so it never blocks.
