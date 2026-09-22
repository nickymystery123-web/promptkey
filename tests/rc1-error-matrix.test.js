/* PHASE 3D RC1 — GATE D 错误处理矩阵复验（SPEC B §3.1）。
   10 类错误中 9 类已有既有测试覆盖（复验表见交付报告）：
     API Timeout      → gateway.test.js #5；http-service.test.js（AI_TIMEOUT 不降级）
     Network Error    → http-service.test.js；3c-3a.test.js AI-3
     AI Provider      → deepseek-provider.test.js #7/#15
     Invalid Response → gateway.test.js #4；deepseek-provider.test.js #9
     JSON Parse       → http-service.test.js（non-JSON → NETWORK_ERROR）
     Speech Error     → voice-loop.test.js L/M
     Mic Permission   → voice-loop.test.js K；voice-error-reset.test.js 1
     Empty Input      → machine.test.js；3c-2b.test.js E3/UI-19
     Storage Error    → 3c-3a.test.js TP-6/TP-8
   本文件补唯一缺项：Clipboard Error（ERR-CLIP-01..02）。
   零延时、mock AI/Voice/Storage（复用 3c-3b.test.js harness 模式）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/state/store.js";
import { act } from "../src/state/actions.js";
import { createFlows } from "../src/flows/prompt-flow.js";
import { inboxThoughts } from "../src/state/selectors.js";

const zeroDelays = {
  understandStep: 0, understandFirst: 0, structuringSettle: 0,
  readyToSend: 0, sending: 0, transcribing: 0
};
async function tick(n = 8) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

function mockAI() {
  return {
    async analyzePrompt(input) {
      return {
        prompt: { role: "Expert Assistant", objective: "OPTIMIZED ▸ " + input, context: "", requirements: ["Clear"], style: ["Minimal"], output: "" },
        detectedIntent: "general"
      };
    },
    async improvePrompt(p) { return p; },
    async rewritePrompt(p) { return p; }
  };
}

function harness() {
  const store = createStore();
  const ai = mockAI();
  const voice = {
    isAvailable: () => true, async start() {}, async stop() {}, async abort() {},
    onTranscript() {}, onEnd() {}, onError() {}
  };
  const storage = {
    saveSession: async () => {}, loadSession: async () => null, clearSession: async () => {},
    savePosition: async () => {}, loadPosition: async () => null,
    saveOrbPosition: async () => {}, loadOrbPosition: async () => null,
    saveDraft: async () => {}, loadDraft: async () => null, clearDraft: async () => {},
    saveInbox: async () => {}, loadInbox: async () => []
  };
  const copies = [];
  let failCopy = false;
  const delivery = {
    deliver: async (p) => ({ ok: true }),
    copy: async (text) => {
      if (failCopy) throw new Error("clipboard denied");
      copies.push(text);
    }
  };
  const flows = createFlows({ store, ai, voice, delivery, storage, delays: zeroDelays });
  flows.bindVoiceCallbacks();
  return { store, flows, copies, failAgain: (v) => { failCopy = v; } };
}

/* ---- ERR-CLIP-01: clipboard 写入失败 → DELIVERY_ERROR + 用户可理解提示，不崩溃 ---- */
test("ERR-CLIP-01: copy 失败 → DELIVERY_ERROR + 'Copy failed' 提示；Thought 与状态不崩溃", async () => {
  const h = harness();
  h.failAgain(true);
  h.store.dispatch(act.inboxAddRefined("帮我写一段关于 AI 硬件产品发布的微博文案", "text"));
  const thoughts = inboxThoughts(h.store.getState());
  assert.equal(thoughts.length, 1, "前置：Thought 已入箱");

  await h.flows.copyThoughtToClipboard(thoughts[0].id, "refined");
  await tick();
  const s = h.store.getState();
  assert.ok(s.error, "错误状态已置位");
  assert.equal(s.error.code, "DELIVERY_ERROR", "错误码为 DELIVERY_ERROR");
  assert.match(s.error.message, /Copy failed/i, "用户可理解的失败提示");
  assert.equal(inboxThoughts(s).length, 1, "Thought 不因复制失败丢失");
});

/* ---- ERR-CLIP-02: 失败可恢复 —— 重试成功出 COPIED；下一次用户动作清除 error ---- */
test("ERR-CLIP-02: clipboard 失败后重试成功 → COPIED toast；后续输入清除 error，会话存活", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("帮我写一段关于 AI 硬件产品发布的微博文案", "text"));
  h.store.dispatch(act.inboxRefine(h.store.getState().inbox.thoughts[0].id, "OPTIMIZED ▸ 文案"));
  const thought = inboxThoughts(h.store.getState())[0];

  h.failAgain(true);
  await h.flows.copyThoughtToClipboard(thought.id, "refined");
  await tick();
  assert.ok(h.store.getState().error, "前置：第一次复制失败");

  h.failAgain(false);
  await h.flows.copyThoughtToClipboard(thought.id, "refined");
  await tick();
  let s = h.store.getState();
  assert.equal(s.toast.text, "COPIED", "重试成功 → COPIED toast");
  assert.equal(h.copies.length, 1, "剪贴板写入恰好一次（重试那次）");

  // error 为可恢复设计：下一次用户输入（UPDATE_INPUT）清除
  h.store.dispatch(act.updateInput("继续写下一句"));
  s = h.store.getState();
  assert.equal(s.error, null, "用户动作后错误清除");
  assert.equal(s.input, "继续写下一句", "会话继续可用");
});

function store_dispatch_input(h) {
  h.store.dispatch(act.updateInput("帮我写一段关于 AI 硬件产品发布的微博文案"));
}
