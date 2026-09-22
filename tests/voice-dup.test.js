/* PHASE 3C-3C — P0-A Voice Transcript Duplication Tests.
   Strictly verifies the 8 scenarios from §6.6 matrix. Two layers:
   · Provider-level: simulates Chrome recognition events (including duplicate
     onresult replays, pause auto-restart, and onend fallback paths) against
     createBrowserSpeechProvider using a controlled FakeSR window.
   · Machine + flow-level: connects the deduped provider output through the
     real reducer so Composer state ends up exactly right.
   Rule: NEVER use simple `if (last===curr) skip` to assert correctness — we
   simulate legitimate repeated user utterances which MUST both survive. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserSpeechProvider } from "../src/services/voice/browser-provider.js";
import { createStore } from "../src/state/store.js";
import { act, COMPOSER_LIMIT } from "../src/state/actions.js";

/* ---- controlled FakeSR window matching Web Speech API event shape ---- */
function fakeSpeechWindow() {
  const instances = [];
  class FakeSR {
    constructor() { instances.push(this); this.lang = ""; this.interimResults = false; this.continuous = false; }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
  }
  return { win: { SpeechRecognition: FakeSR, navigator: { language: "zh-CN" } }, instances };
}
/** Build a SpeechRecognition result event shape.
 * @param {object[]} segments — each { transcript, isFinal }
 * @param {number} resultIndex — where the Chrome result array starts this event */
function resultEvent(segments, resultIndex = 0) {
  const results = segments.map((s) => ({ 0: { transcript: s.transcript }, isFinal: !!s.isFinal }));
  results.length = segments.length;
  return { resultIndex, results };
}
/** Start a provider + attach transcript accumulator. Returns helpers. */
async function setupProvider() {
  const { win, instances } = fakeSpeechWindow();
  const p = createBrowserSpeechProvider(win);
  const events = []; // [{text, isFinal, seq}]
  p.onTranscript((text, isFinal, seq) => events.push({ text, isFinal, seq: Number(seq) >>> 0 }));
  let ends = 0;
  p.onEnd(() => { ends++; });
  let errors = [];
  p.onError((c) => errors.push(c));
  await p.start();
  return { p, instances, events, get ends() { return ends; }, errors };
}
/** Flows-like harness: wires a store to provider output then checks state.input. */
async function setupMachineHarness() {
  const { win, instances } = fakeSpeechWindow();
  const provider = createBrowserSpeechProvider(win);
  const store = createStore();
  provider.onTranscript((text, isFinal, seq) => store.dispatch(act.voiceTranscript(text, isFinal, seq)));
  provider.onEnd(() => store.dispatch(act.voiceEnded()));
  await provider.start();
  store.dispatch(act.startVoice());
  return { provider, instances, store };
}

/* ============================================================
   VOICE-DUP-01: 单段 final "你好" 只出现一次
   ============================================================ */
test("VOICE-DUP-01: single final '你好' appears exactly once in Composer", async () => {
  const { instances, store } = await setupMachineHarness();
  instances[0].onresult(resultEvent([{ transcript: "你好", isFinal: true }]));
  assert.equal(store.getState().input, "你好");
  // Simulate Chrome duplicate final event (same resultIndex=0, same text) → MUST BE IGNORED
  instances[0].onresult(resultEvent([{ transcript: "你好", isFinal: true }]));
  assert.equal(store.getState().input, "你好", "Chrome duplicate final event must not re-write / append to Composer");
  const count = (store.getState().input.match(/你好/g) || []).length;
  assert.equal(count, 1, `'你好' must occur exactly 1 time, got ${count}`);
});

/* ============================================================
   VOICE-DUP-02: 连续 A → pause → B → pause → C → 每段只出现一次
   ============================================================ */
test("VOICE-DUP-02: pause-restart chain A B C — each segment preserved exactly once", async () => {
  const { instances, store } = await setupMachineHarness();
  // Segment A (instance 0, final), then pause/auto-restart
  instances[0].onresult(resultEvent([{ transcript: "A段", isFinal: true }]));
  assert.equal(store.getState().input, "A段");
  instances[0].onend();                     // pause → auto-restart → instance 1
  assert.equal(instances.length, 2);
  // Segment B (instance 1)
  instances[1].onresult(resultEvent([{ transcript: "B段", isFinal: true }]));
  // Provider reports session-accumulated total: A段B段
  assert.equal(store.getState().voiceTranscript.text, "A段B段");
  assert.equal(store.getState().input, "A段 B段", "Composer should be A + space + B (normalized)");
  instances[1].onend();                     // another pause → instance 2
  assert.equal(instances.length, 3);
  // Segment C (instance 2)
  instances[2].onresult(resultEvent([{ transcript: "C段", isFinal: true }]));
  assert.equal(store.getState().input, "A段 B段 C段");
  // Verify each segment appears exactly once
  for (const seg of ["A段", "B段", "C段"]) {
    const n = (store.getState().input.match(new RegExp(seg, "g")) || []).length;
    assert.equal(n, 1, `${seg} must appear once, got ${n} (state='${store.getState().input}')`);
  }
});

