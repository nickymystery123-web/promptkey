/* Intent Compiler unit tests — local modules (no LLM involved) */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInput, extractConstraintClauses } from "../server/ai/skills/intent-compiler/normalizer.js";
import { createTerminologyResolver } from "../server/ai/skills/intent-compiler/terminology.js";
import { evaluateFidelity } from "../server/ai/skills/intent-compiler/fidelity.js";
import { evaluateQuality } from "../server/ai/skills/intent-compiler/evaluator.js";
import { parseCompilerInput, sanitizeAnalyzeOutput } from "../server/ai/skills/intent-compiler/schema.js";
import { resolveContext } from "../server/ai/skills/intent-compiler/context.js";
import { structureFromIntent, structureFromRaw } from "../server/ai/skills/intent-compiler/structurer.js";
import { createStructuredPrompt } from "../src/models/prompt.js";

/* ---- PK-01 normalizer ---- */
test("normalizer collapses repeated CJK sequences but keeps legit reduplications", () => {
  assert.equal(normalizeInput("整体整体优化一下"), "整体优化一下");
  assert.equal(normalizeInput("我想看看这个"), "我想看看这个"); // 看看 untouched (1-char)
  assert.equal(normalizeInput("这个这个页面对吧"), "这个页面对吧");
});

test("normalizer strips edge fillers but never negations", () => {
  const out = normalizeInput("就是我想让这个页面高级一点");
  assert.ok(!out.startsWith("就是"));
  assert.equal(normalizeInput("不要改现有功能"), "不要改现有功能");
  assert.equal(normalizeInput("呃，帮我做个页面"), "帮我做个页面");
});

test("extractConstraintClauses finds negation clauses", () => {
  const clauses = extractConstraintClauses("重新设计首页，但是不要改现有功能，也不要增加新的页面。");
  assert.equal(clauses.length, 2);
  assert.ok(clauses[0].includes("不要改现有功能"));
});

/* ---- PK-02 terminology ---- */
test("terminology scan: deep seek → DeepSeek (high confidence)", () => {
  const r = createTerminologyResolver();
  const hits = r.scan("帮我接一下 deep seek 的 API");
  assert.equal(hits[0].corrected, "DeepSeek");
  assert.ok(hits[0].confidence >= 0.9);
});

test("terminology scan: sequel → SQL only with data context", () => {
  const r = createTerminologyResolver();
  const withCtx = r.scan("帮我用 sequel 查一下这个数据");
  assert.equal(withCtx[0].corrected, "SQL");
  assert.ok(withCtx[0].confidence >= 0.9);
  const noCtx = r.scan("the sequel was great");
  assert.ok(noCtx[0].confidence < 0.7); // low → keep original by default
});

test("techTermsIn detects canonical terms for fidelity checks", () => {
  const r = createTerminologyResolver();
  assert.deepEqual(r.techTermsIn("这个 React 页面 API 调不通").sort(), ["API", "React"]);
});

/* ---- PK-04 context ---- */
test("context engages only when references exist", () => {
  const ctx = { currentTask: "设计首页", recentInputs: [] };
  assert.equal(resolveContext("把刚才那个再简洁一点", ctx).used, true);
  assert.equal(resolveContext("帮我写个函数", ctx).used, false);
  assert.equal(resolveContext("把刚才那个改改", null).used, false);
});

/* ---- PK-07 fidelity ---- */
test("fidelity FAILs when constraints are dropped", () => {
  const r = evaluateFidelity({
    rawInput: "重新设计首页，但是不要改现有功能，也不要增加新的页面。",
    optimizedText: "重新设计首页，增加新页面提升体验。",
    llmFidelity: { intentFidelity: 0.5, removedRequirements: ["不要改现有功能"], addedAssumptions: ["增加新页面"], semanticChanges: [] },
    techTerms: []
  });
  assert.equal(r.verdict, "FAIL");
  assert.ok(r.violations.length >= 2);
});

test("fidelity PASSes when constraints and tech terms preserved", () => {
  const r = evaluateFidelity({
    rawInput: "重新设计首页，但是不要改现有功能",
    optimizedText: "重新设计首页，但不要改现有功能",
    llmFidelity: { intentFidelity: 0.97, removedRequirements: [], addedAssumptions: [], semanticChanges: [] },
    techTerms: []
  });
  assert.equal(r.verdict, "PASS");
  assert.ok(r.score >= 0.9);
});

test("fidelity FAILs when tech term is altered", () => {
  const r = evaluateFidelity({
    rawInput: "帮我检查 React 页面的 API",
    optimizedText: "帮我检查 Vue 页面的接口",
    llmFidelity: null,
    techTerms: ["React", "API"]
  });
  assert.ok(r.violations.some((v) => v.includes("React")));
});

/* ---- PK-08 evaluator ---- */
test("quality score formula follows spec §34 weights", () => {
  const structured = createStructuredPrompt({
    objective: "写一个 Python 函数计算平均值",
    requirements: ["处理边界情况"],
    output: "代码",
    context: "生产环境"
  });
  const q = evaluateQuality({ optimizedText: "写一个 Python 函数，计算两个数字的平均值。", structured, fidelityScore: 1 });
  const expected = 0.4 * 1 + 0.2 * q.clarity + 0.2 * q.specificity + 0.2 * q.executability;
  assert.ok(Math.abs(q.qualityScore - expected) < 0.001);
  assert.ok(q.qualityScore > 0.8);
});

/* ---- schema ---- */
test("parseCompilerInput defaults and preserves rawInput", () => {
  const c = parseCompilerInput({ text: "  帮我做个页面  ", inputSource: "VOICE?" });
  assert.equal(c.inputSource, "text");
  assert.equal(c.mode, "quick");
  assert.equal(c.rawInput, "帮我做个页面");
  assert.throws(() => parseCompilerInput({ text: "  " }));
});

test("sanitizeAnalyzeOutput coerces messy model output", () => {
  const out = sanitizeAnalyzeOutput({
    intent: { task: "coding", goal: ["x"], requirements: "not-an-array" },
    optimizedPrompt: "do x",
    corrections: [{ original: "a", corrected: "b", confidence: 5 }],
    structured: null
  });
  assert.equal(out.intent.task, "coding");
  assert.deepEqual(out.intent.requirements, []);
  assert.equal(out.corrections[0].confidence, 0); // out-of-range → 0
  assert.equal(out.structured, null);
});

/* ---- structurer ---- */
test("structureFromIntent keeps constraints in requirements", () => {
  const p = structureFromIntent({
    task: "ui_design", object: "首页", goal: ["重新设计首页"],
    context: ["正在改版"], requirements: ["更简洁"], constraints: ["不要改功能"],
    preferences: ["minimal"], expectedOutput: "设计稿", subtasks: []
  });
  assert.ok(p.requirements.includes("不要改功能"));
  assert.equal(p.style[0], "minimal");
});

test("structureFromRaw produces conservative fallback", () => {
  const p = structureFromRaw("重新设计首页，但是不要改现有功能");
  assert.equal(p.objective, "重新设计首页，但是不要改现有功能");
});
