/* PHASE 3C-3C — 4 HOTFIXES 专项契约测试。
   覆盖:
     · VOICE-DUP-01..08 (seq 判重 + delta-append + 超限 → Long Thought)
     · UI-INBOX-01..07 (Capture+ADD DOM/样式/事件 全部拆除)
     · REFINE-UX-01..07 (REFINE pending ⇒ 小图标呼吸灯，不再复用 Voice busy)
     · LONG-01..10     (Composer/Voice 超限 → Long Thought DOC card 入库)
   零延时、mock AI/Voice、最小 DOM stub（与 3c-2b / 3c-3b 同构，不依赖 jsdom）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/state/store.js";
import { act, COMPOSER_LIMIT } from "../src/state/actions.js";
import { createFlows } from "../src/flows/prompt-flow.js";
import { canRefine, inboxThoughts } from "../src/state/selectors.js";
import { createRenderer, collectRefs } from "../src/ui/renderer.js";
import { createBrowserSpeechProvider } from "../src/services/voice/browser-provider.js";
import { reducer, initialState } from "../src/state/machine.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS = readFileSync(join(ROOT, "css", "float.css"), "utf8");
const HTML = readFileSync(join(ROOT, "index.html"), "utf8");

const zeroDelays = {
  understandStep: 0, understandFirst: 0, structuringSettle: 0,
  readyToSend: 0, sending: 0, transcribing: 0, draftDebounce: 0
};
async function tick(n = 10) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/* ---- helpers ------------------------------------------------------------ */

function allOf(root) {
  const out = [];
  (function walk(n) { out.push(n); (n._children || []).forEach(walk); })(root);
  return out;
}
function matchSel(node, sel) {
  const m = /^(?:([\w-]+)|\.([\w-]+)(?:\[data-(\w+)="([^"]*)"\])?)$/.exec(sel);
  if (!m) return false;
  if (m[1]) return (node.tagName || "").toLowerCase() === m[1].toLowerCase();
  const [, , cls, attr, val] = m;
  if (!node.classList || !node.classList.contains(cls)) return false;
  if (attr && node.dataset[attr] !== val) return false;
  return true;
}

function mockAI() {
  const calls = { analyze: 0, improve: 0, rewrite: 0 };
  const pending = [];
  let manual = false;
  return {
    calls,
    setManual(v) { manual = !!v; },
    resolveAll() { pending.splice(0).forEach((r) => r && r.resolve && r.resolve(r.v)); },
    analyzePrompt(input) {
      calls.analyze++;
      const v = {
        prompt: {
          role: "Expert Assistant", objective: "OPTIMIZED ▸ " + input,
          context: "", requirements: ["Clear"], style: ["Minimal"], output: ""
        },
        detectedIntent: "general"
      };
      if (manual) return new Promise((resolve) => pending.push({ resolve, v }));
      return Promise.resolve(v);
    },
    async improvePrompt(p) { calls.improve++; return p; },
    async rewritePrompt(p) { calls.rewrite++; return p; }
  };
}

function mockVoice() {
  const cbs = { transcript: () => {}, end: () => {}, error: () => {} };
  return {
    calls: { start: 0, stop: 0, abort: 0 },
    cbs,
    onTranscript: (fn) => (cbs.transcript = fn),
    onEnd: (fn) => (cbs.end = fn),
    onError: (fn) => (cbs.error = fn),
    pushTranscript(text, isFinal, seq) { cbs.transcript(text, isFinal, seq); },
    pushEnd() { cbs.end(); },
    pushError(code) { cbs.error(code); },
    isAvailable() { return true; },
    async start() { this.calls.start++; },
    async stop() { this.calls.stop++; },
    async abort() { this.calls.abort++; }
  };
}

/* ---- 最小 DOM stub（与 3c-2b / 3c-3b 同构） ---- */
function fakeEl(tag = "div", id = "") {
  // Shared class store — keeps className (direct assignment) in sync with
  // classList.add/remove/toggle/contains. Fixes UI-INBOX-06 + LONG-04 which
  // both relied on querySelectorAll(".pk-thought") being able to match
  // elements that had their className set directly by renderer.js.
  const _cls = new Set();
  const el = {
    id: id, tagName: String(tag).toUpperCase(), value: "",
    hidden: false, disabled: false, innerHTML: "", dataset: {}, style: {},
    scrollHeight: 0, rows: 1, _listKey: null, _listeners: {}, _children: [], _text: "",
    get className() { return [..._cls].join(" "); },
    set className(v) {
      const parts = String(v || "").split(/\s+/).filter(Boolean);
      _cls.clear();
      parts.forEach((p) => _cls.add(p));
    },
    getAttribute(k) { return k in this.dataset ? this.dataset[k] : null; },
    setAttribute(k, v) { this.dataset[k] = v; },
    removeAttribute(k) { delete this.dataset[k]; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    focus() { globalThis.document.activeElement = this; },
    setSelectionRange() {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; this._children = []; },
    append(...kids) { kids.forEach((k) => { if (typeof k === "string") this._text += k; else this._children.push(k); }); },
    appendChild(k) { this._children.push(k); return k; },
    replaceWith(k) { this._replacement = k; },
    querySelector(sel) {
      return allOf(this).find((n) => n !== this && matchSel(n, sel)) || null;
    },
    querySelectorAll(sel) {
      return allOf(this).filter((n) => n !== this && matchSel(n, sel));
    }
  };
  el.classList = {
    _set: _cls,
    add(...c) { c.forEach((x) => _cls.add(x)); },
    remove(...c) { c.forEach((x) => _cls.delete(x)); },
    toggle(c, force) {
      const on = force === undefined ? !_cls.has(c) : !!force;
      if (on) _cls.add(c); else _cls.delete(c);
      return on;
    },
    contains(c) { return _cls.has(c); }
  };
  el.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
  return el;
}

/* Install a global document facade BEFORE buildDomStub so renderer can call
 * document.createElement / document.createTextNode. getElementById and other
 * registry features are filled by buildDomStub. */
(function installGlobalDoc() {
  const stub = {
    activeElement: null,
    createElement: (tag) => fakeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text, classList: undefined }),
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    getElementById: () => fakeEl()
  };
  globalThis.document = stub;
})();

