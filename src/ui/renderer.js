/* Renderer — the ONLY module that writes to the DOM (besides window-manager's
   positioning). Pure projection: state → pixels. All interactions dispatch actions. */

import { SECTION_NAMES, sectionToText } from "../models/prompt.js";
import { act } from "../state/actions.js";
import {
  effectiveStatus, statusLabel, sectionKeys,
  customButtonsEnabled, isProcessing, currentPrompt, inboxThoughts, canRefine, canConfirm,
  draftBadgeLabel, draftSavedLabel, canUndoInput, canRedoInput, aiModeLabel
} from "../state/selectors.js";
import { thoughtCopyText, thoughtPreview } from "../models/thought.js";

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
    understandList: $("pk-understand-list"),
    sections: $("pk-sections"),
    reviewbar: $("pk-reviewbar"),
    yousaidText: $("pk-yousaid-text"),
    useOriginal: $("pk-use-original"),
    useOptimized: $("pk-use-optimized"),
    msg: $("pk-workspace-msg"),
    c1: $("pk-c1"),
    c2: $("pk-c2"),
    voice: $("pk-voice"),
    voiceCaption: $("pk-voice-caption"),
    refine: $("pk-refine"),
    submit: $("pk-submit"),
    copyBtn: $("pk-copy-btn"),
    newBtn: $("pk-new-btn"),
    aiMode: $("pk-ai-mode"),
    draftBadge: $("pk-draft-badge"),
    draftSaved: $("pk-draft-saved"),
    undo: $("pk-undo"),
    redo: $("pk-redo"),
    minimized: $("pk-minimized"),
    pill: $("pk-pill"),
    toast: $("pk-toast"),
    inbox: $("pk-inbox"),
    inboxToggle: $("pk-inbox-toggle"),
    inboxClear: $("pk-inbox-clear"),
    inboxCount: $("pk-inbox-count"),
    inboxBody: $("pk-inbox-body"),
    inboxDraft: $("pk-inbox-draft"),
    inboxAdd: $("pk-inbox-add"),
    inboxList: $("pk-inbox-list")
  };
}

