/* Keyboard shortcut predicates (3C-3B §8.4). Pure functions over keyboard
   events — no DOM, no state — so they are unit-testable and shared by the
   single binding site in main.js. */

/* Voice toggle: Ctrl/Cmd + Shift + M.
   - e.repeat guard: holding the keys must not toggle repeatedly (UI-14).
   - modifier combo never produces text, so Composer content is never
     corrupted even when the textarea is focused (UI-15). */
export function isVoiceToggleShortcut(e) {
  if (!e || e.repeat) return false;
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return false;
  return String(e.key || "").toLowerCase() === "m";
}

/* Platform-appropriate hint label: ⌘⇧M on macOS, Ctrl+Shift+M elsewhere. */
export function voiceShortcutHint(platformish) {
  return /mac|iphone|ipad/i.test(String(platformish || "")) ? "⌘⇧M" : "Ctrl+Shift+M";
}
