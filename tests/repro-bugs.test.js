/* PHASE 3C-2B — Bug #8 / Bug #9 复现测试（Task #37，RULE 2 第一步）。
   目标：先复现并定位两个用户实测真实 Bug 的根因，再实施修复。
     #9  VOICE 多轮复用失效（一次使用后二次基本失效）
     #8  Composer 持续编辑失效（输入后无法稳定再修改/追加/删除）

   本文件在修复前预期：REPRO-9-provider 与 REPRO-8-renderer 两个测试 FAIL（复现成功），
   REPRO-9-flow 基线 PASS（证明 flow 层同步时序下多轮复用无逻辑 bug，根因在 provider 竞态）。
   修复后全部应转绿（本文件将演进为正式专项测试，见 Task #40）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/state/store.js";
import { act } from "../src/state/actions.js";
import { createFlows } from "../src/flows/prompt-flow.js";
import { createRenderer, collectRefs } from "../src/ui/renderer.js";
import { createBrowserSpeechProvider } from "../src/services/voice/browser-provider.js";

const zeroDelays = {
  understandStep: 0, understandFirst: 0, structuringSettle: 0,
  readyToSend: 0, sending: 0, transcribing: 0
};
async function tick(n = 6) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/* ==================== #9 — provider 层竞态 ==================== */
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

test("REPRO #9: 第二轮 start 后，第一轮旧 recognition 的迟到 onend 不应被误判为 pause 自动重启", async () => {
  const { win, instances } = fakeSpeechWindow();
  const p = createBrowserSpeechProvider(win);
  const ends = [];
  p.onEnd(() => ends.push("end"));

  // 第一轮：start → user stop（onend 尚未触发，浏览器异步延迟）
  await p.start();
  assert.equal(instances.length, 1);
  await p.stop();
  assert.equal(instances[0].stopped, true);

  // 第二轮：再次 start（userStopped=false, active=true, 当前 recognition=R2）
  await p.start();
  assert.equal(instances.length, 2);
  assert.equal(instances[1].started, true);

  // 第一轮 R1 的 onend 此时才迟到触发：
  instances[0].onend();
  // 正确行为：旧实例的 end 是噪音 → 忽略 → 不新建 recognition、不触发 endCb
  assert.equal(instances.length, 2, "旧 recognition 的 onend 不应触发自动重启（会陷入无限重启）");
  assert.equal(ends.length, 0, "旧 recognition 的 onend 不应结束会话");

  // 第二轮当前 R2 仍应正常：stop → 其 onend → 恰好一次 endCb
  await p.stop();
  instances[1].onend();
  assert.equal(ends.length, 1, "第二轮自己的 end 应恰好触发一次 endCb");
  assert.equal(instances.length, 2, "第二轮 stop 后不应再自动重启");
});