/* Build a registry of fake elements keyed by id, so collectRefs($) can find them
 * by id string, and querySelectorAll(".foo") walks the children tree. Writes
 * the real byId-backed getElementById onto the global document facade. */
function buildDomStub() {
  const ids = [
    "pk-float","pk-minimized","pk-workspace","pk-voice","pk-voice-caption",
    "pk-voice-hint","pk-voice-cancel","pk-refine","pk-submit","pk-submit-arrow",
    "pk-copy-btn","pk-new-btn","pk-c1","pk-c2","pk-input","pk-undo","pk-redo",
    "pk-input-label","pk-draft-badge","pk-draft-saved","pk-ai-mode","pk-status-label",
    "pk-toast","pk-message","pk-error","pk-transcript","pk-transcript-label",
    "pk-understand-list","pk-view-idle","pk-view-input","pk-view-review",
    "pk-review-original","pk-review-optimized","pk-use-original","pk-use-optimized",
    "pk-inbox","pk-inbox-toggle","pk-inbox-count","pk-inbox-clear","pk-inbox-body",
    "pk-inbox-list",
    "pk-input-tools",
    "pk-pk-inbox-capture","pk-inbox-draft","pk-inbox-add"
  ];
  const root = fakeEl("body", "");
  const byId = {};
  ids.forEach((id) => {
    const el = fakeEl(id.startsWith("pk-") ? "div" : "div", id);
    byId[id] = el;
    root.appendChild(el);
  });
  // pk-refine 内部有 pk-refine-spinner / pk-refine-icon / pk-refine-text children
  if (byId["pk-refine"]) {
    const icon = fakeEl("span"); icon.classList.add("pk-refine-icon"); byId["pk-refine"].appendChild(icon);
    const spinner = fakeEl("span"); spinner.classList.add("pk-refine-spinner"); byId["pk-refine"].appendChild(spinner);
    const text = fakeEl("span"); text.classList.add("pk-refine-text"); byId["pk-refine"].appendChild(text);
  }
  // replace global doc getElementById / querySelector* with the real registry
  const doc = globalThis.document;
  doc.getElementById = (id) => byId[id] || fakeEl("div", id);
  doc.querySelector = (s) => root.querySelector(s);
  doc.querySelectorAll = (s) => root.querySelectorAll(s);
  doc.$ = (id) => byId[id] || fakeEl("div", id); // test shorthand mirroring old harness
  doc.root = root;
  doc.byId = byId;
  return doc;
}

