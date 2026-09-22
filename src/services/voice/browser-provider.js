/* BrowserSpeechProvider — VoiceService adapter over Web Speech API.
   All browser specifics live here; flows/UI see only the interface.

   Continuous listening (Phase 3C-2A): a pause must NOT end the session.
   recognition.continuous = true and, when the browser ends a segment on its
   own (onend without an explicit user stop), we automatically restart so the
   user can keep talking after thinking. Only an explicit stop() (user says
   "I'm done") or abort() (user cancels) stops the loop for good. */

export function createBrowserSpeechProvider(win) {
  const w = win || (typeof window !== "undefined" ? window : {});
  const SR = w.SpeechRecognition || w.webkitSpeechRecognition;

  let recognition = null;
  let userStopped = false; // set by stop()/abort() — no auto-restart after these
  let active = false;      // this provider instance has a live recognition loop
  let carryText = "";      // accumulated transcript preserved across an auto-restart
  let lastEmitted = "";    // most recent text we reported (the carry baseline)
  let segmentSeq = 0;      // final segments seen in this session (1-based per final).
    // Incremented exactly once per NEW final segment. Same final re-raised as a
    // duplicate browser event keeps the same seq. This lets the machine tell
    // "same final re-emitted" (deduplicate) vs "genuinely two separate finals"
    // (keep both, even when their text is identical — user repeated themselves).
  let finalSig = null;     // { seq, isFinal, hash } — last signature we actually emitted for a FINAL.
    // Ensures the onend fallback never re-emits a final already sent via onresult.
  // VOICE-DUP: per-instance deduplication. A single recognition instance may see
  // Chrome re-raise the SAME final result (with identical resultIndex + text)
  // as a duplicate onresult. We must NOT re-add the same final portion to
  // carryText a second time — otherwise carryText + fresh double-counts and
  // leaks a duplicated transcript delta downstream. freshFinalForInstance tracks
  // the already-committed final signature for *the current* recognition object,
  // keyed by its lastFinal hash + lastFinalResultIndex. A genuinely new segment
  // (or a new recognition instance after auto-restart, or a legitimately
  // repeated utterance after an interim) gets a new signature and is added.
  let instanceDedup = null; // { instance, resultIndex, hash }
  function instanceKeyFor(r, resultIndex, freshText, isFinal) {
    if (!isFinal) return null;
    return {
      instance: r,
      resultIndex: Number(resultIndex) >>> 0,
      hash: sha(String(freshText || ""))
    };
  }
  function sameInstanceFinal(r, resultIndex, freshText) {
    if (!instanceDedup) return false;
    return instanceDedup.instance === r
      && instanceDedup.resultIndex === (Number(resultIndex) >>> 0)
      && instanceDedup.hash === sha(String(freshText || ""));
  }
  function sha(s) {
    // Tiny stable 32-bit fingerprint — not crypto, but enough to distinguish
    // 64KB-or-less transcripts reliably without a dependency.
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }
  function sameSigAsLastFinal(seq, isFinal, text) {
    if (!isFinal || !finalSig) return false;
    return finalSig.seq === seq
      && finalSig.isFinal === isFinal
      && finalSig.hash === sha(String(text || ""));
  }
  function markFinalSig(seq, isFinal, text) {
    if (!isFinal) { finalSig = null; return; }
    finalSig = { seq, isFinal: true, hash: sha(String(text || "")) };
  }
  let transcriptCb = () => {};
  let endCb = () => {};    // final end: user stop or real end, flow decides
  let errorCb = () => {};

  return {
    isAvailable() {
      return !!SR;
    },

    start() {
      return new Promise((resolve, reject) => {
        if (!SR) {
          reject(Object.assign(new Error("Speech recognition unsupported"), { code: "VOICE_UNAVAILABLE" }));
          return;
        }
        try {
          userStopped = false;
          active = true;
          carryText = ""; // fresh session: nothing carried over
          lastEmitted = "";
          segmentSeq = 0;
          finalSig = null;
          instanceDedup = null;
          recognition = createRecognition();
          bindRecognition(recognition);
          recognition.start();
          resolve();
        } catch (err) {
          active = false;
          reject(Object.assign(err, { code: "VOICE_UNAVAILABLE" }));
        }
      });
    },

    /* STOP/DONE: user says "I'm done" — finalize this segment, no auto-restart. */
    stop() {
      userStopped = true;
      if (recognition) {
        try { recognition.stop(); } catch (e) { /* already stopped */ }
      }
      return Promise.resolve();
    },

    /* CANCEL: abandon the session; trailing "aborted" error/end events are noise. */
    abort() {
      userStopped = true;
      active = false;
      if (recognition) {
        try { recognition.abort(); } catch (e) { /* already stopped */ }
      }
      return Promise.resolve();
    },

    onTranscript(cb) { transcriptCb = cb || (() => {}); },
    onEnd(cb) { endCb = cb || (() => {}); },
    onError(cb) { errorCb = cb || (() => {}); }
  };

  function createRecognition() {
    const r = new SR();
    const zh = ((w.navigator && w.navigator.language) || "").toLowerCase().startsWith("zh");
    r.lang = zh ? "zh-CN" : "en-US";
    r.interimResults = true;
    r.continuous = true; // pausing must not end the session
    return r;
  }

  function bindRecognition(r) {
    r.onresult = (e) => {
      // Instance guard (3C-2B Bug #9): after a second start(), a stale event
      // from a previous recognition instance must be discarded. Without this,
      // the old instance's late onresult/onend is misread as this session's
      // pause → triggers an unwanted auto-restart → browser force-ends the
      // current instance → infinite restart loop.
      if (r !== recognition) return;
      // 3D-RC2 GATE A — finals-accumulation model. In continuous mode Chrome
      // re-delivers the WHOLE accumulated result list on every event;
      // e.resultIndex marks the FIRST result that changed. Only
      // [resultIndex..] is new — iterating from 0 re-counts already-finalized
      // segments, so carryText + "fresh" double-counted every earlier segment
      // (the 3D duplication bug: segment 2+ arrived as carryText+allHistory).
      const startIdx = Number(e.resultIndex) >>> 0;
      let freshFinal = "";    // new FINAL text in this event (gets committed)
      let freshInterim = "";   // new/updated INTERIM text (preview only)
      for (let i = startIdx; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = (res && res[0] && res[0].transcript) || "";
        if (res && res.isFinal) freshFinal += txt;
        else freshInterim += txt;
      }

      if (freshFinal) {
        // Duplicate-final replay guard (VOICE-DUP-01/03): Chrome can re-raise
        // the SAME final (same instance + same resultIndex + same text). A
        // genuinely new segment advances resultIndex inside the instance, or
        // runs on a NEW instance after a pause auto-restart (instanceDedup is
        // wiped there) — including a legal repeated utterance (VOICE-DUP-06).
        if (sameInstanceFinal(r, startIdx, freshFinal)) {
          return; // swallow duplicate: no carry, no emit, no seq change.
        }
        instanceDedup = instanceKeyFor(r, startIdx, freshFinal, true);
        segmentSeq += 1;              // exactly one bump per NEW final segment
        carryText = carryText + freshFinal; // cumulative session transcript
        lastEmitted = carryText;
        markFinalSig(segmentSeq, true, carryText);
        transcriptCb(carryText, true, segmentSeq);
        if (freshInterim) {
          // Same event also carries the start of the next segment — surface
          // it live (preview only; it commits when its own final arrives).
          transcriptCb(carryText + freshInterim, false, segmentSeq);
          lastEmitted = carryText + freshInterim;
        }
        return;
      }
      if (freshInterim) {
        // Growing preview: committed finals + the live interim tail.
        transcriptCb(carryText + freshInterim, false, segmentSeq);
        lastEmitted = carryText + freshInterim;
        return;
      }
      // Restart boundary: new instance produced no text yet, but we hold a
      // finalized baseline the flow hasn't seen. Deliver it as final.
      if (carryText !== lastEmitted) {
        const seq = segmentSeq || 1;
        if (sameSigAsLastFinal(seq, true, carryText)) return;
        transcriptCb(carryText, true, seq);
        lastEmitted = carryText;
        markFinalSig(seq, true, carryText);
      }
    };
    r.onerror = (e) => {
      // Instance guard (Bug #9): stale errors from a previous instance are noise.
      if (r !== recognition) return;
      // "aborted" is the expected result of our own abort() (user cancel) — not an error.
      if (e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        errorCb("VOICE_UNAVAILABLE"); // permission denied / mic blocked
      } else if (e.error === "no-speech") {
        // 3D-RC2 GATE A — graceful silence: in continuous mode a silent pause
        // makes the browser end the segment and onend auto-restarts the loop.
        // Surfacing it as an error mid-loop would flip the UI to error state
        // and make the machine DROP every transcript after the pause. Only
        // forward no-speech when the loop is actually terminating.
        if (!active || userStopped) errorCb("VOICE_NO_SPEECH");
      } else {
        errorCb("VOICE_ERROR");
      }
    };
    r.onend = () => {
      // Instance guard (Bug #9): a stale onend from a previous recognition
      // instance must never restart the CURRENT loop. With the guard, the old
      // instance's late onend is dropped instead of being treated as a pause
      // of the new session.
      if (r !== recognition) return;
      // A pause triggered a browser-level end of this segment. Auto-restart so
      // the user can keep talking — UNLESS the user explicitly stopped/cancelled.
      if (!active || userStopped) {
        active = false;
        // Deliver any finalized baseline the flow hasn't seen yet (e.g. the
        // browser ended without a final onresult right before stop()).
        if (carryText !== lastEmitted) {
          const seq = segmentSeq || 1;
          if (!sameSigAsLastFinal(seq, true, carryText)) {
            transcriptCb(carryText, true, seq);
            lastEmitted = carryText;
            markFinalSig(seq, true, carryText);
          }
        }
        endCb(); // final end → flow decides what to do with the accumulated text
        return;
      }
      try {
        const next = createRecognition();
        recognition = next;   // update the instance ref BEFORE binding, so the
        instanceDedup = null; // new instance: previous per-instance dedup keys
                              // are irrelevant; fresh resultIndex starts at 0.
        bindRecognition(next); // instance guard in the new handlers sees it
        next.start(); // the carry baseline survives into the next segment
      } catch (err) {
        active = false;
        errorCb("VOICE_ERROR");
      }
    };
  }
}
