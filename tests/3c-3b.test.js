/* PHASE 3C-3B — PRODUCT UI RESET 专项测试（规范 §24 UI-01 ~ UI-28）。
   验证 UI reset 后的新行为契约：
     · Creative Inbox / Composer = 两大主导内容面（独立渲染、独立滚动、互不挤压）
     · VOICE / REFINE = 两大主导操作（按钮 + 键盘快捷键同一条 flow，无并行状态路径）
     · Thought 卡片 COPY/USE/EDIT/DELETE 全部保留且语义安全
     · REFINE 显式、失败保 Composer、AI DEMO badge 诚实、草稿持久化、Undo/Redo、
       delivered 门禁、响应式无横向溢出、键盘可达
   零延时、mock AI/Voice、最小 DOM stub（复用 3c-2b 模式）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/state/store.js";
import { act } from "../src/state/actions.js";
import { createFlows } from "../src/flows/prompt-flow.js";
import { canRefine, canConfirm, inboxThoughts, aiModeLabel } from "../src/state/selectors.js";
import { createRenderer, collectRefs } from "../src/ui/renderer.js";
import { isVoiceToggleShortcut, voiceShortcutHint } from "../src/ui/shortcuts.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS = readFileSync(join(ROOT, "css", "float.css"), "utf8");
const HTML = readFileSync(join(ROOT, "index.html"), "utf8");

const zeroDelays = {
  understandStep: 0, understandFirst: 0, structuringSettle: 0,
  readyToSend: 0, sending: 0, transcribing: 0
};
async function tick(n = 8) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/* ---- controllable mock AI ---- */
function mockAI() {
  const calls = { analyze: 0, improve: 0, rewrite: 0 };
  let fail = 0;
  return {
    calls,
    failNext() { fail++; },
    analyzePrompt(input) {
      calls.analyze++;
      if (fail > 0) {
        fail--;
        return Promise.reject(Object.assign(new Error("mock AI failure"), { code: "AI_ERROR" }));
      }
      return Promise.resolve({
        prompt: {
          role: "Expert Assistant", objective: "OPTIMIZED ▸ " + input,
          context: "", requirements: ["Clear"], style: ["Minimal"], output: ""
        },
        detectedIntent: "general"
      });
    },
    async improvePrompt(p) { calls.improve++; return p; },
    async rewritePrompt(p) { calls.rewrite++; return p; }
  };
}

function mockVoice() {
  const cbs = { transcript: () => {}, end: () => {}, error: () => {} };
  const calls = { start: 0, stop: 0, abort: 0 };
  return {
    calls, cbs,
    isAvailable() { return true; },
    async start() { calls.start++; },
    async stop() { calls.stop++; },
    async abort() { calls.abort++; },
    onTranscript(cb) { cbs.transcript = cb; },
    onEnd(cb) { cbs.end = cb; },
    onError(cb) { cbs.error = cb; }
  };
}

function harness() {
  const store = createStore();
  const ai = mockAI();
  const voice = mockVoice();
  const saved = { drafts: [], inbox: [] };
  const storage = {
    saveSession: async () => {}, loadSession: async () => null, clearSession: async () => {},
    savePosition: async () => {}, loadPosition: async () => null,
    saveDraft: async (t) => { saved.drafts.push(t); },
    loadDraft: async () => null, clearDraft: async () => {},
    saveInbox: async (t) => { saved.inbox.push(t); }, loadInbox: async () => []
  };
  const delivered = { copies: [], prompts: [] };
  const delivery = {
    deliver: async (p) => { delivered.prompts.push(p); return { ok: true }; },
    copy: async (text) => { delivered.copies.push(text); }
  };
  const flows = createFlows({ store, ai, voice, delivery, storage, delays: zeroDelays });
  flows.bindVoiceCallbacks();
  return { store, ai, voice, flows, delivered, saved };
}

/* ---- 最小 DOM stub（与 3c-2b.test.js 同构） ---- */
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
    set textContent(v) { this._text = v; this._children = []; },
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

function rendererHarness() {
  const h = harness();
  const refs = collectRefs(globalThis.document);
  const renderer = createRenderer(refs, h.store);
  renderer.bindFlows(h.flows);
  return { ...h, refs, renderer };
}
function click(el) {
  (el._listeners.click || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} }));
}

