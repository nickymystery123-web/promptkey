/* Voice Interaction Loop tests (Phase 3C-1 + 3C-2A + 3C-2B).
   Covers: live transcript, explicit-stop → Composer append (voice is INPUT
   ONLY — it never creates a Thought; Creative Inbox is reached ONLY via
   REFINE), cancel semantics, abort/stale protection, error recovery,
   continuous-listening provider behavior (pause auto-restart + transcript
   carry), and the Original/Optimized selection reached via USE (take-back)
   + manual submit.
   Zero delays, controllable mock voice service, controllable mock AI. No DOM. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/state/store.js";
import { act, ERR } from "../src/state/actions.js";
import { createFlows } from "../src/flows/prompt-flow.js";

import { createBrowserSpeechProvider } from "../src/services/voice/browser-provider.js";
import { assertVoiceService } from "../src/services/voice/interface.js";

const zeroDelays = {
  understandStep: 0, understandFirst: 0, structuringSettle: 0,
  readyToSend: 0, sending: 0, transcribing: 0
};

/* flush microtasks + a few macrotask ticks (flows use setTimeout(0) waits) */
async function tick(n = 6) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/* ---- controllable mock VoiceService ---- */
function mockVoice({ available = true } = {}) {
  const cbs = { transcript: () => {}, end: () => {}, error: () => {} };
  const calls = { start: 0, stop: 0, abort: 0 };
  return {
    calls,
    available,
    isAvailable() { return this.available; },
    async start() { calls.start++; },
    async stop() { calls.stop++; },
    async abort() { calls.abort++; },
    onTranscript(cb) { cbs.transcript = cb; },
    onEnd(cb) { cbs.end = cb; },
    onError(cb) { cbs.error = cb; },
    emitTranscript(text, isFinal) { cbs.transcript(text, isFinal); },
    emitEnd() { return cbs.end(); },
    emitError(code) { cbs.error(code); }
  };
}

/* ---- controllable mock AI: FIFO gates (multi-hang), counts calls, can fail ---- */
function mockAI() {
  const calls = { analyze: 0, improve: 0, rewrite: 0 };
  const gates = []; // each analyze consumes the next unresolved gate
  let fail = 0;
  const api = {
    calls,
    lastSignal: null,
    lastOptions: null,
    hangNext() {
      const gate = {};
      gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
      gate.resolved = false;
      gates.push(gate);
    },
    releaseNext() {
      const gate = gates.find((g) => !g.resolved);
      if (gate) { gate.resolved = true; gate.resolve(); }
    },
    failNext() { fail++; },
    analyzePrompt(input, options = {}) {
      calls.analyze++;
      api.lastSignal = options.signal || null;
      api.lastOptions = options;
      const respond = () => ({
        prompt: {
          role: "Expert Assistant",
          objective: "OPTIMIZED ▸ " + input,
          context: "",
          requirements: ["Clear"],
          style: ["Minimal"],
          output: ""
        },
        detectedIntent: "general"
      });
      if (fail > 0) {
        fail--;
        return Promise.reject(Object.assign(new Error("mock AI failure"), { code: "AI_ERROR" }));
      }
      // NOTE: intentionally ignores options.signal — a provider that never aborts,
      // so state-level stale protection (reqSeq) is what must save us.
      const gate = gates.find((g) => !g.consumed);
      if (gate) { gate.consumed = true; return gate.promise.then(respond); }
      return Promise.resolve(respond());
    },
    async improvePrompt(p) { calls.improve++; return p; },
    async rewritePrompt(p) { calls.rewrite++; return p; }
  };
  return api;
}

function harness({ voiceAvailable = true } = {}) {
  const store = createStore();
  const ai = mockAI();
  const voice = mockVoice({ available: voiceAvailable });
  const storage = {
    saveSession: async () => {}, loadSession: async () => null, clearSession: async () => {},
    savePosition: async () => {}, loadPosition: async () => null
  };
  const delivered = { calls: 0, copies: [], prompts: [] };
  const delivery = {
    deliver: async (prompt) => { delivered.calls++; delivered.prompts.push(prompt); return { ok: true }; },
    copy: async (text) => { delivered.copies.push(text); }
  };
  const flows = createFlows({ store, ai, voice, delivery, storage, delays: zeroDelays });
  flows.bindVoiceCallbacks();
  return { store, ai, voice, flows, delivered };
}

