// Moodle removal: strips links, images and text mentioning moodle.ecs.soton.ac.uk.
// Loaded as a content script before content.js, which calls grepAndRemove()
// on the page and on content added later.
self.SpookyMoodle = (() => {
  "use strict";

  // Our own spooks are left alone.
  function isOurs(node) {
    return !!(node.closest && node.closest(".spook-root, #spook-layer"));
  }

  // Grep for any mention within the HTML of "moodle.ecs.soton.ac.uk" and remove it.
  const MOODLE_PATTERN = /moodle\.ecs\.soton\.ac\.uk/i;
  const MOODLE_GLOBAL = /moodle\.ecs\.soton\.ac\.uk/gi;

  function grepAndRemove(rootNode = document.body) {
    if (!rootNode || !rootNode.isConnected) return;

    // Check if rootNode itself is a matching link/resource element
    if (rootNode.matches && rootNode.matches("a, img, iframe, form, [data-url], [data-href]") && !isOurs(rootNode)) {
      const target =
        (rootNode.getAttribute("href") || "") +
        " " +
        (rootNode.getAttribute("src") || "") +
        " " +
        (rootNode.getAttribute("action") || "") +
        " " +
        (rootNode.getAttribute("data-url") || "") +
        " " +
        (rootNode.getAttribute("data-href") || "");
      if (MOODLE_PATTERN.test(target)) {
        rootNode.remove();
        return;
      }
    }

    // 1. Remove elements whose links/attributes mention moodle.ecs.soton.ac.uk
    if (rootNode.querySelectorAll) {
      rootNode.querySelectorAll("a, img, iframe, form, [data-url], [data-href]").forEach((el) => {
        if (isOurs(el)) return;
        const target =
          (el.getAttribute("href") || "") +
          " " +
          (el.getAttribute("src") || "") +
          " " +
          (el.getAttribute("action") || "") +
          " " +
          (el.getAttribute("data-url") || "") +
          " " +
          (el.getAttribute("data-href") || "");
        if (MOODLE_PATTERN.test(target)) el.remove();
      });

      // Also clean up any mentions in title, alt, or aria-label attributes
      rootNode.querySelectorAll("[title], [alt], [aria-label]").forEach((el) => {
        if (isOurs(el)) return;
        for (const attr of ["title", "alt", "aria-label"]) {
          const val = el.getAttribute(attr);
          if (val && MOODLE_PATTERN.test(val)) {
            el.setAttribute(attr, val.replace(MOODLE_GLOBAL, ""));
          }
        }
      });
    }

    // 2. Grep text nodes for any text mention and remove it
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
    const toClean = [];
    let n;
    while ((n = walker.nextNode())) {
      if (MOODLE_PATTERN.test(n.nodeValue)) {
        toClean.push(n);
      }
    }

    for (const textNode of toClean) {
      textNode.nodeValue = textNode.nodeValue.replace(MOODLE_GLOBAL, "");
      let parent = textNode.parentElement;
      while (
        parent &&
        !parent.textContent.trim() &&
        !isOurs(parent) &&
        parent !== document.body &&
        parent !== document.documentElement
      ) {
        const next = parent.parentElement;
        parent.remove();
        parent = next;
      }
    }
  }

  return { grepAndRemove };
})();
