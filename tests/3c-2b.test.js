/* PHASE 3C-2B — 专项交叉场景测试（Task #40）。
   聚焦既有 inbox/voice-loop/repro-bugs 未覆盖的交叉验证（用户 18 条指令第 3-10 条）：
     A. canRefine / canConfirm 门禁（selectors 层）
     B. USE 覆盖式 merge 行为（replace，非 append；不静默清空；不自动 submit）
     C. Composer 编辑闭环 + Voice 多轮交叉（内容不丢、中间编辑不丢、追加合并；
        provider pause 自动 restart 对 flow 不可见）
     D. Creative Inbox 编辑中不被列表重建覆盖（renderer DOM 层）
     E. REFINE 唯一入箱 + 普通 Composer 输入不直接入箱（流程级双重验证）
     F. 底部物理控制：无 SEND/CONFIRM & SEND 实体键；Composer #pk-submit 门禁
   Zero delays, mock AI/voice, 最小 DOM stub（含子节点遍历以驱动 renderer 按钮）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/state/store.js";
import { act, ERR } from "../src/state/actions.js";
import { createFlows } from "../src/flows/prompt-flow.js";
import { canRefine, canConfirm, inboxThoughts } from "../src/state/selectors.js";
import { createRenderer, collectRefs } from "../src/ui/renderer.js";
import { createBrowserSpeechProvider } from "../src/services/voice/browser-provider.js";

const zeroDelays = {
  understandStep: 0, understandFirst: 0, structuringSettle: 0,
  readyToSend: 0, sending: 0, transcribing: 0
};
async function tick(n = 8) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/* ---- controllable mock AI (FIFO gates, counts, can fail/hang) ---- */
function mockAI() {
  const calls = { analyze: 0, improve: 0, rewrite: 0 };
  const gates = [];
  let fail = 0;
  const api = {
    calls,
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
      const gate = gates.find((g) => !g.consumed);
      if (gate) { gate.consumed = true; return gate.promise.then(respond); }
      return Promise.resolve(respond());
    },
    async improvePrompt(p) { calls.improve++; return p; },
    async rewritePrompt(p) { calls.rewrite++; return p; }
  };
  return api;
}

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
  const delivered = { calls: 0, copies: [], prompts: [] };
  const delivery = {
    deliver: async (prompt) => { delivered.calls++; delivered.prompts.push(prompt); return { ok: true }; },
    copy: async (text) => { delivered.copies.push(text); }
  };
  const flows = createFlows({ store, ai, voice, delivery, storage, delays: zeroDelays });
  flows.bindVoiceCallbacks();
  return { store, ai, voice, flows, delivered };
}

/* ==================== A. canRefine / canConfirm 门禁 ==================== */
test("A1: canRefine — 空输入/纯空白 false；processing/voice 活动 false；calm+文本 true", () => {
  const store = createStore();
  assert.equal(canRefine(store.getState()), false, "空输入不可 REFINE");
  store.dispatch(act.updateInput("hello"));
  assert.equal(canRefine(store.getState()), true, "calm + 文本可 REFINE");

  store.dispatch(act.startVoice()); // listening 阻止 REFINE（防中途 refine）
  assert.equal(canRefine(store.getState()), false, "voice listening 时不可 REFINE");
  store.dispatch(act.voiceEnded());

  store.dispatch(act.submitThought()); // understanding 阻止 REFINE
  assert.equal(store.getState().interaction, "understanding");
  assert.equal(canRefine(store.getState()), false, "understanding 时不可 REFINE");

  store.dispatch(act.reset());
  store.dispatch(act.updateInput("  "));
  assert.equal(canRefine(store.getState()), false, "纯空白不可 REFINE");
});

test("A2: canConfirm — review true；input+文本 true；空 false；delivered false", async () => {
  const h = harness();
  assert.equal(canConfirm(h.store.getState()), false, "空 Composer 不可 SUBMIT");
  h.store.dispatch(act.updateInput("hello"));
  assert.equal(canConfirm(h.store.getState()), true, "input+文本可 SUBMIT");
  h.store.dispatch(act.updateInput(""));
  assert.equal(canConfirm(h.store.getState()), false);
  h.store.dispatch(act.updateInput("hello"));
  await h.flows.submitThought();
  await tick();
  assert.equal(h.store.getState().interaction, "review");
  assert.equal(canConfirm(h.store.getState()), true, "review 态可 SUBMIT");
  await h.flows.confirmAndSend();
  await tick();
  assert.equal(h.store.getState().interaction, "delivered");
  assert.equal(canConfirm(h.store.getState()), false, "delivered 不可重复 SUBMIT");
});

