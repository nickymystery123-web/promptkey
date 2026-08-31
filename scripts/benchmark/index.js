/* Benchmark v1 runner — orchestration.
   Usage:
     node scripts/benchmark.js                  # auto: real if AI_MODE=real+key, else demo
     node scripts/benchmark.js --mode real      # real DeepSeek (production path)
     node scripts/benchmark.js --mode demo      # deterministic rule-based floor
     node scripts/benchmark.js --judge          # also run LLM-as-Judge (extra calls, eval-only)
   Writes reports/prompt-intelligence/benchmark-v1.{json,md} + baseline snapshot. */

import { readFile, readdir, writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createIntentCompiler, SKILL_VERSION } from "../../server/ai/skills/intent-compiler/index.js";
import { scoreCase, aggregateResults } from "./eval.js";
import { createBenchmarkDemoGateway } from "./demo-gateway.js";
import { judgeCase } from "./judge.js";
import { buildReportJson, buildMarkdownReport } from "./report.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES_DIR = join(root, "tests", "fixtures", "prompt-intelligence", "benchmark-v1");
const REPORTS_DIR = join(root, "reports", "prompt-intelligence");
const REPORT_JSON = join(REPORTS_DIR, "benchmark-v1.json");
const REPORT_MD = join(REPORTS_DIR, "benchmark-v1.md");
const BASELINE_JSON = join(REPORTS_DIR, "benchmark-v1.baseline.json");

export async function loadCases() {
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".json"));
  const cases = [];
  for (const f of files) {
    const data = JSON.parse(await readFile(join(FIXTURES_DIR, f), "utf8"));
    for (const c of data.cases) cases.push(c);
  }
  return cases;
}

export function validateCases(cases) {
  const ids = new Set();
  const categories = {};
  const problems = [];
  for (const c of cases) {
    if (ids.has(c.id)) problems.push(`duplicate id ${c.id}`);
    ids.add(c.id);
    if (!c.category) problems.push(`${c.id}: missing category`);
    categories[c.category] = (categories[c.category] || 0) + 1;
    if (!c.input || typeof c.input !== "string") problems.push(`${c.id}: missing input`);
    if (!c.expected || typeof c.expected !== "object") problems.push(`${c.id}: missing expected`);
    if (!Array.isArray(c.expected?.intentTokens)) problems.push(`${c.id}: expected.intentTokens must be an array`);
    if (!Array.isArray(c.expected?.constraints)) problems.push(`${c.id}: expected.constraints must be an array`);
  }
  if (cases.length !== 50) problems.push(`expected 50 cases, got ${cases.length}`);
  for (const [k, v] of Object.entries(categories)) {
    if (v !== 5) problems.push(`category ${k} has ${v} cases (expected 5)`);
  }
  if (problems.length) throw new Error(`Benchmark fixture validation failed:\n- ${problems.join("\n- ")}`);
  return cases;
}

async function buildRealCompiler() {
  const { loadConfig } = await import("../../server/config/env.js");
  const { createLogger } = await import("../../server/lib/logger.js");
  const { createProviderRegistry } = await import("../../server/ai/registry.js");
  const { createDeepSeekProvider } = await import("../../server/ai/providers/deepseek.js");
  const { createGateway } = await import("../../server/ai/gateway/gateway.js");

  const config = loadConfig();
  const logger = createLogger({ logInputPreview: false });
  const registry = createProviderRegistry()
    .register("deepseek", createDeepSeekProvider({
      apiKey: config.AI_API_KEY,
      model: config.AI_MODEL || "deepseek-chat",
      baseUrl: config.AI_BASE_URL
    }));
  const gateway = createGateway({ registry, config, logger });
  return { compiler: createIntentCompiler({ gateway }), gateway, model: registry.get("deepseek").model };
}

function buildDemoCompiler() {
  const gateway = createBenchmarkDemoGateway();
  return { compiler: createIntentCompiler({ gateway }), gateway, model: "demo-rules-benchmark" };
}