/* ============ A. Voice start ============ */
test("A: voice start → listening state, service started", async () => {
  const h = harness();
  await h.flows.toggleVoice();
  assert.equal(h.store.getState().voice, "listening");
  assert.equal(h.voice.calls.start, 1);
});

/* ============ B. Live interim transcript ============ */
test("B: interim transcript updates preview only — input untouched, no AI", async () => {
  const h = harness();
  await h.flows.toggleVoice();
  h.voice.emitTranscript("把首页", false);
  h.voice.emitTranscript("把首页弄", false);
  const s = h.store.getState();
  assert.deepEqual(s.voiceTranscript, { text: "把首页弄", final: false });
  assert.equal(s.input, ""); // interim never commits
  assert.equal(h.ai.calls.analyze, 0);
});

/* ============ C. Final transcript ============ */
test("C: final transcript commits to input verbatim", async () => {
  const h = harness();
  await h.flows.toggleVoice();
  const exact = "帮我把 Deep seek 页面弄得高级一点";
  h.voice.emitTranscript(exact, true);
  const s = h.store.getState();
  assert.equal(s.input, exact); // byte-for-byte, no mutation
  assert.deepEqual(s.voiceTranscript, { text: exact, final: true });
});

/* ============ D. Explicit stop → Composer (3C-2B: NO auto-AI, NO inbox Thought) ============ */
test("D: explicit stop appends the voice final to the Composer — never auto-submits to AI, never creates a Thought", async () => {
  const h = harness();
  await h.flows.toggleVoice();
  h.voice.emitTranscript("create a landing page", true);
  await h.voice.emitEnd(); // user tapped stop → provider's final end
  await tick();
  const s = h.store.getState();
  assert.equal(s.voice, "idle");
  assert.equal(h.ai.calls.analyze, 0); // 3C-2B: voice is INPUT ONLY — no auto-AI
  assert.equal(s.input, "create a landing page"); // final appended to Composer
  assert.equal(s.inbox.thoughts.length, 0); // voice never creates an inbox Thought
  assert.match(s.message.text, /Added to your prompt/); // user decides next: REFINE or send
});

/* ============ E. Interim never triggers AI ============ */
test("E: interim-only session ends without any AI call", async () => {
  const h = harness();
  await h.flows.toggleVoice();
  h.voice.emitTranscript("half a thought", false); // interim only
  await h.voice.emitEnd();
  await tick();
  assert.equal(h.ai.calls.analyze, 0);
  assert.equal(h.store.getState().voice, "idle");
  assert.equal(h.store.getState().inbox.thoughts.length, 0); // nothing final → nothing saved
  assert.match(h.store.getState().message.text, /Didn't catch that/);
});

/* ============ F. Cancel before final transcript ============ */
test("F: cancel before final discards transcript, restores draft, never calls AI", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("typed draft"));
  await h.flows.toggleVoice();
  h.voice.emitTranscript("spoken words", false);
  await h.flows.cancelVoice();
  const s = h.store.getState();
  assert.equal(s.voice, "idle");
  assert.equal(s.voiceTranscript, null);
  assert.equal(s.input, "typed draft"); // pre-voice draft restored
  assert.equal(h.voice.calls.abort, 1);
  assert.equal(h.ai.calls.analyze, 0);
  assert.equal(s.inbox.thoughts.length, 0); // cancelled → nothing saved
  // late onEnd from the aborted recognition must not submit anything
  await h.voice.emitEnd();
  await tick();
  assert.equal(h.ai.calls.analyze, 0);
});

/* ============ G. Cancel after a pending REFINE ============ */
test("G: cancelling a pending REFINE kills the request (stale response ignored)", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("create a landing page"));
  h.ai.hangNext();
  const refinePromise = h.flows.refineFromComposer(); // REFINE hangs
  await tick();
  assert.equal(h.store.getState().refinePending, true, "REFINE 进行中");
  assert.equal(h.ai.calls.analyze, 1);

  h.flows.newThought(); // user abandons this prompt
  const s = h.store.getState();
  assert.equal(s.interaction, "idle");
  assert.equal(s.input, "", "Composer 被清空");
  assert.equal(h.ai.lastSignal.aborted, true);

  // late response arrives → must be ignored completely
  h.ai.releaseNext();
  await refinePromise;
  await tick();
  const s2 = h.store.getState();
  assert.equal(s2.interaction, "idle");
  assert.equal(s2.refinePending, false);
  assert.equal(s2.inbox.thoughts.length, 0, "取消后无 Thought 入箱");
});

