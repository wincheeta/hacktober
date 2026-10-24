// Logs the page's full HTML once the page has finished loading.
function logPageHtml() {
  console.log("[Page HTML Logger]", document.documentElement.outerHTML);
}

// document_idle can run before or after the load event, so handle both.
if (document.readyState === "complete") {
  logPageHtml();
} else {
  window.addEventListener("load", logPageHtml, { once: true });
}