/* ============================================================
   VOICE-DUP-03: 模拟 browser duplicate final event → 只出现一次
   Provider-level: fire exact same final onresult TWICE on the SAME instance.
   ============================================================ */
test("VOICE-DUP-03: provider — duplicate final onresult (same instance, same resultIndex) produces ONE emission", async () => {
  const { instances, events } = await setupProvider();
  instances[0].onresult(resultEvent([{ transcript: "你好", isFinal: true }], 0));
  instances[0].onresult(resultEvent([{ transcript: "你好", isFinal: true }], 0)); // Chrome duplicate replay
  const finals = events.filter((e) => e.isFinal);
  assert.equal(finals.length, 1,
    `Expected exactly 1 FINAL emission, got ${finals.length}: ${JSON.stringify(finals)}`);
  assert.equal(finals[0].text, "你好");
});

/* ============================================================
   VOICE-DUP-04: onresult(final) → then onend fallback → only once.
   场景: browser 先 onresult(final) 再在 onend 时由于 carryText === lastEmitted
   不会再次 fallback 发送。但若中间异常（carryText≠lastEmitted）时，
   finalSig 必须正确去重。
   ============================================================ */
test("VOICE-DUP-04: onresult(final) then stop()+onend — transcript emitted once", async () => {
  const { p, instances, events } = await setupProvider();
  instances[0].onresult(resultEvent([{ transcript: "hello world", isFinal: true }]));
  assert.equal(events.filter((e) => e.isFinal).length, 1);
  await p.stop();
  instances[0].onend();                   // explicit stop end
  const finals = events.filter((e) => e.isFinal);
  assert.equal(finals.length, 1,
    `onend must NOT re-emit a final that already came via onresult: ${JSON.stringify(finals)}`);
  assert.equal(finals[0].text, "hello world");
});

/* ============================================================
   VOICE-DUP-05: final A → onend restart → final B → 结果 A B
   ============================================================ */
test("VOICE-DUP-05: final A, pause auto-restart new instance, final B → session total A+B", async () => {
  const { instances, events } = await setupProvider();
  instances[0].onresult(resultEvent([{ transcript: "A", isFinal: true }]));
  instances[0].onend();                     // pause → auto-restart
  assert.equal(instances.length, 2);
  instances[1].onresult(resultEvent([{ transcript: "B", isFinal: true }]));
  const finals = events.filter((e) => e.isFinal);
  // Expect: seq=1 "A", seq=2 "AB" (session cumulative — carryText=A persists)
  assert.ok(finals.length >= 2, `need at least 2 finals, got ${finals.length}`);
  assert.equal(finals[0].text, "A");
  assert.equal(finals[0].seq, 1);
  // The second final should CARRY forward the first (pause continuation).
  const lastFinal = finals[finals.length - 1];
  assert.equal(lastFinal.text, "AB");
  assert.equal(lastFinal.seq, 2);
});

/* ============================================================
   VOICE-DUP-06: 合法重复 (legitimate repeated speech) 必须保留
   用户连续说两次 "你好" 但两次是 *独立* 的 segment：
     · 第一 instance 说 "你好" → final 然后 restart
     · 新 instance 再说 "你好" → final
   结果必须是两个 "你好"（不同 resultIndex 在 session 累计上，不同 seq）。
   ============================================================ */
test("VOICE-DUP-06: legitimate repeated speech (two independent segments) — both preserved, not deduped away", async () => {
  const { instances, store } = await setupMachineHarness();
  // First utterance: 你好 on instance 0 at resultIndex 0
  instances[0].onresult(resultEvent([{ transcript: "你好", isFinal: true }], 0));
  assert.equal(store.getState().input, "你好");
  instances[0].onend();                     // pause → auto-restart, NEW instance
  assert.equal(instances.length, 2);
  // Second utterance: 你好 on NEW instance 1 at resultIndex 0 → LEGALLY new
  instances[1].onresult(resultEvent([{ transcript: "你好", isFinal: true }], 0));
  // Machine should have appended second 你好 via delta logic.
  const finalInput = store.getState().input;
  const count = (finalInput.match(/你好/g) || []).length;
  assert.equal(count, 2,
    `Two genuinely separate '你好' segments must BOTH survive in Composer. Count=${count}, state='${finalInput}'`);
});

