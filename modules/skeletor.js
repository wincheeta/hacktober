// Skeletor: the corner widget with a depressing fact, and his chat box.
// Loaded as a content script before content.js, which calls init() once and
// show() / reset() as pages are spooked and cleared. Chat replies come from
// Ollama via background.js ("skeletor-chat").
self.SpookySkeletor = (() => {
  "use strict";

  // From content.js: isLive(gen) - is that spook generation still current;
  // dragMode() - is "Move spooks by dragging" on; ask(message, timeoutMs).
  let hooks = null;

  function init(h) {
    hooks = h;
  }

  const DEPRESSING_FACTS = [
    "Every atom in your body came from an exploding star, just to end up sitting here scrolling.",
    "In about 5 billion years, the Sun will expand and boil Earth's oceans, erasing all evidence of humanity.",
    "You have already met almost everyone who will ever genuinely remember your existence.",
    "One day, someone will say your name out loud for the very last time, and then you'll be completely forgotten.",
    "Sharks are older than trees, Saturn's rings, and any sense of accomplishment you felt today.",
    "Over 99% of all species that have ever lived on Earth are now extinct. We're on the list!",
    "Your skeleton is completely wet right now, and it will remain so until long after you're gone.",
    "There are over 3 trillion trees on Earth, and not a single one cares about your deadlines.",
    "Sloths sometimes mistake their own arms for tree branches, grab them, and plunge to their doom.",
    "Your brain decides what you do up to 10 seconds before you are even aware of making the decision.",
    "Every second, your cells accumulate mutations that your body will eventually fail to repair.",
    "The universe is expanding into a freezing, completely silent void of eternal nothingness.",
    "One day, your parents put you down as a child and never picked you up again.",
    "Somewhere on the calendar is the anniversary of your death, and you pass it every year without knowing.",
    "In about 4.5 billion years, Andromeda will collide with the Milky Way, dismantling the solar system.",
    "Elephants will mourn other elephants in their group dying and will hold funerals for them and will even recognize the bones of said elephant and cry out in sadness",
    "Your dog will mourn you when you die, but your cats will be indifferent",
    "You share 50% of your DNA with a banana",
    "Your body contains more bacterial cells than human cells",
    "There is a single whale that is unable to communicate with any other whale of it's kind due to different frequencies",
    "if a sheep is not sheared, it will be weighed down and eventually fall over, and ends up starving to death",
    "Many people go through the last years of their life sad and chronically lonely",
    "Every 60 seconds, a minute passes - Ali",
    "If a panda has more than one cub, she often cannot care for both of the babies, and must choose one to survive.",
    "If you die alone at home, your pet cat will likely start to devour your body to survive"
  ];

  function showSkeletor(myGen) {
    if (!hooks.isLive(myGen) || !document.body) return;
    if (document.getElementById("spook-skeletor")) return;

    let gifUrl;
    try {
      gifUrl = chrome.runtime.getURL("Pictures/skeletor.gif");
    } catch {
      return;
    }

    const container = document.createElement("div");
    container.id = "spook-skeletor";
    container.className = "spook-root spook-skeletor-container";

    const bubble = document.createElement("div");
    bubble.className = "spook-skeletor-bubble";

    const fact = document.createElement("p");
    fact.className = "spook-skeletor-fact";
    fact.textContent = DEPRESSING_FACTS[Math.floor(Math.random() * DEPRESSING_FACTS.length)];

    const signoff = document.createElement("div");
    signoff.className = "spook-skeletor-signoff";
    signoff.textContent = "— Until we meet again!";

    bubble.appendChild(fact);
    bubble.appendChild(signoff);

    const img = document.createElement("img");
    img.className = "spook-skeletor-img";
    img.src = gifUrl;
    img.alt = "Skeletor";
    img.title = "Talk to Skeletor";
    // A native image drag (from the slightest wobble) would swallow the click.
    img.draggable = false;

    // He or his bubble opens the chat.
    container.addEventListener("click", () => {
      if (!hooks.dragMode()) toggleSkeletorChat(); // in drag mode a click is part of a drag
    });

    container.appendChild(bubble);
    container.appendChild(img);

    document.body.appendChild(container);
  }

  // ---------- Skeletor chat ----------
  // Clicking Skeletor opens a chat box in his corner. content.js keeps the box
  // out of drag mode (see onPointerDown).

  const CHAT_REPLY_TIMEOUT_MS = 65000; // > background's CHAT_TIMEOUT_MS
  const CHAT_GREETING = "Speak, you miserable worm! What does a fool like you want with Skeletor?";
  let chatHistory = []; // [{ role, content }], the greeting first
  let chatBusy = false;
  let chatError = "";
  let chatGen = 0; // bumped by reset(), so a reply to a cleared chat is dropped

  function toggleSkeletorChat() {
    if (document.getElementById("spook-skeletor-chat")) closeSkeletorChat();
    else openSkeletorChat();
  }

  // The chat box takes Skeletor's corner while it's open.
  function closeSkeletorChat() {
    const panel = document.getElementById("spook-skeletor-chat");
    if (panel) panel.remove();
    const skeletor = document.getElementById("spook-skeletor");
    if (skeletor) skeletor.classList.remove("spook-skeletor-hidden");
  }

  function chatAvatar(path) {
    try {
      return chrome.runtime.getURL(path);
    } catch {
      return ""; // extension reloaded
    }
  }

  function openSkeletorChat() {
    if (!chatHistory.length) chatHistory.push({ role: "assistant", content: CHAT_GREETING });

    const panel = document.createElement("div");
    panel.id = "spook-skeletor-chat";
    panel.className = "spook-root spook-skeletor-chat";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Chat with Skeletor");

    const header = document.createElement("div");
    header.className = "spook-chat-header";
    const title = document.createElement("span");
    title.textContent = "Skeletor";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "spook-chat-close";
    close.setAttribute("aria-label", "Close chat");
    close.textContent = "×";
    close.addEventListener("click", closeSkeletorChat);
    header.append(title, close);

    const log = document.createElement("div");
    log.className = "spook-chat-log";
    log.setAttribute("aria-live", "polite");

    const form = document.createElement("form");
    form.className = "spook-chat-form";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "spook-chat-input";
    input.placeholder = "Say something, fool…";
    input.maxLength = 500;
    input.autocomplete = "off";
    const send = document.createElement("button");
    send.type = "submit";
    send.className = "spook-chat-send";
    send.textContent = "Send";
    form.append(input, send);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || chatBusy) return;
      input.value = "";
      sendChat(text);
    });

    // Keep typing away from page shortcuts (YouTube's k, j, / and so on).
    for (const type of ["keydown", "keyup", "keypress"]) {
      panel.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === "keydown" && e.key === "Escape") closeSkeletorChat();
      });
    }

    panel.append(header, log, form);
    makeChatResizable(panel);
    document.body.appendChild(panel);
    const skeletor = document.getElementById("spook-skeletor");
    if (skeletor) skeletor.classList.add("spook-skeletor-hidden");
    renderChat();
    input.focus();
  }

  // Grip in the top-right corner. The box is pinned bottom-left, so it grows up
  // and to the right. The size is kept in storage.local for every page.
  const CHAT_MIN_W = 240;
  const CHAT_MIN_H = 260;
  let chatSize = null; // { w, h } in px, once the user has resized

  function applyChatSize(panel, size) {
    const w = Math.round(Math.min(Math.max(size.w, CHAT_MIN_W), window.innerWidth - 32));
    const h = Math.round(Math.min(Math.max(size.h, CHAT_MIN_H), window.innerHeight - 32));
    // Important, to beat the stylesheet's own !important size.
    panel.style.setProperty("width", `${w}px`, "important");
    panel.style.setProperty("height", `${h}px`, "important");
    return { w, h };
  }

  function makeChatResizable(panel) {
    if (chatSize) applyChatSize(panel, chatSize);
    else {
      try {
        chrome.storage.local
          .get("chatSize")
          .then(({ chatSize: saved }) => {
            if (chatSize || !saved || !Number.isFinite(saved.w) || !Number.isFinite(saved.h)) return;
            chatSize = applyChatSize(panel, saved);
          })
          .catch(() => {});
      } catch {
        // extension reloaded
      }
    }

    const grip = document.createElement("div");
    grip.className = "spook-chat-resize";
    grip.title = "Drag to resize";
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, w: panel.offsetWidth, h: panel.offsetHeight };
      const move = (ev) => {
        chatSize = applyChatSize(panel, { w: start.w + ev.clientX - start.x, h: start.h - (ev.clientY - start.y) });
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        try {
          if (chatSize) chrome.storage.local.set({ chatSize }).catch(() => {});
        } catch {
          // extension reloaded: nowhere to save
        }
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });
    panel.append(grip);
  }

  function renderChat() {
    const panel = document.getElementById("spook-skeletor-chat");
    if (!panel) return;
    const log = panel.querySelector(".spook-chat-log");
    const botIcon = chatAvatar("Pictures/skeletor-head.webp");
    const userIcon = chatAvatar("Pictures/default-user.webp");
    const line = (cls, text) => Object.assign(document.createElement("div"), { className: `spook-chat-msg ${cls}`, textContent: text });
    // A message bubble with its sender's picture beside it.
    const row = (user, text, extra = "") => {
      const r = document.createElement("div");
      r.className = `spook-chat-row ${user ? "spook-chat-row-user" : "spook-chat-row-bot"}`;
      const icon = Object.assign(document.createElement("img"), { className: "spook-chat-avatar", src: user ? userIcon : botIcon, alt: "" });
      r.append(icon, line(`${user ? "spook-chat-user" : "spook-chat-bot"} ${extra}`, text));
      return r;
    };
    log.replaceChildren(...chatHistory.map((m) => row(m.role === "user", m.content)));
    if (chatBusy) log.append(row(false, "Skeletor is scheming…", "spook-chat-pending"));
    if (chatError) log.append(line("spook-chat-error", chatError));
    log.scrollTop = log.scrollHeight;
    panel.querySelector(".spook-chat-send").disabled = chatBusy;
  }

  async function sendChat(text) {
    const myGen = chatGen;
    chatHistory.push({ role: "user", content: text });
    chatBusy = true;
    chatError = "";
    renderChat();
    // The greeting stays local; the model gets the real conversation.
    const reply = await hooks.ask({ type: "skeletor-chat", messages: chatHistory.slice(1) }, CHAT_REPLY_TIMEOUT_MS);
    if (myGen !== chatGen) return; // the chat was cleared meanwhile
    chatBusy = false;
    if (reply && reply.status === "ok" && reply.reply) {
      chatHistory.push({ role: "assistant", content: reply.reply });
    } else {
      chatError = `Skeletor is silent. ${(reply && reply.error) || "Is Ollama running?"}`;
    }
    renderChat();
  }

  // Forget the conversation (the page was re-spooked or left).
  function reset() {
    chatGen++;
    chatHistory = [];
    chatBusy = false;
    chatError = "";
  }

  return { init, show: showSkeletor, reset };
})();
