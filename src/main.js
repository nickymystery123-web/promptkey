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
  const ai = assertAIService(
    createFallbackAIService(createHttpAIService(), createDemoAIProvider())
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
    store.dispatch(act.updateInput(refs.input.value));
  });
  refs.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      flows.confirmAndSend();
    }
  });

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

  // initial paint
  renderer.render(store.getState(), { ...store.getState(), message: null, toast: null, window: "launcher" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