/* ==================== B. USE 覆盖式 merge 行为 ==================== */
test("B1: USE 以 Thought 文本【覆盖】现有 Composer 内容（replace，非 append），且不自动 submit", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("idea", "text"));
  const id = h.store.getState().inbox.thoughts[0].id;
  h.store.dispatch(act.inboxRefine(id, "REFINED ▸ idea"));
  h.store.dispatch(act.updateInput("existing typed draft that should be replaced"));
  await h.flows.sendThoughtToPrompt(id);
  const s = h.store.getState();
  assert.equal(s.input, "REFINED ▸ idea", "USE 是覆盖式设置，不是追加");
  assert.equal(s.interaction, "input", "USE 不自动 submit");
  assert.equal(h.ai.calls.analyze, 0, "USE 本身不调用 AI");
});

test("B2: USE 在 Thought 无 refinedText 时回退 originalText（绝不取回空文本）", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("only original idea", "text"));
  const id = h.store.getState().inbox.thoughts[0].id;
  await h.flows.sendThoughtToPrompt(id);
  assert.equal(h.store.getState().input, "only original idea");
  assert.equal(h.store.getState().interaction, "input");
});

test("B3: USE 未知 id 是 no-op —— Composer 内容不被静默清空", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("keep me"));
  await h.flows.sendThoughtToPrompt("nonexistent-id");
  const s = h.store.getState();
  assert.equal(s.input, "keep me", "未知 id 不应清空/改动 Composer");
  assert.equal(h.ai.calls.analyze, 0);
});

test("B4: USE 取回后 Thought 不被消费/删除（可再次 USE）", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("reusable idea", "text"));
  const id = h.store.getState().inbox.thoughts[0].id;
  h.store.dispatch(act.inboxRefine(id, "REFINED ▸ reusable idea"));
  await h.flows.sendThoughtToPrompt(id);
  assert.equal(h.store.getState().input, "REFINED ▸ reusable idea");
  assert.equal(inboxThoughts(h.store.getState()).length, 1, "USE 不删除 Thought");
  h.store.dispatch(act.updateInput("overwritten"));
  await h.flows.sendThoughtToPrompt(id); // 再次 USE
  assert.equal(h.store.getState().input, "REFINED ▸ reusable idea");
  assert.equal(inboxThoughts(h.store.getState()).length, 1);
});

/* ==================== C. Composer 编辑闭环 + Voice 多轮交叉 ==================== */
test("C1: Composer 编辑闭环（状态层）——输入/修改/删除/清空/空白全部正确", () => {
  const store = createStore();
  store.dispatch(act.updateInput("hello"));
  assert.equal(store.getState().input, "hello");
  store.dispatch(act.updateInput("hello world")); // 追加/修改
  assert.equal(store.getState().input, "hello world");
  store.dispatch(act.updateInput("hello")); // 删回
  assert.equal(store.getState().input, "hello");
  store.dispatch(act.updateInput("")); // 清空 → idle
  assert.equal(store.getState().interaction, "idle");
  store.dispatch(act.updateInput("  ")); // 纯空白 → 仍是 idle
  assert.equal(store.getState().interaction, "idle");
  store.dispatch(act.updateInput("x"));
  assert.equal(store.getState().interaction, "input"); // 重新输入 → input
});

test("C2: 打字草稿跨 3 轮 voice 不丢 —— voice 追加累积、中间手动编辑也被保留", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("typed draft"));
  // 第一轮
  await h.flows.toggleVoice();
  h.voice.emitTranscript("voice one", true);
  await h.voice.emitEnd();
  await tick();
  assert.equal(h.store.getState().input, "typed draft voice one");
  // 中间手动编辑
  h.store.dispatch(act.updateInput("typed draft voice one edited"));
  // 第二轮
  await h.flows.toggleVoice();
  h.voice.emitTranscript("voice two", true);
  await h.voice.emitEnd();
  await tick();
  assert.equal(h.store.getState().input, "typed draft voice one edited voice two");
  // 第三轮
  await h.flows.toggleVoice();
  h.voice.emitTranscript("voice three", true);
  await h.voice.emitEnd();
  await tick();
  const s = h.store.getState();
  assert.equal(s.input, "typed draft voice one edited voice two voice three");
  assert.equal(s.inbox.thoughts.length, 0, "voice 三轮从不直接入箱");
  assert.equal(s.voice, "idle");
  assert.equal(h.voice.calls.start, 3);
});

