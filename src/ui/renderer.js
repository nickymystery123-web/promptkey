/* Renderer — the ONLY module that writes to the DOM (besides window-manager's
   positioning). Pure projection: state → pixels. All interactions dispatch actions. */

import { act } from "../state/actions.js";
import {
  effectiveStatus, statusLabel, inboxThoughts, canRefine, canConfirm,
  draftBadgeLabel, draftSavedLabel, canUndoInput, canRedoInput, aiModeLabel
} from "../state/selectors.js";
import { thoughtCopyText } from "../models/thought.js";

export function collectRefs(doc) {
  const $ = (id) => doc.getElementById(id);
  return {
    float: $("pk-float"),
    dragHandle: $("pk-drag-handle"),
    statusLabel: $("pk-status-label"),
    minBtn: $("pk-min-btn"),
    closeBtn: $("pk-close-btn"),
    workspace: $("pk-workspace"),
    input: $("pk-input"),
    transcript: $("pk-transcript"),
    transcriptLabel: $("pk-transcript-label"),
    transcriptText: $("pk-transcript-text"),
    voiceCancel: $("pk-voice-cancel"),
    msg: $("pk-workspace-msg"),
    voice: $("pk-voice"),
    voiceCaption: $("pk-voice-caption"),
    refine: $("pk-refine"),
    submit: $("pk-submit"),
    aiMode: $("pk-ai-mode"),
    draftBadge: $("pk-draft-badge"),
    draftSaved: $("pk-draft-saved"),
    undo: $("pk-undo"),
    redo: $("pk-redo"),
    minimized: $("pk-minimized"),
    toast: $("pk-toast"),
    inbox: $("pk-inbox"),
    inboxToggle: $("pk-inbox-toggle"),
    inboxClear: $("pk-inbox-clear"),
    inboxCount: $("pk-inbox-count"),
    inboxBody: $("pk-inbox-body"),
    inboxList: $("pk-inbox-list"),
    idleView: $("pk-view-idle")
  };
}

