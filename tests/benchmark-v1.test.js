/* Benchmark v1 regression suite (Phase 3B-3 §15).
   1. fixture integrity: 50 cases, categories A–J × 5, schema-complete
   2. scoring engine units: perfect → 1.0; overreach/constraint-loss/false-correction detection
   3. end-to-end demo run (deterministic, no LLM): report shape + invariants
   The real-mode run is NOT part of `npm test` (requires the live API);
   run it separately with `npm run benchmark:real`. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntentCompiler } from "../server/ai/skills/intent-compiler/index.js";
import { loadCases, validateCases } from "../scripts/benchmark/index.js";
import { scoreCase, aggregateResults, buildDelivered, norm, textCollapsed, hasAffirmativeToken } from "../scripts/benchmark/eval.js";
import { createBenchmarkDemoGateway } from "../scripts/benchmark/demo-gateway.js";
import { runBenchmark } from "../scripts/benchmark/index.js";

const CTX = { requestId: "pk_bm_test", route: "/benchmark" };

/* ---------- 1. fixture integrity ---------- */
test("benchmark-v1: 50 cases, categories A-J, unique ids, schema complete", async () => {
  const cases = await loadCases();
  assert.doesNotThrow(() => validateCases(cases));
  assert.equal(cases.length, 50);
  const ids = new Set(cases.map((c) => c.id));
  assert.equal(ids.size, 50);
  const cats = {};
  for (const c of cases) {
    cats[c.category] = (cats[c.category] || 0) + 1;
    assert.ok(c.input && c.input.length > 0, `${c.id} input`);
    assert.ok(c.expected, `${c.id} expected`);
    assert.ok(Array.isArray(c.expected.intentTokens), `${c.id} intentTokens`);
    assert.ok(Array.isArray(c.expected.constraints), `${c.id} constraints`);
    assert.ok(Array.isArray(c.expected.forbiddenInferences), `${c.id} forbiddenInferences`);
    if (c.expected.terminology) {
      assert.ok(Array.isArray(c.expected.terminology.correctCorrections), `${c.id} correctCorrections`);
      assert.ok(Array.isArray(c.expected.terminology.falseCorrections), `${c.id} falseCorrections`);
      assert.ok(Array.isArray(c.expected.terminology.preserveTerms), `${c.id} preserveTerms`);
    }
  }
  for (const [k, v] of Object.entries(cats)) assert.equal(v, 5, `category ${k} count`);
});

/* ---------- 2. scoring engine units ---------- */
function makeResult(overrides = {}) {
  return {
    detectedIntent: overrides.detectedIntent || "ui_design",
    prompt: {
      objective: overrides.objective || "优化这个页面的视觉表现，使其看起来更高级",
      context: overrides.context || "",
      requirements: overrides.requirements || ["整体视觉更高级"],
      style: overrides.style || ["高级"],
      output: overrides.output || ""
    },
    meta: {
      rawInput: overrides.rawInput || "帮我把这个页面弄得高级一点。",
      correctedInput: overrides.correctedInput ?? "帮我把这个页面弄得高级一点。",
      optimizedPrompt: overrides.optimizedPrompt || "优化这个页面的视觉表现，使其看起来更高级。",
      intent: { task: overrides.intentTask || "ui_design", subtasks: overrides.subtasks || [], context: overrides.intentContext || [] },
      corrections: overrides.corrections || [],
      uncertainties: overrides.uncertainties || [],
      aiSuggestions: overrides.aiSuggestions || [],
      conservative: !!overrides.conservative
    }
  };
}

const EXPECT_A01 = {
  task: "ui_design",
  intentTokens: ["页面", ["高级", "更高端"]],
  forbiddenInferences: ["玻璃", "渐变", "3D", "动画", "Apple", "苹果", "微交互"],
  constraints: []
};