export function createRenderer(refs, store) {
  let lastRenderKey = null;
  let lastEditingKey = null;
  let msgTimer = null;
  let toastTimer = null;
  let lastTrigger = null; // element to return focus to after close
  const flowsRef = {};    // late-bound flow references (set by main.js) for inbox actions

  function bindFlows(flows) {
    flowsRef.sendThoughtToPrompt = flows.sendThoughtToPrompt;
    flowsRef.copyThoughtToClipboard = flows.copyThoughtToClipboard;
    flowsRef.refineFromComposer = flows.refineFromComposer;
  }

  function setLastTrigger(el) { lastTrigger = el; }

  /* ---- sections (optimized) or raw words (original) ---- */
  function renderSections(state) {
    const session = state.session;
    const head = session && session.versions.length
      ? session.versions[session.versions.length - 1]
      : null;
    const original = !!(session && session.selection === "original");
    const keys = original ? [] : sectionKeys(state);

    if ((!head && !original) || (!original && !keys.length)) {
      if (lastRenderKey !== null) { refs.sections.innerHTML = ""; lastRenderKey = null; }
      return;
    }

    const renderKey = (head ? head.id : "none") + ":" + (original ? "original" : "optimized");
    if (renderKey !== lastRenderKey) {
      lastRenderKey = renderKey;
      refs.sections.innerHTML = "";

      if (original) {
        // Original — the user's exact words, shown read-only. Never reconstructed from AI output.
        const block = document.createElement("div");
        block.className = "pk-section on pk-original-block";
        const name = document.createElement("div");
        name.className = "pk-section-name";
        name.textContent = "ORIGINAL — YOUR EXACT WORDS";
        const val = document.createElement("div");
        val.className = "pk-section-value";
        val.textContent = session.rawThought;
        block.append(name, val);
        refs.sections.appendChild(block);
        return;
      }

      const prompt = currentPrompt(state);
      keys.forEach((key) => {
        const sec = document.createElement("div");
        sec.className = "pk-section on";
        sec.dataset.key = key;
        const name = document.createElement("div");
        name.className = "pk-section-name";
        name.textContent = SECTION_NAMES[key];
        const val = document.createElement("div");
        val.className = "pk-section-value";
        const v = prompt[key];
        if (Array.isArray(v)) {
          const ul = document.createElement("ul");
          v.forEach((item) => {
            const li = document.createElement("li");
            li.textContent = item;
            ul.appendChild(li);
          });
          val.appendChild(ul);
        } else {
          val.textContent = v;
        }
        const hint = document.createElement("div");
        hint.className = "pk-section-hint";
        hint.textContent = "✓ UPDATED";
        sec.append(name, val, hint);
        sec.addEventListener("click", () => {
          const st = store.getState();
          if (st.editingSection) return;
          if (["review", "ready_to_send"].includes(st.interaction)) {
            store.dispatch(act.selectSection(key));
          }
        });
        refs.sections.appendChild(sec);
      });
      if (head.source === "edited" || head.source === "improved" || head.source === "rewritten") {
        const activeKey = state.session.selectedSection;
        const node = refs.sections.querySelector(`.pk-section[data-key="${activeKey}"]`);
        if (node) node.classList.add("just-saved");
      }
    }

    // selection highlight (cheap to recompute)
    const nodes = refs.sections.querySelectorAll(".pk-section");
    const sel = state.session ? state.session.selectedSection : null;
    const selectable = ["review", "editing", "ready_to_send"].includes(state.interaction);
    nodes.forEach((n) => {
      n.classList.toggle("active", selectable && n.dataset.key === sel);
    });
  }

  /* ---- inline section editor ---- */
  function renderEditor(state) {
    const editing = state.editingSection;
    if (editing === lastEditingKey) return;
    lastEditingKey = editing;
    if (!editing) return;

    const sec = refs.sections.querySelector(`.pk-section[data-key="${editing}"]`);
    if (!sec) return;
    const valEl = sec.querySelector(".pk-section-value");
    if (!valEl) return;
    const prompt = currentPrompt(state);
    const text = sectionToText(prompt, editing);

    const ta = document.createElement("textarea");
    ta.className = "pk-section-edit";
    ta.value = text;
    ta.rows = Math.min(6, Math.max(1, text.split("\n").length));
    valEl.replaceWith(ta);
    ta.setAttribute("aria-label", "Edit " + (SECTION_NAMES[editing] || editing));
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    let committed = false;
    const commit = (save) => {
      if (committed) return;
      committed = true;
      store.dispatch(save ? act.saveEdit(editing, ta.value) : act.cancelEdit());
    };
    ta.addEventListener("blur", () => commit(true));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); commit(false); }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(true); }
      e.stopPropagation();
    });
  }

  /* ---- understanding lines (state-driven) ---- */
  function renderUnderstanding(state) {
    const lines = refs.understandList.querySelectorAll("li");
    lines.forEach((li, i) => {
      const step = state.understandStep;
      li.classList.toggle("on", step >= i);
      li.classList.toggle("done", step > i || step >= 3);
    });
  }

  /* ---- live voice transcript preview ----
     Interim = muted (still being recognized); final = solid (committed).
     Interim text is preview-only and never reaches the AI backend. */
  function renderVoice(state) {
    const active = state.voice === "listening" || state.voice === "processing";
    refs.transcript.hidden = !active;
    if (!active) return;
    refs.transcriptLabel.textContent = state.voice === "processing" ? "PROCESSING" : "LISTENING";
    const t = state.voiceTranscript;
    refs.transcriptText.textContent = t && t.text ? t.text : "Listening…";
    refs.transcriptText.classList.toggle("interim", !!(t && t.text && !t.final));
    refs.transcriptText.classList.toggle("empty", !(t && t.text));
  }

  /* ---- review bar: YOU SAID + Original/Optimized choice ---- */
  function renderReviewbar(state) {
    const session = state.session;
    const show = !!session && ["review", "editing", "ready_to_send", "sending"].includes(state.interaction);
    refs.reviewbar.hidden = !show;
    if (!show) return;
    refs.yousaidText.textContent = session.rawThought;
    const original = session.selection === "original";
    refs.useOriginal.setAttribute("aria-pressed", original ? "true" : "false");
    refs.useOptimized.setAttribute("aria-pressed", original ? "false" : "true");
    refs.useOriginal.classList.toggle("on", original);
    refs.useOptimized.classList.toggle("on", !original);
  }

  /* ---- Creative Inbox (Phase 3C-2A) ----
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
    const expandedIds = state.inbox ? state.inbox.expandedIds : [];

    // The inbox is always mounted inside the workspace (not a gated view),
    // so its own header / draft can stay live regardless of prompt status.
    refs.inbox.dataset.open = open ? "1" : "0";
    refs.inbox.dataset.count = String(count);
    refs.inboxToggle.setAttribute("aria-expanded", open ? "true" : "false");
    refs.inboxBody.hidden = !open;
    refs.inboxCount.hidden = count === 0;
    refs.inboxCount.textContent = count;
    refs.inboxClear.hidden = !open || count === 0;
    // 3C-2B: ADD no longer creates a Thought — it places the capture into the
    // Composer. Still disabled on empty draft.
    refs.inboxAdd.disabled = !(state.inbox && state.inbox.draft && state.inbox.draft.trim());

    // Draft: keep the field in sync with state via pure value comparison
    // (same caret-safe policy as the Composer input; no activeElement guard).
    const draftEl = refs.inboxDraft;
    if (draftEl.value !== (state.inbox ? state.inbox.draft : "")) {
      draftEl.value = state.inbox ? state.inbox.draft : "";
    }
    // Auto-grow the draft up to 3 lines.
    if (draftEl.value) {
      draftEl.style.height = "auto";
      draftEl.style.height = Math.min(3, draftEl.scrollHeight / 20) + "em";
    } else {
      draftEl.style.height = "";
    }

    // Thoughts list — rebuild when ids / text / refined / expansion / open change.
    const listKey = thoughts.map((t) => t.id + ":" + t.originalText.length + (t.refinedText ? "+r" : "")).join("|")
      + ":" + expandedIds.join(",") + ":" + (open ? "1" : "0");
    // While a thought is being edited inline, keep its textarea alive — don't
    // rebuild the list out from under it. (Edited/deleted cards force a rebuild
    // via the explicit _listKey reset in commit().)
    if (editingThoughtId && thoughts.some((t) => t.id === editingThoughtId)) return;
    if (listKey === refs.inbox._listKey) return;
    refs.inbox._listKey = listKey;

    refs.inboxList.textContent = "";

    if (!count) {
      const empty = document.createElement("p");
      empty.className = "pk-inbox-empty";
      empty.textContent = "IDEAS YOU CAPTURE LIVE HERE";
      refs.inboxList.appendChild(empty);
      return;
    }

    thoughts.forEach((t) => {
      const expanded = expandedIds.includes(t.id);
      const card = document.createElement("div");
      card.className = "pk-thought";
      card.dataset.id = t.id;
      card.dataset.open = expanded ? "1" : "0";

      const head = document.createElement("div");
      head.className = "pk-thought-head";

      const src = document.createElement("span");
      src.className = "pk-thought-src" + (t.source === "voice" ? " voice" : "");
      src.textContent = t.source === "voice" ? "VOICE" : "TEXT";

      const time = document.createElement("span");
      time.className = "pk-thought-time";
      time.textContent = fmtThoughtTime(t.updatedAt);

      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "pk-thought-expand";
      expand.setAttribute("aria-label", expanded ? "Collapse thought" : "Expand thought");
      expand.textContent = expanded ? "COLLAPSE" : "EXPAND";
      expand.addEventListener("click", () => store.dispatch(act.inboxToggleExpanded(t.id)));

      head.append(src, time, expand);
      card.appendChild(head);

      const original = document.createElement("p");
      original.className = "pk-thought-original";
      original.textContent = thoughtPreview(t, expanded ? 100000 : 42);
      card.appendChild(original);

      if (t.refinedText) {
        const refined = document.createElement("p");
        refined.className = "pk-thought-refined";
        const tag = document.createElement("span");
        tag.className = "pk-refined-tag";
        tag.textContent = "REFINED";
        refined.appendChild(tag);
        refined.appendChild(document.createTextNode(t.refinedText));
        card.appendChild(refined);
      }

      const actions = document.createElement("div");
      actions.className = "pk-thought-actions";
      const btn = (label, variant, primary) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pk-thought-btn" + (primary ? " primary" : "");
        b.textContent = label;
        return b;
      };
      const send = btn("USE", "", true);
      send.setAttribute("aria-label", "Use this thought in the prompt");
      send.addEventListener("click", () => flowsRef.sendThoughtToPrompt(t.id));
      const copyR = btn("COPY REFINED", "refined");
      copyR.addEventListener("click", () => flowsRef.copyThoughtToClipboard(t.id, "refined"));
      const copyO = btn("COPY ORIGINAL", "original");
      copyO.addEventListener("click", () => flowsRef.copyThoughtToClipboard(t.id, "original"));
      const edit = btn("EDIT", "");
      edit.addEventListener("click", () => startThoughtEdit(t.id));
      const del = btn("DELETE", "");
      del.addEventListener("click", () => store.dispatch(act.inboxDelete(t.id)));
      actions.append(send, copyR, copyO, edit, del);
      card.appendChild(actions);

      refs.inboxList.appendChild(card);
    });
  }

  /* ---- inline thought editor (edit → textarea → save/cancel) ---- */
  let editingThoughtId = null;
  function startThoughtEdit(id) {
    editingThoughtId = id;
    const card = refs.inboxList.querySelector(`.pk-thought[data-id="${id}"]`);
    if (!card) return;
    const original = card.querySelector(".pk-thought-original");
    if (!original) return;
    const text = thoughtCopyText(
      inboxThoughts(store.getState()).find((t) => t.id === id),
      "original"
    );
    const ta = document.createElement("textarea");
    ta.className = "pk-thought-edit-ta";
    ta.value = text;
    ta.rows = Math.min(6, Math.max(1, text.split("\n").length));
    ta.setAttribute("aria-label", "Edit thought");
    original.replaceWith(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      editingThoughtId = null;
      const next = (ta.value || "").trim();
      if (save && next && next !== thoughtCopyText(inboxThoughts(store.getState()).find((t) => t.id === id), "original")) {
        store.dispatch(act.inboxEdit(id, next)); // keeps id, rewrites originalText in place
      }
      // Force a re-render of the list next pass (restore the read-only card).
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
    refs.workspace.setAttribute("aria-busy", isProcessing(state) ? "true" : "false");

    // input — always mirror state (Bug #8: the old activeElement guard made
    // external state changes invisible while the Composer was focused, so the
    // DOM fell out of sync with state and the next keystroke reverted it).
    // A pure value comparison keeps the caret intact while still honoring
    // programmatic updates (voice append, REFINE results, USE take-back).
    if (refs.input.value !== state.input) {
      refs.input.value = state.input;
    }
    // 3C-3A §7: after UNDO/REDO the caret is restored to the entry's saved
    // selection (typing clears it in the machine — no repeated re-apply).
    if (state.inputSelection && refs.input.value === state.input && refs.input.setSelectionRange) {
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
    // 3C-2B: bottom bar carries VOICE / REFINE only — the explicit final-send
    // entry lives inside the Composer as #pk-submit (no standalone SEND key).
    refs.refine.disabled = !canRefine(state);
    refs.refine.classList.toggle("busy", state.voice === "processing");
    refs.c1.disabled = !customButtonsEnabled(state);
    refs.c2.disabled = !customButtonsEnabled(state);
    refs.c1.classList.toggle("busy", state.interaction === "improving");
    refs.c1.dataset.busyTip = "IMPROVING…";
    refs.c2.classList.toggle("busy", state.interaction === "rewriting");
    refs.c2.dataset.busyTip = "REWRITING…";
    refs.voice.classList.toggle("listening", state.voice === "listening");
    refs.voiceCaption.textContent =
      state.voice === "listening" ? "LISTENING"
      : state.voice === "processing" ? "PROCESSING"
      : state.voice === "error" ? "RETRY"
      : "VOICE";
    refs.voice.setAttribute("aria-pressed", state.voice === "listening" ? "true" : "false");
    // Composer submit entry (3C-2B): enabled exactly when canConfirm() says the
    // user has something to submit — idle/input with text, or a reviewable prompt.
    if (refs.submit) refs.submit.disabled = !canConfirm(state);

    // minimized bubble & launcher pill visibility
    refs.minimized.hidden = state.window !== "minimized";
    refs.pill.hidden = state.window !== "hidden";

    // views
    renderSections(state);
    renderEditor(state);
    renderUnderstanding(state);
    renderVoice(state);
    renderReviewbar(state);
    renderInbox(state);
    if (state.message !== prev.message) renderMessage(state);
    if (state.toast !== prev.toast) renderToast(state);

    // focus management
    if (prev.window !== state.window) {
      if ((state.window === "expanded" || state.window === "focus") &&
          (prev.window === "hidden" || prev.window === "minimized" || prev.window === "launcher")) {
        if (state.interaction === "input") refs.input.focus();
        else refs.closeBtn.focus({ preventScroll: true });
      }
      if (state.window === "hidden" && lastTrigger && document.contains(lastTrigger)) {
        lastTrigger.focus({ preventScroll: true });
      }
      if (state.window === "minimized") {
        refs.minimized.focus({ preventScroll: true });
      }
    }
  }

  return { render, setLastTrigger, bindFlows };
}
