/* PHASE 3C-3A — 专项测试（USE append / Thought persistence / Draft persistence /
   Undo-Redo history / Status badge / REAL-DEMO visibility）。

   Covers the FINAL product contract:
     · USE = APPEND (non-destructive, "\n\n" join, no auto-submit, no consume)
     · Creative Inbox persistence (save/load/edit/delete/order/corrupt/unavailable)
     · Composer draft persistence (debounce / restore / pagehide / clear rules)
     · Application-level edit history (typing coalescing, programmatic steps,
       undo/redo, redo clearing, selection restore)
     · Draft badge (EMPTY/DRAFT/DRAFT·VOICE/DRAFT·THOUGHT/SAVED/UNSAVED)
     · AI mode visibility (REAL/DEMO — Demo never masquerades as Real)

   Zero delays, mock AI/voice/delivery, real LocalStorageService over a mock
   localStorage map. No DOM. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/state/store.js";
import { act, ERR } from "../src/state/actions.js";
import { createFlows } from "../src/flows/prompt-flow.js";
import {
  canRefine, inboxThoughts,
  draftBadgeLabel, draftSavedLabel, canUndoInput, canRedoInput, aiModeLabel
} from "../src/state/selectors.js";
import { createLocalStorageService } from "../src/services/storage/local-storage.js";
import { createFallbackAIService } from "../src/services/ai/fallback-service.js";
import { createHistory, pushEntry, undo, redo, canUndo, canRedo } from "../src/state/history.js";
import { thoughtCopyText } from "../src/models/thought.js";

const zeroDelays = {
  understandStep: 0, understandFirst: 0, structuringSettle: 0,
  readyToSend: 0, sending: 0, transcribing: 0, draftDebounce: 1
};
async function tick(n = 12) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/* ---- mock localStorage (in-memory Map) ---- */
function mockLS() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map
  };
}

