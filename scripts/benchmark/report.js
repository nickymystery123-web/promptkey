/* Benchmark v1 — report writers (JSON + Markdown, spec §17). */

const CATEGORY_LABELS = {
  A: "A. Basic Conversational Input",
  B: "B. Conversational Noise",
  C: "C. ASR / Speech Recognition Errors",
  D: "D. Terminology Disambiguation",
  E: "E. Constraint Preservation",
  F: "F. Anti-Overinterpretation",
  G: "G. Chinese-English Mixed Input",
  H: "H. Context / Referential Input",
  I: "I. Multi-step Intent",
  J: "J. Difficult Natural Speech"
};

const pct = (n) => `${(n * 100).toFixed(1)}%`;

export function buildReportJson({ meta, results, aggregate, judge }) {
  return {
    report: "PromptKey Intelligence Benchmark v1",
    generatedAt: meta.generatedAt,
    skillVersion: meta.skillVersion,
    mode: meta.mode,
    model: meta.model || "n/a",
    cases: results.length,
    ...aggregate,
    judge,
    casesDetail: results.map((r) => ({
      id: r.case.id,
      category: r.case.category,
      input: r.case.input,
      inputSource: r.case.inputSource,
      expectedTask: r.case.expected.task || null,
      score: r.scored.score,
      verdict: r.scored.verdict,
      dims: r.scored.dims,
      failures: r.scored.failures,
      evidence: r.scored.evidence
    }))
  };
}

export function buildMarkdownReport({ meta, results, aggregate, judge, previous }) {
  const L = [];
  const push = (s = "") => L.push(s);
  const hr = () => push("---");
  const verdictLine = (id, v) => (v === "PASS" ? "PASS" : v === "CAUTION" ? "CAUTION" : "**FAIL**");

  push(`# PromptKey Intelligence Benchmark v1`);
  push();
  push(`- Generated: ${meta.generatedAt}`);
  push(`- Skill version: **${meta.skillVersion}**`);
  push(`- Mode: ${meta.mode} (${meta.model || "n/a"})`);
  push(`- Cases: ${meta.cases}`);
  hr();

  push(`## Overall Score`);
  push();
  push(`| Dimension | Weight | Score |`);
  push(`|---|---|---|`);
  push(`| Intent Fidelity | 35% | ${pct(aggregate.dimScores.fidelity)} |`);
  push(`| Terminology Accuracy | 20% | ${pct(aggregate.dimScores.terminology)} |`);
  push(`| Constraint Preservation | 20% | ${pct(aggregate.dimScores.constraints)} |`);
  push(`| Executability | 15% | ${pct(aggregate.dimScores.executability)} |`);
  push(`| Anti-Overinterpretation | 10% | ${pct(aggregate.dimScores.antiOI)} |`);
  push(`| **Overall** | | **${pct(aggregate.overall)}** |`);
  push();
  push(`**Verdicts:** PASS ${aggregate.verdictCounts.PASS} · CAUTION ${aggregate.verdictCounts.CAUTION} · FAIL ${aggregate.verdictCounts.FAIL}`);
  push();

  push(`## Key Product Metrics`);
  push();
  push(`- **Over-Interpretation Rate:** ${pct(aggregate.overInterpretationRate)} (target: as low as possible)`);
  push(`- **Constraint Loss Rate:** ${pct(aggregate.constraintLossRate)} (target: ≤ 3%)`);
  push(`- **Terminology Correction Accuracy:** correct ${aggregate.terminology.correctApplied}/${aggregate.terminology.correctTotal} · false ${aggregate.terminology.falseViolations}/${aggregate.terminology.falseTotal} · missed ${aggregate.terminology.missed} · preserve lost ${aggregate.terminology.preserveLost}/${aggregate.terminology.preserveTotal}`);
  push(`- **Terminology Error Rate:** ${pct(aggregate.terminology.errorRate)}`);
  push(`- **Suggestion Overreach (warnings):** ${aggregate.suggestionOverreachCases} cases`);
  hr();

  push(`## Category Scores`);
  push();
  push(`| Category | Score |`);
  push(`|---|---|`);
  for (const [k, v] of Object.entries(aggregate.categoryScores).sort()) {
    push(`| ${CATEGORY_LABELS[k] || k} | ${pct(v)} |`);
  }
  push();

  const tax = Object.entries(aggregate.taxonomy).sort((a, b) => b[1] - a[1]);
  if (tax.length) {
    push(`## Failure Taxonomy`);
    push();
    push(`| Type | Count |`);
    push(`|---|---|`);
    for (const [type, count] of tax) push(`| ${type} | ${count} |`);
    push();
  }

  const failed = results.filter((r) => r.scored.verdict === "FAIL");
  const cautioned = results.filter((r) => r.scored.verdict === "CAUTION");
  if (failed.length || cautioned.length) {
    push(`## Top Failures`);
    push();
    for (const r of [...failed, ...cautioned].slice(0, 15)) {
      push(`### ${r.case.id} (${r.scored.verdict}) — ${r.case.name}`);
      push();
      push(`Score: ${(r.scored.score * 100).toFixed(1)}%`);
      for (const f of r.scored.failures) {
        push(`- **${f.type}:** ${f.detail}`);
      }
      push(`- Original: ${JSON.stringify(r.case.input)}`);
      push(`- Delivered: ${JSON.stringify(r.scored.evidence.delivered)}`);
      push(`- CorrectedInput: ${JSON.stringify(r.scored.evidence.correctedInput)}`);
      push(`- DetectedIntent: ${r.scored.evidence.detectedIntent}${r.scored.evidence.subtasks.length ? ` / subtasks: ${r.scored.evidence.subtasks.join(" → ")}` : ""}`);
      push();
    }
  }

  if (previous) {
    push(`## Comparison with Previous Version`);
    push();
    push(`| Metric | ${previous.skillVersion} (before) | ${meta.skillVersion} (after) | Delta |`);
    push(`|---|---|---|---|`);
    const rows = [
      ["Overall", "overall"],
      ["Intent Fidelity", "dimScores.fidelity"],
      ["Terminology Accuracy", "dimScores.terminology"],
      ["Constraint Preservation", "dimScores.constraints"],
      ["Executability", "dimScores.executability"],
      ["Anti-Overinterpretation", "dimScores.antiOI"],
      ["Over-Interpretation Rate", "overInterpretationRate"],
      ["Constraint Loss Rate", "constraintLossRate"],
      ["Terminology Error Rate", "terminology.errorRate"]
    ];
    for (const [label, path] of rows) {
      const before = path.split(".").reduce((o, k) => o && o[k], previous);
      const after = path.split(".").reduce((o, k) => o && o[k], aggregate);
      const b = before === undefined ? "-" : pct(before);
      const a = after === undefined ? "-" : pct(after);
      const delta = before !== undefined && after !== undefined ? ((after - before) * 100).toFixed(1) + "pp" : "-";
      push(`| ${label} | ${b} | ${a} | ${delta} |`);
    }
    push();
  }

  push(`## Calibration Suggestions`);
  push();
  if (!failed.length && !cautioned.length) {
    push(`All cases PASS. No calibration needed — do not over-engineer the skill.`);
  } else {
    const suggestions = suggestCalibration(aggregate.taxonomy);
    for (const s of suggestions) push(`- ${s}`);
    push();
    push(`Next step: apply the highest-impact change, bump SKILL_VERSION, re-run the benchmark, compare.`);
  }
  hr();
  push();
  push(`_Report generated by scripts/benchmark — rule-based + semantic assertions; LLM Judge optional and evaluation-only._`);

  return L.join("\n");
}

