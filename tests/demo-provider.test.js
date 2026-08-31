/* Unit tests — DemoAIProvider (spec §11 requirements) */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoAIProvider } from "../src/services/ai/demo-provider.js";
import { isValidPrompt } from "../src/models/prompt.js";

const ai = createDemoAIProvider({ latency: { analyze: 0, improve: 0, rewrite: 0 } });

test("deterministic: same input → same output", async () => {
  const a = await ai.analyzePrompt("I want to create a premium AI product website");
  const b = await ai.analyzePrompt("I want to create a premium AI product website");
  assert.deepEqual(a, b);
});

test("analyze returns schema-valid prompt + detectedIntent", async () => {
  const r = await ai.analyzePrompt("帮我规划一个东京三天旅行");
  assert.ok(isValidPrompt(r.prompt));
  assert.equal(r.detectedIntent, "travel");
  assert.equal(r.prompt.role, "Travel Planner");
});

test("general fallback never fails on unmatched input", async () => {
  const r = await ai.analyzePrompt("zzqxv unlikely match");
  assert.ok(isValidPrompt(r.prompt));
  assert.equal(r.detectedIntent, "general");
  assert.equal(r.prompt.role, "Expert Assistant");
});

test("improve enhances objective and keeps schema", async () => {
  const { prompt } = await ai.analyzePrompt("create a website");
  const improved = await ai.improvePrompt(prompt);
  assert.ok(isValidPrompt(improved));
  assert.ok(improved.objective.includes("with a clear structure"));
  assert.ok(improved.style.includes("Clear"));
});

test("rewrite recomposes objective and keeps schema", async () => {
  const { prompt } = await ai.analyzePrompt("create a website");
  const rewritten = await ai.rewritePrompt(prompt);
  assert.ok(isValidPrompt(rewritten));
  assert.ok(rewritten.objective.startsWith("Deliver "));
});

test("failNext() simulates AI_ERROR once, then recovers", async () => {
  const local = createDemoAIProvider({ latency: { analyze: 0, improve: 0, rewrite: 0 } });
  local.failNext();
  await assert.rejects(() => local.analyzePrompt("anything"), /Simulated AI error/);
  const ok = await local.analyzePrompt("anything"); // next call works again
  assert.ok(isValidPrompt(ok.prompt));
});