/* ============================================================
   VOICE-DUP-07: 接近 Composer 长度边界 — state.input.length === textarea.value.length (conceptual state == DOM)
   我们没有真实 DOM，用 reducer output 的 codepoint 长度与 期望长度一致 并与
   voiceCommittedLen 对应 provider rawText 长度 做校验保证一致。
   ============================================================ */
test("VOICE-DUP-07: near COMPOSER_LIMIT boundary — state length matches committed provider length, no drift", async () => {
  const { instances, store } = await setupMachineHarness();
  // Fill Composer with baseline (kept well below COMPOSER_LIMIT — overflow
  // behavior is LONG-03's job). 1900 chars of typed content:
  const baseline = "x".repeat(1900);
  store.dispatch(act.updateInput(baseline));
  assert.equal(store.getState().input.length, 1900);
  // Voice appends a 15-char final segment. Machine delta adds one space between
  // existing and new non-empty content. Total = 1900 + 1 + 15 = 1916.
  instances[0].onresult(resultEvent([{ transcript: "q".repeat(15), isFinal: true }]));
  const stateNow = store.getState();
  assert.equal([...stateNow.input].length, 1916,
    `state.input must equal 1916 (1900 + space + 15), got ${[...stateNow.input].length}`);
  // voiceCommittedLen must equal the RAW provider final length for this
  // segment (i.e. the fresh portion — 15 q's). Future finals slice against it.
  assert.equal(stateNow.voiceCommittedLen, 15,
    `voiceCommittedLen must equal raw provider segment length 15`);
});

/* ============================================================
   VOICE-DUP-08: 用户主动停止后，onend 不得 restart
   ============================================================ */
test("VOICE-DUP-08: explicit stop → onend must NOT restart recognition; session terminates", async () => {
  const ctx = await setupProvider(); // keep object ref so `ends` getter reads dynamically
  ctx.instances[0].onresult(resultEvent([{ transcript: "stop me", isFinal: true }]));
  const before = ctx.instances.length;
  await ctx.p.stop();
  ctx.instances[0].onend();
  const after = ctx.instances.length;
  assert.equal(after, before, "After explicit stop, onend must NOT create a new recognition instance");
  assert.equal(ctx.ends, 1, "Exactly one session-end callback must fire");
  // Re-confirm: no auto-restarted instance was started
  assert.equal(ctx.instances.filter((x) => x.started).length, 1, "Only the original instance should ever have start()ed");
});

/* ============================================================
   3D-RC2 GATE A — 真实 Chrome 累积事件专项测试。
   Chrome continuous 模式下每次 onresult 携带全量 results 列表，
   resultIndex 指向首个新增/变更结果。以下场景复现用户报告的
   “第二句开始重复 / 字突然跳入”路径，验证 finals 累积模型。
   ============================================================ */

/* CHROME-01: 同一 instance 连续多段（全量重发 + resultIndex 增量） */
test("CHROME-01: same-instance consecutive segments — delta merge, zero duplication", async () => {
  const { instances, store } = await setupMachineHarness();
  // 段1 final（resultIndex=0）
  instances[0].onresult(resultEvent([{ transcript: "第一句", isFinal: true }], 0));
  assert.equal(store.getState().input, "第一句");
  // 段2 interim 渐进（results 全量含段1，resultIndex=1 指向新段）
  instances[0].onresult(resultEvent([
    { transcript: "第一句", isFinal: true }, { transcript: "第二", isFinal: false }
  ], 1));
  assert.equal(store.getState().input, "第一句", "interim 不得提前落 Composer state");
  // 段2 final
  instances[0].onresult(resultEvent([
    { transcript: "第一句", isFinal: true }, { transcript: "第二句", isFinal: true }
  ], 1));
  assert.equal(store.getState().input, "第一句 第二句");
  assert.equal((store.getState().input.match(/第一句/g) || []).length, 1,
    "第一句 只出现一次（旧 bug：carryText+全量 fresh 会得到 '第一句 第一句 第二句'）");
});