/* ---- controllable mock AI ---- */
function mockAI() {
  const calls = { analyze: 0, improve: 0, rewrite: 0 };
  const api = {
    calls,
    lastOptions: null,
    failNext() { api._fail = true; },
    _fail: false,
    analyzePrompt(input, options = {}) {
      calls.analyze++;
      api.lastOptions = options;
      if (api._fail) {
        api._fail = false;
        return Promise.reject(Object.assign(new Error("mock AI failure"), { code: "AI_ERROR" }));
      }
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

/* ---- harness with a REAL LocalStorageService over mock localStorage ---- */
function harness({ ls = mockLS(), delays = zeroDelays } = {}) {
  const store = createStore();
  const ai = mockAI();
  const voice = mockVoice();
  const storage = createLocalStorageService(ls);
  const storageSpy = {
    saveInbox: async (t) => storage.saveInbox(t),
    loadInbox: () => storage.loadInbox(),
    clearInbox: () => storage.clearInbox(),
    saveDraft: (t) => storage.saveDraft(t),
    loadDraft: () => storage.loadDraft(),
    clearDraft: () => storage.clearDraft(),
    saveSession: async () => {}, loadSession: async () => null, clearSession: async () => {},
    savePosition: async () => {}, loadPosition: async () => null
  };
  const clears = { inbox: 0, draft: 0 };
  const rawClearInbox = storageSpy.clearInbox.bind(storageSpy);
  const rawClearDraft = storageSpy.clearDraft.bind(storageSpy);
  storageSpy.clearInbox = async () => { clears.inbox++; return rawClearInbox(); };
  storageSpy.clearDraft = async () => { clears.draft++; return rawClearDraft(); };
  const delivered = { calls: 0, copies: [] };
  const delivery = {
    deliver: async (prompt) => { delivered.calls++; return { ok: true }; },
    copy: async (text) => { delivered.copies.push(text); }
  };
  const flows = createFlows({ store, ai, voice, delivery, storage: storageSpy, delays });
  flows.bindVoiceCallbacks();
  return { store, ai, voice, flows, ls, storage: storageSpy, clears, delivered };
}

/* boot simulation: what main.js does on startup */
async function bootRestore(h) {
  const thoughts = await h.storage.loadInbox();
  if (Array.isArray(thoughts) && thoughts.length) h.store.dispatch(act.inboxRestore(thoughts));
  const draft = await h.storage.loadDraft();
  if (typeof draft === "string" && draft) h.store.dispatch(act.restoreDraft(draft));
}

async function seedThought(h, text, refined) {
  h.store.dispatch(act.inboxAddRefined(text, "text"));
  const id = h.store.getState().inbox.thoughts[0].id;
  if (refined) h.store.dispatch(act.inboxRefine(id, refined));
  return id;
}

/* ==================================================================== *
 * 1. USE = APPEND (DECISION #1)                                        *
 * ==================================================================== */
test("USE-1: empty Composer + USE → Composer = thought text alone", async () => {
  const h = harness();
  const id = await seedThought(h, "idea", "REFINED ▸ idea");
  await h.flows.sendThoughtToPrompt(id);
  assert.equal(h.store.getState().input, "REFINED ▸ idea");
});

test("USE-2: non-empty Composer + USE → existing.trimEnd() + \\n\\n + thought (no overwrite)", async () => {
  const h = harness();
  const id = await seedThought(h, "idea", "Additional research context.");
  h.store.dispatch(act.updateInput("This is my original unfinished prompt."));
  await h.flows.sendThoughtToPrompt(id);
  assert.equal(
    h.store.getState().input,
    "This is my original unfinished prompt.\n\nAdditional research context."
  );
});

test("USE-3: Composer 尾部已有空白 → 最小化归一，不产生 \\n\\n\\n\\n；已有内部文本不被修改", async () => {
  const h = harness();
  const id = await seedThought(h, "idea", "  tail thought  ");
  h.store.dispatch(act.updateInput("kept text   \n\n  "));
  await h.flows.sendThoughtToPrompt(id);
  assert.equal(
    h.store.getState().input,
    "kept text\n\ntail thought",
    "只处理追加边界（trimEnd + \\n\\n + trim），内部文本不动"
  );
});

test("USE-4: multiple USE — 重复使用同一 Thought 追加两次，Thought 不被消费", async () => {
  const h = harness();
  const id = await seedThought(h, "idea", "REUSABLE");
  await h.flows.sendThoughtToPrompt(id);
  await h.flows.sendThoughtToPrompt(id);
  await h.flows.sendThoughtToPrompt(id);
  assert.equal(h.store.getState().input, "REUSABLE\n\nREUSABLE\n\nREUSABLE");
  assert.equal(inboxThoughts(h.store.getState()).length, 1, "USE 不删除 Thought");
});

test("USE-5: USE 不自动 submit（interaction 停留在 input，零 AI 调用）", async () => {
  const h = harness();
  const id = await seedThought(h, "idea", "REFINED");
  h.store.dispatch(act.updateInput("draft"));
  await h.flows.sendThoughtToPrompt(id);
  const s = h.store.getState();
  assert.equal(s.interaction, "input");
  assert.equal(s.session, null, "未进入 pipeline");
  assert.equal(h.ai.calls.analyze, 0, "USE 本身不调 AI");
});

test("USE-6: USE 无 refinedText 时回退 originalText；未知 id 不改动 Composer", async () => {
  const h = harness();
  const id = await seedThought(h, "only original");
  await h.flows.sendThoughtToPrompt(id);
  assert.equal(h.store.getState().input, "only original");
  h.store.dispatch(act.updateInput("keep me"));
  await h.flows.sendThoughtToPrompt("nonexistent-id");
  assert.equal(h.store.getState().input, "keep me", "未知 id 不清空/改动 Composer");
});

test("USE-7 (STEP 10 数据丢失验收): USE 后 Undo 恢复用户原文（不清空、不变 Thought）", async () => {
  const h = harness();
  const id = await seedThought(h, "idea", "Additional research context.");
  h.store.dispatch(act.updateInput("This is my original unfinished prompt."));
  await h.flows.sendThoughtToPrompt(id);
  assert.equal(
    h.store.getState().input,
    "This is my original unfinished prompt.\n\nAdditional research context."
  );
  h.store.dispatch(act.undoInput());
  assert.equal(
    h.store.getState().input,
    "This is my original unfinished prompt.",
    "Undo 恢复 USE 之前的用户原文"
  );
  assert.notEqual(h.store.getState().input, "", "不能清空 Composer");
  assert.notEqual(h.store.getState().input, "Additional research context.", "不能恢复成 Thought");
  h.store.dispatch(act.redoInput());
  assert.equal(
    h.store.getState().input,
    "This is my original unfinished prompt.\n\nAdditional research context.",
    "Redo 恢复追加结果"
  );
});

test("USE-8 (STEP 11 组合验收): A + Voice B + USE C → A B\\n\\nC，层层可 Undo", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("A"));
  h.store.dispatch(act.startVoice());
  h.voice.emitTranscript("B", true); // voice final → append "A B"
  h.store.dispatch(act.voiceEnded());
  const id = await seedThought(h, "idea", "C");
  await h.flows.sendThoughtToPrompt(id);
  assert.equal(h.store.getState().input, "A B\n\nC", "不覆盖任何已有内容");
  h.store.dispatch(act.undoInput());
  assert.equal(h.store.getState().input, "A B", "Undo 移除 USE 追加");
  h.store.dispatch(act.undoInput());
  assert.equal(h.store.getState().input, "A", "Undo 移除 Voice 追加");
});

/* ==================================================================== *
 * 2. Thought Persistence (DECISION #2)                                 *
 * ==================================================================== */
test("TP-1: REFINE → SUBMIT 后自动持久化（无需手动调用）", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("my thought"));
  await h.flows.refineFromComposer();
  await tick();
  assert.equal(h.store.getState().input, "OPTIMIZED ▸ my thought", "REFINE 写 Composer");
  await h.flows.submitThought();
  await tick();
  const persisted = await h.storage.loadInbox();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].originalText, "my thought");
  assert.match(persisted[0].refinedText, /OPTIMIZED ▸ my thought/);
  assert.equal(persisted[0].source, "text");
  assert.ok(persisted[0].id && persisted[0].createdAt && persisted[0].updatedAt, "全字段持久化");
});

