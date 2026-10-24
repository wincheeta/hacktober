# Page HTML Logger

A minimal browser extension (Manifest V3) that logs the full HTML of every page to the browser console after the page finishes loading.

## Files

- `manifest.json` – extension manifest; registers the content script on all URLs.
- `content.js` – content script that waits for the page `load` event, then logs `document.documentElement.outerHTML`.

## Running it

### Chrome / Edge / Brave

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this directory.
4. Open any web page, then open DevTools (F12) and go to the **Console** tab. You'll see a `[Page HTML Logger]` entry containing the page's HTML.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this directory.
3. Open any web page, then open the Web Console (Ctrl+Shift+K) to see the logged HTML.

Temporary add-ons are removed when Firefox restarts; repeat step 2 to load it again.

## Developing

There is no build step — edit the files directly.

- After changing `content.js`, reload the extension (the ↻ button on `chrome://extensions`, or **Reload** on `about:debugging` in Firefox), then refresh the page you're testing.
- After changing `manifest.json`, reload the extension the same way. If the manifest is invalid, the browser shows the error on the extensions page.
- Content script output appears in the **page's** console, not the extension's service worker console.
- Content scripts don't run on browser-internal pages such as `chrome://` URLs, `about:` pages or the Chrome Web Store, so test on a normal website.
- The `browser_specific_settings.gecko.id` in the manifest is only used by Firefox; Chrome ignores it (and may show a harmless warning about it).