/* ---- provider+flow 集成：pause 自动 restart 对 flow 不可见 ---- */
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

test("C3: provider 层 pause 自动 restart 不触发 flow 的 end —— voice 保持 LISTENING，final 仍只提交一次", async () => {
  const { win, instances } = fakeSpeechWindow();
  const p = createBrowserSpeechProvider(win);
  const store = createStore();
  const ai = mockAI();
  const storage = {
    saveSession: async () => {}, loadSession: async () => null, clearSession: async () => {},
    savePosition: async () => {}, loadPosition: async () => null
  };
  const delivery = { deliver: async () => ({ ok: true }), copy: async () => {} };
  const flows = createFlows({ store, ai, voice: p, delivery, storage, delays: zeroDelays });
  flows.bindVoiceCallbacks();

  await flows.toggleVoice();
  assert.equal(store.getState().voice, "listening");
  assert.equal(store.getState().input, "");

  // pause：recognition #0 自行 end → provider 自动重启，flow 必须看不到 end
  instances[0].onend();
  await tick();
  assert.equal(store.getState().voice, "listening", "pause 自动 restart 不应被误判为 user stop");
  assert.equal(store.getState().input, "", "pause 不应产生任何内容");

  // 用户在新 recognition #1 上说出 final
  instances[1].onresult({ results: [{ 0: { transcript: "final words" }, isFinal: true }] });
  await tick();
  assert.equal(store.getState().input, "final words");

  // 显式 stop：只有这一次真正结束会话（exactly-once）
  await flows.toggleVoice(); // listening → voice.stop()
  assert.equal(store.getState().voice, "listening", "stop 后、浏览器 onend 前仍 listening");
  instances[1].onend(); // 浏览器在 stop 后触发最终 end
  await tick();
  const s = store.getState();
  assert.equal(s.voice, "idle");
  assert.equal(s.input, "final words");
  assert.equal(s.inbox.thoughts.length, 0);
  assert.equal(instances.length, 2, "explicit stop 后不再自动重启");
});

/* ==================== D. Inbox 编辑中不被列表重建覆盖（renderer DOM） ==================== */
/* 最小 DOM stub —— 支持子节点遍历，使 renderer 的 querySelector/appendChild/按钮点击可驱动。
   textContent 必须是访问器：真实 DOM 中 `el.textContent = "..."` 会先清空所有子节点
   （renderer 用 `refs.inboxList.textContent = ""` 清空列表再重建）。普通属性无法做到。 */
function fakeEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(), value: "", hidden: false, disabled: false,
    innerHTML: "", dataset: {}, style: {}, scrollHeight: 0, rows: 1,
    _listKey: null, _listeners: {}, _children: [], _text: "",
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : !!force;
        if (on) this._set.add(c); else this._set.delete(c);
        return on;
      },
      contains(c) { return this._set.has(c) || String(el.className || "").split(/\s+/).includes(c); }
    },
    setAttribute(k, v) { this.dataset[k] = v; },
    getAttribute(k) { return k in this.dataset ? this.dataset[k] : null; },
    removeAttribute(k) { delete this.dataset[k]; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    focus() { globalThis.document.activeElement = this; },
    setSelectionRange() {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; this._children = []; }, // 赋值即清空子节点（真实 DOM 语义）
    append(...kids) { kids.forEach((k) => { if (typeof k === "string") this._text += k; else this._children.push(k); }); },
    appendChild(k) { this._children.push(k); return k; },
    querySelector(sel) { return allOf(this).find((n) => n !== el && matchSel(n, sel)) || null; },
    querySelectorAll(sel) { return allOf(this).filter((n) => n !== el && matchSel(n, sel)); },
    replaceWith() {},
    contains() { return false; }
  };
  return el;
}
function allOf(root) {
  const out = [];
  (function walk(n) { out.push(n); (n._children || []).forEach(walk); })(root);
  return out;
}
function matchSel(node, sel) {
  // "button" | ".cls" | ".cls[data-id=\"x\"]" | ".cls[data-key=\"x\"]"
  const m = /^(?:([\w-]+)|\.([\w-]+)(?:\[data-(\w+)="([^"]*)"\])?)$/.exec(sel);
  if (!m) return false;
  if (m[1]) return (node.tagName || "").toLowerCase() === m[1].toLowerCase();
  const [, , cls, attr, val] = m;
  if (!node.classList || !node.classList.contains(cls)) return false;
  if (attr && node.dataset[attr] !== val) return false;
  return true;
}
globalThis.document = {
  activeElement: null,
  createElement: (tag) => fakeEl(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: text, classList: undefined }),
  querySelector: () => fakeEl(),
  getElementById: () => fakeEl()
};