test("TP-2: EDIT → 持久化；DELETE → 持久化；顺序保持一致", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("first", "text"));
  h.store.dispatch(act.inboxAddRefined("second", "text"));
  h.store.dispatch(act.inboxAddRefined("third", "text"));
  await tick();
  const ids = inboxThoughts(h.store.getState()).map((t) => t.id);
  h.store.dispatch(act.inboxEdit(ids[1], "second EDITED"));
  await tick();
  let persisted = await h.storage.loadInbox();
  assert.equal(persisted[1].originalText, "second EDITED", "编辑结果已持久化");
  h.store.dispatch(act.inboxDelete(ids[0]));
  await tick();
  persisted = await h.storage.loadInbox();
  assert.equal(persisted.length, 2, "删除已持久化");
  assert.deepEqual(
    persisted.map((t) => t.originalText),
    ["second EDITED", "third"],
    "顺序保持一致"
  );
});

test("TP-3: 刷新模拟（bootRestore）→ Thought A/B/C 全部恢复且顺序一致", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("Thought A", "text"));
  h.store.dispatch(act.inboxAddRefined("Thought B", "voice"));
  h.store.dispatch(act.inboxAddRefined("Thought C", "text"));
  h.store.dispatch(act.inboxRefine(inboxThoughts(h.store.getState())[0].id, "REFINED A"));
  await tick();
  // simulate refresh: brand-new store, same localStorage
  const h2 = harness({ ls: h.ls });
  await bootRestore(h2);
  const thoughts = inboxThoughts(h2.store.getState());
  assert.deepEqual(
    thoughts.map((t) => t.originalText),
    ["Thought A", "Thought B", "Thought C"],
    "刷新后顺序一致"
  );
  assert.equal(thoughts[0].refinedText, "REFINED A", "refinedText 恢复");
  assert.equal(thoughts[1].source, "voice", "source 恢复");
});

test("TP-4: INBOX_EDIT 后刷新 → 编辑结果仍存在；DELETE 后刷新 → Thought 不存在", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("original words", "text"));
  await tick();
  const id = inboxThoughts(h.store.getState())[0].id;
  h.store.dispatch(act.inboxEdit(id, "edited words"));
  await tick();
  let h2 = harness({ ls: h.ls });
  await bootRestore(h2);
  assert.equal(inboxThoughts(h2.store.getState())[0].originalText, "edited words");
  h.store.dispatch(act.inboxDelete(id));
  await tick();
  h2 = harness({ ls: h.ls });
  await bootRestore(h2);
  assert.equal(inboxThoughts(h2.store.getState()).length, 0, "删除后刷新不再存在");
});

