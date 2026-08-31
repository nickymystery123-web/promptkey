/* Benchmark v1 — semantic scoring engine (Phase 3B-3).
   Rule-based + semantic assertions; never exact-string equality.
   Five weighted dimensions (spec §6):
     Intent Fidelity 35% · Terminology Accuracy 20% · Constraint Preservation 20%
     Executability 15% · Anti-Overinterpretation 10%.
   Failure taxonomy per spec §11. Pure functions — unit-testable. */

const WEIGHTS = { fidelity: 0.35, terminology: 0.2, constraints: 0.2, executability: 0.15, antiOI: 0.1 };
export const VERDICT_PASS = 0.85;
export const VERDICT_CAUTION = 0.7;

/* ---- text normalization: keep only letters/digits (CJK + latin) ---- */
export function norm(s) {
  return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/* Collapsed matching for TERMINOLOGY: lowercase + collapse whitespace runs,
   but keep a single space between tokens. Unlike norm(), this distinguishes
   "deep seek" (spaced) from "DeepSeek" (unspaced) — critical for ASR
   correction verification. */
export function textCollapsed(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function containsTerm(text, term) {
  const t = String(term || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;
  return textCollapsed(text).includes(t);
}

/* Case-sensitive variant — used for canonical correction targets and
   preserved technical terms (React stays React, DeepSeek stays DeepSeek).
   Case-insensitive matching would mask a missed capitalization correction. */
export function containsTermCS(text, term) {
  const t = String(term || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  return String(text || "").replace(/\s+/g, " ").includes(t);
}

/* A token may be a string or an array of alternatives (any one counts). */
export function tokenHit(textNorm, token) {
  const list = Array.isArray(token) ? token : [token];
  return list.some((t) => textNorm.includes(norm(t)));
}

export function tokenCoverage(textNorm, tokens) {
  if (!tokens || !tokens.length) return { hits: 0, total: 0, missing: [] };
  const missing = tokens.filter((t) => !tokenHit(textNorm, t));
  return { hits: tokens.length - missing.length, total: tokens.length, missing };
}

export function constraintHit(textNorm, constraint) {
  // every group must have at least one hit
  return constraint.groups.every((group) => group.some((t) => textNorm.includes(norm(t))));
}

/* The delivered prompt = optimizedPrompt + all structured fields.
   aiSuggestions are excluded (design: suggestions are labeled, not delivered). */
export function buildDelivered(result) {
  const m = result.meta || {};
  const p = result.prompt || {};
  const parts = [
    m.optimizedPrompt,
    p.objective, p.context,
    ...(Array.isArray(p.requirements) ? p.requirements : []),
    ...(Array.isArray(p.style) ? p.style : []),
    p.output
  ];
  return parts.filter((x) => x && typeof x === "string").join(" ");
}

const ACTION_VERB = /(create|design|write|build|analyze|translate|plan|check|fix|review|optimize|improve|refactor|simplify|rewrite|生成|创建|设计|写|规划|分析|翻译|检查|修复|优化|整理|改|调整|重写|润色|重构|简化|收一收|接|做|查|处理)/i;

/* Anti-overinterpretation is about the model INVENTING requirements.
   A negated mention of a forbidden token (e.g. user says "不是要重新做" and the
   compiler echoes "不要重新做" as a constraint) is constraint preservation,
   NOT invention. Occurrences preceded by a negation marker are therefore
   exempt. */
const NEGATION_MARKERS = /(不|没|别|勿|莫|毋|免|禁|无|否|防|避|never|not|no|don'?t|do not|didn'?t|doesn'?t|without|instead of)/i;
const NEGATION_WINDOW = 8;

export function hasAffirmativeToken(collapsedText, token) {
  const list = Array.isArray(token) ? token : [token];
  const t = String(collapsedText || "");
  return list.some((tok) => {
    const key = String(tok || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!key) return false;
    let idx = t.indexOf(key);
    while (idx !== -1) {
      const before = t.slice(Math.max(0, idx - NEGATION_WINDOW), idx);
      if (!NEGATION_MARKERS.test(before)) return true; // affirmative occurrence
      idx = t.indexOf(key, idx + key.length);
    }
    return false;
  });
}

/* ---- one case → detailed scored result ---- */
export function scoreCase(result, expected) {
  const delivered = buildDelivered(result);
  const dNorm = norm(delivered);
  const dCollapsed = textCollapsed(delivered);
  const m = result.meta || {};
  const p = result.prompt || {};
  const corrected = norm(m.correctedInput);
  const e = expected || {};

  /* 1 — Intent Fidelity */
  const task = e.task || null;
  const taskHit = task ? result.detectedIntent === task : true;
  const cov = tokenCoverage(dNorm, e.intentTokens);
  let fidelity = task ? 0.5 * (taskHit ? 1 : 0) + 0.5 * (cov.total ? cov.hits / cov.total : 1) : (cov.total ? cov.hits / cov.total : 1);
  if (task && !taskHit) fidelity = Math.min(fidelity, 0.4); // task drift is severe

  /* 2 — Terminology */
  const termChecks = [];
  const correctCorrections = (e.terminology && e.terminology.correctCorrections) || [];
  const falseCorrections = (e.terminology && e.terminology.falseCorrections) || [];
  const preserveTerms = (e.terminology && e.terminology.preserveTerms) || [];
  correctCorrections.forEach((c) => {
    const applied = containsTermCS(delivered, c.to);
    termChecks.push({ type: "correct", label: `${c.from}→${c.to}`, from: c.from, to: c.to, pass: applied });
  });
  preserveTerms.forEach((t) => {
    termChecks.push({ type: "preserve", label: t, term: t, pass: containsTermCS(delivered, t) });
  });
  const falseViolations = [];
  falseCorrections.forEach((c) => {
    const violated = containsTerm(delivered, c.to); // case-insensitive: any form of the wrong term is bad
    termChecks.push({ type: "false", label: `${c.from}≠${c.to}`, from: c.from, to: c.to, pass: !violated });
    if (violated) falseViolations.push(c);
  });
  const termTotal = termChecks.length ? termChecks.length : 1;
  const terminology = termChecks.length
    ? termChecks.reduce((acc, c) => acc + (c.pass ? 1 : 0), 0) / termTotal
    : 1; // no terminology checks → nothing to fail

  /* 3 — Constraints */
  const constraints = (e.constraints || []).map((c) => ({ label: c.label, pass: constraintHit(dNorm, c) }));
  const constraintScore = constraints.length ? constraints.filter((c) => c.pass).length / constraints.length : 1;
  const lostConstraints = constraints.filter((c) => !c.pass).map((c) => c.label);

  /* 4 — Executability */
  const objective = p.objective || "";
  const hasVerb = ACTION_VERB.test(objective);
  const len = delivered.length;
  let executability = 0;
  executability += objective ? (0.35 + (hasVerb ? 0.35 : 0)) : 0;      // 0..0.7
  executability += len >= 8 && len <= 400 ? 0.15 : 0.05;               // sane length
  const noiseHits = (e.noiseRemoved || []).filter((t) => containsTerm(m.correctedInput, t));
  executability += noiseHits.length === 0 ? 0.15 : 0;                  // noise-free
  executability = Math.min(1, Math.max(0, executability));

  /* 5 — Anti-Overinterpretation */
  const forbidden = e.forbiddenInferences || [];
  const oiViolations = forbidden.filter((t) => hasAffirmativeToken(dCollapsed, t));
  const antiOI = oiViolations.length === 0 ? 1 : 1 / (1 + oiViolations.length);
  const suggestionOverreach = forbidden.filter((t) =>
    (m.aiSuggestions || []).some((s) => norm(s).includes(norm(Array.isArray(t) ? t[0] : t))));

  /* ---- aggregate ---- */
  const dims = {
    fidelity: Number(fidelity.toFixed(3)),
    terminology: Number(terminology.toFixed(3)),
    constraints: Number(constraintScore.toFixed(3)),
    executability: Number(executability.toFixed(3)),
    antiOI: Number(antiOI.toFixed(3))
  };
  /* ---- failure taxonomy (first applicable, priority order) ---- */
  let failureType = null;
  let failureDetail = null;
  const fail = (type, detail) => { if (!failureType) { failureType = type; failureDetail = detail; } };
  if (falseViolations.length) fail("FALSE_CORRECTION", `wrongly applied: ${falseViolations.map((v) => `${v.from}→${v.to}`).join(", ")}`);
  if (lostConstraints.length) fail("CONSTRAINT_LOSS", `missing: ${lostConstraints.join("; ")}`);
  if (oiViolations.length) fail("OVER_INTERPRETATION", `invented: ${oiViolations.map((t) => (Array.isArray(t) ? t.join("|") : t)).join(", ")}`);
  if (termChecks.some((c) => !c.pass && c.type !== "false")) fail("TERMINOLOGY_ERROR", termChecks.filter((c) => !c.pass && c.type !== "false").map((c) => c.label).join(", "));
  if (e.taskType === "multi_step" && result.detectedIntent !== "multi_step") fail("INTENT_DRIFT", `expected multi_step, got ${result.detectedIntent}`);
  if (task && !taskHit) fail("INTENT_DRIFT", `task ${result.detectedIntent} ≠ ${task}`);
  if (cov.total && cov.hits / cov.total < 0.6) fail("INTENT_DRIFT", `core tokens missing: ${cov.missing.map((t) => (Array.isArray(t) ? t.join("|") : t)).join(", ")}`);
  if (e.contextInference && !contextUsed(result, e)) fail("CONTEXT_ERROR", "expected context resolution, context not reflected in output");
  if (executability < 0.6) fail("EXECUTABILITY_FAILURE", `executability ${executability.toFixed(2)}`);
  if (len > 600) fail("PROMPT_BLOAT", `delivered length ${len}`);

  const failures = [];
  if (failureType) failures.push({ type: failureType, detail: failureDetail });

  const score = Number(
    (WEIGHTS.fidelity * dims.fidelity + WEIGHTS.terminology * dims.terminology +
     WEIGHTS.constraints * dims.constraints + WEIGHTS.executability * dims.executability +
     WEIGHTS.antiOI * dims.antiOI).toFixed(3)
  );
  // Verdict = weighted score, corrected by failure semantics (spec §2/§3/§5):
  // hard violations (invented requirements / false corrections / lost constraints)
  // are product-fatal → always FAIL; any other recorded failure demotes to CAUTION.
  const HARD_FAILURES = new Set(["FALSE_CORRECTION", "OVER_INTERPRETATION", "CONSTRAINT_LOSS"]);
  let verdict = score >= VERDICT_PASS ? "PASS" : score >= VERDICT_CAUTION ? "CAUTION" : "FAIL";
  if (failureType) {
    if (HARD_FAILURES.has(failureType)) verdict = "FAIL";
    else if (verdict === "PASS") verdict = "CAUTION";
  }

  return {
    dims,
    score,
    verdict,
    failures,
    evidence: {
      delivered,
      correctedInput: m.correctedInput,
      detectedIntent: result.detectedIntent,
      subtasks: (m.intent && m.intent.subtasks) || [],
      intentContext: (m.intent && m.intent.context) || [],
      conservative: !!m.conservative,
      corrections: m.corrections || [],
      termChecks,
      lostConstraints,
      oiViolations: oiViolations.map((t) => (Array.isArray(t) ? t.join("|") : t)),
      suggestionOverreach: suggestionOverreach.map((t) => (Array.isArray(t) ? t.join("|") : t)),
      noiseHits,
      uncertaintyRecorded: (m.uncertainties || []).length > 0
    }
  };
}

function contextUsed(result, expected) {
  const delivered = buildDelivered(result);
  const dNorm = norm(delivered);
  const ctx = ((result.meta && result.meta.intent && result.meta.intent.context) || []).join(" ");
  const tokens = expected.contextTokens || [];
  return tokens.some((t) => norm(ctx).includes(norm(t)) || dNorm.includes(norm(t)));
}

/* ---- aggregate across cases ---- */
export function aggregateResults(results) {
  const dims = { fidelity: [], terminology: [], constraints: [], executability: [], antiOI: [] };
  let constraintChecks = 0, constraintLosses = 0;
  let correctApplied = 0, correctTotal = 0, falseViolations = 0, falseTotal = 0, preserveLost = 0, preserveTotal = 0;
  let oiCases = 0, suggestionOverreachCases = 0;
  const taxonomy = {};
  const topFailures = [];

  for (const r of results) {
    for (const k of Object.keys(dims)) dims[k].push(r.scored.dims[k]);
    constraintChecks += r.case.constraints ? r.case.constraints.length : 0;
    constraintLosses += r.scored.evidence.lostConstraints.length;
    for (const c of r.scored.evidence.termChecks) {
      if (c.type === "correct") { correctTotal++; if (c.pass) correctApplied++; }
      if (c.type === "false") { falseTotal++; if (!c.pass) falseViolations++; }
      if (c.type === "preserve") { preserveTotal++; if (!c.pass) preserveLost++; }
    }
    if (r.scored.evidence.oiViolations.length) oiCases++;
    if (r.scored.evidence.suggestionOverreach.length) suggestionOverreachCases++;
    for (const f of r.scored.failures) taxonomy[f.type] = (taxonomy[f.type] || 0) + 1;
    if (r.scored.verdict !== "PASS") topFailures.push(r);
  }

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const dimScores = Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, Number(mean(v).toFixed(3))]));
  const overall = Number(
    (WEIGHTS.fidelity * dimScores.fidelity + WEIGHTS.terminology * dimScores.terminology +
     WEIGHTS.constraints * dimScores.constraints + WEIGHTS.executability * dimScores.executability +
     WEIGHTS.antiOI * dimScores.antiOI).toFixed(3)
  );

  const verdictCounts = results.reduce((acc, r) => { acc[r.scored.verdict] = (acc[r.scored.verdict] || 0) + 1; return acc; }, {});
  const missed = correctTotal - correctApplied;
  const termChecksTotal = correctTotal + falseTotal + preserveTotal;
  const terminologyErrorRate = termChecksTotal ? (missed + falseViolations + preserveLost) / termChecksTotal : 0;

  // per-category
  const categories = {};
  for (const r of results) {
    const c = r.case.category || "?";
    if (!categories[c]) categories[c] = [];
    categories[c].push(r.scored.score);
  }
  const categoryScores = Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(3))]));

  return {
    skillVersion: results[0] && results[0].skillVersion,
    mode: results[0] && results[0].mode,
    dimScores,
    overall,
    verdictCounts: { PASS: verdictCounts.PASS || 0, CAUTION: verdictCounts.CAUTION || 0, FAIL: verdictCounts.FAIL || 0 },
    overInterpretationRate: Number((oiCases / results.length).toFixed(3)),
    constraintLossRate: constraintChecks ? Number((constraintLosses / constraintChecks).toFixed(3)) : 0,
    terminology: {
      correctApplied, correctTotal, missed,
      falseViolations, falseTotal,
      preserveLost, preserveTotal,
      errorRate: Number(terminologyErrorRate.toFixed(3))
    },
    suggestionOverreachCases,
    taxonomy,
    categoryScores,
    topFailures: topFailures
      .sort((a, b) => (a.scored.verdict === b.scored.verdict ? b.scored.score - a.scored.score : (a.scored.verdict === "FAIL" ? -1 : 1)))
      .slice(0, 15)
      .map((r) => ({ id: r.case.id, verdict: r.scored.verdict, score: r.scored.score, failures: r.scored.failures, evidence: r.scored.evidence }))
  };
}