test("D1: 编辑某 Thought 时，触发会改变 listKey 的无关渲染不得重建列表（textarea 不被覆盖）", () => {
  const store = createStore();
  const refs = collectRefs(globalThis.document);
  const renderer = createRenderer(refs, store);
  renderer.bindFlows({ sendThoughtToPrompt() {}, copyThoughtToClipboard() {} });

  // 通过 REFINE 路径入箱一个 Thought
  store.dispatch(act.inboxAddRefined("idea one", "text"));
  store.dispatch(act.inboxAddRefined("idea two", "text"));
  const [one] = store.getState().inbox.thoughts;

  renderer.render(store.getState(), { ...store.getState(), window: "launcher" });
  store.dispatch(act.inboxToggleOpen()); // 展开面板
  renderer.render(store.getState(), store.getState());
  assert.equal(refs.inbox._listKey !== null && refs.inbox._listKey.length > 0, true, "列表已构建");

  // 找到第一张卡片并点击 EDIT 按钮（进入编辑态）
  const cards = refs.inboxList.querySelectorAll(".pk-thought");
  assert.equal(cards.length, 2);
  const actions = cards[0].querySelector(".pk-thought-actions");
  const editBtn = actions.querySelectorAll("button").find((b) => b.textContent === "EDIT");
  assert.ok(editBtn, "EDIT 按钮存在");
  const listKeyBefore = refs.inbox._listKey;
  editBtn._listeners.click.forEach((fn) => fn({ key: "", preventDefault() {}, stopPropagation() {} }));

  // 编辑中：触发一个会改变 listKey 的动作（展开）+ 无关 render → 不得重建
  store.dispatch(act.inboxToggleExpanded(one.id));
  renderer.render(store.getState(), store.getState());
  assert.equal(refs.inbox._listKey, listKeyBefore,
    "编辑中列表不得被重建覆盖（否则编辑 textarea 会丢失）");

  // 编辑态期间内容文本未被清空（未被 rebuild 清空重建）
  assert.equal(rendererStateListKey(refs), listKeyBefore);
});

// 辅助：返回当前 listKey（供断言）
function rendererStateListKey(refs) {
  return refs.inbox._listKey;
}

test("D2: 编辑保存（INBOX_EDIT）后列表重建且内容更新；DELETE 也正确重建", () => {
  const store = createStore();
  const refs = collectRefs(globalThis.document);
  const renderer = createRenderer(refs, store);
  renderer.bindFlows({ sendThoughtToPrompt() {}, copyThoughtToClipboard() {} });
  store.dispatch(act.inboxAddRefined("idea one", "text"));
  const id = store.getState().inbox.thoughts[0].id;
  renderer.render(store.getState(), { ...store.getState(), window: "launcher" });
  store.dispatch(act.inboxToggleOpen());
  renderer.render(store.getState(), store.getState());

  // 编辑保存（commit 会 delete _listKey → 下一轮重建）
  store.dispatch(act.inboxEdit(id, "idea one edited"));
  if (refs.inbox) delete refs.inbox._listKey; // renderer commit 做的事
  renderer.render(store.getState(), store.getState());
  assert.equal(refs.inbox._listKey.length > 0, true);
  // 卡片内容反映编辑结果
  const cards = refs.inboxList.querySelectorAll(".pk-thought");
  assert.equal(cards.length, 1);
  const original = cards[0].querySelector(".pk-thought-original");
  assert.equal(original.textContent, "idea one edited");

  // 删除 → 列表清空（重建为空态）
  store.dispatch(act.inboxDelete(id));
  if (refs.inbox) delete refs.inbox._listKey;
  renderer.render(store.getState(), store.getState());
  assert.equal(refs.inboxList.querySelectorAll(".pk-thought").length, 0);
});