test("TP-5: NEW_THOUGHT 不清空 Inbox（持久化数据保留）；RESET/CLEAR ALL 清空并持久化", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("kept", "text"));
  await tick();
  h.flows.newThought();
  await tick();
  let persisted = await h.storage.loadInbox();
  assert.equal(persisted.length, 1, "NEW_THOUGHT 后 Inbox 仍在");
  h.store.dispatch(act.inboxClearAll());
  await tick();
  persisted = await h.storage.loadInbox();
  assert.equal(persisted.length, 0, "CLEAR ALL 持久化为空");
});

test("TP-6: corrupt storage → loadInbox 返回 []，不崩溃", async () => {
  const ls = mockLS();
  ls.setItem("pk-float:inbox", "{broken json");
  const storage = createLocalStorageService(ls);
  assert.deepEqual(await storage.loadInbox(), []);
});

test("TP-7: 存储结构畸形（非 Thought 的条目被丢弃，合法条目保留）", async () => {
  const ls = mockLS();
  ls.setItem("pk-float:inbox", JSON.stringify({
    v: 1,
    thoughts: [
      { id: "th-1", originalText: "good", refinedText: null, source: "text", createdAt: "x", updatedAt: "x" },
      { id: "", originalText: "no id" },
      "not an object",
      null,
      { id: "th-2", originalText: "  " }
    ]
  }));
  const storage = createLocalStorageService(ls);
  const list = await storage.loadInbox();
  assert.equal(list.length, 1, "畸形条目被丢弃");
  assert.equal(list[0].originalText, "good");
});

test("TP-8: storage 完全不可用 → REFINE/SUBMIT/编辑/删除不崩溃，会话内 Inbox 正常", async () => {
  const ls = mockLS();
  ls.setItem = () => { throw new Error("quota"); };
  ls.getItem = () => { throw new Error("blocked"); };
  const h = harness({ ls });
  h.store.dispatch(act.updateInput("still works"));
  await h.flows.refineFromComposer();
  await tick();
  assert.equal(h.store.getState().input, "OPTIMIZED ▸ still works", "REFINE 成功写 Composer");
  await h.flows.submitThought();
  await tick();
  assert.equal(inboxThoughts(h.store.getState()).length, 1, "SUBMIT 后 Inbox 正常");
  h.store.dispatch(act.inboxEdit(inboxThoughts(h.store.getState())[0].id, "edited"));
  assert.equal(inboxThoughts(h.store.getState())[0].originalText, "edited", "会话内编辑正常");
  assert.equal(h.store.getState().input, "", "SUBMIT 成功后清空 Composer");
});

/* ==================================================================== *
 * 3. Composer Draft Persistence (Enhancement #1)                       *
 * ==================================================================== */
test("DP-1: 输入 500ms debounce 后自动保存（一次静默期只写一次）", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("He"));
  h.store.dispatch(act.updateInput("Hell"));
  h.store.dispatch(act.updateInput("Hello"));
  await tick();
  const draft = await h.storage.loadDraft();
  assert.equal(draft, "Hello", "debounce 后保存最终值");
  assert.equal(h.store.getState().draftSaved, true, "SAVED");
});

test("DP-2: UNSAVED → SAVED 状态翻转（debounce 期间 UNSAVED）", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("draft"));
  assert.equal(h.store.getState().draftSaved, false, "输入瞬间 UNSAVED");
  await tick();
  assert.equal(h.store.getState().draftSaved, true, "flush 后 SAVED");
});

test("DP-3: flushDraft（pagehide）强制立即落盘", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("urgent"));
  await h.flows.flushDraft();
  assert.equal(await h.storage.loadDraft(), "urgent");
});

test("DP-4: 刷新恢复 → 原始文本一字不差；不经 AI、不 REFINE、不自动 Submit", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("my exact draft"));
  await h.flows.flushDraft();
  const h2 = harness({ ls: h.ls });
  await bootRestore(h2);
  const s = h2.store.getState();
  assert.equal(s.input, "my exact draft", "原文恢复");
  assert.equal(s.interaction, "input", "停留在 input 态");
  assert.equal(s.session, null, "不自动进入 pipeline");
  assert.equal(h2.ai.calls.analyze, 0, "不经 AI");
  assert.equal(s.draftSaved, true, "恢复即 SAVED");
});