test("eval: perfect output scores 1.0 across dimensions and PASSes", () => {
  const r = scoreCase(makeResult(), EXPECT_A01);
  assert.equal(r.dims.fidelity, 1);
  assert.equal(r.dims.terminology, 1);
  assert.equal(r.dims.constraints, 1);
  assert.equal(r.dims.antiOI, 1);
  assert.equal(r.verdict, "PASS");
  assert.deepEqual(r.failures, []);
});

test("eval: over-interpretation (glassmorphism invented) → OVER_INTERPRETATION, antiOI=1/3", () => {
  const r = scoreCase(makeResult({
    objective: "使用玻璃拟态与渐变提升按钮的高级感",
    requirements: ["采用玻璃拟态"],
    optimizedPrompt: "使用玻璃拟态和渐变让页面更高级"
  }), EXPECT_A01);
  // two forbidden tokens invented (玻璃 + 渐变) → 1/(1+2)
  assert.equal(r.dims.antiOI, Number((1 / 3).toFixed(3)));
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.failures[0].type, "OVER_INTERPRETATION");
});

test("eval: NEGATED forbidden mention (constraint echo) is NOT over-interpretation", () => {
  const expectJ04 = {
    intentTokens: ["高级"],
    forbiddenInferences: ["重新设计", "重新做", "重做", "改版", "推翻"]
  };
  const r = scoreCase(makeResult({
    objective: "让那个东西看起来更高级，但不要重新制作",
    requirements: ["不要重新做"],
    optimizedPrompt: "外观升级使其更高级，但不要重新制作",
    intentContext: ["用户澄清不是要重新做"]
  }), expectJ04);
  // every occurrence of 重新做/重做 is negated (不是/不要) → no invented inference
  assert.equal(r.dims.antiOI, 1);
  assert.equal(r.verdict, "PASS");
  assert.ok(!r.failures.some((f) => f.type === "OVER_INTERPRETATION"));
});

test("eval: hasAffirmativeToken distinguishes negated vs affirmative occurrences", () => {
  const t = textCollapsed("不要重新做这个页面，把按钮重新做一下 不是要重做，改版就免了");
  assert.equal(hasAffirmativeToken(t, "重新做"), true);   // 把按钮重新做一下 → affirmative
  assert.equal(hasAffirmativeToken(t, "重做"), false);    // 不是要重做 → negated only
  assert.equal(hasAffirmativeToken(t, "改版"), false);    // 改版就免了 → negated (免)
  assert.equal(hasAffirmativeToken("do not redesign the page but redesign the header", "redesign"), true);
});

test("eval: constraint loss detected → CONSTRAINT_LOSS", () => {
  const expectE = {
    intentTokens: ["首页"],
    constraints: [{ label: "不改变现有功能", groups: [["不要", "别", "不能", "不改", "保留", "保持"], ["现有功能"]] }]
  };
  const r = scoreCase(makeResult({
    objective: "重新设计首页",
    requirements: [],
    optimizedPrompt: "重新设计首页，使其焕然一新"
  }), expectE);
  assert.equal(r.dims.constraints, 0);
  assert.equal(r.failures[0].type, "CONSTRAINT_LOSS");
  assert.deepEqual(r.evidence.lostConstraints, ["不改变现有功能"]);
});

test("eval: false correction (sequel→SQL in movie context) → FALSE_CORRECTION", () => {
  const expectD = {
    intentTokens: ["sequel"],
    terminology: { correctCorrections: [], falseCorrections: [{ from: "sequel", to: "SQL" }], preserveTerms: [] }
  };
  const r = scoreCase(makeResult({
    detectedIntent: "writing",
    objective: "这个电影的 sequel 写得不错，点评一下",
    optimizedPrompt: "分析这个电影的 sequel，并用 SQL 角度评价",
    correctedInput: "这个电影的 sequel 写得不错"
  }), expectD);
  assert.equal(r.dims.terminology, 0);
  assert.equal(r.failures[0].type, "FALSE_CORRECTION");
});

