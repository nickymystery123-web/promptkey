/* PromptKey Float — composition root.
   Wires: services → store → flows → renderer/window-manager → DOM events.
   DOM events only dispatch actions or call flows; no business logic here. */

import { createStore } from "./state/store.js";
import { act } from "./state/actions.js";
import { createDemoAIProvider } from "./services/ai/demo-provider.js";
import { createHttpAIService } from "./services/ai/http-service.js";
import { createFallbackAIService } from "./services/ai/fallback-service.js";
import { assertAIService } from "./services/ai/interface.js";
import { createBrowserSpeechProvider } from "./services/voice/browser-provider.js";
import { assertVoiceService } from "./services/voice/interface.js";
import { createClipboardDelivery } from "./services/delivery/clipboard-provider.js";
import { assertDeliveryService } from "./services/delivery/interface.js";
import { createLocalStorageService } from "./services/storage/local-storage.js";
import { createFlows } from "./flows/prompt-flow.js";
import { collectRefs, createRenderer } from "./ui/renderer.js";
import { createWindowManager } from "./ui/window-manager.js";

function boot() {
  const refs = collectRefs(document);
  const store = createStore();

  // AI: backend API first, local Demo as degraded-mode fallback (PRD Demo First).
  // The flow layer never learns which one answered — same AIService interface.
  // 3C-3A §5: onMode reports which transport actually answered so the system
  // bar can show AI · REAL / AI · DEMO (Demo never masquerades as Real).
  const ai = assertAIService(
    createFallbackAIService(createHttpAIService(), createDemoAIProvider(), {
      onMode: (mode) => store.dispatch(act.aiMode(mode))
    })
  );
  const voice = assertVoiceService(createBrowserSpeechProvider(window));
  const delivery = assertDeliveryService(createClipboardDelivery(navigator, document));
  const storage = createLocalStorageService(window.localStorage);

  const flows = createFlows({ store, ai, voice, delivery, storage });
  flows.bindVoiceCallbacks();

  const renderer = createRenderer(refs, store);
  renderer.bindFlows(flows); // inbox send/copy callbacks
  const wm = createWindowManager({ refs, store, storage, win: window });
  wm.init();

  store.subscribe((state, prev) => {
    renderer.render(state, prev);
    wm.onState(state, prev);
  });

  /* ---- DOM events → actions/flows ---- */
  document.querySelectorAll(".pk-try").forEach((btn) => {
    btn.addEventListener("click", () => {
      renderer.setLastTrigger(btn);
      store.dispatch(act.openFloat());
    });
  });
  refs.pill.addEventListener("click", () => {
    renderer.setLastTrigger(refs.pill);
    store.dispatch(act.openFloat());
  });
  refs.minBtn.addEventListener("click", () => store.dispatch(act.minimizeFloat()));
  refs.closeBtn.addEventListener("click", () => flows.closeFloat());
  refs.minimized.addEventListener("click", () => {
    if (refs.minimized.dataset.moved === "1") { refs.minimized.dataset.moved = ""; return; }
    store.dispatch(act.restoreFloat());
  });

  // Whole workspace is the input area
  refs.workspace.addEventListener("click", (e) => {
    const s = store.getState();
    if (s.interaction !== "idle" && s.interaction !== "input") return;
    if (e.target.closest("button") || e.target.closest("textarea")) return;
    if (e.target.closest(".pk-inbox")) return; // Creative Inbox is its own surface
    if (s.interaction === "idle") store.dispatch(act.startInput());
    refs.input.focus();
  });

  refs.input.addEventListener("input", () => {
    // 3C-3A: the caret rides along with every keystroke so UNDO can restore it.
    store.dispatch(act.updateInput(refs.input.value, {
      selectionStart: refs.input.selectionStart,
      selectionEnd: refs.input.selectionEnd
    }));
  });
  refs.input.addEventListener("keydown", (e) => {
    // 3C-3A §7.5: application-level undo/redo (the native stack is corrupted
    // by programmatic writes, so it is fully replaced — always preventDefault).
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      store.dispatch(e.shiftKey ? act.redoInput() : act.undoInput());
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      flows.confirmAndSend();
    }
  });

  // 3C-3A §7.5/§7.6: global shortcut (works when the Composer is not focused),
  // but never hijacks undo inside other text surfaces (inbox capture, section
  // or thought editors). Mobile has no keyboard — the ↺/↻ buttons are the
  // entry point there.
  function globalUndoRedo(e) {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
    const t = e.target;
    // ANY text surface is skipped: the Composer input has its own keydown
    // handler (double dispatch here caused TWO undo steps per shortcut —
    // found in 3C-3A STEP 8 browser E2E), and other surfaces (inbox capture,
    // section/thought editors) must keep their native undo.
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
    e.preventDefault();
    store.dispatch(e.shiftKey ? act.redoInput() : act.undoInput());
  }
  document.addEventListener("keydown", globalUndoRedo);
  if (refs.undo) refs.undo.addEventListener("click", () => store.dispatch(act.undoInput()));
  if (refs.redo) refs.redo.addEventListener("click", () => store.dispatch(act.redoInput()));

  refs.c1.addEventListener("click", () => flows.improve());
  refs.c2.addEventListener("click", () => flows.rewrite());
  refs.voice.addEventListener("click", () => flows.toggleVoice());
  refs.refine.addEventListener("click", () => flows.refineFromComposer());
  refs.submit.addEventListener("click", () => flows.confirmAndSend());
  refs.voiceCancel.addEventListener("click", (e) => {
    e.stopPropagation();
    flows.cancelVoice();
  });
  refs.useOriginal.addEventListener("click", () => store.dispatch(act.useOriginal()));
  refs.useOptimized.addEventListener("click", () => store.dispatch(act.useOptimized()));
  refs.copyBtn.addEventListener("click", () => flows.copyPrompt());
  refs.newBtn.addEventListener("click", () => flows.newThought());

  /* ---- Creative Inbox (Phase 3C-2B) ----
     All ops are local & immediate. Add = place capture into the Composer
     (no inbox Thought is created by ADD — REFINE is the only entry). */
  refs.inboxToggle.addEventListener("click", () => store.dispatch(act.inboxToggleOpen()));
  refs.inboxAdd.addEventListener("click", () => flows.addThoughtFromInbox());
  refs.inboxDraft.addEventListener("input", () => {
    store.dispatch(act.inboxUpdateDraft(refs.inboxDraft.value));
  });
  refs.inboxDraft.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if ((store.getState().inbox.draft || "").trim()) flows.addThoughtFromInbox();
    }
    e.stopPropagation();
  });
  refs.inboxClear.addEventListener("click", () => store.dispatch(act.inboxClearAll()));

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Escape = CANCEL voice (abandon, no AI call). Tap-mic-again = STOP/DONE (finalize).
    flows.cancelVoice();
  });

  /* ---- 3C-3A §4.4/§6: boot-time restore (best-effort, silent degrade) ----
     Persisted Creative Inbox thoughts + Composer draft come back exactly as
     saved: order preserved, no AI, no REFINE, no auto-submit. */
  (async () => {
    try {
      const thoughts = await storage.loadInbox();
      if (Array.isArray(thoughts) && thoughts.length) store.dispatch(act.inboxRestore(thoughts));
      const draft = await storage.loadDraft();
      if (typeof draft === "string" && draft) store.dispatch(act.restoreDraft(draft));
    } catch (e) { /* storage unavailable — core flows unaffected */ }
  })();

  /* ---- 3C-3A §6.2: forced final save at page-hide boundaries ----
     localStorage is synchronous, so the flush is safe to run here. */
  window.addEventListener("pagehide", () => { flows.flushDraft(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flows.flushDraft();
  });

  // initial paint
  renderer.render(store.getState(), { ...store.getState(), message: null, toast: null, window: "launcher" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
