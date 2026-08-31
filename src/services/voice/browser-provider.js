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
      // Fresh segment for THIS recognition instance. When we auto-restarted,
      // carryText holds the already-finalized baseline from before the pause;
      // the new segment is appended so the session's transcript never loses
      // a finished thought just because the browser split the stream.
      let fresh = "";
      let freshFinal = false;
      for (let i = 0; i < e.results.length; i++) {
        fresh += e.results[i][0].transcript;
        if (e.results[i].isFinal) freshFinal = true;
      }
      if (fresh) {
        const full = carryText + fresh;
        transcriptCb(full, freshFinal);
        if (freshFinal) {
          carryText = full;      // baseline locked — future segments append after it
          lastEmitted = full;
        } else {
          lastEmitted = full;    // so a stop() right after still reports the latest interim
        }
      } else if (carryText !== lastEmitted) {
        // Restart boundary: new instance produced no text yet, but we hold a
        // finalized baseline the flow hasn't seen. Deliver it as final.
        transcriptCb(carryText, true);
        lastEmitted = carryText;
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
        errorCb("VOICE_NO_SPEECH");   // heard nothing — recoverable, retry or type
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
          transcriptCb(carryText, true);
          lastEmitted = carryText;
        }
        endCb(); // final end → flow decides what to do with the accumulated text
        return;
      }
      try {
        const next = createRecognition();
        recognition = next;   // update the instance ref BEFORE binding, so the
        bindRecognition(next); // instance guard in the new handlers sees it
        next.start(); // the carry baseline survives into the next segment
      } catch (err) {
        active = false;
        errorCb("VOICE_ERROR");
      }
    };
  }
}