/* ============ H. Abort pending REFINE request ============ */
test("H: pending REFINE receives a real AbortSignal that aborts on newThought", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("anything"));
  h.ai.hangNext();
  h.flows.refineFromComposer();
  await tick();
  assert.ok(h.ai.lastSignal instanceof AbortSignal);
  assert.equal(h.ai.lastSignal.aborted, false);
  h.flows.newThought();
  assert.equal(h.ai.lastSignal.aborted, true);
  h.ai.releaseNext();
  await tick();
});

/* ============ I. Stale response ignored (REFINE A cancelled → REFINE B starts → A arrives late) ============ */
test("I: stale response from cancelled REFINE A never pollutes REFINE B", async () => {
  const h = harness();

  // --- A: REFINE "thought A", hangs ---
  h.store.dispatch(act.updateInput("thought A"));
  h.ai.hangNext();
  const refineA = h.flows.refineFromComposer();
  await tick();
  assert.equal(h.store.getState().refinePending, true);
  const signalA = h.ai.lastSignal;

  // --- user cancels A, starts B ---
  h.flows.newThought();
  assert.equal(h.store.getState().interaction, "idle");
  assert.equal(signalA.aborted, true);

  h.store.dispatch(act.updateInput("thought B"));
  h.ai.hangNext();
  const refineB = h.flows.refineFromComposer(); // B hangs
  await tick();
  assert.equal(h.ai.calls.analyze, 2);

  // --- A's response finally arrives (provider ignored the abort signal) ---
  h.ai.releaseNext();
  await refineA;
  await tick();
  assert.equal(h.store.getState().refinePending, true, "B still pending");
  assert.equal(h.store.getState().inbox.thoughts.length, 0, "A's stale response ignored");

  // --- B completes ---
  h.ai.releaseNext();
  await refineB;
  await tick();
  assert.equal(h.store.getState().refinePending, false);
  assert.equal(h.store.getState().input, "OPTIMIZED ▸ thought B", "REFINE B 写 Composer");
  assert.equal(h.store.getState().inbox.thoughts.length, 0, "REFINE 本身不入箱");

  await h.flows.submitThought();
  await tick();
  const s = h.store.getState();
  assert.equal(s.input, "");
  assert.equal(s.inbox.thoughts.length, 1);
  assert.equal(s.inbox.thoughts[0].originalText, "thought B");
  assert.match(s.inbox.thoughts[0].refinedText, /thought B/);
});

/* ============ J. Browser unsupported ============ */
test("J: browser without SpeechRecognition → VOICE_UNAVAILABLE, app stays usable", async () => {
  const h = harness({ voiceAvailable: false });
  await h.flows.toggleVoice();
  const s = h.store.getState();
  assert.equal(s.voice, "error");
  assert.equal(s.error.code, ERR.VOICE_UNAVAILABLE);
  assert.match(s.error.message, /type your thought/);
  assert.equal(h.voice.calls.start, 0);
});

/* ============ K. Permission denied ============ */
test("K: mic permission denied (provider maps not-allowed) → VOICE_UNAVAILABLE + fallback hint", async () => {
  const h = harness();
  await h.flows.toggleVoice();
  h.voice.emitError("VOICE_UNAVAILABLE"); // provider already mapped not-allowed → this code
  const s = h.store.getState();
  assert.equal(s.voice, "error");
  assert.equal(s.error.code, ERR.VOICE_UNAVAILABLE);
  assert.match(s.error.message, /type your thought/);
});

/* ============ L. Speech recognition error ============ */
test("L: speech error → recoverable error state with retry hint, no AI call", async () => {
  const h = harness();
  await h.flows.toggleVoice();
  h.voice.emitTranscript("partial", false);
  h.voice.emitError("VOICE_ERROR");
  const s = h.store.getState();
  assert.equal(s.voice, "error");
  assert.match(s.error.message, /retry, or type instead/);
  assert.equal(s.voiceTranscript, null); // temp transcript cleared
  assert.equal(h.ai.calls.analyze, 0);
});