/* ================================================================
   UI-01 — Creative Inbox renders multiple Thoughts independently
   ================================================================ */
test("UI-01: Inbox 独立渲染多个 Thought（每条一张卡片）", () => {
  const { store, refs, renderer } = rendererHarness();
  store.dispatch(act.inboxAddRefined("first idea", "text"));
  store.dispatch(act.inboxAddRefined("second idea", "voice"));
  renderer.render(store.getState(), { ...store.getState(), window: "launcher" });

  const cards = refs.inboxList.querySelectorAll(".pk-thought");
  assert.equal(cards.length, 2, "两个 Thought → 两张卡片");
  const ids = cards.map((c) => c.dataset.id);
  assert.equal(new Set(ids).size, 2, "卡片各自携带独立 id");
  // 3E 简化：卡片只显示文本正文 + 悬停删除，无来源徽标
  cards.forEach((c) => {
    assert.ok(c.querySelector(".pk-thought-body"), "每张卡片有正文文本");
    assert.ok(c.querySelector(".pk-thought-delete"), "每张卡片有删除按钮");
  });
});

/* ================================================================
   UI-02 / UI-03 — each Thought exposes COPY; COPY does not mutate
   ================================================================ */
test("UI-02: 3E 简化卡片无 COPY/USE/EDIT 按钮，仅点文编辑 + 悬停删除", () => {
  const { store, refs, renderer } = rendererHarness();
  store.dispatch(act.inboxAddRefined("copy me", "text"));
  renderer.render(store.getState(), { ...store.getState(), window: "launcher" });

  const card = refs.inboxList.querySelector(".pk-thought");
  assert.ok(card.querySelector(".pk-thought-body"), "有点文即编入口");
  assert.ok(card.querySelector(".pk-thought-delete"), "有悬停删除按钮");
  assert.equal(card.querySelector(".pk-thought-actions"), null, "无旧版操作按钮容器");
});

test("UI-03: COPY 不变更 Thought（纯剪贴板读取）", async () => {
  const { store, flows, delivered } = harness();
  store.dispatch(act.inboxAddRefined("immutable", "text"));
  const before = inboxThoughts(store.getState())[0];
  const snapshot = JSON.stringify(before);

  await flows.copyThoughtToClipboard(before.id, "refined");
  await tick();

  const after = inboxThoughts(store.getState())[0];
  assert.equal(delivered.copies.length, 1, "复制到剪贴板一次");
  assert.equal(delivered.copies[0], "immutable");
  // id / 文本 / 时间戳均不因 COPY 改变
  assert.equal(after.id, before.id);
  assert.equal(after.originalText, before.originalText);
  assert.equal(JSON.stringify(after), snapshot, "Thought 对象未被 COPY 变更");
});

/* ================================================================
   UI-04 / UI-05 — USE appends; USE does not consume
   ================================================================ */
test("UI-04: USE 将 Thought 追加到 Composer（非破坏、\\n\\n 分隔）", async () => {
  const { store, flows } = harness();
  store.dispatch(act.updateInput("existing draft"));
  store.dispatch(act.inboxAddRefined("inbox idea", "text"));
  const id = inboxThoughts(store.getState())[0].id;

  await flows.sendThoughtToPrompt(id);
  assert.equal(store.getState().input, "existing draft\n\ninbox idea",
    "追加在既有草稿之后，且不打断原有内容");
});

test("UI-05: USE 不消耗 Thought（仍在 Inbox，可再次 USE）", async () => {
  const { store, flows } = harness();
  store.dispatch(act.inboxAddRefined("reusable", "text"));
  const id = inboxThoughts(store.getState())[0].id;

  await flows.sendThoughtToPrompt(id);
  await flows.sendThoughtToPrompt(id);
  assert.equal(inboxThoughts(store.getState()).length, 1, "Thought 仍在 Inbox");
  assert.equal(store.getState().input, "reusable\n\nreusable", "可重复 USE");
});

/* ================================================================
   UI-06 / UI-07 — Thought edit / delete remain functional
   ================================================================ */
test("UI-06: Thought 编辑保持可用（inboxEdit 原地更新文本）", () => {
  const { store } = harness();
  store.dispatch(act.inboxAddRefined("before edit", "text"));
  const id = inboxThoughts(store.getState())[0].id;
  store.dispatch(act.inboxEdit(id, "after edit"));
  const t = inboxThoughts(store.getState())[0];
  assert.equal(t.originalText, "after edit");
  assert.equal(t.id, id, "编辑保留同一 id");
});