test("DP-5: SUBMIT 后清除 Draft；REFINE/Voice/USE 不清除", async () => {
  const h = harness();
  // REFINE 成功后把优化结果写回 Composer，Draft 保存为优化后文本
  h.store.dispatch(act.updateInput("refine me"));
  await h.flows.refineFromComposer();
  await h.flows.flushDraft();
  assert.equal(await h.storage.loadDraft(), "OPTIMIZED ▸ refine me", "REFINE 不清 Draft，保存优化结果");

  // Voice 保留（final append 也落盘）。Voice merge 用空格分隔符（machine 既有语义），
  // 故 transcript 不带前导空格 → "survives voice plus voice"
  h.store.dispatch(act.updateInput("survives voice"));
  h.store.dispatch(act.startVoice());
  h.voice.emitTranscript("plus voice", true);
  h.store.dispatch(act.voiceEnded());
  await h.flows.flushDraft();
  assert.equal(await h.storage.loadDraft(), "survives voice plus voice", "Voice 不清 Draft");

  // USE 保留；直接新建一条 Thought 来 USE
  const id = await seedThought(h, "seed", "USED");
  await h.flows.sendThoughtToPrompt(id);
  await h.flows.flushDraft();
  assert.equal(await h.storage.loadDraft(), "survives voice plus voice\n\nUSED", "USE 不清 Draft");

  // Submit 清除
  await h.flows.submitThought();
  await tick(20);
  assert.equal(h.store.getState().interaction, "idle", "3E SUBMIT 后直接回到 idle");
  assert.equal(await h.storage.loadDraft(), "", "SUBMIT 后 Draft 清除");
  assert.ok(h.clears.draft >= 1, "clearDraft 被调用");
  // inbox 现有 USE 来源的一条 + SUBMIT 产生的一条（REFINE 未直接入箱）
  assert.equal(h.store.getState().inbox.thoughts.length, 2, "USE 来源与 SUBMIT 各入箱一条");
});

test("DP-6: NEW 明确清除 Draft（含未 debounce 的内容）", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("discard me"));
  h.flows.newThought();
  assert.equal(h.store.getState().input, "", "in-state draft 清空");
  assert.equal(await h.storage.loadDraft(), "", "持久化 draft 清除");
});

/* ==================================================================== *
 * 4. Undo / Redo — history.js 纯函数                                    *
 * ==================================================================== */
test("H-1: 连续 typing 合并 — H/He/Hel/Hell/Hello 只是一个 undo 步", () => {
  let hist = createHistory("", 0);
  hist = pushEntry(hist, { value: "H" }, { now: 100 });
  hist = pushEntry(hist, { value: "He" }, { now: 150 });
  hist = pushEntry(hist, { value: "Hel" }, { now: 200 });
  hist = pushEntry(hist, { value: "Hell" }, { now: 250 });
  hist = pushEntry(hist, { value: "Hello" }, { now: 300 });
  assert.equal(hist.past.length, 0, "500ms 内全部合并为单步");
  const u = undo(hist);
  assert.equal(u.entry.value, "", "Undo 一步回到空串");
});

test("H-2: 超过合并窗口的输入形成独立步骤", () => {
  let hist = createHistory("", 0);
  hist = pushEntry(hist, { value: "Hello" }, { now: 100 });
  hist = pushEntry(hist, { value: "Hello world" }, { now: 100 + 600 });
  assert.equal(hist.past.length, 1, "600ms 后的新输入独立成步");
  const u = undo(hist);
  assert.equal(u.entry.value, "Hello");
});

test("H-3: programmatic 写入永不合并（即使紧邻）", () => {
  let hist = createHistory("", 0);
  hist = pushEntry(hist, { value: "A" }, { now: 100 });
  hist = pushEntry(hist, { value: "A\n\nB" }, { now: 101, programmatic: true });
  assert.equal(hist.past.length, 1, "程序化写入独立成步");
  const u = undo(hist);
  assert.equal(u.entry.value, "A");
});