export function createRenderer(refs, store) {
  let msgTimer = null;
  let toastTimer = null;
  let lastTrigger = null; // element to return focus to after close
  let copyFlow = null;    // 3E: copyThoughtToClipboard from flows
  let submitAnimTimer = null;
  let thoughtEnterTimer = null;
  let prevInboxCount = 0;

  function bindFlows(flows) {
    copyFlow = flows.copyThoughtToClipboard;
  }

  function setLastTrigger(el) { lastTrigger = el; }

  /* ---- live voice transcript preview ----
     3D-RC2 GATE B: the live words now surface directly in the Composer, so
     while LISTENING this panel keeps only the status line + CANCEL. During
     PROCESSING (after an explicit stop) it recaps the final transcript.
     Interim text is preview-only and never reaches the AI backend. */
  function renderVoice(state) {
    // 3E: no small LISTENING line — the prominent voice-button breathing ring
    // is the only listening cue. Keep the panel for the processing recap only.
    const active = state.voice === "processing";
    refs.transcript.hidden = !active;
    if (!active) return;
    refs.transcriptLabel.textContent = "PROCESSING";
    refs.transcriptText.hidden = false;
    const t = state.voiceTranscript;
    refs.transcriptText.textContent = t && t.text ? t.text : "";
    refs.transcriptText.classList.toggle("interim", !!(t && t.text && !t.final));
    refs.transcriptText.classList.toggle("empty", !(t && t.text));
  }

  /* ---- Creative Inbox (3E simplified) ----
     Constant presence inside the workspace. Capture is local & instant —
     the inbox never calls AI on add/edit/delete/copy/expand, so it never
     blocks the active prompt session. Refined text (if present) is shown
     separately and never masks the original. */
  function fmtThoughtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function renderInbox(state) {
    const thoughts = inboxThoughts(state);
    const count = thoughts.length;
    const open = state.inbox && state.inbox.open === true;

    refs.inbox.dataset.open = open ? "1" : "0";
    refs.inbox.dataset.count = String(count);
    refs.inboxToggle.setAttribute("aria-expanded", open ? "true" : "false");
    refs.inboxBody.hidden = !open;
    refs.inboxCount.hidden = count === 0;
    refs.inboxCount.textContent = count;
    refs.inboxClear.hidden = !open || count === 0;

    // Rebuild when identity / text / refined presence changes.
    const listKey = thoughts.map((t) =>
      t.id + ":" + (t.originalText || "").length + ":" + (t.refinedText ? "r" : "-") + ":" + (t.long ? "l" : "-")
    ).join("|") + ":" + (open ? "1" : "0");
    if (editingThoughtId && thoughts.some((t) => t.id === editingThoughtId)) return;
    if (listKey === refs.inbox._listKey) return;
    refs.inbox._listKey = listKey;

    refs.inboxList.textContent = "";

    if (!count) {
      const empty = document.createElement("p");
      empty.className = "pk-inbox-empty";
      empty.textContent = "Ideas you capture live here.";
      refs.inboxList.appendChild(empty);
      return;
    }

    /* 3E simplified Thought card:
       · Default shows refined (optimized) text.
       · Toggle to original when refined exists.
       · Click body to edit the currently displayed version.
       · COPY + DELETE are hover-only. */
    const prevCount = refs.inbox._count || 0;
    refs.inbox._count = count;
    const shouldEnter = count > prevCount && prevCount > 0; // animate new arrivals (skip first paint)
    thoughts.forEach((t, index) => {
      const hasRefined = !!t.refinedText;
      const card = document.createElement("div");
      card.className = "pk-thought" + (t.long ? " long" : "");
      card.dataset.id = t.id;
      card.dataset.mode = hasRefined ? "refined" : "original";

      if (t.long) {
        const docTag = document.createElement("div");
        docTag.className = "pk-thought-doc";
        const title = document.createElement("span");
        title.className = "pk-thought-doc-title";
        title.textContent = "LONG DOCUMENT";
        const size = document.createElement("span");
        size.className = "pk-thought-doc-size";
        size.textContent = (t.chars || 0).toLocaleString() + " chars";
        docTag.appendChild(title);
        docTag.appendChild(size);
        card.appendChild(docTag);
      }

      let body;
      if (hasRefined) {
        const toggle = document.createElement("div");
        toggle.className = "pk-thought-toggle";
        const optBtn = document.createElement("button");
        optBtn.type = "button";
        optBtn.className = "pk-toggle-btn on";
        optBtn.textContent = "优化后";
        const origBtn = document.createElement("button");
        origBtn.type = "button";
        origBtn.className = "pk-toggle-btn";
        origBtn.textContent = "优化前";
        body = document.createElement("p");
        body.className = "pk-thought-body";
        body.textContent = t.refinedText;
        const setMode = (mode) => {
          card.dataset.mode = mode;
          optBtn.classList.toggle("on", mode === "refined");
          origBtn.classList.toggle("on", mode === "original");
          body.textContent = mode === "refined" ? t.refinedText : t.originalText;
        };
        optBtn.addEventListener("click", () => setMode("refined"));
        origBtn.addEventListener("click", () => setMode("original"));
        toggle.appendChild(optBtn);
        toggle.appendChild(origBtn);
        card.appendChild(toggle);
      } else {
        body = document.createElement("p");
        body.className = "pk-thought-body";
        body.textContent = t.originalText;
      }

      body.setAttribute("role", "button");
      body.setAttribute("tabindex", "0");
      body.setAttribute("aria-label", "Edit thought");
      body.title = "点击编辑";
      const beginEdit = () => startThoughtEdit(t.id, body);
      body.addEventListener("click", beginEdit);
      body.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); beginEdit(); }
      });
      card.appendChild(body);

      const foot = document.createElement("div");
      foot.className = "pk-thought-foot";
      const meta = document.createElement("span");
      meta.className = "pk-thought-meta";
      const time = document.createElement("span");
      time.className = "pk-thought-time";
      time.textContent = fmtThoughtTime(t.updatedAt);
      meta.appendChild(time);
      foot.appendChild(meta);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "pk-thought-delete";
      del.setAttribute("aria-label", "Delete thought");
      del.textContent = "×";
      del.addEventListener("click", () => store.dispatch(act.inboxDelete(t.id)));
      foot.appendChild(del);

      // COPY button (hover-only, copies the currently displayed variant)
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "pk-thought-copy";
      copyBtn.setAttribute("aria-label", "Copy thought");
      copyBtn.textContent = "COPY";
      copyBtn.addEventListener("click", () => {
        const mode = card.dataset.mode || (t.refinedText ? "refined" : "original");
        if (copyFlow) copyFlow(t.id, mode);
      });
      foot.appendChild(copyBtn);

      card.appendChild(foot);
      if (shouldEnter && index === thoughts.length - 1) {
        card.classList.add("pk-thought-enter");
        clearTimeout(thoughtEnterTimer);
        thoughtEnterTimer = setTimeout(() => card.classList.remove("pk-thought-enter"), 360);
      }
      refs.inboxList.appendChild(card);
    });
  }

  /* ---- inline thought editor (edit → textarea → save/cancel) ---- */
  let editingThoughtId = null;
  function startThoughtEdit(id, bodyEl) {
    editingThoughtId = id;
    const card = bodyEl && bodyEl.closest(".pk-thought");
    if (!card) return;
    const t = inboxThoughts(store.getState()).find((thought) => thought.id === id);
    if (!t) return;
    const mode = card.dataset.mode || (t.refinedText ? "refined" : "original");
    const text = mode === "refined" ? (t.refinedText || t.originalText) : t.originalText;
    const ta = document.createElement("textarea");
    ta.className = "pk-thought-edit-ta";
    ta.value = text;
    ta.rows = Math.min(6, Math.max(1, text.split("\n").length));
    ta.setAttribute("aria-label", "Edit thought");
    bodyEl.replaceWith(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      editingThoughtId = null;
      const next = (ta.value || "").trim();
      if (save && next && next !== text) {
        if (mode === "refined" && t.refinedText) {
          store.dispatch(act.inboxRefine(id, next));
        } else {
          store.dispatch(act.inboxEdit(id, next));
        }
      }
      if (refs.inbox) delete refs.inbox._listKey;
    };
    ta.addEventListener("blur", () => commit(true));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); commit(false); }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(true); }
      e.stopPropagation();
    });
  }

  /* ---- transient message / toast ---- */
  function renderMessage(state) {
    if (!state.message) return;
    refs.msg.textContent = state.message.text;
    refs.msg.classList.add("on");
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => refs.msg.classList.remove("on"), 2600);
  }
  function renderToast(state) {
    if (!state.toast) return;
    refs.toast.textContent = state.toast.text;
    refs.toast.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => refs.toast.classList.remove("on"), 1800);
  }

  /* ---- main render ---- */
  function render(state, prev) {
    // window chrome
    refs.float.setAttribute("data-window", state.window);
    refs.float.setAttribute("data-status", effectiveStatus(state));
    refs.float.setAttribute("aria-hidden", state.window === "hidden" ? "true" : "false");
    refs.statusLabel.textContent = statusLabel(state);

    // workspace busy state for screen readers
    refs.workspace.setAttribute("aria-busy", (state.refinePending || state.voice === "processing") ? "true" : "false");

    // input — always mirror state (Bug #8: the old activeElement guard made
    // external state changes invisible while the Composer was focused, so the
    // DOM fell out of sync with state and the next keystroke reverted it).
    // A pure value comparison keeps the caret intact while still honoring
    // programmatic updates (voice append, REFINE results, USE take-back).
    // 3D-RC2 GATE B 边说边浮现: while LISTENING the Composer mirrors the live
    // voice preview (committed words + growing interim tail) — display-only &
    // readOnly; the machine's state.input only ever holds committed finals.
    const liveVoice = (state.voice === "listening" && state.voiceTranscript && state.voiceTranscript.text)
      ? state.voiceTranscript.text : null;
    const shownInput = liveVoice != null ? liveVoice : state.input;
    if (refs.input.value !== shownInput) {
      refs.input.value = shownInput;
    }
    if (refs.input.readOnly !== (liveVoice != null)) refs.input.readOnly = liveVoice != null;
    refs.input.classList.toggle("pk-voice-live", liveVoice != null);
    // 3C-3A §7: after UNDO/REDO the caret is restored to the entry's saved
    // selection (typing clears it in the machine — no repeated re-apply).
    if (!liveVoice && state.inputSelection && refs.input.value === state.input && refs.input.setSelectionRange) {
      try {
        refs.input.setSelectionRange(state.inputSelection.start, state.inputSelection.end);
      } catch (e) { /* detached input — skip */ }
    }

    // 3C-3A §8: draft badge (EMPTY/DRAFT/DRAFT·VOICE/DRAFT·THOUGHT) + SAVED/UNSAVED
    if (refs.draftBadge) refs.draftBadge.textContent = draftBadgeLabel(state);
    if (refs.draftSaved) {
      const savedLabel = draftSavedLabel(state);
      refs.draftSaved.hidden = !savedLabel;
      if (savedLabel) {
        refs.draftSaved.textContent = savedLabel;
        refs.draftSaved.classList.toggle("unsaved", savedLabel === "UNSAVED");
      }
    }
    // 3C-3A §7.6: undo/redo buttons — disabled state must reflect canUndo/canRedo
    if (refs.undo) refs.undo.disabled = !canUndoInput(state);
    if (refs.redo) refs.redo.disabled = !canRedoInput(state);

    // 3C-3A §5: AI mode indicator — hidden until the first AI call reveals it.
    // DEMO is always visually distinct (never masquerades as REAL).
    if (refs.aiMode) {
      const label = aiModeLabel(state);
      refs.aiMode.hidden = !label;
      if (label) {
        refs.aiMode.textContent = label;
        refs.aiMode.className = "pk-ai-mode " + (state.aiMode === "demo" ? "demo" : "real");
      }
    }

    // controls
    // 3E: bottom bar carries VOICE / REFINE / SUBMIT.
    refs.refine.disabled = !canRefine(state);
    const refinePending = !!state.refinePending;
    refs.refine.classList.toggle("pending", refinePending);
    refs.refine.classList.toggle("busy", !refinePending && state.voice === "processing");
    refs.refine.setAttribute("aria-busy", refinePending ? "true" : "false");
    refs.refine.dataset.tip = refinePending ? "REFINING…" : "REFINE → COMPOSER";
    refs.voice.classList.toggle("listening", state.voice === "listening");
    refs.float.classList.toggle("pk-listening", state.voice === "listening");
    refs.voiceCaption.textContent =
      state.voice === "listening" ? "LISTENING"
      : state.voice === "processing" ? "PROCESSING"
      : state.voice === "error" ? "RETRY"
      : "VOICE";
    refs.voice.setAttribute("aria-pressed", state.voice === "listening" ? "true" : "false");
    if (refs.submit) refs.submit.disabled = !canConfirm(state);

    // minimized bubble — Orb is the persistent desktop entry point.
    refs.minimized.hidden = state.window !== "minimized";

    // views
    renderVoice(state);
    const beforeInboxCount = Number(refs.inbox.dataset.count) || 0;
    renderInbox(state);
    const afterInboxCount = Number(refs.inbox.dataset.count) || 0;
    if (afterInboxCount > beforeInboxCount && beforeInboxCount > 0) {
      // 3E paper-suck animation: the Composer text is pulled into the Inbox.
      refs.input.classList.add("pk-submit-suck");
      clearTimeout(submitAnimTimer);
      submitAnimTimer = setTimeout(() => refs.input.classList.remove("pk-submit-suck"), 420);
    }
    if (state.message !== prev.message) renderMessage(state);
    if (state.toast !== prev.toast) renderToast(state);

    // focus management
    if (prev.window !== state.window) {
      if ((state.window === "expanded" || state.window === "focus") &&
          (prev.window === "hidden" || prev.window === "minimized" || prev.window === "launcher")) {
        if (state.interaction === "input") refs.input.focus();
        else refs.closeBtn.focus({ preventScroll: true });
      }
      if (state.window === "minimized") {
        refs.minimized.focus({ preventScroll: true });
      }
    }
  }

  return { render, setLastTrigger, bindFlows };
}