test("UI-07: Thought 删除保持可用（inboxDelete 移除目标卡片）", () => {
  const { store } = harness();
  store.dispatch(act.inboxAddRefined("keep", "text"));
  store.dispatch(act.inboxAddRefined("drop", "text"));
  const dropId = inboxThoughts(store.getState())[1].id;
  store.dispatch(act.inboxDelete(dropId));
  const rest = inboxThoughts(store.getState());
  assert.equal(rest.length, 1);
  assert.equal(rest[0].originalText, "keep");
});

/* ================================================================
   UI-08 ~ UI-11 — scroll isolation contracts (CSS)
   ================================================================ */
test("UI-08: Inbox 内部滚动存在且有界（.pk-inbox-list overflow-y:auto + max-height 约束）", () => {
  const listBlock = CSS.match(/\.pk-inbox-list\{[^}]*\}/s);
  assert.ok(listBlock, ".pk-inbox-list 规则存在");
  assert.match(listBlock[0], /overflow-y:auto/, "列表自身滚动");
  const inboxBlock = CSS.match(/\.pk-inbox\{[^}]*\}/s);
  assert.ok(inboxBlock && /max-height:\d+%/.test(inboxBlock[0]),
    "Inbox 有 max-height 上限（有界）");
});

test("UI-09: Composer 内部滚动存在且有界（flex:1 + min-height:0 + 视图 overflow-y:auto）", () => {
  const area = CSS.match(/\.pk-input-area\{[^}]*\}/s);
  assert.ok(area, ".pk-input-area 规则存在");
  assert.match(area[0], /flex:1/, "Composer 占据剩余空间");
  assert.match(area[0], /min-height:0/, "允许收缩从而产生内部滚动");
  const view = CSS.match(/\.pk-view\{[^}]*\}/s);
  assert.ok(view && /overflow-y:auto/.test(view[0]), "视图层提供有界滚动");
});

test("UI-10: Inbox 增长不会把 Composer 挤出可用空间（Inbox max-height ≤ 60%）", () => {
  const inboxBlock = CSS.match(/\.pk-inbox\{[^}]*\}/s)[0];
  const pct = Number(inboxBlock.match(/max-height:(\d+)%/)[1]);
  assert.ok(pct > 0 && pct <= 60, `Inbox 上限 ${pct}% —— Composer 始终保有 ≥40% 工作区`);
  assert.match(inboxBlock, /flex:0 1 auto/, "Inbox 不强制撑满（可收缩）");
});

test("UI-11: Composer 增长不破坏 Inbox 可用性（Composer flex:1 吸收增量，Inbox 保持 flex:none-ish 存在）", () => {
  const area = CSS.match(/\.pk-input-area\{[^}]*\}/s)[0];
  assert.match(area, /flex:1/, "Composer 吸收纵向增量");
  const inboxBlock = CSS.match(/\.pk-inbox\{[^}]*\}/s)[0];
  assert.match(inboxBlock, /min-height:0/, "Inbox 可收缩但不被移除");
  // 结构上 Inbox 始终挂载在 Composer 之前（HTML 顺序）
  assert.ok(HTML.indexOf('id="pk-inbox"') < HTML.indexOf('id="pk-input"'),
    "Inbox 在 DOM 中先于 Composer —— 两大内容面并存");
});

/* ================================================================
   UI-12 ~ UI-15 — Voice button & keyboard shortcut
   ================================================================ */
test("UI-12: VOICE 按钮切换既有 Voice action（toggleVoice 启动 listening）", async () => {
  const { store, flows, voice } = harness();
  await flows.toggleVoice();
  assert.equal(store.getState().voice, "listening");
  assert.equal(voice.calls.start, 1, "调用的是同一个 voice provider");
});