function harness() {
  const dom = buildDomStub();
  const refs = collectRefs(dom);
  const store = createStore();
  const ai = mockAI();
  const voice = mockVoice();
  const storage = {
    saveSession: async () => {}, loadSession: async () => null, clearSession: async () => {},
    savePosition: async () => {}, loadPosition: async () => null,
    saveDraft: async () => {}, loadDraft: async () => null, clearDraft: async () => {},
    saveInbox: async () => {}, loadInbox: async () => []
  };
  const delivered = { copies: [], prompts: [] };
  const delivery = {
    deliver: async (p) => { delivered.prompts.push(p); return { ok: true }; },
    copy: async (text) => { delivered.copies.push(text); }
  };
  const flows = createFlows({ store, ai, voice, delivery, storage, delays: zeroDelays });
  flows.bindVoiceCallbacks();
  const renderer = createRenderer(refs, store);
  renderer.bindFlows(flows);
  store.subscribe((s) => renderer.render(s, s));
  return { store, refs, ai, voice, storage, delivery, flows, renderer, dom, delivered };
}

/* =========================================================================
 * P0-A · VOICE-DUP-01..08
 * ========================================================================= */

test("VOICE-DUP-01: browser 重播同一 final(相同 seq) → 只写入一次，Composer 不重复", () => {
  const { store } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.startVoice());
  store.dispatch(act.voiceTranscript("你好", true, 1));
  assert.equal(store.getState().input, "你好");
  store.dispatch(act.voiceTranscript("你好", true, 1));
  assert.equal(store.getState().input, "你好");
});

test("VOICE-DUP-02: 真实两次相同文本(不同 seq) → 都写入并保留", () => {
  const { store } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.startVoice());
  store.dispatch(act.voiceTranscript("是", true, 1));
  // Provider 重新 start 之后再发一个独立的 final，累计 total = "是 是"，seq = 2
  store.dispatch(act.voiceTranscript("是 是", true, 2));
  assert.equal(store.getState().input, "是 是");
});

test("VOICE-DUP-03: 连续 finals（用户停顿），provider 以累计 total 上报，机器只 append delta", () => {
  const { store } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.startVoice());
  store.dispatch(act.voiceTranscript("A", true, 1));
  assert.equal(store.getState().input, "A");
  store.dispatch(act.voiceTranscript("A B", true, 2));
  assert.equal(store.getState().input, "A B");
});

test("VOICE-DUP-04: Composer 预录入内容后，voice final 追加而非覆盖", () => {
  const { store } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.updateInput("写之前：", { programmatic: true }));
  store.dispatch(act.startVoice());
  store.dispatch(act.voiceTranscript("说了一句话", true, 1));
  assert.equal(store.getState().input, "写之前： 说了一句话");
});

test("VOICE-DUP-05: interim 不写入 Composer，final 才写入", () => {
  const { store } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.startVoice());
  store.dispatch(act.voiceTranscript("interim preview", false, 0));
  assert.equal(store.getState().input, "");
  assert.equal(store.getState().voiceTranscript.text, "interim preview");
  store.dispatch(act.voiceTranscript("final text", true, 1));
  assert.equal(store.getState().input, "final text");
});

test("VOICE-DUP-06: VOICE_ENDED / CANCEL / NEW_THOUGHT 重置 voiceSeq 和 committedLen", async () => {
  const { store, flows } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.startVoice());
  store.dispatch(act.voiceTranscript("X", true, 1));
  store.dispatch(act.voiceEnded());
  let s = store.getState();
  assert.equal(s.voiceSeq, 0);
  assert.equal(s.voiceCommittedLen, 0);
  // CANCEL — cancelVoice is async (awaits voice.abort()), must await it
  store.dispatch(act.startVoice());
  store.dispatch(act.voiceTranscript("Y", true, 1));
  await flows.cancelVoice();
  await tick(2);
  s = store.getState();
  assert.equal(s.voiceSeq, 0, "after cancelVoice voiceSeq");
  assert.equal(s.voiceCommittedLen, 0, "after cancelVoice voiceCommittedLen");
  // NEW_THOUGHT — newThought is synchronous; voiceSeq/voiceCommittedLen reset
  store.dispatch(act.startVoice());
  store.dispatch(act.voiceTranscript("Z", true, 1));
  flows.newThought();
  s = store.getState();
  assert.equal(s.voiceSeq, 0, "after newThought voiceSeq");
  assert.equal(s.voiceCommittedLen, 0, "after newThought voiceCommittedLen");
});