/* ============ M. Retry after error ============ */
test("M: after error, tapping mic again retries → listening", async () => {
  const h = harness();
  await h.flows.toggleVoice();
  h.voice.emitError("VOICE_ERROR");
  assert.equal(h.store.getState().voice, "error");
  await h.flows.toggleVoice(); // retry
  assert.equal(h.store.getState().voice, "listening");
  assert.equal(h.voice.calls.start, 2);
  assert.equal(h.store.getState().error, null);
});

/* ============ N. Text fallback after error ============ */
test("N: after voice error, typing still works end-to-end", async () => {
  const h = harness({ voiceAvailable: false });
  await h.flows.toggleVoice(); // → error
  h.store.dispatch(act.updateInput("write a marketing email"));
  await h.flows.submitThought();
  await tick();
  // 3E 简化：SUBMIT 不再走 understanding → review 管线，直接入箱
  assert.equal(h.store.getState().interaction, "idle");
  assert.equal(h.store.getState().inbox.thoughts.length, 1);
  assert.equal(h.store.getState().inbox.thoughts[0].originalText, "write a marketing email");
  assert.equal(h.ai.calls.analyze, 0, "SUBMIT 不调用 AI");
});



/* ============ machine-level: cancel transitions ============ */
test("machine: VOICE_CANCEL only acts from listening/processing; restores pre-voice input", async () => {
  const store = createStore();
  store.dispatch(act.cancelVoice());
  assert.equal(store.getState().voice, "idle"); // no-op from idle

  store.dispatch(act.updateInput("draft"));
  store.dispatch(act.startVoice());
  store.dispatch(act.voiceTranscript("partial", false));
  store.dispatch(act.cancelVoice());
  let s = store.getState();
  assert.equal(s.voice, "idle");
  assert.equal(s.input, "draft");
  assert.equal(s.voiceTranscript, null);

  // cancel from processing (after stop, before done)
  store.dispatch(act.startVoice());
  store.dispatch(act.voiceTranscript("final words", true));
  store.dispatch(act.stopVoice());
  assert.equal(store.getState().voice, "processing");
  store.dispatch(act.cancelVoice());
  s = store.getState();
  assert.equal(s.voice, "idle");
  assert.equal(s.input, "draft"); // final transcript discarded too
});

test("machine: stale VOICE_TRANSCRIPT outside listening is dropped", () => {
  const store = createStore();
  store.dispatch(act.voiceTranscript("ghost", true));
  const s = store.getState();
  assert.equal(s.input, "");
  assert.equal(s.voiceTranscript, null);
});