function suggestCalibration(taxonomy) {
  const out = [];
  if (taxonomy.OVER_INTERPRETATION) out.push(`OVER_INTERPRETATION (×${taxonomy.OVER_INTERPRETATION}): strengthen the "do not invent requirements / never pick a specific design solution" rule in the Skill system prompt; add explicit negatives (no glassmorphism/gradient/3D/Apple-style unless the user asked).`);
  if (taxonomy.CONSTRAINT_LOSS) out.push(`CONSTRAINT_LOSS (×${taxonomy.CONSTRAINT_LOSS}): the system prompt already marks constraints as high priority; add "constraints must appear VERBATIM in structured.requirements" and list the exact constraint clause in optimizedPrompt.`);
  if (taxonomy.FALSE_CORRECTION) out.push(`FALSE_CORRECTION (×${taxonomy.FALSE_CORRECTION}): add an explicit rule "homophone candidates are only corrections when domain context strongly supports them; otherwise preserve the original word".`);
  if (taxonomy.TERMINOLOGY_ERROR) out.push(`TERMINOLOGY_ERROR (×${taxonomy.TERMINOLOGY_ERROR}): verify canonical technical terms (React/JSON/SQL/DeepSeek…) are preserved exactly; add them to the preservation checklist in the prompt.`);
  if (taxonomy.CONTEXT_ERROR) out.push(`CONTEXT_ERROR (×${taxonomy.CONTEXT_ERROR}): make context resolution more explicit — when a reference (刚才/那个/再/继续) exists, resolve the object from currentTask and name it in the objective.`);
  if (taxonomy.INTENT_DRIFT) out.push(`INTENT_DRIFT (×${taxonomy.INTENT_DRIFT}): verify task classification and multi-step subtask capture; require the full task chain in intent.subtasks for multi_step.`);
  if (taxonomy.EXECUTABILITY_FAILURE) out.push(`EXECUTABILITY_FAILURE (×${taxonomy.EXECUTABILITY_FAILURE}): keep objectives short and verb-first; strip residual fillers.`);
  if (taxonomy.PROMPT_BLOAT) out.push(`PROMPT_BLOAT (×${taxonomy.PROMPT_BLOAT}): enforce "simple tasks stay simple — never exceed a few sentences".`);
  if (!out.length) out.push(`No taxonomy-specific failures; inspect CAUTION cases individually.`);
  return out;
}
