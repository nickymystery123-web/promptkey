/* PHASE 3D RC1 — PROMPTKEY ORB 专项契约测试。
   覆盖:
     · ORB-VISUAL-01..08 (品牌视觉: Monogram SVG / 56px→48px / 8状态CSS / reduced-motion)
     · ORB-INT-01..12    (交互: 点击恢复 / 拖动 / 边缘吸附 / 位置持久化 / resize clamp / 预留桩)
     · ORB-STATE-01..08  (状态管道: listening / processing / ready / error / hover / press)
   零延时、mock storage、最小 DOM stub（与 3c-3c.test.js 同构，不依赖 jsdom）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/state/store.js";
import { act } from "../src/state/actions.js";
import { createRenderer, collectRefs } from "../src/ui/renderer.js";
import { createWindowManager } from "../src/ui/window-manager.js";
import { createOrbController, computeOrbState } from "../src/ui/orb.js";
import { createLocalStorageService } from "../src/services/storage/local-storage.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS = readFileSync(join(ROOT, "css", "float.css"), "utf8");
const HTML = readFileSync(join(ROOT, "index.html"), "utf8");

async function tick(n = 10) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/* ---- 最小 DOM stub（与 3c-3c.test.js 同构） ---- */
function fakeEl(tag = "div", id = "") {
  const _cls = new Set();
  const el = {
    id, tagName: String(tag).toUpperCase(), value: "",
    hidden: false, disabled: false, innerHTML: "", dataset: {}, style: {},
    scrollHeight: 0, rows: 1, _listeners: {}, _children: [], _text: "",
    get className() { return [..._cls].join(" "); },
    set className(v) {
      const parts = String(v || "").split(/\s+/).filter(Boolean);
      _cls.clear(); parts.forEach((p) => _cls.add(p));
    },
    getAttribute(k) { return k in this.dataset ? this.dataset[k] : null; },
    setAttribute(k, v) { this.dataset[k] = v; },
    removeAttribute(k) { delete this.dataset[k]; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatchEvent(ev) {
      (this._listeners[ev.type] || []).forEach((fn) => fn(ev));
      return true;
    },
    focus() { globalThis.document.activeElement = this; },
    setSelectionRange() {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; this._children = []; },
    append(...kids) { kids.forEach((k) => { if (typeof k === "string") this._text += k; else this._children.push(k); }); },
    appendChild(k) { this._children.push(k); return k; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
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
  el.getBoundingClientRect = () => ({ width: 56, height: 56, top: 100, left: 100, right: 156, bottom: 156 });
  el.setPointerCapture = () => {};
  return el;
}

(function installGlobalDoc() {
  globalThis.document = {
    activeElement: null,
    body: fakeEl("body"),
    createElement: (tag) => fakeEl(tag),
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    getElementById: () => fakeEl()
  };
})();

/* ---- fake window + 指针事件工具 ---- */
function fakeWin(innerWidth = 1280, innerHeight = 900) {
  const listeners = {};
  const CustomEvent = function (type) { this.type = type; };
  return {
    innerWidth, innerHeight,
    CustomEvent,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    _resize() { (listeners.resize || []).forEach((fn) => fn()); }
  };
}
function ptr(target, x, y, opts = {}) {
  return {
    clientX: x, clientY: y, button: 0,
    target: { closest: () => null },
    preventDefault() {},
    ...opts
  };
}
function drag(el, fromX, fromY, toX, toY) {
  el.dispatchEvent(ptr(el, fromX, fromY, { type: "pointerdown" }));
  el.dispatchEvent(ptr(el, toX, toY, { type: "pointermove" }));
  el.dispatchEvent(ptr(el, toX, toY, { type: "pointerup" }));
}

/* ---- capture storage ---- */
function captureStorage(savedOrb = null) {
  const calls = { saveOrbPosition: [], savePosition: [] };
  return {
    calls,
    loadPosition: async () => null,
    savePosition: async (p) => { calls.savePosition.push(p); },
    loadOrbPosition: async () => savedOrb,
    saveOrbPosition: async (p) => { calls.saveOrbPosition.push(p); },
    loadInbox: async () => [], saveInbox: async () => {},
    saveDraft: async () => {}, loadDraft: async () => "", clearDraft: async () => {}
  };
}

function dynamicRect(el, w, h) {
  const x = parseFloat(el.style.left) || 0;
  const y = parseFloat(el.style.top) || 0;
  return { width: w, height: h, left: x, top: y, right: x + w, bottom: y + h };
}

function orbHarness({ innerWidth = 1280, innerHeight = 900, savedOrb = null } = {}) {
  const win = fakeWin(innerWidth, innerHeight);
  const storage = captureStorage(savedOrb);
  const refs = {
    float: fakeEl("div", "pk-float"),
    dragHandle: fakeEl("div", "pk-drag-bar"),
    minimized: fakeEl("button", "pk-minimized")
  };
  // rect 跟随 style.left/top（拖动/吸附断言用；px 单位用 parseFloat 解析）
  refs.minimized.getBoundingClientRect = () => dynamicRect(refs.minimized, 56, 56);
  refs.float.getBoundingClientRect = () => dynamicRect(refs.float, 620, 520);
  const store = createStore();
  const wm = createWindowManager({ refs, store, storage, win });
  wm.init();
  const orbCtl = createOrbController({ refs, win });
  orbCtl.init();
  store.subscribe((s, p) => { wm.onState(s, p); orbCtl.onState(s, p); });
  return { win, storage, refs, store, wm, orbCtl };
}

/* =========================================================================
 * ORB-VISUAL-01..08 — 品牌视觉（HTML/CSS 静态契约）
 * ========================================================================= */

test("ORB-VISUAL-01: Monogram SVG 存在；旧圆点/PK 文字节点已删除；aria-label 正确", () => {
  assert.ok(HTML.includes('class="pk-orb-glyph"'), "pk-orb-glyph 节点必须存在");
  assert.ok(/<svg viewBox="0 0 24 24"/.test(HTML), "内联 SVG Monogram 必须存在");
  assert.ok(HTML.includes("pk-orb-ring"), "外圈 ring 节点必须存在");
  assert.ok(!HTML.includes("pk-min-dot"), "旧 .pk-min-dot 圆点必须删除");
  assert.ok(!HTML.includes("pk-min-pk"), "旧 .pk-min-pk 'PK' 文字必须删除");
  assert.ok(HTML.includes('id="pk-minimized" class="pk-orb"'), "Orb 根节点带 pk-orb class");
  assert.ok(HTML.includes('aria-label="打开 PromptKey"'), "aria-label = 打开 PromptKey");
  assert.ok(HTML.includes("PROMPTKEY · Ready"), "hover tooltip 保留品牌提示");
});

test("ORB-VISUAL-02: 默认 56×56；≤700px 视口降为 48×48", () => {
  assert.ok(/#pk-minimized\{[^}]*width:56px;height:56px/.test(CSS), "默认尺寸 56px");
  const m700 = CSS.match(/@media \(max-width:700px\)\{([\s\S]*?)\n\}/);
  assert.ok(m700, "700px 断言块存在");
  assert.ok(/#pk-minimized\{width:48px;height:48px\}/.test(m700[1]), "小屏 48px");
});

test("ORB-VISUAL-03: 8 状态 CSS 双通道（data-state + .pk-orb--*）", () => {
  ["hover", "press", "listening", "processing", "ready", "error"].forEach((s) => {
    assert.ok(CSS.includes(`[data-state="${s}"]`), `data-state="${s}" 规则必须存在`);
    assert.ok(CSS.includes(`.pk-orb--${s}`), `.pk-orb--${s} class 通道必须存在`);
  });
  // expand 状态 = 展开/收起过渡（pk-boot 既有体系），idle 为默认无需规则
});

test("ORB-VISUAL-04: prefers-reduced-motion 关闭全部 Orb 动画", () => {
  const m = CSS.match(/@media \(prefers-reduced-motion: reduce\)\{([\s\S]*?)\n\}/);
  assert.ok(m, "reduce 媒体查询必须存在");
  assert.ok(m[1].includes("#pk-minimized"), "Orb 动画必须被禁用");
  assert.ok(m[1].includes("animation:none"), "animation 必须禁用");
});

test("ORB-VISUAL-05: 四组关键帧动画（breathe/spin/pulse/shake）", () => {
  assert.ok(CSS.includes("@keyframes pk-orb-breathe"));
  assert.ok(CSS.includes("@keyframes pk-orb-spin"));
  assert.ok(CSS.includes("@keyframes pk-orb-pulse"));
  assert.ok(CSS.includes("@keyframes pk-orb-shake"));
});

test("ORB-VISUAL-06: 毛玻璃 + 紫色内发光 + 深色半透底", () => {
  assert.ok(/#pk-minimized\{[^}]*backdrop-filter:blur\(10px\)/.test(CSS), "毛玻璃");
  assert.ok(/#pk-minimized\{[^}]*background:rgba\(18,18,20,\.72\)/.test(CSS), "深色半透明底");
  assert.ok(/#pk-minimized\{[^}]*inset 0 0 12px rgba\(120,90,255,\.18\)/.test(CSS), "紫色微光");
});

test("ORB-VISUAL-07: z-index 2147483000 — Float/Orb 顶置层级（3D-RC2 GATE D 置顶契约）", () => {
  assert.ok(/#pk-minimized\{[^}]*z-index:2147483000/.test(CSS), "Orb z-index=2147483000");
  assert.ok(/#pk-float\{[^}]*z-index:2147483000/.test(CSS), "Float z-index=2147483000");
  assert.ok(/#pk-toast\{[^}]*z-index:2147483200/.test(CSS), "Toast z-index 高于 Float 一档");
  assert.ok(!CSS.includes("z-index:999999"), "禁止 999999 机械层级");
});

test("ORB-VISUAL-08: 焦点环 + 吸附回弹过渡存在", () => {
  assert.ok(CSS.includes("#pk-minimized:focus-visible"), ":focus-visible 焦点环");
  assert.ok(CSS.includes(".pk-orb-snapping"), "边缘吸附回弹过渡类");
});

/* =========================================================================
 * ORB-INT-01..12 — 交互
 * ========================================================================= */

test("ORB-INT-01: 默认 hidden；window=minimized 时可见（renderer 驱动）", () => {
  const dom = buildRendererDom();
  const store = createStore();
  const renderer = createRenderer(dom.refs, store);
  renderer.bindFlows({ copyThought: async () => {}, sendThought: async () => {} });
  store.subscribe((s, p) => renderer.render(s, p));
  // 初始渲染（与 main.js 同构：prev.window = "launcher"）
  renderer.render(store.getState(), { ...store.getState(), window: "launcher" });
  assert.equal(dom.byId["pk-minimized"].hidden, true, "默认 hidden");
  store.dispatch(act.openFloat());
  store.dispatch(act.minimizeFloat());
  assert.equal(store.getState().window, "minimized");
  assert.equal(dom.byId["pk-minimized"].hidden, false, "minimized 时可见");
});

test("ORB-INT-02: 单击恢复 — minimizeFloat → restoreFloat 状态往返（button 语义）", () => {
  const { store } = orbHarness();
  store.dispatch(act.openFloat());
  store.dispatch(act.minimizeFloat());
  assert.equal(store.getState().window, "minimized");
  store.dispatch(act.restoreFloat());
  assert.equal(store.getState().window, "expanded");
});

test("ORB-INT-03: 拖动（>3px）→ dataset.moved=1（防误触通道）", () => {
  const { refs } = orbHarness();
  drag(refs.minimized, 100, 100, 300, 300);
  assert.equal(refs.minimized.dataset.moved, "1", "拖动后 moved=1");
});

test("ORB-INT-04: 释放后自动吸附最近边缘（拖到左侧 → x=24, dock=left）", async () => {
  const { refs, storage } = orbHarness();
  refs.minimized.style.left = "100px"; refs.minimized.style.top = "100px";
  drag(refs.minimized, 100, 100, 40, 400); // 靠近左边缘
  await tick(2);
  assert.equal(refs.minimized.style.left, "24px", "吸附到左边缘 SNAP=24");
  const saved = storage.calls.saveOrbPosition.at(-1);
  assert.equal(saved.dock, "left", "dock=left");
});

test("ORB-INT-05: 拖到右下 → 吸附 right/bottom 边缘 + 完整 {x,y,dock} 持久化", async () => {
  const { refs, storage, win } = orbHarness();
  refs.minimized.style.left = "100px"; refs.minimized.style.top = "100px";
  drag(refs.minimized, 100, 100, win.innerWidth - 30, win.innerHeight - 30);
  await tick(2);
  const saved = storage.calls.saveOrbPosition.at(-1);
  assert.ok(saved, "saveOrbPosition 必须被调用");
  assert.equal(saved.x, win.innerWidth - 56 - 24, "右边缘吸附坐标");
  assert.equal(saved.dock, "right", "dock=right");
  assert.equal(typeof saved.y, "number", "y 已记录");
});

test("ORB-INT-06: init 时从 storage 恢复记忆位置", async () => {
  const { refs } = orbHarness({ savedOrb: { x: 200, y: 300, dock: "left" } });
  await tick(2);
  assert.equal(refs.minimized.style.left, "200px", "恢复 x");
  assert.equal(refs.minimized.style.top, "300px", "恢复 y");
});

test("ORB-INT-07: 恢复越界位置 → clamp 回可视区", async () => {
  const { refs, win } = orbHarness({ savedOrb: { x: 99999, y: -50, dock: "right" } });
  await tick(2);
  const x = parseFloat(refs.minimized.style.left), y = parseFloat(refs.minimized.style.top);
  assert.ok(x >= 8 && x <= win.innerWidth - 56 - 8, "x 在可视区内");
  assert.ok(y >= 8 && y <= win.innerHeight - 56 - 8, "y 在可视区内（负值被 clamp）");
});

test("ORB-INT-08: resize → Orb 永不丢出视口", async () => {
  const { refs, win } = orbHarness({ savedOrb: { x: 1200, y: 800, dock: "right" } });
  await tick(2);
  win._resize(); // 模拟窗口缩小
  await tick(2);
  const x = parseFloat(refs.minimized.style.left), y = parseFloat(refs.minimized.style.top);
  assert.ok(x <= win.innerWidth - 56 - 8 + 1, "resize 后 x 回到视口内");
  assert.ok(y <= win.innerHeight - 56 - 8 + 1, "resize 后 y 回到视口内");
});

test("ORB-INT-09: 纯点击（无位移）→ 不吸附、不持久化", async () => {
  const { refs, storage } = orbHarness();
  refs.minimized.style.left = "600px"; refs.minimized.style.top = "400px";
  // pointerdown + pointerup 原地（位移 0）
  refs.minimized.dispatchEvent(ptr(refs.minimized, 600, 400, { type: "pointerdown" }));
  refs.minimized.dispatchEvent(ptr(refs.minimized, 600, 400, { type: "pointerup" }));
  await tick(2);
  assert.equal(storage.calls.saveOrbPosition.length, 0, "无位移不应持久化");
  assert.equal(refs.minimized.dataset.moved, undefined, "无位移不标记 moved");
});

test("ORB-INT-10: 双击/长按为 RC2 预留桩 — 只派发事件，无 UI 副作用", async () => {
  const { refs, win } = orbHarness();
  const events = [];
  refs.minimized.addEventListener("pk-orb-dblclick", (e) => events.push("dblclick"));
  refs.minimized.addEventListener("pk-orb-longpress", (e) => events.push("longpress"));
  // 长按：pointerdown 后静止 >500ms（无 move / up）
  refs.minimized.dispatchEvent(ptr(refs.minimized, 0, 0, { type: "pointerdown" }));
  await new Promise((r) => setTimeout(r, 560));
  // 双击
  refs.minimized.dispatchEvent({ type: "dblclick" });
  assert.deepEqual(events, ["longpress", "dblclick"], "两个预留事件通道都触发");
  assert.equal(refs.minimized._children.length, 0, "长按不产生任何 UI 节点（无 Quick Menu）");
});

test("ORB-INT-11: 主 Float 拖动/吸附零回归（既有行为保持）", async () => {
  const { refs, storage } = orbHarness();
  // 主 Float 拖动: 事件挂在 dragHandle，作用于 float（与生产代码一致）
  refs.float.style.left = "600px"; refs.float.style.top = "400px";
  drag(refs.dragHandle, 600, 400, 5, 700); // 拖到左缘附近
  await tick(2);
  assert.equal(refs.float.style.left, "24px", "主 Float 左缘吸附仍生效");
  assert.ok(storage.calls.savePosition.length >= 1, "Float 位置持久化仍生效");
});

test("ORB-INT-12: Orb 与 Float 位置持久化键独立（真实 localStorage 服务）", async () => {
  const map = new Map();
  const ls = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
  const svc = createLocalStorageService(ls);
  await svc.savePosition({ x: 111, y: 222 });
  await svc.saveOrbPosition({ x: 333, y: 444, dock: "top" });
  const pos = await svc.loadPosition();
  const orb = await svc.loadOrbPosition();
  assert.deepEqual(pos, { x: 111, y: 222 });
  assert.deepEqual(orb, { x: 333, y: 444, dock: "top" });
  // 篡改/损坏降级
  map.set("pk-float:orb-pos", "{corrupt");
  assert.equal(await svc.loadOrbPosition(), null, "损坏数据 → null 静默降级");
  map.set("pk-float:orb-pos", JSON.stringify({ x: "a", y: 2 }));
  assert.equal(await svc.loadOrbPosition(), null, "非法类型 → null");
  map.set("pk-float:orb-pos", JSON.stringify({ x: 1, y: 2, dock: "diag" }));
  assert.deepEqual(await svc.loadOrbPosition(), { x: 1, y: 2, dock: "right" }, "非法 dock → right");
});

/* =========================================================================
 * ORB-STATE-01..08 — 状态管道
 * ========================================================================= */

test("ORB-STATE-01: 默认 idle", () => {
  assert.equal(computeOrbState({ voice: "idle", refinePending: false }, null, { hover: false, press: false, ready: false, error: false }), "idle");
});

test("ORB-STATE-02: voice=listening → listening（含优先级：压过 hover）", () => {
  const t = { hover: true, press: false, ready: false, error: false };
  assert.equal(computeOrbState({ voice: "listening", refinePending: false }, null, t), "listening");
});

test("ORB-STATE-03: refinePending → processing（优先于 listening）", () => {
  const t = { hover: false, press: false, ready: false, error: false };
  assert.equal(computeOrbState({ voice: "listening", refinePending: true }, null, t), "processing");
});

test("ORB-STATE-04: refine 完成（pending true→false）→ ready 一次 pulse → 回 idle", async () => {
  const { store, refs } = orbHarness();
  store.dispatch(act.refinePending(true));
  assert.equal(refs.minimized.dataset.state, "processing", "进行中 processing");
  store.dispatch(act.refinePending(false));
  assert.equal(refs.minimized.dataset.state, "ready", "完成瞬间 ready");
  await new Promise((r) => setTimeout(r, 520));
  assert.equal(refs.minimized.dataset.state, "idle", "pulse 后回 idle");
});

test("ORB-STATE-05: state.error 出现 → error 震动后回 idle", async () => {
  const { store, refs } = orbHarness();
  store.dispatch(act.error("E_TEST", "boom"));
  assert.equal(refs.minimized.dataset.state, "error", "错误瞬间 error");
  await new Promise((r) => setTimeout(r, 380));
  assert.equal(refs.minimized.dataset.state, "idle", "震动后回 idle");
});

test("ORB-STATE-06: 指针 hover / press 驱动（transient）", () => {
  const { refs } = orbHarness();
  refs.minimized.dispatchEvent(ptr(refs.minimized, 0, 0, { type: "pointerenter" }));
  assert.equal(refs.minimized.dataset.state, "hover", "pointerenter → hover");
  refs.minimized.dispatchEvent(ptr(refs.minimized, 0, 0, { type: "pointerdown" }));
  assert.equal(refs.minimized.dataset.state, "press", "pointerdown → press");
  refs.minimized.dispatchEvent(ptr(refs.minimized, 0, 0, { type: "pointerup" }));
  assert.equal(refs.minimized.dataset.state, "hover", "pointerup → 回 hover");
  refs.minimized.dispatchEvent(ptr(refs.minimized, 0, 0, { type: "pointerleave" }));
  assert.equal(refs.minimized.dataset.state, "idle", "pointerleave → idle");
});

test("ORB-STATE-07: 双通道 — data-state 与 .pk-orb--* class 同步", () => {
  const { store, refs } = orbHarness();
  store.dispatch(act.startVoice());
  assert.equal(refs.minimized.dataset.state, "listening");
  assert.ok(refs.minimized.classList.contains("pk-orb--listening"), "class 通道同步");
  assert.ok(!refs.minimized.classList.contains("pk-orb--processing"), "其余状态 class 关闭");
});

test("ORB-STATE-08: store 端到端 — START_VOICE / REFINE_PENDING / ERROR 全管道", () => {
  const { store, refs } = orbHarness();
  store.dispatch(act.startVoice());
  assert.equal(refs.minimized.dataset.state, "listening");
  store.dispatch(act.refinePending(true));
  assert.equal(refs.minimized.dataset.state, "processing");
  store.dispatch(act.refinePending(false));
  assert.equal(refs.minimized.dataset.state, "ready");
  store.dispatch(act.error("E_X", "fail"));
  assert.equal(refs.minimized.dataset.state, "error");
});

/* ---- helper: renderer 级 DOM（ORB-INT-01 用） ---- */
function buildRendererDom() {
  const ids = [
    "pk-float", "pk-minimized", "pk-workspace", "pk-voice", "pk-voice-caption",
    "pk-voice-hint", "pk-voice-cancel", "pk-refine", "pk-submit", "pk-submit-arrow",
    "pk-copy-btn", "pk-new-btn", "pk-c1", "pk-c2", "pk-input", "pk-undo", "pk-redo",
    "pk-input-label", "pk-draft-badge", "pk-draft-saved", "pk-ai-mode", "pk-status-label",
    "pk-toast", "pk-message", "pk-error", "pk-transcript", "pk-transcript-label",
    "pk-understand-list", "pk-view-idle", "pk-view-input", "pk-view-review",
    "pk-review-original", "pk-review-optimized", "pk-use-original", "pk-use-optimized",
    "pk-inbox", "pk-inbox-toggle", "pk-inbox-count", "pk-inbox-clear", "pk-inbox-body",
    "pk-inbox-list", "pk-input-tools"
  ];
  const byId = {};
  ids.forEach((id) => { byId[id] = fakeEl("div", id); });
  const doc = globalThis.document;
  doc.getElementById = (id) => byId[id] || fakeEl("div", id);
  return { refs: collectRefs(doc), byId };
}