test("H-4: 新输入清除 redo 栈；相同值 no-op", () => {
  let hist = createHistory("", 0);
  hist = pushEntry(hist, { value: "one" }, { now: 100 });
  hist = pushEntry(hist, { value: "two" }, { now: 100 + 600 });
  const undone = undo(hist).history;
  assert.ok(canRedo(undone));
  const redone = pushEntry(undone, { value: "three" }, { now: 100 + 1200 });
  assert.equal(redone.future.length, 0, "新编辑清空 redo");
  assert.equal(redone.past.length, 1);
  const noop = pushEntry(redone, { value: "three" }, { now: 100 + 1300 });
  assert.equal(noop, redone, "相同值 no-op（返回同一对象）");
});

test("H-5: 空历史 undo/redo 是 no-op（返回 null）", () => {
  const hist = createHistory("");
  assert.equal(undo(hist), null);
  assert.equal(redo(hist), null);
  assert.equal(canUndo(hist), false);
  assert.equal(canRedo(hist), false);
});

test("H-6: entry 携带 selection，undo 恢复光标", () => {
  let hist = createHistory("", 0);
  hist = pushEntry(hist, { value: "Hello", selectionStart: 2, selectionEnd: 5 }, { now: 100 });
  hist = pushEntry(hist, { value: "Hello!", selectionStart: 6, selectionEnd: 6 }, { now: 100 + 600 });
  const u = undo(hist);
  assert.equal(u.entry.selectionStart, 2);
  assert.equal(u.entry.selectionEnd, 5);
  const redone = redo(u.history);
  assert.equal(redone.entry.selectionStart, 6);
});

/* ==================================================================== *
 * 5. Undo / Redo — machine 集成                                         *
 * ==================================================================== */
test("M-1: 机器层 typing 快速连发合并；Undo 一步回空", () => {
  const store = createStore();
  ["H", "He", "Hel", "Hell", "Hello"].forEach((t) => store.dispatch(act.updateInput(t)));
  assert.equal(store.getState().history.past.length, 0, "合并为一步");
  store.dispatch(act.undoInput());
  assert.equal(store.getState().input, "");
});

test("M-2: Voice final 是独立步骤 — Undo 移除整段语音追加", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("typed"));
  h.store.dispatch(act.startVoice());
  h.voice.emitTranscript("spoken words", true);
  h.store.dispatch(act.voiceEnded());
  assert.equal(h.store.getState().input, "typed spoken words");
  h.store.dispatch(act.undoInput());
  assert.equal(h.store.getState().input, "typed", "整段语音追加一步移除");
});

test("M-3: Inbox ADD 是独立步骤；USE 是独立步骤", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("base"));
  h.store.dispatch(act.inboxUpdateDraft("added text"));
  await h.flows.addThoughtFromInbox();
  assert.equal(h.store.getState().input, "base added text");
  h.store.dispatch(act.undoInput());
  assert.equal(h.store.getState().input, "base", "ADD 一步移除");
});

test("M-4: Undo → 新输入 → redo 栈清空（canRedo false）", () => {
  const store = createStore();
  // now 注入模拟真实打字节奏：相邻输入间隔 >500ms 才是独立 undo 步（§7.3）
  store.dispatch(act.updateInput("one", { now: 1000 }));
  store.dispatch(act.updateInput("one two", { now: 1600 }));
  store.dispatch(act.undoInput());
  assert.equal(store.getState().input, "one");
  assert.ok(canRedoInput(store.getState()));
  store.dispatch(act.updateInput("one three", { now: 2200 }));
  assert.equal(canRedoInput(store.getState()), false, "新输入清空 redo");
  assert.equal(store.getState().input, "one three");
});

test("M-5: UNDO_INPUT 恢复光标位置（inputSelection）；typing 后清除", () => {
  const store = createStore();
  // now 注入：两次输入间隔 600ms → 独立步骤，光标随 entry 保存
  store.dispatch(act.updateInput("Hello world", { selectionStart: 5, selectionEnd: 5, now: 1000 }));
  store.dispatch(act.updateInput("Hello world!", { selectionStart: 12, selectionEnd: 12, now: 1600 }));
  store.dispatch(act.undoInput());
  const s = store.getState();
  assert.equal(s.input, "Hello world");
  assert.deepEqual(s.inputSelection, { start: 5, end: 5 }, "光标随 undo 恢复");
  store.dispatch(act.updateInput("Hello world x", { selectionStart: 13, selectionEnd: 13, now: 2200 }));
  assert.equal(store.getState().inputSelection, null, "typing 清除恢复光标");
});

