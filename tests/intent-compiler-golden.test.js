/* Golden Dataset runner (spec §51–§55) — every fixture case runs through the
   real compile() pipeline with a scripted mock gateway (deterministic).
   Semantic assertions, never exact-string equality (spec §52). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createIntentCompiler } from "../server/ai/skills/intent-compiler/index.js";
import { createTerminologyResolver } from "../server/ai/skills/intent-compiler/terminology.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "prompt-intelligence");
const CTX = { requestId: "pk_req_golden", route: "/test", signal: undefined };

async function loadCases() {
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".json"));
  const cases = [];
  for (const f of files) {
    const data = JSON.parse(await readFile(join(FIXTURES_DIR, f), "utf8"));
    for (const c of data.cases) cases.push({ ...c, _file: f });
  }
  return cases;
}

function checkExpect(result, c) {
  const e = c.expect || {};
  const meta = result.meta;
  const optimized = meta.optimizedPrompt;
  const lowOpt = optimized.toLowerCase();

  if (e.task) assert.equal(result.detectedIntent, e.task, `[${c.name}] task`);
  if (e.subtasks) assert.deepEqual(meta.intent.subtasks, e.subtasks, `[${c.name}] subtasks`);
  if (e.correctedIncludes) e.correctedIncludes.forEach((s) =>
    assert.ok(meta.correctedInput.includes(s), `[${c.name}] correctedInput missing "${s}"`));
  if (e.normalizedIncludes) e.normalizedIncludes.forEach((s) =>
    assert.ok(meta.normalizedInput.includes(s), `[${c.name}] normalizedInput missing "${s}"`));
  if (e.normalizedNotIncludes) e.normalizedNotIncludes.forEach((s) =>
    assert.ok(!meta.normalizedInput.includes(s), `[${c.name}] normalizedInput should not contain "${s}"`));
  if (e.optimizedIncludes) e.optimizedIncludes.forEach((s) =>
    assert.ok(lowOpt.includes(s.toLowerCase()), `[${c.name}] optimizedPrompt missing "${s}"`));
  if (e.optimizedNotIncludes) e.optimizedNotIncludes.forEach((s) =>
    assert.ok(!lowOpt.includes(s.toLowerCase()), `[${c.name}] optimizedPrompt must NOT contain "${s}"`));
  if (e.optimizedMaxLength) assert.ok(optimized.length <= e.optimizedMaxLength,
    `[${c.name}] optimizedPrompt too long (${optimized.length})`);
  if (e.structuredRequirementsInclude) e.structuredRequirementsInclude.forEach((s) =>
    assert.ok(result.prompt.requirements.some((r) => r.includes(s)), `[${c.name}] requirements missing "${s}"`));
  if (e.structuredStyleIncludes) e.structuredStyleIncludes.forEach((s) =>
    assert.ok(result.prompt.style.includes(s), `[${c.name}] style missing "${s}"`));
  if (e.intentContextIncludes) e.intentContextIncludes.forEach((s) =>
    assert.ok(meta.intent.context.some((x) => x.includes(s)), `[${c.name}] intent.context missing "${s}"`));
  if (e.roleIsEmpty) assert.equal(result.prompt.role, "", `[${c.name}] role should be empty`);
  if (e.correctionFor) {
    const hit = meta.corrections.find((x) => x.original === e.correctionFor.original);
    assert.ok(hit, `[${c.name}] correction for "${e.correctionFor.original}" missing`);
    assert.equal(hit.corrected, e.correctionFor.corrected);
    assert.ok(hit.confidence >= 0.7, `[${c.name}] correction confidence too low`);
  }
  if (e.uncertaintyExpected !== undefined) {
    assert.equal(meta.uncertainties.length > 0, e.uncertaintyExpected, `[${c.name}] uncertainty expectation`);
  }
  if (e.aiSuggestionsPresent) assert.ok(meta.aiSuggestions.length > 0, `[${c.name}] aiSuggestions expected`);
  if (e.conservative !== undefined) assert.equal(meta.conservative, e.conservative, `[${c.name}] conservative flag`);
  if (e.objectiveIncludes) e.objectiveIncludes.forEach((s) =>
    assert.ok(result.prompt.objective.includes(s), `[${c.name}] objective missing "${s}"`));
  if (e.objectiveNotIncludes) e.objectiveNotIncludes.forEach((s) =>
    assert.ok(!result.prompt.objective.includes(s), `[${c.name}] objective must NOT contain "${s}"`));
  if (e.fidelityMin) assert.ok(meta.quality.intentFidelity >= e.fidelityMin,
    `[${c.name}] fidelity ${meta.quality.intentFidelity} < ${e.fidelityMin}`);
}

const cases = await loadCases();
assert.ok(cases.length >= 12, `golden dataset too small: ${cases.length}`);

for (const c of cases) {
  test(`golden: ${c.name} (${c._file})`, async () => {
    const gateway = { chatJson: async () => c.mockLLM };
    const compiler = createIntentCompiler({ gateway, terminology: createTerminologyResolver() });
    const result = await compiler.analyze(c.input, CTX, {
      inputSource: c.inputSource || "text",
      mode: "quick",
      context: c.context || null
    });
    // invariants on EVERY case (spec §5/§37)
    assert.ok(result.meta.rawInput === c.input, "rawInput must be preserved verbatim");
    assert.ok(result.meta.quality.qualityScore >= 0 && result.meta.quality.qualityScore <= 1);
    checkExpect(result, c);
  });
}

test("golden: improve keeps original when fidelity FAILs", async () => {
  const original = { role: "Designer", objective: "Create a website", context: "", requirements: ["Keep it fast"], style: ["Minimal"], output: "" };
  const gateway = {
    chatJson: async () => ({
      prompt: { role: "Guru", objective: "Build a spaceship", context: "", requirements: [], style: [], output: "" },
      changes: ["everything"],
      fidelity: { intentFidelity: 0.2, semanticChanges: ["task changed"], addedAssumptions: ["spaceship"], removedRequirements: ["Keep it fast"] }
    })
  };
  const compiler = createIntentCompiler({ gateway });
  const next = await compiler.improve(original, CTX);
  assert.deepEqual(next, original); // conservative: user's version wins
});

test("golden: improve returns model version when fidelity passes", async () => {
  const original = { role: "Designer", objective: "Create a website", context: "", requirements: ["Keep it fast"], style: ["Minimal"], output: "" };
  const gateway = {
    chatJson: async () => ({
      prompt: { role: "Designer", objective: "Create a fast, modern website", context: "", requirements: ["Keep it fast"], style: ["Minimal"], output: "" },
      changes: ["clarified objective"],
      fidelity: { intentFidelity: 0.96, semanticChanges: [], addedAssumptions: [], removedRequirements: [] }
    })
  };
  const compiler = createIntentCompiler({ gateway });
  const next = await compiler.improve(original, CTX);
  assert.equal(next.objective, "Create a fast, modern website");
  assert.ok(next.requirements.includes("Keep it fast"));
});

test("golden: compiler output quality score within [0,1] and performance logged", async () => {
  const gateway = { chatJson: async () => cases[0].mockLLM };
  const compiler = createIntentCompiler({ gateway });
  const r = await compiler.analyze(cases[0].input, CTX, { inputSource: "voice" });
  const perf = r.meta.performance;
  assert.ok(typeof perf.intentCompilerDuration === "number");
  assert.ok(typeof perf.llmDuration === "number");
  assert.equal(perf.inputSource, "voice");
  assert.equal(perf.mode, "quick");
});
