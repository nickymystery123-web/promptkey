/* Edit history (3C-3A §7) — PURE functions, no DOM, no side effects.
   The application-level undo/redo stack for the Composer.

   Why not browser-native Ctrl+Z: Voice appends, Thought USE, Inbox ADD and
   other programmatic Composer writes corrupt the native undo stack. This
   module owns an explicit history instead.

   Entry shape: { value, selectionStart, selectionEnd }
   History shape: { past: Entry[], present: Entry, baseline: Entry,
                    future: Entry[], pushedAt }

   `baseline` is the creation-time entry (empty Composer, or the restored
   draft). It NEVER enters `past` — `past.length` counts USER steps only, so
   the first typing burst merges into the untouched baseline without creating
   a step ("Hello" + Undo → "", one step, §7.3).

   Rules (FINAL product contract):
     · typing entries pushed within the coalesce window (~500ms) MERGE into one
       step ("Hello" + Undo → ""), per §7.3
     · programmatic writes (voice append / USE / ADD) ALWAYS form an independent
       step, per §7.4 — they never take the baseline-merge or time-coalesce path
     · any new push clears the redo future (§7.7)
     · UNDO can always return to the baseline (§7.2 recoverable) */

export const COALESCE_MS = 500;

export function createHistory(value = "", now = 0) {
  const v = typeof value === "string" ? value : "";
  const entry = { value: v, selectionStart: v.length, selectionEnd: v.length };
  return {
    past: [],
    present: entry,
    baseline: entry,
    future: [],
    pushedAt: now
  };
}

export function canUndo(history) {
  return !!history
    && (history.past.length > 0 || history.present !== history.baseline);
}

export function canRedo(history) {
  return !!history && history.future.length > 0;
}

/* Push a new entry. `programmatic` disables coalescing (independent step).
   Returns the same object when nothing changed (entry equals present). */
export function pushEntry(history, entry, { programmatic = false, now = Date.now() } = {}) {
  if (!entry || typeof entry.value !== "string") return history;
  if (!history) return createHistory(entry.value, now);
  const normalized = {
    value: entry.value,
    selectionStart: typeof entry.selectionStart === "number" ? entry.selectionStart : entry.value.length,
    selectionEnd: typeof entry.selectionEnd === "number" ? entry.selectionEnd : entry.value.length
  };
  if (normalized.value === history.present.value) return history; // no-op edit
  // First USER typing on an untouched baseline merges into it — the baseline
  // never becomes a past step (§7.3). Programmatic writes are excluded (§7.4).
  const atBaseline = !programmatic
    && history.past.length === 0
    && history.present === history.baseline;
  const timeCoalesce = !programmatic
    && typeof history.pushedAt === "number"
    && (now - history.pushedAt) >= 0
    && (now - history.pushedAt) < COALESCE_MS;
  if (atBaseline || timeCoalesce) {
    // merge into the current step: present is replaced, past untouched.
    // New content always clears the redo future (§7.7).
    return { ...history, present: normalized, future: [], pushedAt: now };
  }
  return {
    past: history.past.concat([history.present]),
    present: normalized,
    baseline: history.baseline,
    future: [], // new edit clears the redo stack (§7.7)
    pushedAt: now
  };
}

/* Undo → { history, entry } | null (nothing to undo).
   Pops the last user step; when no step exists but the text drifted from the
   baseline (first typing burst), UNDO returns to the baseline itself. */
export function undo(history) {
  if (!canUndo(history)) return null;
  if (history.past.length > 0) {
    const past = history.past.slice(0, -1);
    const present = history.past[history.past.length - 1];
    return {
      history: {
        past,
        present,
        baseline: history.baseline,
        future: [history.present].concat(history.future),
        pushedAt: 0
      },
      entry: present
    };
  }
  return {
    history: {
      past: [],
      present: history.baseline,
      baseline: history.baseline,
      future: [history.present].concat(history.future),
      pushedAt: 0
    },
    entry: history.baseline
  };
}

/* Redo → { history, entry } | null (nothing to redo). */
export function redo(history) {
  if (!canRedo(history)) return null;
  const future = history.future.slice(1);
  const present = history.future[0];
  // when we are sitting on the baseline (undone the first burst), redo must
  // not push the baseline into past — undo stays "return to baseline"
  const past = history.present !== history.baseline
    ? history.past.concat([history.present])
    : history.past;
  return {
    history: { past, present, baseline: history.baseline, future, pushedAt: 0 },
    entry: present
  };
}