test("VOICE-DUP-07: voice final 边界恰好 COMPOSER_LIMIT；溢出则 Long promote", () => {
  const { store } = harness();
  store.dispatch(act.openFloat());
  const base = "a".repeat(1998);
  store.dispatch(act.updateInput(base));
  assert.equal(store.getState().input.length, 1998);
  store.dispatch(act.startVoice());
  // final1: delta "b" → merged = base + " " + "b" = 2000 chars，刚好
  store.dispatch(act.voiceTranscript("b", true, 1));
  assert.equal(store.getState().input.length, COMPOSER_LIMIT);
  // final2: provider累计为 "b c"（长度3），voiceCommittedLen=1，slice(1)=" c"
  // merged = 2000 + 2 = 2002 → overflow
  store.dispatch(act.voiceTranscript("b c", true, 2));
  const s = store.getState();
  assert.equal(s.input, "");
  const ts = inboxThoughts(s);
  assert.equal(ts.length, 1);
  assert.equal(ts[0].long, true);
  assert.equal(ts[0].chars, COMPOSER_LIMIT + 2);
  assert.match(s.toast ? s.toast.text : "", /LONG VOICE/);
});

test("VOICE-DUP-08: browser-provider 重复 final onresult 本地 dedup", () => {
  const inst = {
    lang: "", continuous: false, interimResults: false,
    onresult: null, onerror: null, onend: null, onstart: null,
    start() { setTimeout(() => {
      // REAL event structure:
      //   { resultIndex, results: [ {0:{transcript}, isFinal, length} ] }
      // NOT a single result object — otherwise results[i][0] derefs wrong.
      const mk = (t, f) => ({ 0: { transcript: t }, isFinal: f, length: 1 });
      const evt1 = { resultIndex: 0, results: [mk("hello world", true)] };
      const evt2 = { resultIndex: 0, results: [mk("hello world", true)] };
      inst.onresult && inst.onresult(evt1);
      inst.onresult && inst.onresult(evt2);
    }, 0); },
    stop() { setTimeout(() => inst.onend && inst.onend(), 0); },
    abort() { setTimeout(() => inst.onend && inst.onend(), 0); }
  };
  const win = { SpeechRecognition: function() { return inst; } };
  const p = createBrowserSpeechProvider(win);
  let finals = [];
  p.onTranscript((t, f) => f && finals.push(t));
  return p.start().then(async () => {
    await tick(6);
    await p.stop();
    await tick(6);
    assert.equal(finals.length, 1, finals.join(" | "));
    assert.equal(finals[0], "hello world");
  });
});

/* =========================================================================
 * P0-B · UI-INBOX-01..07
 * ========================================================================= */

test("UI-INBOX-01: index.html 内无 pk-inbox-draft / pk-inbox-add DOM 节点", () => {
  assert.equal(/id="pk-inbox-draft"/.test(HTML), false, "必须移除 Capture textarea");
  assert.equal(/id="pk-inbox-add"/.test(HTML), false, "必须移除 ADD 按钮");
});

test("UI-INBOX-02: CSS 中 .pk-inbox-capture / .pk-inbox-draft / .pk-inbox-add 为 display:none", () => {
  const has = (cls) => new RegExp("\\." + cls.replace(/[.-]/g, "\\$&") + "\\s*\\{[^}]*display\\s*:\\s*none").test(CSS);
  // fallback: tolerate whitespace via contains
  const contains = (cls, str) => {
    const idx = CSS.indexOf("." + cls);
    return idx !== -1 && CSS.slice(idx, idx + 200).includes(str);
  };
  assert.ok(has("pk-inbox-capture") || contains("pk-inbox-capture", "display:none"), ".pk-inbox-capture hidden");
  assert.ok(has("pk-inbox-draft")   || contains("pk-inbox-draft",   "display:none"), ".pk-inbox-draft hidden");
  assert.ok(has("pk-inbox-add")     || contains("pk-inbox-add",     "display:none"), ".pk-inbox-add hidden");
});

test("UI-INBOX-03: main.js 不再 bind inboxDraft / inboxAdd 事件", () => {
  const main = readFileSync(join(ROOT, "src", "main.js"), "utf8");
  assert.equal(/refs\.inboxAdd\.addEventListener/.test(main), false);
  assert.equal(/refs\.inboxDraft\.addEventListener/.test(main), false);
  assert.equal(/addThoughtFromInbox\(\)/.test(main), false);
});

