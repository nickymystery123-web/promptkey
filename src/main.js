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
import { createOrbController } from "./ui/orb.js";
import { isVoiceToggleShortcut, voiceShortcutHint } from "./ui/shortcuts.js";

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
  /* PHASE 3D RC1: PromptKey Orb — 状态管道（listening/processing/ready/error
     从 store 订阅；hover/press 指针驱动；双击/长按为 RC2 预留桩） */
  const orb = createOrbController({ refs, win: window });
  orb.init();

  store.subscribe((state, prev) => {
    renderer.render(state, prev);
    wm.onState(state, prev);
    orb.onState(state, prev);
  });

  /* ---- DOM events → actions/flows ---- */
  document.querySelectorAll(".pk-try").forEach((btn) => {
    btn.addEventListener("click", () => {
      renderer.setLastTrigger(btn);
      store.dispatch(act.openFloat());
    });
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

  refs.voice.addEventListener("click", () => flows.toggleVoice());

  /* ---- 3C-3B §8.4: Voice keyboard shortcut — Ctrl/Cmd+Shift+M toggles the
     SAME flows.toggleVoice() action as the button (no parallel state path).
     Capture phase so it works from any focus target; the predicate guards
     key-repeat (no double toggle) and the combo never types into editors. */
  document.addEventListener("keydown", (e) => {
    if (!isVoiceToggleShortcut(e)) return;
    e.preventDefault();
    flows.toggleVoice();
  }, true);
  // Platform-appropriate shortcut discoverability hint (⌘⇧M / Ctrl+Shift+M).
  const voiceHint = document.getElementById("pk-voice-hint");
  if (voiceHint && navigator && navigator.platform) {
    voiceHint.textContent = voiceShortcutHint(navigator.platform);
  }
  refs.refine.addEventListener("click", () => flows.refineFromComposer());
  refs.submit.addEventListener("click", () => flows.confirmAndSend());
  // Stage 2 · P1-4: Idle view is a big "tap / click to begin" surface.
  // START_INPUT swaps interaction idle → input regardless of draft content;
  // on the next store tick the renderer shows the input view, then we focus.
  if (refs.idleView) {
    refs.idleView.addEventListener("click", () => {
      if (store.getState().interaction !== "idle") return;
      store.dispatch(act.startInput());
      setTimeout(() => refs.input && refs.input.focus(), 0);
    });
  }
  refs.voiceCancel.addEventListener("click", (e) => {
    e.stopPropagation();
    flows.cancelVoice();
  });

  /* ---- Creative Inbox (3E) ----
     Thoughts are rendered by renderer.js. Only the panel toggle and CLEAR ALL
     are bound here. */
  refs.inboxToggle.addEventListener("click", () => store.dispatch(act.inboxToggleOpen()));
  refs.inboxClear.addEventListener("click", () => store.dispatch(act.inboxClearAll()));

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Escape = CANCEL voice (abandon, no AI call). Tap-mic-again = STOP/DONE (finalize).
    flows.cancelVoice();
  });

  /* ---- Stage 2 · Global Submit Shortcuts (P0-1) ----
       · Ctrl+Enter / Cmd+Enter submits from INPUT / REVIEW / EDITING
         regardless of where focus is.
       · Plain Enter (no Shift, no modifier) submits ONLY from REVIEW and
         only when focus is NOT inside an editable surface — otherwise Enter
         in Composer, Inbox draft, section, and thought editors still keeps
         its "new line / inline save" meaning.

       IMPORTANT: the listener is attached with useCapture=true. Both the
       Composer input and the Inbox draft textareas call e.stopPropagation()
       on keydown to guard their own Enter semantics. If we listened in the
       bubble phase, the global handlers would never fire when focus is on
       those surfaces. Capture phase runs BEFORE the target listeners, so
       stopPropagation does not prevent us (we just run earlier, and the
       target-specific handlers still run for their own Enter newline case,
       which is fine because Ctrl/Cmd modifier is exclusive with Enter). */
  document.addEventListener("keydown", (e) => {
    const s = store.getState();
    const inSendable = ["idle", "input"].includes(s.interaction);
    const ctrlOrCmd = e.ctrlKey || e.metaKey;

    if (ctrlOrCmd && e.key === "Enter" && inSendable) {
      e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      flows.confirmAndSend();
    }
  }, true); // capture phase

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