/* ==================== #9 — flow 层多轮行为基线 ==================== */
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
function mockAI() {
  const calls = { analyze: 0, improve: 0, rewrite: 0 };
  const api = {
    calls,
    lastOptions: null,
    analyzePrompt(input, options = {}) {
      calls.analyze++;
      api.lastOptions = options;
      return Promise.resolve({
        prompt: { role: "Expert Assistant", objective: "OPTIMIZED ▸ " + input, context: "", requirements: ["Clear"], style: ["Minimal"], output: "" },
        detectedIntent: "general"
      });
    },
    async improvePrompt(p) { calls.improve++; return p; },
    async rewritePrompt(p) { calls.rewrite++; return p; }
  };
  return api;
}
function harness() {
  const store = createStore();
  const ai = mockAI();
  const voice = mockVoice();
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

test("REPRO #9-flow 基线: 同步时序下第一/二/三轮 voice 均可完整 start→stop→end→idle（flow 逻辑本身可复用；final 追加合并进 Composer）", async () => {
  const h = harness();
  const words = ["first thought", "second thought", "third thought"];
  for (const text of words) {
    await h.flows.toggleVoice();
    assert.equal(h.store.getState().voice, "listening");
    h.voice.emitTranscript(text, true);
    await h.voice.emitEnd();
    await tick();
    const s = h.store.getState();
    assert.equal(s.voice, "idle", `第 ${text} 轮应复位到 idle`);
    // 3C-2B: voice final 追加到 Composer（set if empty, else append）——
    // 每轮都成功复位 voice 切片，content 在多轮间累积（非覆盖）
  }
  const s = h.store.getState();
  assert.equal(s.input, words.join(" ")); // 追加合并策略
  assert.equal(s.inbox.thoughts.length, 0); // voice 从不直接入箱
  // 三轮共用同一个 flows 实例（对应真实浏览器同一页面多次点 mic）
  assert.equal(h.voice.calls.start, 3);
});

/* ==================== #8 — renderer Composer 输入守卫 ==================== */
function fakeEl(id = "") {
  const el = {
    id, value: "", hidden: false, disabled: false, textContent: "",
    innerHTML: "", dataset: {}, style: {}, scrollHeight: 0, rows: 1,
    _listKey: null, _listeners: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : !!force;
        if (on) this._set.add(c); else this._set.delete(c);
        return on;
      },
      contains(c) { return this._set.has(c); }
    },
    setAttribute(k, v) { this.dataset[k] = v; },
    getAttribute(k) { return k in this.dataset ? this.dataset[k] : null; },
    removeAttribute(k) { delete this.dataset[k]; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    focus() { globalThis.document.activeElement = this; },
    setSelectionRange() {},
    append(...kids) { kids.forEach((k) => { if (typeof k === "string") this.textContent += k; }); },
    appendChild(k) { this.lastChild = k; return k; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    replaceWith() {},
    contains() { return false; }
  };
  return el;
}

/* renderer.js 内部使用全局 document.createElement / document.activeElement，
   这里提供最小 DOM stub（仅覆盖 renderer 用到的 API，无真实浏览器依赖）。 */
globalThis.document = {
  activeElement: null,
  createElement: (tag) => fakeEl(tag),
  querySelector: (sel) => fakeEl(sel),
  getElementById: (id) => fakeEl(id)
};

test("REPRO #8: 焦点在 Composer 时，外部 state 变更（如 voice final / 程序化回填）必须同步到 DOM input", () => {
  const store = createStore();
  const refs = collectRefs(globalThis.document);
  const renderer = createRenderer(refs, store);
  renderer.bindFlows({ sendThoughtToPrompt() {}, copyThoughtToClipboard() {} });

  // 首帧
  renderer.render(store.getState(), { ...store.getState(), window: "launcher" });

  // 用户在 Composer 输入 "hello"：DOM value 领先，input 事件已同步 state
  refs.input.value = "hello";
  store.dispatch(act.updateInput("hello"));
  assert.equal(refs.input.value, store.getState().input);
  refs.input.focus(); // 用户正聚焦 Composer（document.activeElement === refs.input）
  renderer.render(store.getState(), store.getState());

  // 外部程序化变更 state.input（模拟 voice final 覆盖 / REFINE 回填等非击键更新）
  store.dispatch(act.updateInput("hello world"));
  renderer.render(store.getState(), store.getState());

  // 断言：DOM 必须同步到新值——用户聚焦不能挡住外部 state 回填
  assert.equal(refs.input.value, "hello world",
    "焦点在 Composer 时，外部 state 变更必须同步到 DOM（否则下次击键会基于旧 DOM 值把 state 拉回）");
});

test("REPRO #8b: 用户正在击键（焦点在 Composer 且 DOM 值与 state 一致）时，render 不得覆盖 input 值", () => {
  const store = createStore();
  const refs = collectRefs(globalThis.document);
  const renderer = createRenderer(refs, store);
  renderer.bindFlows({ sendThoughtToPrompt() {}, copyThoughtToClipboard() {} });
  renderer.render(store.getState(), { ...store.getState(), window: "launcher" });

  refs.input.value = "typing…";
  store.dispatch(act.updateInput("typing…")); // 击键 → input 事件已同步
  refs.input.focus();
  renderer.render(store.getState(), store.getState());

  // 无关 render（如 message 变化）不应碰 input
  store.dispatch(act.showMessage("hi"));
  renderer.render(store.getState(), store.getState());
  assert.equal(refs.input.value, "typing…", "用户击键的内容不应被无关 render 覆盖");
});