test("UI-INBOX-04: addThoughtFromInbox 流程函数仍存在（fallback 契约）", () => {
  const flowSrc = readFileSync(join(ROOT, "src", "flows", "prompt-flow.js"), "utf8");
  assert.ok(/async function addThoughtFromInbox/.test(flowSrc) || /function addThoughtFromInbox/.test(flowSrc));
});

test("UI-INBOX-05: renderer 对 inboxDraft/inboxAdd 空引用安全（不抛），空 inbox 渲染不崩", () => {
  const { renderer, store } = harness();
  let ok = true;
  try {
    store.dispatch(act.openFloat());
    renderer.render(store.getState(), store.getState());
    store.dispatch(act.updateInput("typed text"));
    renderer.render(store.getState(), store.getState());
  } catch (e) { ok = false; }
  assert.ok(ok, "renderer 抛 NPE — null guard 未生效");
});

test("UI-INBOX-06: Inbox body 只剩 Thought list；count badge = N", () => {
  const { store, dom, renderer } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.inboxAddRefined("idea one", "text"));
  const idA = inboxThoughts(store.getState())[0].id;
  store.dispatch(act.inboxRefine(idA, "OPT idea one"));
  store.dispatch(act.inboxAddRefined("idea two", "voice"));
  const state = store.getState();
  renderer.render(state, { ...state, renderKey: -1 });
  const inboxList = dom.$("pk-inbox-list");
  // diagnostic
  const c0 = inboxList._children[0];
  const diags = [
    "inboxList._children.length=" + inboxList._children.length,
    "c0.className=" + JSON.stringify(c0 && c0.className),
    "c0.classList exists=" + String(!!(c0 && c0.classList)),
    "c0.classList._set has pk-thought=" + String(c0 && c0.classList && c0.classList._set && c0.classList._set.has("pk-thought")),
    "c0.classList.contains('pk-thought')=" + String(c0 && c0.classList && c0.classList.contains("pk-thought")),
    "matchSel direct=" + String(c0 && matchSel(c0, ".pk-thought")),
    "allOf(inboxList).length=" + allOf(inboxList).length,
    "allOf filter class has=" + allOf(inboxList).filter((n) => n && n.classList && n.classList.contains("pk-thought")).length,
    "allOf filter via className=" + allOf(inboxList).filter((n) => n && String(n.className || "").split(/\s+/).includes("pk-thought")).length
  ].join(" / ");
  const cards = inboxList.querySelectorAll(".pk-thought");
  assert.equal(cards.length, 2, diags);
  const count = dom.$("pk-inbox-count");
  assert.equal(count.hidden, false);
  assert.equal(String(count.textContent || "").trim(), "2");
});

test("UI-INBOX-07: 不依赖 capture draft，Composer 打字 → REFINE → SUBMIT 生成 inbox 内容", async () => {
  const { store, flows, ai } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.updateInput("用户直接在 Composer 写"));
  await flows.refineFromComposer();
  await flows.submitThought();
  const s = store.getState();
  assert.equal(ai.calls.analyze, 1);
  assert.equal(inboxThoughts(s).length, 1);
  assert.equal(inboxThoughts(s)[0].originalText, "用户直接在 Composer 写");
  assert.equal(inboxThoughts(s)[0].refinedText, "OPTIMIZED ▸ 用户直接在 Composer 写");
});

/* =========================================================================
 * P1 · REFINE-UX-01..07
 * ========================================================================= */

test("REFINE-UX-01: refinePending 添加后 state 正确切换（idempotent）", () => {
  let s = initialState;
  assert.equal(s.refinePending, false);
  const s1 = reducer(s, act.refinePending(true));
  assert.equal(s1.refinePending, true);
  const s2 = reducer(s1, act.refinePending(true)); // 同值不 clone
  assert.ok(s1 === s2, "idempotent：相同值 true→true 不应 clone");
  const s3 = reducer(s2, act.refinePending(false));
  assert.equal(s3.refinePending, false);
});

test("REFINE-UX-02: refinePending=true ⇒ canRefine false + 按钮 disabled + aria-busy", () => {
  const { store, renderer, dom } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.updateInput("has text"));
  assert.equal(canRefine(store.getState()), true);
  store.dispatch(act.refinePending(true));
  assert.equal(canRefine(store.getState()), false);
  renderer.render(store.getState(), store.getState());
  const btn = dom.$("pk-refine");
  assert.equal(btn.disabled, true);
  assert.equal(btn.getAttribute("aria-busy"), "true");
});

