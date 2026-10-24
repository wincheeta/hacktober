// Prompts and JSON schemas for the Ollama requests made by background.js.
// Loaded before background.js (manifest "scripts" in Firefox, importScripts in Chrome).
self.SpookifyPrompts = (() => {
  "use strict";
  const S = self.Spookify;

  // Output tokens dominate latency on CPU (~7 tokens/s for a 3B model), so
  // replies use one-letter keys and leave out `p` when a spook has only one
  // position: about 36 tokens for three placements instead of 55. A shorter
  // prompt also keeps an uncached first request (~40 prompt tokens/s) quick.
  const shortDescription = (d) => d.replace(/ \(good for[^)]*\)/, "");
  const SYSTEM_PROMPT = [
    "You decorate web pages for Halloween. You get a few page elements (anchors) near where the user is reading.",
    "Pick at most `budget` anchors and give each a different spook that suits it.",
    "Spooks (id: look [positions], possess = changes the element itself):",
    ...S.catalog.map((s) => {
      const where = s.positions.length > 1 ? ` [${s.positions.join(",")}]` : s.positions[0] === "possess" ? " [possess]" : "";
      return `- ${s.id}: ${shortDescription(s.description)}${where}`;
    }),
    "Rules: avoid spooks in `recently_used`; include one creepy_caption for a heading, image or footer; include one possess spook when the budget allows.",
    `\`t\` (only ${S.catalog.filter((s) => s.needsText).map((s) => s.id).join(", ")}): a playful, family-friendly line of at most 8 words that riffs on the anchor's text.`,
    "If `rewrites` is above 0, also rewrite up to that many h1/h2/h3 anchors into a spooky version of the same idea, about the same length.",
    "Reply as compact JSON. a=anchor, s=spook, p=position (only for spooks with several positions), t=text. Example:",
    '{"placements":[{"a":"a3","s":"ghost"},{"a":"a9","s":"creepy_caption","p":"after","t":"Here lies the comment section"}],"rewrites":[{"a":"a2","t":"The Price of Your Soul"}]}',
  ].join("\n");

  const WORDS_PROMPT = [
    "You rename everyday web page words into Halloween words.",
    "You get the page title, a list of common words from the page, and `count`.",
    "Pick up to `count` words from the list and give each a spooky, family-friendly replacement of one or two words",
    "that keeps the same part of speech and still makes sense in a sentence (cart -> coffin, search -> seance, team -> coven).",
    "Every replacement must be clearly Halloween: ghosts, graves, bones, witches, potions, monsters, curses. Never a plain synonym.",
    "Prefer words that are easy to spot on the page: navigation, buttons, nouns from headings.",
    "Use only words from the list. Reply as compact JSON, f=from, t=to, for example:",
    '{"swaps":[{"f":"cart","t":"coffin"},{"f":"login","t":"summon"}]}',
  ].join("\n");

  // Skeletor's chat box (modules/skeletor.js).
  const SKELETOR_PROMPT = [
    "You are Skeletor, the cackling skull-faced villain from Snake Mountain, haunting a web page for Halloween.",
    'Stay in character: theatrical, boastful and cartoonishly insulting ("Fool!", "you miserable worm"), scheming to defeat He-Man and seize Castle Grayskull, and fond of gloomy, depressing facts.',
    "Keep it family-friendly: no swearing, no real threats, nothing cruel about real people.",
    "Reply in at most three short sentences of plain text: no markdown, no emoji, no stage directions.",
  ].join("\n");

  // Preferred schema: one variant per spook, so positions are always valid and
  // only text spooks can carry text. `flat` is the fallback for Ollama builds
  // that reject anyOf (background.js decides when).
  function buildSchema(ids, budget, headingIds, rewrites, flat) {
    const a = { type: "string", enum: ids };
    const items = flat
      ? {
          type: "object",
          properties: {
            a,
            s: { type: "string", enum: S.catalog.map((s) => s.id) },
            p: { type: "string", enum: S.POSITIONS },
            t: { type: "string" },
          },
          required: ["a", "s"],
        }
      : {
          anyOf: S.catalog.map((s) => {
            const properties = { a, s: { type: "string", const: s.id } };
            const required = ["a", "s"];
            if (s.positions.length > 1) {
              properties.p = { type: "string", enum: s.positions };
              required.push("p");
            }
            if (s.needsText) {
              properties.t = { type: "string", maxLength: S.MAX_TEXT };
              required.push("t");
            }
            return { type: "object", properties, required, additionalProperties: false };
          }),
        };
    const properties = { placements: { type: "array", maxItems: budget, items } };
    if (rewrites > 0 && headingIds.length) {
      properties.rewrites = {
        type: "array",
        maxItems: rewrites,
        items: {
          type: "object",
          properties: { a: { type: "string", enum: headingIds }, t: { type: "string", maxLength: S.MAX_TEXT } },
          required: ["a", "t"],
        },
      };
    }
    return { type: "object", properties, required: ["placements"] };
  }

  function wordsSchema(words, count) {
    return {
      type: "object",
      properties: {
        swaps: {
          type: "array",
          maxItems: count,
          items: {
            type: "object",
            properties: {
              f: { type: "string", enum: words },
              t: { type: "string", maxLength: S.MAX_SWAP_TEXT },
            },
            required: ["f", "t"],
          },
        },
      },
      required: ["swaps"],
    };
  }

  // Expand the model's one-letter keys into the names the validators use.
  function expandReply(parsed) {
    const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
    return {
      placements: list(parsed.placements).map((p) => ({ anchor: p.a, spook: p.s, position: p.p, text: p.t })),
      rewrites: list(parsed.rewrites).map((r) => ({ anchor: r.a, text: r.t })),
      swaps: list(parsed.swaps).map((w) => ({ from: w.f, to: w.t })),
    };
  }

  function parseJson(content) {
    try {
      return JSON.parse(content);
    } catch {
      const match = /\{[\s\S]*\}/.exec(content || "");
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
  }

  return { SYSTEM_PROMPT, WORDS_PROMPT, SKELETOR_PROMPT, buildSchema, wordsSchema, expandReply, parseJson };
})();