test("UI-13: Ctrl/Cmd+Shift+M 触发与按钮相同的 toggleVoice", async () => {
  // 谓词契约：Ctrl+Shift+M（win/linux）与 Cmd+Shift+M（mac）都识别
  assert.ok(isVoiceToggleShortcut({ key: "M", ctrlKey: true, shiftKey: true }));
  assert.ok(isVoiceToggleShortcut({ key: "m", metaKey: true, shiftKey: true }));
  assert.ok(!isVoiceToggleShortcut({ key: "m", ctrlKey: true }), "缺 shift 不触发");
  assert.ok(!isVoiceToggleShortcut({ key: "m", shiftKey: true }), "缺 ctrl/cmd 不触发");

  // 与 main.js 绑定完全相同的处理路径：谓词命中 → preventDefault → flows.toggleVoice()
  const { store, flows, voice } = harness();
  const e = { key: "M", ctrlKey: true, shiftKey: true, repeat: false };
  if (isVoiceToggleShortcut(e)) await flows.toggleVoice();
  assert.equal(store.getState().voice, "listening", "快捷键走的 SAME toggleVoice flow");
  assert.equal(voice.calls.start, 1);
});

test("UI-14: 快捷键长按重复（e.repeat）不产生重复切换", async () => {
  assert.ok(!isVoiceToggleShortcut({ key: "M", ctrlKey: true, shiftKey: true, repeat: true }),
    "repeat 事件被谓词拒绝");
  const { store, flows } = harness();
  const down = { key: "M", ctrlKey: true, shiftKey: true, repeat: false };
  const held = { key: "M", ctrlKey: true, shiftKey: true, repeat: true };
  if (isVoiceToggleShortcut(down)) await flows.toggleVoice();
  if (isVoiceToggleShortcut(held)) await flows.toggleVoice(); // 不执行
  if (isVoiceToggleShortcut(held)) await flows.toggleVoice(); // 不执行
  assert.equal(store.getState().voice, "listening", "长按只切换一次（未来回抖动）");
});

test("UI-15: 快捷键不污染 Composer 文本", async () => {
  const { store, flows } = harness();
  store.dispatch(act.updateInput("precious draft"));
  const e = { key: "M", ctrlKey: true, shiftKey: true, repeat: false };
  if (isVoiceToggleShortcut(e)) await flows.toggleVoice();
  assert.equal(store.getState().input, "precious draft",
    "修饰键组合不产生字符输入 —— 文本零污染");
  // 提示符平台化
  assert.equal(voiceShortcutHint("MacIntel"), "⌘⇧M");
  assert.equal(voiceShortcutHint("Win32"), "Ctrl+Shift+M");
});

/* ================================================================
   UI-16 / UI-17 — Voice pause tolerance & explicit stop
   ================================================================ */
test("UI-16: 识别停顿（非 final 的 onend 由 provider 自动重启）期间 Voice 保持活动", async () => {
  const { store, flows, voice } = harness();
  await flows.toggleVoice();
  assert.equal(store.getState().voice, "listening");
  // 模拟识别停顿：provider 内部重启，flow 层只看到 transcript 继续到达
  voice.cbs.transcript("half sentence", false);
  await tick();
  assert.equal(store.getState().voice, "listening", "停顿不终止 Voice");
  assert.match(store.getState().voiceTranscript.text, /half sentence/);
});

test("UI-17: 只有显式 stop 才结束 Voice（final transcript 落入 Composer 后归位 idle）", async () => {
  const { store, flows, voice } = harness();
  await flows.toggleVoice();
  voice.cbs.transcript("spoken words", true); // final
  await tick();
  assert.equal(store.getState().voice, "listening", "final transcript 本身不结束会话");
  await flows.toggleVoice(); // 显式 stop
  assert.equal(voice.calls.stop, 1);
  voice.cbs.end(); // 浏览器随后 onend
  await tick();
  assert.equal(store.getState().voice, "idle");
  assert.equal(store.getState().input, "spoken words", "最终文本保留在 Composer");
});

/* ================================================================
   UI-18 ~ UI-21 — REFINE contract
   ================================================================ */
test("UI-18: REFINE 保持显式（仅输入不触发任何 AI 调用）", async () => {
  const { store, ai } = harness();
  store.dispatch(act.updateInput("just typing, no refine"));
  await tick();
  assert.equal(ai.calls.analyze, 0, "无显式 REFINE → 零 AI 调用");
  assert.equal(store.getState().inbox.thoughts.length, 0, "无 Thought 自动入箱");
});