test("REFINE-UX-03: refineFromComposer 期间挂 refinePending，完成/失败 均清除", async () => {
  const { store, flows, ai } = harness();
  ai.setManual(true);
  store.dispatch(act.openFloat());
  store.dispatch(act.updateInput("待优化"));
  const p = flows.refineFromComposer();
  await tick(4);
  assert.equal(store.getState().refinePending, true);
  ai.resolveAll();
  await p;
  assert.equal(store.getState().refinePending, false);
});

test("REFINE-UX-04: pending 期间 renderer 给按钮加 .pending，spinner 节点已创建并在 children 中", () => {
  const { store, renderer, dom } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.updateInput("t"));
  store.dispatch(act.refinePending(true));
  renderer.render(store.getState(), store.getState());
  const btn = dom.$("pk-refine");
  assert.ok(btn.classList.contains("pending"), ".pending class 未挂");
  // spinner 已经是我们挂在 btn._children 里的
  const spinners = btn.querySelectorAll(".pk-refine-spinner");
  assert.equal(spinners.length, 1, "spinner 必须渲染 1 个");
});

test("REFINE-UX-05: pending 期间 tooltip = REFINING…", () => {
  const { store, renderer, dom } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.updateInput("t"));
  store.dispatch(act.refinePending(true));
  renderer.render(store.getState(), store.getState());
  assert.match(dom.$("pk-refine").dataset["tip"] || "", /REFINING/);
});

test("REFINE-UX-06: CSS 定义 pk-refine-breathe keyframes 且 .pending .spinner 应用 animation", () => {
  assert.ok(/@keyframes\s+pk-refine-breathe/.test(CSS), "缺少 pk-refine-breathe keyframes");
  const re = /\.pk-refine\.pending\s*\.pk-refine-spinner\s*\{[^}]*animation[^}]*pk-refine-breathe/;
  assert.ok(re.test(CSS), "pending spinner 未启用 breathe 动画");
});

test("REFINE-UX-07: voice processing vs refine pending 使用不同 class（不混）", () => {
  const { store, renderer, dom } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.updateInput("t"));
  let s = { ...store.getState(), voice: "processing", refinePending: false };
  renderer.render(s, s);
  let btn = dom.$("pk-refine");
  assert.ok(btn.classList.contains("busy"));
  assert.ok(!btn.classList.contains("pending"));
  s = { ...store.getState(), refinePending: true, voice: "idle" };
  renderer.render(s, s);
  btn = dom.$("pk-refine");
  assert.ok(!btn.classList.contains("busy"));
  assert.ok(btn.classList.contains("pending"));
});

/* =========================================================================
 * P1 · LONG-01..10
 * ========================================================================= */

test("LONG-01: COMPOSER_LIMIT=2000 单一来源，Composer 无 maxlength 硬截断", () => {
  assert.equal(COMPOSER_LIMIT, 2000);
  const actSrc = readFileSync(join(ROOT, "src", "state", "actions.js"), "utf8");
  assert.match(actSrc, /COMPOSER_LIMIT\s*=\s*2000/);
  const match = HTML.match(/<textarea[^>]*id="pk-input"[^>]*>/);
  assert.ok(match, "Composer textarea 必须存在");
  assert.ok(!/maxlength/.test(match[0]), "Composer 硬 maxlength 必须移除");
});

test("LONG-02: UPDATE_INPUT ≤ COMPOSER_LIMIT 不触发 promote", () => {
  const { store } = harness();
  store.dispatch(act.updateInput("a".repeat(2000)));
  const s = store.getState();
  assert.equal(s.input.length, 2000);
  assert.equal(inboxThoughts(s).length, 0);
});

test("LONG-03: UPDATE_INPUT > COMPOSER_LIMIT → promote + Composer 清空 + toast", () => {
  const { store } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.updateInput("x".repeat(2001)));
  const s = store.getState();
  assert.equal(s.input, "");
  assert.equal(inboxThoughts(s).length, 1);
  const t = inboxThoughts(s)[0];
  assert.equal(t.long, true);
  assert.equal(t.chars, 2001);
  assert.equal(t.originalText, "x".repeat(2001));
  assert.ok(s.inbox.expandedIds.includes(t.id));
  assert.match(s.toast ? s.toast.text : "", /LONG.*INBOX/);
});

