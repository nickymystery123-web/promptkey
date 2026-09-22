/* Voice error → close → reopen reset tests (Bug #10).
   User spec:
     1. Inside the Float after a voice error: RETRY shown; tapping mic retries;
        or the user can recover to idle.
     2. Closing PromptKey Float MUST terminate/clean up the current Voice
        Session, clear the voice error, and leave NO listening / processing /
        error residue after close.
     3. Re-opening the Float: voice MUST start from idle; the Composer stays
        editable; whenever the Composer has content, REFINE MUST be usable.
     4. New dedicated test: idle → Voice Error → CLOSE_FLOAT → OPEN_FLOAT →
        voice === idle → Composer input → REFINE enabled → REFINE lands in Inbox.
   Zero delays, mock voice/AI, real reducer + flows. No DOM. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/state/store.js";
import { act, ERR } from "../src/state/actions.js";
import { createFlows } from "../src/flows/prompt-flow.js";
import { canRefine, canConfirm, inboxThoughts } from "../src/state/selectors.js";

const zeroDelays = {
  understandStep: 0, understandFirst: 0, structuringSettle: 0,
  readyToSend: 0, sending: 0, transcribing: 0
};
async function tick(n = 8) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/* ---- controllable mock AI (same shape as voice-loop/3c-2b) ---- */
function mockAI() {
  const calls = { analyze: 0, improve: 0, rewrite: 0 };
  const api = {
    calls,
    lastOptions: null,
    analyzePrompt(input, options = {}) {
      calls.analyze++;
      api.lastOptions = options;
      return Promise.resolve({
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
    },
    async improvePrompt(p) { calls.improve++; return p; },
    async rewritePrompt(p) { calls.rewrite++; return p; }
  };
  return api;
}

/* ---- controllable mock VoiceService ---- */
function mockVoice() {
  const cbs = { transcript: () => {}, end: () => {}, error: () => {} };
  const calls = { start: 0, stop: 0, abort: 0 };
  return {
    calls,
    isAvailable() { return true; },
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

function harness() {
  const store = createStore();
  const ai = mockAI();
  const voice = mockVoice();
  const storage = {
    saveSession: async () => {}, loadSession: async () => null, clearSession: async () => {},
    savePosition: async () => {}, loadPosition: async () => null
  };
  const delivery = { deliver: async () => ({ ok: true }), copy: async () => {} };
  const flows = createFlows({ store, ai, voice, delivery, storage, delays: zeroDelays });
  flows.bindVoiceCallbacks();
  return { store, ai, voice, flows };
}

/* 需求 1：Float 内 error 态 —— RETRY 渲染由 renderer 负责（voiceCaption="RETRY"）；
   本测试验证状态层：error 后 tap mic = retry → listening；或 RESET/恢复 idle。 */
test("1: inside the Float, error shows retryable state; mic tap retries → listening", async () => {
  const h = harness();
  await h.flows.toggleVoice();
  h.voice.emitTranscript("partial words", false);
  h.voice.emitError("VOICE_ERROR");
  let s = h.store.getState();
  assert.equal(s.voice, "error");
  assert.match(s.error.message, /retry, or type instead/);
  assert.equal(s.voiceTranscript, null);

  // tap mic again = retry → back to listening
  await h.flows.toggleVoice();
  s = h.store.getState();
  assert.equal(s.voice, "listening");
  assert.equal(s.error, null);
  assert.equal(h.voice.calls.start, 2);
});

test("1b: error state recovers to idle via RESET, and error is cleared", () => {
  const h = harness();
  h.store.dispatch(act.startVoice());
  h.store.dispatch(act.voiceError(ERR.VOICE_ERROR));
  assert.equal(h.store.getState().voice, "error");
  h.store.dispatch(act.reset());
  const s = h.store.getState();
  assert.equal(s.voice, "idle");
  assert.equal(s.error, null);
});

/* 需求 2：CLOSE_FLOAT 必须终止/清理 Voice Session、清除 error，不留 listening/processing/error 残留。 */
test("2: CLOSE_FLOAT resets the voice slice — no listening/processing/error residue, error cleared", async () => {
  const h = harness();
  h.store.dispatch(act.openFloat());
  await h.flows.toggleVoice();
  h.voice.emitError("VOICE_ERROR");
  assert.equal(h.store.getState().voice, "error");

  await h.flows.closeFloat();
  let s = h.store.getState();
  assert.equal(s.window, "minimized");
  assert.equal(s.voice, "idle", "error 不得残留在关闭后");
  assert.equal(s.error, null, "voice error 必须被清除");
  assert.equal(s.voiceTranscript, null);
  assert.equal(s.preVoiceInput, null);
});

test("2b: closing while LISTENING aborts the provider (mic stopped) and resets to idle", async () => {
  const h = harness();
  h.store.dispatch(act.openFloat());
  await h.flows.toggleVoice();
  assert.equal(h.store.getState().voice, "listening");
  assert.equal(h.voice.calls.abort, 0);

  await h.flows.closeFloat();
  assert.equal(h.voice.calls.abort, 1, "关闭时必须 abort 底层 recognition，停止 mic");
  const s = h.store.getState();
  assert.equal(s.window, "minimized");
  assert.equal(s.voice, "idle");
  assert.equal(s.voiceTranscript, null);
});

test("2c: closing while PROCESSING aborts the provider and resets to idle", async () => {
  const h = harness();
  h.store.dispatch(act.openFloat());
  await h.flows.toggleVoice();
  h.voice.emitTranscript("final words", true);
  h.store.dispatch(act.stopVoice()); // → processing
  assert.equal(h.store.getState().voice, "processing");

  await h.flows.closeFloat();
  assert.equal(h.voice.calls.abort, 1);
  const s = h.store.getState();
  assert.equal(s.window, "minimized");
  assert.equal(s.voice, "idle");
});

test("2d: closing a calm (idle-voice) Float does not touch the provider and still hides", async () => {
  const h = harness();
  h.store.dispatch(act.openFloat());
  await h.flows.closeFloat();
  assert.equal(h.voice.calls.abort, 0, "无活动语音会话时不应无谓 abort");
  assert.equal(h.store.getState().window, "minimized");
  assert.equal(h.store.getState().voice, "idle");
});

test("2e: closing with voice error KEEPS the Composer draft (input persists across close)", async () => {
  const h = harness();
  h.store.dispatch(act.openFloat());
  h.store.dispatch(act.updateInput("my typed draft"));
  await h.flows.toggleVoice();
  h.voice.emitError("VOICE_ERROR");
  await h.flows.closeFloat();
  const s = h.store.getState();
  assert.equal(s.window, "minimized");
  assert.equal(s.voice, "idle");
  assert.equal(s.error, null);
  assert.equal(s.input, "my typed draft", "Composer 草稿在关闭后保留");
});

/* 需求 3：重开后 voice 从 idle 开始、Composer 可编辑、有内容则 REFINE 可用。 */
test("3: re-open after error → voice starts idle, Composer editable, REFINE usable with content", async () => {
  const h = harness();
  await h.flows.toggleVoice();
  h.voice.emitError("VOICE_ERROR");
  await h.flows.closeFloat();

  h.store.dispatch(act.openFloat());
  let s = h.store.getState();
  assert.equal(s.window, "expanded");
  assert.equal(s.voice, "idle", "重开后 voice 必须从 idle 开始");

  // Composer 正常可编辑（打字流）
  h.store.dispatch(act.updateInput("write a marketing email"));
  s = h.store.getState();
  assert.equal(s.interaction, "input");
  assert.equal(canRefine(s), true, "有内容时 REFINE 必须可用");
  assert.equal(canConfirm(s), true);
});

/* 需求 4：专项路径 —— idle → Voice Error → CLOSE → OPEN → idle → 输入 → REFINE → 入箱。 */
test("4: [spec path] idle → Voice Error → CLOSE_FLOAT → OPEN_FLOAT → voice idle → Composer input → REFINE enabled → REFINE lands in Inbox", async () => {
  const h = harness();

  // idle
  assert.equal(h.store.getState().voice, "idle");
  assert.equal(h.store.getState().window, "hidden");

  // → Voice Error（在 Float 内：先打开再 mic error）
  h.store.dispatch(act.openFloat());
  await h.flows.toggleVoice();
  h.voice.emitError("VOICE_ERROR");
  assert.equal(h.store.getState().voice, "error");
  assert.equal(canRefine(h.store.getState()), false, "error 后 Composer 空 → 无内容仍不可 REFINE");

  // → CLOSE_FLOAT（清理 voice session + 清除 error）
  await h.flows.closeFloat();
  let s = h.store.getState();
  assert.equal(s.window, "minimized");
  assert.equal(s.voice, "idle");
  assert.equal(s.error, null);

  // → OPEN_FLOAT
  h.store.dispatch(act.openFloat());
  s = h.store.getState();
  assert.equal(s.window, "expanded");
  assert.equal(s.voice, "idle", "voice === idle");

  // → Composer 输入
  h.store.dispatch(act.updateInput("design a pricing page"));
  s = h.store.getState();
  assert.equal(s.interaction, "input");

  // → REFINE enabled
  assert.equal(canRefine(s), true, "REFINE enabled");

  // → REFINE 正常优化到 Composer，再 SUBMIT 入箱
  await h.flows.refineFromComposer();
  await tick();
  s = h.store.getState();
  assert.equal(h.ai.calls.analyze, 1);
  assert.equal(s.input, "OPTIMIZED ▸ design a pricing page", "REFINE 写 Composer");
  assert.equal(inboxThoughts(s).length, 0, "REFINE 本身不入箱");
  await h.flows.submitThought();
  await tick();
  s = h.store.getState();
  assert.equal(inboxThoughts(s).length, 1, "SUBMIT 入箱");
  const t = inboxThoughts(s)[0];
  assert.equal(t.originalText, "design a pricing page");
  assert.equal(t.refinedText, "OPTIMIZED ▸ design a pricing page");
  assert.equal(s.input, "", "SUBMIT 成功后清空 Composer");
  assert.equal(s.voice, "idle");
});

/* 补充：error 态（Float 内、未关闭）REFINE 仍可用 —— 语音出错后用户可直接把
   Composer 里已有的内容 refine 入箱，不需要先点 RETRY。 */
test("4b: after a voice error, REFINE is still usable with Composer content (error is not an active-voice gate)", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("idea captured by typing"));
  await h.flows.toggleVoice();
  h.voice.emitError("VOICE_ERROR"); // 出错，但 Composer 已有内容
  let s = h.store.getState();
  assert.equal(s.voice, "error");
  assert.equal(canRefine(s), true, "error 是终止态，不阻止 REFINE（Bug #10 修复）");

  await h.flows.refineFromComposer();
  await tick();
  s = h.store.getState();
  assert.equal(s.input, "OPTIMIZED ▸ idea captured by typing", "REFINE 写 Composer");
  assert.equal(inboxThoughts(s).length, 0, "REFINE 本身不入箱");
  assert.equal(s.voice, "error", "REFINE 不改变 voice 态（用户仍可点 RETRY 或继续）");
  assert.equal(s.error, null, "REFINE 成功后清除 error");
  await h.flows.submitThought();
  await tick();
  s = h.store.getState();
  assert.equal(inboxThoughts(s).length, 1, "SUBMIT 入箱");
});

test("4c: REFINE stays blocked only during LIVE voice (listening/processing)", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("do not refine mid-speech"));
  await h.flows.toggleVoice();
  assert.equal(h.store.getState().voice, "listening");
  assert.equal(canRefine(h.store.getState()), false, "listening 时 REFINE 禁用");
  await h.flows.refineFromComposer(); // 也应被 flows 层拒绝
  await tick();
  assert.equal(h.store.getState().inbox.thoughts.length, 0);

  h.voice.emitTranscript("", true);
  h.store.dispatch(act.stopVoice()); // processing
  assert.equal(h.store.getState().voice, "processing");
  assert.equal(canRefine(h.store.getState()), false, "processing 时 REFINE 禁用");
});