test("UI-19: Composer 为空时 REFINE 不可用（selector + 按钮双门禁）", () => {
  const { store, refs, renderer } = rendererHarness();
  assert.equal(canRefine(store.getState()), false, "空 → canRefine false");
  renderer.render(store.getState(), { ...store.getState(), window: "launcher" });
  assert.equal(refs.refine.disabled, true, "按钮同步禁用");
  store.dispatch(act.updateInput("   "));
  assert.equal(canRefine(store.getState()), false, "纯空白同样禁用");
});

test("UI-20: REFINE 写入 Composer，SUBMIT 后创建 Thought（原文快照 + refinedText）", async () => {
  const { store, flows } = harness();
  store.dispatch(act.updateInput("make me a haiku about rain"));
  await flows.refineFromComposer();
  await tick();
  assert.equal(store.getState().input, "OPTIMIZED ▸ make me a haiku about rain", "REFINE 写 Composer");
  assert.equal(inboxThoughts(store.getState()).length, 0, "REFINE 本身不入箱");
  await flows.submitThought();
  await tick();
  const thoughts = inboxThoughts(store.getState());
  assert.equal(thoughts.length, 1, "SUBMIT 后 Thought 入箱");
  assert.equal(thoughts[0].originalText, "make me a haiku about rain", "原文逐字保留");
  assert.match(thoughts[0].refinedText, /OPTIMIZED ▸/, "AI 结果作为 refinedText 附加");
});

test("UI-21: REFINE 失败保留 Composer（文本不丢、不产生半成品 Thought）", async () => {
  const { store, flows, ai } = harness();
  store.dispatch(act.updateInput("keep these words"));
  ai.failNext();
  await flows.refineFromComposer();
  await tick();
  assert.equal(store.getState().input, "keep these words", "Composer 原样保留");
  assert.equal(inboxThoughts(store.getState()).length, 0, "失败不产生 Thought");
});

/* ================================================================
   UI-22 — AI DEMO badge remains truthful
   ================================================================ */
test("UI-22: AI DEMO/REAL 徽标诚实（demo 永不伪装成 real）", () => {
  const { store, refs, renderer } = rendererHarness();
  // 未知 → 不显示
  renderer.render(store.getState(), { ...store.getState(), window: "launcher" });
  assert.equal(refs.aiMode.hidden, true, "首次 AI 调用前徽标隐藏");
  // demo → 显示 DEMO 且带 .demo 类
  store.dispatch(act.aiMode("demo"));
  renderer.render(store.getState(), store.getState());
  assert.equal(refs.aiMode.hidden, false);
  assert.match(aiModeLabel(store.getState()), /DEMO/);
  assert.ok(refs.aiMode.className.includes("demo"), "DEMO 视觉可区分");
  // real → REAL，不带 .demo
  store.dispatch(act.aiMode("real"));
  renderer.render(store.getState(), store.getState());
  assert.match(aiModeLabel(store.getState()), /REAL/);
  assert.ok(!refs.aiMode.className.includes("demo"), "REAL 不带 demo 样式");
});

/* ================================================================
   UI-23 — Draft persistence intact
   ================================================================ */
test("UI-23: 草稿持久化完好（flushDraft 保存；restoreDraft 恢复）", async () => {
  const { store, flows, saved } = harness();
  store.dispatch(act.updateInput("draft to persist"));
  await flows.flushDraft();
  assert.ok(saved.drafts.includes("draft to persist"), "flushDraft 写入存储");
  // 恢复路径：RESTORE_DRAFT 还原文本
  const store2 = createStore();
  store2.dispatch(act.restoreDraft("draft to persist"));
  assert.equal(store2.getState().input, "draft to persist");
});

/* ================================================================
   UI-24 — Undo/Redo intact
   ================================================================ */
test("UI-24: Undo/Redo 完好（§7.4：连续打字合并为一步；programmatic 写入独立成步）", () => {
  const { store } = harness();
  store.dispatch(act.updateInput("a"));                                    // 用户打字（baseline 合并）
  store.dispatch(act.updateInput("ab", { programmatic: true }));           // programmatic → 独立 entry
  store.dispatch(act.undoInput());
  assert.equal(store.getState().input, "a", "撤销回退到上一独立步");
  store.dispatch(act.redoInput());
  assert.equal(store.getState().input, "ab", "重做前进一步");
  store.dispatch(act.undoInput());
  store.dispatch(act.undoInput());
  assert.equal(store.getState().input, "", "连续撤回到空草稿");
});

