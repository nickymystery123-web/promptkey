/* Flows — async orchestration. The ONLY place services are called.
   Every flow is: dispatch intent → (await service) → dispatch result.
   Delays are injectable so integration tests run instantly. */

import { act, ERR } from "../state/actions.js";
import { currentPrompt, activePrompt, activePromptText } from "../state/selectors.js";
import { thoughtCopyText } from "../models/thought.js";

export function createFlows({ store, ai, voice, delivery, storage, delays = {} }) {
  const d = Object.assign(
    { understandStep: 620, understandFirst: 420, structuringSettle: 320, readyToSend: 500, sending: 900, transcribing: 500, draftDebounce: 500 },
    delays
  );
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = () => store.getState();

  /* Cancellation (spec §15): a new request aborts the previous pending one,
     so a stale response can never overwrite a newer session. */
  let pendingAbort = null;
  let lastInputSource = "text"; // "voice" when the thought came from the mic
  let voiceSession = 0;         // increments per voice session — stale onEnd chains die
  let voiceFlowActive = false;  // true from voice start until its analysis settles
  let reqSeq = 0;               // request generation — late responses from older generations die
  let refineReqSeq = 0;         // refine pending generation — stale finally blocks must not clear the flag
  function trackRequest() {
    if (pendingAbort) pendingAbort.abort();
    pendingAbort = new AbortController();
    reqSeq += 1;
    return pendingAbort.signal;
  }
  function killPendingRequest() {
    reqSeq += 1; // any in-flight response is now stale, even if the provider ignores AbortSignal
    refineReqSeq += 1; // a killed refine must not clear the pending flag in its finally
    if (pendingAbort) pendingAbort.abort();
  }
  function isAborted(e) {
    return e && (e.code === "AI_ABORTED" || e.name === "AbortError");
  }

  /* Persist session whenever it changes (hooked in main via subscribe) */
  async function persistSession() {
    const session = S().session;
    if (session) {
      try { await storage.saveSession(session); }
      catch (e) { store.dispatch(act.error(ERR.STORAGE_ERROR, "Session could not be saved.")); }
    }
  }

  /* ---- 3C-3A persistence side effects (flows = the only services caller) ----
     1) Composer draft: debounced auto-save (§6.1) — one write per quiet 500ms,
        never one per keypress. flushDraft() is the forced final save for
        pagehide / visibilitychange (§6.2). Storage failures degrade silently
        (§6.6): the Composer itself never breaks.
     2) Creative Inbox: saved on every thoughts mutation — REFINE add, EDIT,
        DELETE, INBOX_REFINE metadata, CLEAR ALL, RESET (§4.3). */
  let draftTimer = null;
  async function saveDraftNow() {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    try {
      await storage.saveDraft(S().input || "");
      store.dispatch(act.draftSaved()); // SAVED badge flip (no-op if already saved)
    } catch (e) { /* storage unavailable — silent degrade */ }
  }
  function scheduleDraftSave() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { draftTimer = null; saveDraftNow(); }, d.draftDebounce);
  }
  function flushDraft() { return saveDraftNow(); }
  async function clearDraftNow() {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    try { await storage.clearDraft(); } catch (e) { /* silent degrade */ }
  }

  store.subscribe((state, prev) => {
    if (state.input !== prev.input) scheduleDraftSave();
    if (state.inbox.thoughts !== prev.inbox.thoughts) {
      try { storage.saveInbox(state.inbox.thoughts); } catch (e) { /* silent degrade */ }
    }
  });

  /* ---- Thought → Creative Inbox (3E simplified) -----
     The old understanding/structuring/review/send pipeline is retired.
     SUBMIT now stores the user's exact Composer words as a Thought directly
     in the Creative Inbox (the machine handles the state change). */
  async function submitThought() {
    clearDraftNow();
    store.dispatch(act.submitThought());
  }

  /* ---- C1 / C2 ---- */
  async function runTransform(kind) {
    const isImprove = kind === "improve";
    const prompt = currentPrompt(S());
    if (!prompt) return;
    store.dispatch(isImprove ? act.improvePrompt() : act.rewritePrompt());
    const expected = isImprove ? "improving" : "rewriting";
    if (S().interaction !== expected) return;
    try {
      const signal = trackRequest();
      const myReq = reqSeq;
      const next = isImprove ? await ai.improvePrompt(prompt, signal) : await ai.rewritePrompt(prompt, signal);
      if (myReq !== reqSeq) return; // stale response
      if (S().interaction !== expected) return;
      store.dispatch(isImprove ? act.improveSuccess(next) : act.rewriteSuccess(next));
      store.dispatch(act.showMessage("UPDATED ✓"));
      await persistSession();
    } catch (e) {
      if (isAborted(e)) return;
      store.dispatch(act.error(ERR.AI_ERROR, "Something interrupted the flow. Try again."));
    }
  }

  /* ---- SUBMIT → Creative Inbox (3E simplified) -----
     The old confirm → ready → sending → delivered pipeline is retired.
     SUBMIT now stores the Composer content directly in the Creative Inbox. */
  async function confirmAndSend() {
    const s = S().interaction;
    if (s === "idle" || s === "input") return submitThought();
  }

  /* ---- Copy / New Thought ---- */
  async function copyPrompt() {
    if (!currentPrompt(S())) return;
    try {
      // Original selection copies the user's exact words, byte-for-byte.
      await delivery.copy(activePromptText(S()));
      store.dispatch(act.copyPrompt());
      store.dispatch(act.showToast("PROMPT COPIED"));
    } catch (e) {
      store.dispatch(act.error(ERR.DELIVERY_ERROR, "Copy failed — select the text manually."));
    }
  }

  function newThought() {
    voiceSession += 1;    // kills any in-flight voice finalization
    voiceFlowActive = false;
    killPendingRequest(); // user restarted — cancel pending AI work
    // 3C-3A §6.4: explicit NEW clears the persisted draft (machine clears the
    // in-state draft + history). REFINE/Voice/ADD/USE/Review never clear it.
    clearDraftNow();
    store.dispatch(act.newThought());
  }

  /* ---- Voice ----
     3C-2B continuous semantics:
       · interim transcripts → live preview only (never AI)
       · a pause → provider auto-restarts internally; no flow action (still LISTENING)
       · user STOP (tap mic again / recognition end after explicit stop)
         → the final transcript is APPENDED to the Composer input (set if empty,
           else append). Voice is INPUT ONLY — it never creates a Thought by itself.
         → VOICE_ENDED → idle, so the user can immediately speak again (multi-round).
       · CANCEL → abort everything → restore pre-voice Composer draft, no AI call. */
  function bindVoiceCallbacks() {
    voice.onTranscript((text, isFinal, seq) => {
      store.dispatch(act.voiceTranscript(text, isFinal, seq));
    });
    voice.onError((code) => {
      voiceFlowActive = false;
      store.dispatch(act.voiceError(code || ERR.VOICE_ERROR));
    });
    voice.onEnd(async () => {
      // onEnd now fires only after an explicit stop()/abort() or a real terminal
      // error — a pause restarts recognition inside the provider and never reaches
      // us here. Guard against a stale/cancelled chain:
      if (!["listening", "processing"].includes(S().voice)) return;
      const sessionAtEnd = voiceSession;
      voiceFlowActive = false;
      store.dispatch(act.voiceEnded()); // transcript already in Composer; reset voice slice
      await wait(d.transcribing);
      if (sessionAtEnd !== voiceSession) return; // cancelled / superseded during settle
      if (S().voice !== "idle") return;
      // 3C-2B: the words are now in the Composer. The user decides next: REFINE
      // (→ Creative Inbox) or submit to the prompt pipeline. We never auto-run AI.
      store.dispatch(act.showMessage(
        (S().input || "").trim()
          ? "Added to your prompt — refine it or send it."
          : "Didn't catch that — tap the mic to retry, or type instead."
      ));
    });
  }

  async function toggleVoice() {
    const s = S();
    if (s.voice === "listening") {
      await voice.stop(); // STOP/DONE — finalization continues in onEnd (transcript → Composer)
      return;
    }
    if (!["idle", "input"].includes(s.interaction)) return;
    if (!["idle", "error"].includes(s.voice)) return; // error state: tap mic = retry
    if (!voice.isAvailable()) {
      store.dispatch(act.voiceError(ERR.VOICE_UNAVAILABLE));
      return;
    }
    try {
      voiceSession += 1;   // new session invalidates any previous one
      killPendingRequest(); // and any pending analysis from it
      voiceFlowActive = true;
      store.dispatch(act.startVoice());
      await voice.start();
      store.dispatch(act.showMessage("Listening… tap again to stop, Esc to cancel."));
    } catch (e) {
      voiceFlowActive = false;
      store.dispatch(act.voiceError(ERR.VOICE_UNAVAILABLE));
    }
  }

  /* CANCEL semantics (≠ stop/done):
     discard the pending voice operation, abort any pending request,
     restore the pre-voice draft, never call the AI. */
  async function cancelVoice() {
    const s = S();
    if (s.voice === "listening" || s.voice === "processing") {
      voiceSession += 1; // kills the onEnd finalization chain
      try { await voice.abort(); } catch (e) { /* provider already stopped */ }
      voiceFlowActive = false;
      store.dispatch(act.cancelVoice()); // restores pre-voice input, clears transcript
      return;
    }
    // Voice already submitted → cancel its pending analysis.
    if (voiceFlowActive && ["understanding", "structuring"].includes(s.interaction)) {
      voiceFlowActive = false;
      killPendingRequest();
      store.dispatch(act.newThought()); // safe idle; stale response is ignored by reqSeq guard
    }
  }

  /* CLOSE (Bug #10): closing the Float is a full teardown of the floating
     surface. Any live voice session must be aborted FIRST (stops the mic /
     recognition), so no stale listening/processing/error chain survives into
     the next open. Order matters: abort the provider before dispatching
     CLOSE_FLOAT, so the machine's voice-reset branch sees a settled slice and
     the re-opened Float always starts from voice=idle with REFINE usable. */
  async function closeFloat() {
    const v = S().voice;
    if (v === "listening" || v === "processing") {
      voiceSession += 1; // invalidate any in-flight finalization / analysis
      voiceFlowActive = false;
      killPendingRequest();
      try { await voice.abort(); } catch (e) { /* provider already stopped */ }
    } else {
      voiceFlowActive = false;
    }
    store.dispatch(act.closeFloat());
  }

  /* ---- Creative Inbox flows (Phase 3C-2B) ----
     Entry policy: the ONLY way a Thought enters the inbox is REFINE — Composer
     content → AI refine → createThought(refined). Capturing text (inbox draft
     ADD) or voice finals routes into the Composer, never straight to the inbox.
     Edit/Delete/Copy/Expand are LOCAL, immediate, never block on AI. */
  async function addThoughtFromInbox() {
    // 3C-2B: "ADD" now means "place into the Composer" — set if empty, else
    // append. The user can then REFINE it into the inbox, or send it directly.
    // 3C-3A: a PROGRAMMATIC append (independent history step; plain DRAFT badge).
    const draft = (S().inbox.draft || "").trim();
    if (!draft) return;
    const current = S().input || "";
    const merged = current ? current + (draft ? " " + draft : "") : draft;
    store.dispatch(act.updateInput(merged, { programmatic: true }));
    store.dispatch(act.inboxUpdateDraft("")); // consumed the capture field
    store.dispatch(act.showMessage("Added to your prompt."));
  }

  /* REFINE (3E): optimize the Composer text in place.
     Composer content → AI analyze → refined text written back to Composer.
     The original source is preserved via REFINE_RESULT so SUBMIT can store an
     original/refined pair in the Inbox. */
  async function refineFromComposer() {
    const source = S().input.trim();
    if (!source) return;
    // Bug #10: only LIVE voice blocks REFINE — listening/processing. A terminal
    // error must NOT block the fallback path: after a speech error the words are
    // already in the Composer (or typeable), and REFINE is exactly the recovery.
    if (S().voice === "listening" || S().voice === "processing") return; // don't refine mid-voice
    if (S().refinePending) return; // avoid double-fires from rapid clicks / double-tap
    voiceFlowActive = false;
    store.dispatch(act.refinePending(true));
    refineReqSeq += 1;
    const myRefineReq = refineReqSeq;
    try {
      const signal = trackRequest();
      const myReq = reqSeq;
      const analysis = await ai.analyzePrompt(source, { signal, inputSource: "text" });
      if (myReq !== reqSeq) return; // superseded by a newer request
      const refined = analysis && analysis.prompt && analysis.prompt.objective;
      if (!refined) {
        store.dispatch(act.showToast("REFINE UNAVAILABLE"));
        return;
      }
      // 3E: write optimized text back to Composer; original is preserved for SUBMIT.
      store.dispatch(act.refineResult(source, refined));
    } catch (e) {
      // refinement is best-effort; the Composer text is never lost
      if (!isAborted(e)) store.dispatch(act.showToast("REFINE UNAVAILABLE"));
    } finally {
      // only clear if this generation still owns the pending flag
      if (myRefineReq === refineReqSeq) store.dispatch(act.refinePending(false));
    }
  }

  /* USE (3C-3A DECISION #1): take a Thought back into the Composer as a
     NON-DESTRUCTIVE APPEND — NO auto-submit, NO Thought consumption.
     The user's existing draft is preserved; the Thought text is appended
     after a blank-line separator. Only the join boundary is normalized
     (existing.trimEnd() + "\n\n" + thought.trim()); the interior of the
     existing Composer text is never modified. */
  async function sendThoughtToPrompt(id) {
    const thought = S().inbox.thoughts.find((t) => t.id === id);
    if (!thought) return;
    const text = thoughtCopyText(thought, "refined") || thought.originalText;
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    voiceSession += 1;       // end any voice session cleanly
    voiceFlowActive = false;
    killPendingRequest();    // don't let an in-flight analysis race the take-back
    lastInputSource = thought.source; // the thought's origin flows through the pipeline
    const existing = (S().input || "").trimEnd();
    const merged = existing ? existing + "\n\n" + trimmed : trimmed;
    store.dispatch(act.updateInput(merged, { origin: "thought", programmatic: true }));
    store.dispatch(act.showMessage("Added to your prompt — edit or send it."));
  }

  async function copyThoughtToClipboard(id, variant) {
    const thought = S().inbox.thoughts.find((t) => t.id === id);
    if (!thought) return;
    const text = thoughtCopyText(thought, variant);
    if (!text) return;
    try {
      await delivery.copy(text);
      store.dispatch(act.inboxCopy(id, variant));
      store.dispatch(act.showToast("COPIED"));
    } catch (e) {
      store.dispatch(act.error(ERR.DELIVERY_ERROR, "Copy failed — select the text manually."));
    }
  }

  return {
    submitThought,
    improve: () => runTransform("improve"),
    rewrite: () => runTransform("rewrite"),
    confirmAndSend,
    copyPrompt,
    newThought,
    toggleVoice,
    cancelVoice,
    closeFloat,
    bindVoiceCallbacks,
    persistSession,
    flushDraft,
    addThoughtFromInbox,
    refineFromComposer,
    sendThoughtToPrompt,
    copyThoughtToClipboard
  };
}
