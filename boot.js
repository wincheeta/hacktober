// Runs at document_start. It never blocks: the theme is static CSS that is
// already applied, and this only switches it off (asynchronously) when the
// user has disabled Spookify in the popup.
chrome.storage.sync
  .get({ enabled: true })
  .then((s) => {
    if (!s.enabled) document.documentElement.classList.add("spookify-off");
  })
  .catch(() => {});