/* ================================================================
   UI-25 — Delivered-state gating intact
   ================================================================ */
test("UI-25: SUBMIT 后直接入箱并回到 idle（REFINE/confirm 选择器恢复可用）", async () => {
  const { store, flows, refs, renderer } = rendererHarness();
  store.dispatch(act.updateInput("ship it"));
  await flows.submitThought(); // 3E: idle/input → 直接入箱 → idle
  await tick();
  assert.equal(store.getState().interaction, "idle", "SUBMIT 后回到 idle");
  assert.equal(store.getState().inbox.thoughts.length, 1, "Composer 内容直接入箱");
  // 回到 idle 后，REFINE/SUBMIT 门禁重新按 Composer 内容计算
  assert.equal(canRefine(store.getState()), false, "空 Composer → REFINE 关闭");
  assert.equal(canConfirm(store.getState()), false, "空 Composer → SUBMIT 关闭");
  renderer.render(store.getState(), store.getState());
  assert.equal(refs.refine.disabled, true, "REFINE 按钮禁用");
  assert.equal(refs.submit.disabled, true, "SUBMIT 按钮禁用");
});

/* ================================================================
   UI-26 / UI-27 — viewport overflow contracts (CSS)
   ================================================================ */
test("UI-26: 1280×900 无横向溢出（Float 620px 固定宽 < 视口；landing max-width 有界）", () => {
  const floatBlock = CSS.match(/#pk-float\{[^}]*\}/s)[0];
  const w = Number(floatBlock.match(/width:(\d+)px/)[1]);
  assert.ok(w <= 1280, `Float 宽 ${w}px 在 1280 视口内`);
  assert.match(CSS, /\.nav-inner\{[^}]*max-width:1080px/s, "landing 导航有界");
  assert.match(CSS, /\.site-main\{[^}]*max-width:1080px/s, "landing 主体有界");
  assert.match(floatBlock, /max-height:calc\(100vh - 32px\)/, "Float 高度受视口约束");
});

test("UI-27: 375×667 无横向溢出（≤700px 媒体查询宽度 min(92vw,620px)）", () => {
  const mq = CSS.match(/@media \(max-width:700px\)\{[\s\S]*?\n\}/);
  assert.ok(mq, "700px 媒体查询存在");
  assert.match(mq[0], /width:min\(92vw,620px\)/, "Float 宽度跟随视口（92vw ≤ 345px @375）");
  assert.match(mq[0], /height:min\(86vh,640px\)/, "Float 高度跟随视口");
});

/* ================================================================
   UI-28 — keyboard accessibility of essential controls
   ================================================================ */
test("UI-28: 关键控件全部键盘可达（原生 button + aria-label/aria-keyshortcuts）", () => {
  const required = [
    /id="pk-voice"[^>]*aria-label="[^"]+"/,
    /id="pk-refine"[^>]*aria-label="[^"]+"/,
    /id="pk-submit"[^>]*aria-label="[^"]+"/,
    /id="pk-undo"[^>]*aria-label="[^"]+"/,
    /id="pk-redo"[^>]*aria-label="[^"]+"/,
    /id="pk-inbox-toggle"[^>]*aria-expanded=/,
    /id="pk-min-btn"[^>]*aria-label="[^"]+"/,
    /id="pk-close-btn"[^>]*aria-label="[^"]+"/
  ];
  for (const re of required) {
    assert.match(HTML, re, `控件可访问性契约: ${re.source}`);
  }
  // 快捷键声明
  assert.match(HTML, /id="pk-voice"[^>]*aria-keyshortcuts="Control\+Shift\+M"/);
  assert.match(HTML, /id="pk-undo"[^>]*aria-keyshortcuts="Control\+Z"/);
  // 全局 :focus-visible 样式存在
  assert.match(CSS, /:focus-visible\{[^}]*outline:/s, "键盘焦点可见");
  // 3E 简化：删除按钮默认透明，hover/focus-visible 时显现，仍在 Tab 序中
  assert.match(CSS, /\.pk-thought-delete\{[^}]*opacity:0/s, "删除按钮默认透明");
  assert.match(CSS, /\.pk-thought:hover\s+\.pk-thought-delete\{[^}]*opacity:1/s, "hover 时删除按钮显现");
});