test("M-6: NEW_THOUGHT 重置历史（不可 undo 回旧内容）；RESET 同理", () => {
  const store = createStore();
  store.dispatch(act.updateInput("old draft"));
  store.dispatch(act.newThought());
  assert.equal(store.getState().history.past.length, 0);
  assert.equal(canUndoInput(store.getState()), false);
  store.dispatch(act.updateInput("again"));
  store.dispatch(act.reset());
  assert.equal(canUndoInput(store.getState()), false);
});

test("M-7: RESTORE_DRAFT 的历史基线 = 恢复文本（首个 Undo 撤销的是后续编辑）", () => {
  const store = createStore();
  store.dispatch(act.restoreDraft("restored draft"));
  assert.equal(store.getState().input, "restored draft");
  assert.equal(canUndoInput(store.getState()), false, "恢复本身不是可撤销步骤");
  store.dispatch(act.updateInput("restored draft + edit"));
  h_fix: {
    store.dispatch(act.undoInput());
    assert.equal(store.getState().input, "restored draft", "Undo 回到恢复基线");
    break h_fix;
  }
});

/* ==================================================================== *
 * 6. Status Badge (Enhancement #3)                                      *
 * ==================================================================== */
test("S-1: EMPTY / DRAFT / DRAFT·VOICE / DRAFT·THOUGHT 徽章语义", async () => {
  const h = harness();
  assert.equal(draftBadgeLabel(h.store.getState()), "EMPTY");
  h.store.dispatch(act.updateInput("plain typing"));
  assert.equal(draftBadgeLabel(h.store.getState()), "DRAFT");
  // voice final → DRAFT · VOICE
  h.store.dispatch(act.startVoice());
  h.voice.emitTranscript("spoken", true);
  h.store.dispatch(act.voiceEnded());
  assert.equal(draftBadgeLabel(h.store.getState()), "DRAFT · VOICE");
  // 手动 typing 回到 DRAFT（真实打字必然改变值 → inputOrigin 重置为 null；
  // value-identical 的 UPDATE_INPUT 是 no-op，不构成"手动接管"）
  h.store.dispatch(act.updateInput("plain typing spoken and typed more"));
  assert.equal(draftBadgeLabel(h.store.getState()), "DRAFT");
  // USE → DRAFT · THOUGHT
  const id = await seedThought(h, "idea", "T");
  await h.flows.sendThoughtToPrompt(id);
  assert.equal(draftBadgeLabel(h.store.getState()), "DRAFT · THOUGHT");
});

test("S-2: SAVED / UNSAVED（空输入隐藏）", async () => {
  const h = harness();
  assert.equal(draftSavedLabel(h.store.getState()), "", "空输入隐藏");
  h.store.dispatch(act.updateInput("x"));
  assert.equal(draftSavedLabel(h.store.getState()), "UNSAVED");
  await tick();
  assert.equal(draftSavedLabel(h.store.getState()), "SAVED");
});

/* ==================================================================== *
 * 7. REAL / DEMO Mode Visibility (DECISION #3)                          *
 * ==================================================================== */
test("AI-1: AI_MODE action + aiModeLabel — REAL / DEMO / unknown", () => {
  const store = createStore();
  assert.equal(aiModeLabel(store.getState()), "", "未知时隐藏");
  store.dispatch(act.aiMode("real"));
  assert.equal(store.getState().aiMode, "real");
  assert.equal(aiModeLabel(store.getState()), "AI · REAL");
  store.dispatch(act.aiMode("demo"));
  assert.equal(aiModeLabel(store.getState()), "AI · DEMO", "Demo 不伪装成 Real");
  store.dispatch(act.aiMode("bogus"));
  assert.equal(store.getState().aiMode, "unknown", "非法值归 unknown");
});

test("AI-2: fallback-service — 主链路成功 → onMode('real')", async () => {
  const modes = [];
  const primary = {
    analyzePrompt: async () => ({ prompt: { objective: "x" } }),
    improvePrompt: async (p) => p,
    rewritePrompt: async (p) => p
  };
  const fallback = {
    analyzePrompt: async () => ({ prompt: { objective: "demo" } }),
    improvePrompt: async (p) => p,
    rewritePrompt: async (p) => p
  };
  const svc = createFallbackAIService(primary, fallback, { onMode: (m) => modes.push(m) });
  await svc.analyzePrompt("input");
  assert.deepEqual(modes, ["real"]);
});

