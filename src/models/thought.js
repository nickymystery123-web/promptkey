/* Thought — one idea captured in the Creative Inbox (Phase 3C-2A).
   Lives in state.inbox.thoughts[] — independent of the single prompt session,
   so capturing ideas never blocks on AI or on the active prompt.

   originalText is ALWAYS preserved byte-for-byte. refinedText (if present) is a
   separate, derived copy produced asynchronously — it never overwrites the
   original. source: "voice" | "text". */

let counter = 0;

export function createThought(text, source, now) {
  counter += 1;
  const t = now || Date.now();
  const ts = new Date(t).toISOString();
  return {
    id: "th-" + t.toString(36) + "-" + counter,
    originalText: typeof text === "string" ? text : "",
    refinedText: null, // set later by async refinement; never overwrites originalText
    source: source === "voice" ? "voice" : "text",
    createdAt: ts,
    updatedAt: ts
  };
}

export function withRefinedText(thought, refinedText, now) {
  if (!thought) return thought;
  return {
    ...thought,
    refinedText: typeof refinedText === "string" && refinedText.trim() ? refinedText : null,
    updatedAt: new Date(now || Date.now()).toISOString()
  };
}

/* Edit rewrites originalText in place (keeps id, does not spawn a new thought,
   does not touch other thoughts, never triggers AI). */
export function withOriginalText(thought, text, now) {
  if (!thought) return thought;
  return {
    ...thought,
    originalText: typeof text === "string" ? text : "",
    updatedAt: new Date(now || Date.now()).toISOString()
  };
}

/* Which text to copy / send for a given variant ("original" | "refined"). */
export function thoughtCopyText(thought, variant) {
  if (!thought) return "";
  if (variant === "refined" && thought.refinedText) return thought.refinedText;
  return thought.originalText;
}

/* Summary metadata for collapse preview (first ~128 words). */
export function thoughtPreview(thought, maxWords = 128) {
  if (!thought) return "";
  const words = thought.originalText.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return thought.originalText;
  return words.slice(0, maxWords).join(" ") + "…";
}