/* ============ provider-level: browser-provider error mapping & abort ============ */
function fakeSpeechWindow() {
  const instances = [];
  class FakeSR {
    constructor() { instances.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
  }
  return { win: { SpeechRecognition: FakeSR, navigator: { language: "zh-CN" } }, instances };
}

test("provider: satisfies the VoiceService contract incl. abort()", () => {
  const { win } = fakeSpeechWindow();
  const p = assertVoiceService(createBrowserSpeechProvider(win));
  assert.equal(typeof p.abort, "function");
  assert.equal(p.isAvailable(), true);
});

test("provider: maps not-allowed→VOICE_UNAVAILABLE; no-speech mid-loop is swallowed (graceful silence), aborted swallowed", async () => {
  const { win, instances } = fakeSpeechWindow();
  const p = createBrowserSpeechProvider(win);
  const errors = [];
  p.onError((code) => errors.push(code));
  await p.start();
  const rec = instances[0];
  rec.onerror({ error: "not-allowed" });
  // A silent pause while the continuous loop is alive: onend auto-restarts,
  // surfacing it as an error would flip the UI to error and drop the next
  // segment's transcripts (3D-RC2 GATE A graceful-silence contract).
  rec.onerror({ error: "no-speech" });
  rec.onerror({ error: "audio-capture" });
  rec.onerror({ error: "aborted" }); // our own cancel noise — must not surface
  assert.deepEqual(errors, ["VOICE_UNAVAILABLE", "VOICE_ERROR"]);
  // no-speech only surfaces when the loop is actually terminating.
  await p.stop();
  rec.onerror({ error: "no-speech" });
  assert.deepEqual(errors, ["VOICE_UNAVAILABLE", "VOICE_ERROR", "VOICE_NO_SPEECH"]);
});

test("provider: abort() aborts recognition; stop() stops it", async () => {
  const { win, instances } = fakeSpeechWindow();
  const p = createBrowserSpeechProvider(win);
  await p.start();
  await p.abort();
  assert.equal(instances[0].aborted, true);
  await p.start();
  await p.stop();
  assert.equal(instances[1].stopped, true);
});

test("provider: unavailable without SpeechRecognition; start rejects VOICE_UNAVAILABLE", async () => {
  const p = createBrowserSpeechProvider({ navigator: { language: "en-US" } });
  assert.equal(p.isAvailable(), false);
  await assert.rejects(p.start(), (e) => e.code === "VOICE_UNAVAILABLE");
});

/* ============ provider-level: continuous listening (Phase 3C-2A) ============ */
test("provider: a pause auto-restarts recognition without ending the session", async () => {
  const { win, instances } = fakeSpeechWindow();
  const p = createBrowserSpeechProvider(win);
  let ends = 0;
  p.onEnd(() => { ends++; });
  await p.start();
  assert.equal(instances.length, 1);
  instances[0].onend(); // browser ends this segment on its own (a pause)
  assert.equal(instances.length, 2); // auto-restarted
  assert.equal(instances[1].started, true);
  assert.equal(ends, 0); // session NOT ended
  instances[1].onend(); // another pause
  assert.equal(instances.length, 3);
  assert.equal(ends, 0);
});

test("provider: only an explicit stop ends the session (no further restart)", async () => {
  const { win, instances } = fakeSpeechWindow();
  const p = createBrowserSpeechProvider(win);
  let ends = 0;
  p.onEnd(() => { ends++; });
  await p.start();
  instances[0].onend(); // pause → restart
  assert.equal(instances.length, 2);
  await p.stop(); // user says done
  assert.equal(instances[1].stopped, true);
  instances[1].onend(); // browser fires the final end
  assert.equal(ends, 1);
  assert.equal(instances.length, 2); // no restart after user stop
});

test("provider: abort() cancels the loop — trailing end is the only end, no restart", async () => {
  const { win, instances } = fakeSpeechWindow();
  const p = createBrowserSpeechProvider(win);
  let ends = 0;
  p.onEnd(() => { ends++; });
  await p.start();
  await p.abort();
  assert.equal(instances[0].aborted, true);
  instances[0].onend();
  assert.equal(ends, 1);
  assert.equal(instances.length, 1);
});

test("provider: an auto-restart carries finalized text so no finished thought is lost", async () => {
  const { win, instances } = fakeSpeechWindow();
  const p = createBrowserSpeechProvider(win);
  const seen = [];
  p.onTranscript((text, isFinal) => seen.push({ text, isFinal }));
  await p.start();
  instances[0].onresult({ results: [{ 0: { transcript: "把首页" }, isFinal: true }] });
  assert.equal(seen[0].text, "把首页");
  assert.equal(seen[0].isFinal, true);
  instances[0].onend();
  assert.equal(instances.length, 2);
  instances[1].onresult({ results: [{ 0: { transcript: "弄高级" }, isFinal: false }] });
  assert.equal(seen[1].text, "把首页弄高级");
  assert.equal(seen[1].isFinal, false);
  instances[1].onresult({ results: [{ 0: { transcript: "弄高级" }, isFinal: true }] });
  assert.equal(seen[2].text, "把首页弄高级");
  assert.equal(seen[2].isFinal, true);
});

test("provider: stop() after a final transcript still ends without losing text", async () => {
  const { win, instances } = fakeSpeechWindow();
  const p = createBrowserSpeechProvider(win);
  const seen = [];
  p.onTranscript((text, isFinal) => seen.push({ text, isFinal }));
  await p.start();
  instances[0].onresult({ results: [{ 0: { transcript: "hi" }, isFinal: true }] });
  await p.stop();
  instances[0].onend();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, "hi");
  assert.equal(seen[0].isFinal, true);
});
