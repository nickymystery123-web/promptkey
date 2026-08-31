/* Flows — async orchestration. The ONLY place services are called.
   Every flow is: dispatch intent → (await service) → dispatch result.
   Delays are injectable so integration tests run instantly. */

import { act, ERR } from "../state/actions.js";
import { currentPrompt, activePrompt, activePromptText } from "../state/selectors.js";
import { thoughtCopyText } from "../models/thought.js";

export function createFlows({ store, ai, voice, delivery, storage, delays = {} }) {
  const d = Object.assign(
    { understandStep: 620, understandFirst: 420, structuringSettle: 320, readyToSend: 500, sending: 900, transcribing: 500 },
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
  function trackRequest() {
    if (pendingAbort) pendingAbort.abort();
    pendingAbort = new AbortController();
    reqSeq += 1;
    return pendingAbort.signal;
  }
  function killPendingRequest() {
    reqSeq += 1; // any in-flight response is now stale, even if the provider ignores AbortSignal
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

  /* ---- Thought → Understanding → Structuring → Review ---- */
  async function submitThought() {
    store.dispatch(act.submitThought());
    if (S().interaction !== "understanding") return; // guard rejected (empty input)

    // Understanding animation — state-driven via UNDERSTANDING_STEP
    const steps = [0, 1, 2];
    for (let i = 0; i < steps.length; i++) {
      await wait(i === 0 ? d.understandFirst : d.understandStep);
      if (S().interaction !== "understanding") return; // interrupted
      store.dispatch(act.understandingStep(i));
    }
    await wait(d.understandStep);
    if (S().interaction !== "understanding") return;

    try {
      const inputSource = lastInputSource;
      lastInputSource = "text";
      const signal = trackRequest();
      const myReq = reqSeq;
      const analysis = await ai.analyzePrompt(S().session.rawThought, { signal, inputSource });
      if (myReq !== reqSeq) return; // stale response (cancelled / superseded)
      if (S().interaction !== "understanding") return;
      voiceFlowActive = false;
      store.dispatch(act.completeUnderstanding(analysis));
      store.dispatch(act.structurePrompt(analysis.prompt));
      await wait(d.structuringSettle + 200);
      await persistSession();
    } catch (e) {
      voiceFlowActive = false;
      if (isAborted(e)) return; // superseded by a newer request
      store.dispatch(act.error(e.code === "AI_TIMEOUT" ? ERR.AI_TIMEOUT : ERR.AI_ERROR,
        "Something interrupted the flow. Try again."));
    }
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

  /* ---- Confirm → Ready → Sending → Delivered ---- */
  async function confirmAndSend() {
    const s = S().interaction;
    if (s === "idle" || s === "input") return submitThought();
    if (s === "editing") {
      store.dispatch(act.showMessage("Finish editing first — press Enter to save."));
      return;
    }
    if (s !== "review") return;

    store.dispatch(act.confirmPrompt());
    await wait(d.readyToSend);
    if (S().interaction !== "ready_to_send") return;
    store.dispatch(act.sendPrompt());
    try {
      await delivery.deliver(activePrompt(S())); // demo: prepares channel
      await wait(d.sending);
      if (S().interaction !== "sending") return;
      store.dispatch(act.deliveryComplete());
    } catch (e) {
      store.dispatch(act.error(ERR.DELIVERY_ERROR, "Delivery failed. Your prompt is still here."));
    }
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
    voice.onTranscript((text, isFinal) => {
      store.dispatch(act.voiceTranscript(text, isFinal));
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
    const draft = (S().inbox.draft || "").trim();
    if (!draft) return;
    const current = S().input || "";
    const merged = current ? current + (draft ? " " + draft : "") : draft;
    store.dispatch(act.updateInput(merged));
    store.dispatch(act.inboxUpdateDraft("")); // consumed the capture field
    store.dispatch(act.showMessage("Added to your prompt."));
  }

  /* REFINE (3C-2B): the unique Creative Inbox entry path.
     Composer content → AI analyze → createThought. The Thought's originalText is
     a snapshot of the user's exact Composer words (preserved byte-for-byte),
     and the AI output is attached as refinedText via INBOX_REFINE. The Composer
     text itself is preserved (REFINE captures for the inbox; it does not consume
     the input). */
  async function refineFromComposer() {
    const source = S().input.trim();
    if (!source) return;
    // Bug #10: only LIVE voice blocks REFINE — listening/processing. A terminal
    // error must NOT block the fallback path: after a speech error the words are
    // already in the Composer (or typeable), and REFINE into the Creative Inbox
    // is exactly the recovery the user needs.
    if (S().voice === "listening" || S().voice === "processing") return; // don't refine mid-voice
    voiceFlowActive = false;
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
      // originalText = user's exact words; refinedText = AI output. Never both
      // equal — the AI never overwrites what the user actually said.
      const created = S().inbox.thoughts.length
        ? S().inbox.thoughts[S().inbox.thoughts.length - 1].id
        : null;
      store.dispatch(act.inboxAddRefined(source, "text"));
      const fresh = S().inbox.thoughts[S().inbox.thoughts.length - 1];
      if (fresh && fresh.id !== created) {
        store.dispatch(act.inboxRefine(fresh.id, refined));
      }
      // REFINE succeeded → the user has recovered past the transient speech
      // error. UPDATE_INPUT echoes the same value but its reducer also clears
      // state.error, so the stale "tap the mic to retry" hint doesn't linger
      // after the user already recovered via typing + REFINE (Bug #10).
      store.dispatch(act.updateInput(S().input));
      store.dispatch(act.showToast("REFINED → INBOX"));
    } catch (e) {
      // refinement is best-effort; the Composer text is never lost
      if (!isAborted(e)) store.dispatch(act.showToast("REFINE UNAVAILABLE"));
    }
  }

  /* USE (3C-2B): take a Thought back into the Composer — NO auto-submit.
     The user gets the refined text (or original) into the Composer and stays in
     full control: edit it, REFINE it again, or submit via the Composer entry. */
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
    store.dispatch(act.updateInput(trimmed));
    store.dispatch(act.showMessage("Brought back to your prompt — edit or send it."));
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
    addThoughtFromInbox,
    refineFromComposer,
    sendThoughtToPrompt,
    copyThoughtToClipboard
  };
}