export async function runBenchmark({ mode = "auto", judge = false, writeReports = true, logger = console } = {}) {
  const cases = validateCases(await loadCases());
  const { loadConfig } = await import("../../server/config/env.js");
  const env = loadConfig(); // the only source of truth for AI_MODE / key (server config)
  const resolved = mode === "auto"
    ? env.AI_MODE === "real" && !!env.AI_API_KEY ? "real" : "demo"
    : mode;

  const { compiler, gateway, model } = resolved === "real" ? await buildRealCompiler() : buildDemoCompiler();
  const startedAt = Date.now();

  const results = [];
  for (const c of cases) {
    try {
      const result = await compiler.analyze(c.input, { requestId: `pk_bm_${c.id}`, route: "/benchmark" }, {
        inputSource: c.inputSource || "text",
        mode: "quick",
        context: c.context || null
      });
      const scored = scoreCase(result, c.expected);
      results.push({ case: c, result, scored });
      logger.log(`  ${c.id} [${c.category}] ${scored.verdict.padEnd(7)} ${(scored.score * 100).toFixed(1)}%  ${scored.failures.map((f) => f.type).join(",") || "-"}  "${c.input.slice(0, 30)}..."`);
    } catch (e) {
      results.push({
        case: c, result: null, scored: {
          dims: { fidelity: 0, terminology: 0, constraints: 0, executability: 0, antiOI: 0 },
          score: 0, verdict: "FAIL",
          failures: [{ type: "EXECUTABILITY_FAILURE", detail: `runner error: ${e.message}` }],
          evidence: { delivered: "", correctedInput: "", detectedIntent: "", subtasks: [], intentContext: [], conservative: false, corrections: [], termChecks: [], lostConstraints: [], oiViolations: [], suggestionOverreach: [], noiseHits: [], uncertaintyRecorded: false }
        }
      });
      logger.log(`  ${c.id} [${c.category}] ERROR  ${e.message}`);
    }
    if (resolved === "real") await new Promise((r) => setTimeout(r, 100)); // gentle on the API
  }

  const aggregate = aggregateResults(results.map((r) => ({ case: r.case, scored: r.scored, skillVersion: SKILL_VERSION, mode: resolved })));

  let judgeOut = null;
  if (judge && resolved === "real") {
    logger.log("  running LLM-as-Judge (evaluation only)...");
    judgeOut = [];
    for (const r of results) {
      if (r.result) {
        const j = await judgeCase(gateway, r.case, r.result);
        judgeOut.push(j);
        logger.log(`  judge ${r.case.id}: ${j.verdict || j.error}`);
      }
      await new Promise((res) => setTimeout(res, 100));
    }
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    skillVersion: SKILL_VERSION,
    mode: resolved,
    model: resolved === "real" ? model : "demo-rules (local floor, no LLM)",
    cases: results.length,
    durationMs: Date.now() - startedAt
  };

  let previous = null;
  if (writeReports) {
    await mkdir(REPORTS_DIR, { recursive: true });
    try {
      const prevRaw = JSON.parse(await readFile(REPORT_JSON, "utf8"));
      if (prevRaw.skillVersion !== SKILL_VERSION) previous = prevRaw;
    } catch { /* first run */ }
    // baseline snapshot (skill v1.0) — kept forever for before/after comparison
    try { await access(BASELINE_JSON); } catch {
      const reportJson = buildReportJson({ meta, results, aggregate, judge: judgeOut });
      await writeFile(BASELINE_JSON, JSON.stringify(reportJson, null, 2));
    }
    const reportJson = buildReportJson({ meta, results, aggregate, judge: judgeOut });
    const reportMd = buildMarkdownReport({ meta, results, aggregate, judge: judgeOut, previous });
    await writeFile(REPORT_JSON, JSON.stringify(reportJson, null, 2));
    await writeFile(REPORT_MD, reportMd);
  }

  return { meta, aggregate, results, judge: judgeOut, previous, reportPaths: { json: REPORT_JSON, md: REPORT_MD } };
}

function printSummary({ meta, aggregate, previous }) {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const line = "=".repeat(58);
  console.log(`\n${line}`);
  console.log(`PromptKey Intelligence Benchmark v1`);
  console.log(`Skill version: ${meta.skillVersion} · Mode: ${meta.mode} · Model: ${meta.model}`);
  console.log(`Cases: ${meta.cases} · Duration: ${(meta.durationMs / 1000).toFixed(1)}s`);
  console.log(line);
  console.log(`Intent Fidelity:            ${pct(aggregate.dimScores.fidelity)}`);
  console.log(`Terminology Accuracy:       ${pct(aggregate.dimScores.terminology)}`);
  console.log(`Constraint Preservation:    ${pct(aggregate.dimScores.constraints)}`);
  console.log(`Executability:              ${pct(aggregate.dimScores.executability)}`);
  console.log(`Anti-Overinterpretation:    ${pct(aggregate.dimScores.antiOI)}`);
  console.log(line);
  console.log(`Overall Score:              ${pct(aggregate.overall)}`);
  console.log(line);
  console.log(`Over-Interpretation Rate:   ${pct(aggregate.overInterpretationRate)}`);
  console.log(`Constraint Loss Rate:       ${pct(aggregate.constraintLossRate)}`);
  console.log(`Terminology Error Rate:     ${pct(aggregate.terminology.errorRate)}`);
  console.log(line);
  console.log(`PASS: ${aggregate.verdictCounts.PASS}`);
  console.log(`CAUTION: ${aggregate.verdictCounts.CAUTION}`);
  console.log(`FAIL: ${aggregate.verdictCounts.FAIL}`);
  if (previous) {
    console.log(line);
    const d = ((aggregate.overall - previous.overall) * 100).toFixed(1);
    console.log(`vs previous (${previous.skillVersion}): overall ${d}pp`);
  }
  console.log(line);
}

export async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "auto";
  const judge = args.includes("--judge");
  if (!["auto", "real", "demo"].includes(mode)) {
    console.error(`unknown mode: ${mode} (use auto|real|demo)`);
    process.exit(1);
  }
  const out = await runBenchmark({ mode, judge });
  printSummary(out);
  console.log(`\nReport: ${out.reportPaths.json}\n        ${out.reportPaths.md}`);
  if (out.aggregate.verdictCounts.FAIL > 0) process.exitCode = 2;
  else if (out.aggregate.verdictCounts.CAUTION > 0) process.exitCode = 0; // CAUTION is informational
  return out;
}

// CLI entry
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error("Benchmark failed:", e); process.exit(1); });
}