/* ==================== E. REFINE 唯一入箱（流程级） ==================== */
test("E1: 普通 Composer 输入绝不直接入箱；仅 REFINE 成功后入箱（original/refined 分离）", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("just typing"));
  await tick();
  assert.equal(h.store.getState().inbox.thoughts.length, 0, "打字不直接入箱");
  assert.equal(h.ai.calls.analyze, 0, "打字不触发 AI");
  await h.flows.refineFromComposer();
  await tick();
  const s = h.store.getState();
  assert.equal(s.inbox.thoughts.length, 1, "REFINE 后入箱");
  assert.equal(h.ai.calls.analyze, 1);
  const t = s.inbox.thoughts[0];
  assert.equal(t.originalText, "just typing", "originalText=用户原话");
  assert.equal(t.refinedText, "OPTIMIZED ▸ just typing", "refinedText=AI 产物");
  assert.equal(s.input, "just typing", "REFINE 不消费 Composer 内容");
});

test("E2: voice 活动期间 REFINE 被拒绝（不中途 refine）；结束后可正常 refine", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("idea"));
  await h.flows.toggleVoice();
  await h.flows.refineFromComposer(); // 应被拒
  await tick();
  assert.equal(h.store.getState().inbox.thoughts.length, 0, "voice 活动中不建 Thought");
  assert.equal(h.ai.calls.analyze, 0);
  h.voice.emitTranscript("", true);
  await h.voice.emitEnd();
  await tick();
  await h.flows.refineFromComposer();
  await tick();
  assert.equal(h.store.getState().inbox.thoughts.length, 1, "voice 结束后 REFINE 正常");
  assert.equal(h.ai.calls.analyze, 1);
});

test("E3: 空 Composer 的 REFINE 是 no-op（不调用 AI、不建 Thought）", async () => {
  const h = harness();
  await h.flows.refineFromComposer();
  await tick();
  assert.equal(h.ai.calls.analyze, 0);
  assert.equal(h.store.getState().inbox.thoughts.length, 0);
});

/* ==================== F. 底部物理控制（renderer） ==================== */
test("F1: renderer 不暴露 joystick / 独立 SEND 实体键 refs —— 仅 Composer #pk-submit + VOICE/REFINE", () => {
  const refs = collectRefs(globalThis.document);
  assert.ok(refs.submit, "Composer 内提交入口存在");
  assert.ok(refs.refine, "底部 REFINE 键存在");
  assert.ok(refs.voice, "底部 VOICE 键存在");
  // 无独立发送键 / joystick 引用
  assert.equal("confirm" in refs, false);
  assert.equal("joystick" in refs, false);
  assert.equal("ctrlSend" in refs, false);
});

test("F2: #pk-submit 门禁 —— 空 Composer 禁用，有内容启用，RESET 后回禁用", () => {
  const store = createStore();
  const refs = collectRefs(globalThis.document);
  const renderer = createRenderer(refs, store);
  renderer.bindFlows({ sendThoughtToPrompt() {}, copyThoughtToClipboard() {} });
  renderer.render(store.getState(), { ...store.getState(), window: "launcher" });
  assert.equal(refs.submit.disabled, true, "空 Composer 禁用 SUBMIT");
  store.dispatch(act.updateInput("hello"));
  renderer.render(store.getState(), store.getState());
  assert.equal(refs.submit.disabled, false, "有内容启用 SUBMIT");
  store.dispatch(act.reset());
  renderer.render(store.getState(), store.getState());
  assert.equal(refs.submit.disabled, true, "RESET 后回禁用");
});

test("F3: #pk-refine 门禁 —— 空禁用；有内容启用；voice 活动时禁用", () => {
  const store = createStore();
  const refs = collectRefs(globalThis.document);
  const renderer = createRenderer(refs, store);
  renderer.bindFlows({ sendThoughtToPrompt() {}, copyThoughtToClipboard() {} });
  renderer.render(store.getState(), { ...store.getState(), window: "launcher" });
  assert.equal(refs.refine.disabled, true);
  store.dispatch(act.updateInput("hello"));
  renderer.render(store.getState(), store.getState());
  assert.equal(refs.refine.disabled, false);
  store.dispatch(act.startVoice()); // listening 阻止 REFINE
  renderer.render(store.getState(), store.getState());
  assert.equal(refs.refine.disabled, true);
});