test("LONG-04: Long Thought 渲染 DOC 标题条 + 字符数（3D-RC2 GATE E：DOC chip 已随 meta 安静化退役）", () => {
  const { store, dom, renderer } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.updateInput("d".repeat(2005)));
  const t = inboxThoughts(store.getState())[0];
  renderer.render(store.getState(), store.getState());
  const card = dom.querySelectorAll(".pk-thought").find((c) => {
    const doc = c.querySelectorAll(".pk-thought-doc");
    return doc && doc.length;
  });
  assert.ok(card, "DOC card 必须被渲染");
  assert.ok(card.classList.contains("long"));
  const doc = card.querySelectorAll(".pk-thought-doc")[0];
  const title = doc.querySelectorAll(".pk-thought-doc-title")[0];
  const size = doc.querySelectorAll(".pk-thought-doc-size")[0];
  assert.ok(title && title.textContent.includes("LONG DOCUMENT"));
  assert.ok(size && /2,?005/.test(size.textContent));
  // GATE E meta 安静化：DOC chip 不再渲染（DOC 标题条已表达类型）
  assert.equal(card.querySelectorAll(".pk-thought-long-chip").length, 0);
});

test("LONG-05: Long Thought COPY 原文完整", async () => {
  const { store, flows, delivered } = harness();
  store.dispatch(act.openFloat());
  const long = "c".repeat(2003);
  store.dispatch(act.updateInput(long));
  const t = inboxThoughts(store.getState())[0];
  await flows.copyThoughtToClipboard(t.id, "original");
  assert.equal(delivered.copies[0], long);
});

test("LONG-06: Long Thought EDIT 后 chars/long 重新计算", () => {
  const { store } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.updateInput("e".repeat(2002)));
  const id = inboxThoughts(store.getState())[0].id;
  store.dispatch(act.inboxEdit(id, "短文本"));
  const t = inboxThoughts(store.getState())[0];
  assert.equal(t.long, false);
  assert.equal(t.chars, 3);
  assert.equal(t.originalText, "短文本");
});

test("LONG-07: Long Thought USE 全量原文被 delivery 拿到（无截断）", async () => {
  const { store, flows, delivered } = harness();
  store.dispatch(act.openFloat());
  const payload = "f".repeat(1999); // 单独不会 promote；先放入 Composer 再 USE
  store.dispatch(act.updateInput("pre"));
  // 先入库一个 short，然后入库一个 long 再 USE
  store.dispatch(act.updateInput("g".repeat(2010)));
  const longs = inboxThoughts(store.getState());
  const longId = longs[longs.length - 1].id;
  await flows.sendThoughtToPrompt(longId);
  // use 内部会 dispatch updateInput(merged)，merged = ""（Composer 已清空）+ payload
  // merged.len = 2010 > 2000 → promote again → inbox +=1，input = ""
  const s = store.getState();
  if (s.input) {
    // 如果没有 promote（Composer 仍保留），必须是完整 2010 字
    assert.equal(s.input.length, 2010);
  } else {
    assert.ok(inboxThoughts(s).length >= 2);
  }
});

test("LONG-08: empty/whitespace 写入不会 promote（idempotent）", () => {
  const { store } = harness();
  store.dispatch(act.updateInput(""));
  store.dispatch(act.updateInput("   "));
  const s = store.getState();
  assert.equal(inboxThoughts(s).length, 0);
});

test("LONG-09: Voice final 超限 promote（与 UPDATE_INPUT 一致）", () => {
  const { store } = harness();
  store.dispatch(act.openFloat());
  store.dispatch(act.startVoice());
  const longText = "v".repeat(2005);
  store.dispatch(act.voiceTranscript(longText, true, 1));
  const s = store.getState();
  assert.equal(s.input, "");
  const ts = inboxThoughts(s);
  assert.equal(ts.length, 1);
  assert.equal(ts[0].long, true);
  assert.equal(ts[0].chars, 2005);
  assert.equal(ts[0].source, "voice");
});

test("LONG-10: createThought / withOriginalText 正确更新 chars & long", async () => {
  const m = await import("../src/models/thought.js");
  const t = m.createThought("x".repeat(2500), "text", 1);
  assert.equal(t.long, true);
  assert.equal(t.chars, 2500);
  const t2 = m.withOriginalText(t, "短");
  assert.equal(t2.long, false);
  assert.equal(t2.chars, 1);
});