test("AI-3: NETWORK_ERROR → Demo fallback + onMode('demo')；恢复后回到 'real'（§5.4）", async () => {
  const modes = [];
  let networkUp = false;
  const primary = {
    analyzePrompt: async () => {
      if (!networkUp) throw Object.assign(new Error("down"), { code: "NETWORK_ERROR" });
      return { prompt: { objective: "x" } };
    },
    improvePrompt: async (p) => p,
    rewritePrompt: async (p) => p
  };
  const fallback = {
    analyzePrompt: async () => ({ prompt: { objective: "demo" } }),
    improvePrompt: async (p) => p,
    rewritePrompt: async (p) => p
  };
  const svc = createFallbackAIService(primary, fallback, { onMode: (m) => modes.push(m) });
  const result = await svc.analyzePrompt("input");
  assert.equal(result.prompt.objective, "demo", "回落 Demo 应答");
  assert.deepEqual(modes, ["demo"]);
  networkUp = true;
  await svc.analyzePrompt("input");
  assert.deepEqual(modes, ["demo", "real"], "恢复后翻回 REAL");
});

test("AI-4: 真实 AI 错误（非 NETWORK_ERROR）照常抛出，模式不变（不误标 DEMO）", async () => {
  const modes = [];
  const primary = {
    analyzePrompt: async () => { throw Object.assign(new Error("ai"), { code: "AI_ERROR" }); },
    improvePrompt: async (p) => p,
    rewritePrompt: async (p) => p
  };
  const fallback = { analyzePrompt: async () => ({ prompt: {} }), improvePrompt: async (p) => p, rewritePrompt: async (p) => p };
  const svc = createFallbackAIService(primary, fallback, { onMode: (m) => modes.push(m) });
  await assert.rejects(() => svc.analyzePrompt("x"), (e) => e.code === "AI_ERROR");
  assert.deepEqual(modes, [], "真实 AI 错误不改模式");
});

test("AI-5: 模式经 onMode → store 的完整链路（DEMO 状态真实可见）", async () => {
  const h = harness();
  const modes = [];
  const svc = createFallbackAIService(
    { analyzePrompt: async () => { throw Object.assign(new Error("down"), { code: "NETWORK_ERROR" }); },
      improvePrompt: async (p) => p, rewritePrompt: async (p) => p },
    h.ai,
    { onMode: (m) => { modes.push(m); h.store.dispatch(act.aiMode(m)); } }
  );
  await svc.analyzePrompt("x");
  assert.equal(h.store.getState().aiMode, "demo");
  assert.equal(aiModeLabel(h.store.getState()), "AI · DEMO");
});

/* ==================================================================== *
 * 8. 交叉回归：核心链路不因持久化/历史而破坏                            *
 * ==================================================================== */
test("X-1: REFINE 后 Composer 保留优化结果 + Badge DRAFT · THOUGHT；SUBMIT 后入箱", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("refine me"));
  await h.flows.refineFromComposer();
  await tick();
  let s = h.store.getState();
  assert.equal(inboxThoughts(s).length, 0, "REFINE 本身不入箱");
  assert.equal(s.input, "OPTIMIZED ▸ refine me", "REFINE 成功后 Composer 保留优化结果");
  assert.equal(draftBadgeLabel(s), "DRAFT · THOUGHT");
  await h.flows.submitThought();
  await tick();
  s = h.store.getState();
  assert.equal(inboxThoughts(s).length, 1, "SUBMIT 后入箱");
  assert.equal(s.input, "", "SUBMIT 后清空 Composer");
});

test("X-2: UNDO 不触发 draft 保存之外的 AI；SUBMIT 后 UNDO 恢复 Composer 草稿", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("full flow"));
  await h.flows.submitThought();
  await tick(20);
  assert.equal(h.store.getState().interaction, "idle", "3E SUBMIT 后回到 idle");
  assert.equal(h.store.getState().inbox.thoughts.length, 1, "SUBMIT 已入箱");
  // SUBMIT 是程序化写入并清空 Composer；Undo 一步可恢复原文
  h.store.dispatch(act.undoInput());
  assert.equal(h.store.getState().input, "full flow", "Undo 恢复 SUBMIT 前的 Composer 内容");
  assert.equal(h.ai.calls.analyze, 0, "Undo 不产生 AI 调用");
});