/* CHROME-02: 同段 interim 单调增长 → 恰好一次 final（边说边浮现的 provider 侧保证） */
test("CHROME-02: interim grows monotonically; the segment commits as exactly ONE final", async () => {
  const { instances, events } = await setupProvider();
  instances[0].onresult(resultEvent([{ transcript: "A", isFinal: true }], 0));
  instances[0].onresult(resultEvent([{ transcript: "A", isFinal: true }, { transcript: "B", isFinal: false }], 1));
  instances[0].onresult(resultEvent([{ transcript: "A", isFinal: true }, { transcript: "BC", isFinal: false }], 1));
  instances[0].onresult(resultEvent([{ transcript: "A", isFinal: true }, { transcript: "BCD", isFinal: false }], 1));
  instances[0].onresult(resultEvent([{ transcript: "A", isFinal: true }, { transcript: "BCD", isFinal: true }], 1));
  const finals = events.filter((e) => e.isFinal);
  assert.equal(finals.length, 2, "两段 → 恰好两个 final（A 与 ABCD）");
  assert.equal(finals[0].text, "A");
  assert.equal(finals[1].text, "ABCD");
  assert.deepEqual(events.filter((e) => !e.isFinal).map((e) => e.text), ["AB", "ABC", "ABCD"],
    "interim 预览单调增长（边说边浮现）");
});

/* CHROME-03: 同一事件包含新 final + 下一段 interim */
test("CHROME-03: one event carrying a new final AND the next segment's interim", async () => {
  const { instances, events } = await setupProvider();
  instances[0].onresult(resultEvent([{ transcript: "A", isFinal: true }], 0));
  instances[0].onresult(resultEvent([
    { transcript: "A", isFinal: true }, { transcript: "B", isFinal: true }, { transcript: "C", isFinal: false }
  ], 1));
  const finals = events.filter((e) => e.isFinal);
  assert.equal(finals.length, 2);
  assert.equal(finals[1].text, "AB", "final 只提交 A+B");
  const last = events[events.length - 1];
  assert.equal(last.text, "ABC", "同事件尾随 interim 进入预览");
  assert.equal(last.isFinal, false);
});

/* CHROME-04: Chrome 重放同一全量事件（相同 resultIndex）→ 被吞 */
test("CHROME-04: replay of the same full-list event (same resultIndex) is swallowed", async () => {
  const { instances, events } = await setupProvider();
  instances[0].onresult(resultEvent([{ transcript: "A", isFinal: true }], 0));
  instances[0].onresult(resultEvent([{ transcript: "A", isFinal: true }, { transcript: "B", isFinal: true }], 1));
  instances[0].onresult(resultEvent([{ transcript: "A", isFinal: true }, { transcript: "B", isFinal: true }], 1)); // replay
  const finals = events.filter((e) => e.isFinal);
  assert.equal(finals.length, 2);
  assert.equal(finals[1].text, "AB");
});

/* ============================================================
   3D-RC2 GATE B — 边说边浮现（machine 层：interim 预览 = 已提交 + 尾段）
   ============================================================ */
test("GATE-B: live preview = committed words + interim tail; state.input only holds finals", async () => {
  const { instances, store } = await setupMachineHarness();
  instances[0].onresult(resultEvent([{ transcript: "第一句", isFinal: true }], 0));
  instances[0].onresult(resultEvent([
    { transcript: "第一句", isFinal: true }, { transcript: "第二", isFinal: false }
  ], 1));
  let s = store.getState();
  assert.equal(s.input, "第一句", "interim 不改 state.input");
  assert.equal(s.voiceTranscript.text, "第一句 第二", "预览 = 已提交文本 + 进行中尾段");
  instances[0].onresult(resultEvent([
    { transcript: "第一句", isFinal: true }, { transcript: "第二句", isFinal: true }
  ], 1));
  s = store.getState();
  assert.equal(s.input, "第一句 第二句");
});

test("GATE-B2: 已有打字草稿时，interim 预览叠加在草稿之后（草稿不丢）", async () => {
  const { instances, store } = await setupMachineHarness();
  store.dispatch(act.updateInput("typed"));
  instances[0].onresult(resultEvent([{ transcript: "说", isFinal: false }], 0));
  const s = store.getState();
  assert.equal(s.input, "typed", "草稿未被 interim 覆盖");
  assert.equal(s.voiceTranscript.text, "typed 说", "预览叠加在草稿后");
});

export {};