test("eval: missed ASR correction → TERMINOLOGY_ERROR", () => {
  const expectC = {
    intentTokens: [["DeepSeek", "deepseek"], "API"],
    terminology: { correctCorrections: [{ from: "deep seek", to: "DeepSeek" }], falseCorrections: [], preserveTerms: ["API"] }
  };
  const r = scoreCase(makeResult({
    objective: "帮我接一下 deep seek 的 API",
    optimizedPrompt: "帮我接一下 deep seek 的 API",
    correctedInput: "帮我接一下 deep seek 的 API"
  }), expectC);
  // correction not applied (DeepSeek missing) but "API" preserved → 1/2
  assert.equal(r.dims.terminology, 0.5);
  assert.equal(r.failures[0].type, "TERMINOLOGY_ERROR");
});

test("eval: multi-step missed → INTENT_DRIFT", () => {
  const expectI = { task: "multi_step", taskType: "multi_step", intentTokens: ["分析", "汇报"] };
  const r = scoreCase(makeResult({ detectedIntent: "data_analysis", intentTask: "data_analysis" }), expectI);
  assert.equal(r.failures[0].type, "INTENT_DRIFT");
});

test("eval: aggregate computes weighted overall + product metrics", () => {
  const good = scoreCase(makeResult(), EXPECT_A01);
  const bad = scoreCase(makeResult({ objective: "用玻璃拟态重做" }), EXPECT_A01);
  const agg = aggregateResults([{ case: { constraints: [] }, scored: good, skillVersion: "1.0", mode: "test" },
                                 { case: { constraints: [] }, scored: bad, skillVersion: "1.0", mode: "test" }]);
  // good: all 1.0 · bad: antiOI 0.5, others 1.0 → dims means → weighted overall
  assert.equal(agg.overall, Number((0.35 * 1 + 0.2 * 1 + 0.2 * 1 + 0.15 * 1 + 0.1 * 0.75).toFixed(3)));
  assert.equal(agg.overInterpretationRate, 0.5);
  assert.ok(agg.terminology.errorRate >= 0);
  assert.equal(agg.verdictCounts.PASS + agg.verdictCounts.CAUTION + agg.verdictCounts.FAIL, 2);
});

/* ---------- 3. end-to-end demo run ---------- */
test("benchmark-v1: demo run end-to-end produces valid report without side effects", async () => {
  const out = await runBenchmark({ mode: "demo", writeReports: false, logger: { log: () => {} } });
  assert.equal(out.meta.cases, 50);
  assert.equal(out.meta.mode, "demo");
  const agg = out.aggregate;
  for (const k of ["fidelity", "terminology", "constraints", "executability", "antiOI"]) {
    assert.ok(agg.dimScores[k] >= 0 && agg.dimScores[k] <= 1, `${k} range`);
  }
  assert.ok(agg.overall >= 0 && agg.overall <= 1);
  assert.equal(agg.verdictCounts.PASS + agg.verdictCounts.CAUTION + agg.verdictCounts.FAIL, 50);
  assert.equal(Object.keys(agg.categoryScores).length, 10);
  // rawInput immutability on every case
  for (const r of out.results) {
    assert.equal(r.result.meta.rawInput, r.case.input, `${r.case.id} rawInput immutable`);
  }
});

test("benchmark-v1: demo compiler preserves semantics on an ASR case", async () => {
  const gateway = createBenchmarkDemoGateway();
  const compiler = createIntentCompiler({ gateway });
  const r = await compiler.analyze("帮我接一下 deep seek 的 API。", CTX, { inputSource: "voice" });
  assert.equal(r.meta.rawInput, "帮我接一下 deep seek 的 API。");
  assert.ok(r.meta.normalizedInput.includes("deep seek")); // hints are NOT auto-applied locally
  assert.ok(r.meta.corrections.some((c) => c.original === "deep seek" && c.corrected === "DeepSeek"));
});

test("benchmark-v1: norm() is deterministic and strips punctuation", () => {
  assert.equal(norm("帮我把这个页面，弄得高级一点！"), norm("帮我把这个页面弄得高级一点"));
  assert.equal(norm("DeepSeek API"), "deepseekapi");
});
