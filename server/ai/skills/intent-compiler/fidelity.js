/* PK-07 Intent Fidelity Guard (spec §31–§33).
   The final quality gate: does the optimized output still mean what the
   user meant? Local deterministic checks blended with the model's
   self-report. FAIL → caller must return a conservative version. */

import { extractConstraintClauses } from "./normalizer.js";

export function evaluateFidelity({ rawInput, optimizedText, llmFidelity, techTerms }) {
  const violations = [];   // hard: constraint/terminology broken
  const cautions = [];     // soft: assumptions added, requirements removed

  // 1. technical terms must be preserved (spec §41/§42)
  const optLower = optimizedText.toLowerCase();
  for (const term of techTerms || []) {
    if (!optLower.includes(term.toLowerCase())) {
      violations.push(`technical term altered or dropped: ${term}`);
    }
  }

  // 2. constraints (不要/别/不能/never...) must be preserved (spec §26)
  const clauses = extractConstraintClauses(rawInput);
  for (const clause of clauses) {
    const core = clause.replace(/^(不要|不能|别|不得|无需|不用|避免|禁止|不可以|never|do not|don't|must not)\s*/i, "").trim();
    const negator = clause.match(/^(不要|不能|别|不得|无需|不用|避免|禁止|不可以|never|do not|don't|must not)/i)?.[1] || "";
    const hasNegation = /(不要|不能|别|不得|避免|禁止|never|not)/i.test(optimizedText);
    const corePresent = core && optLower.includes(core.toLowerCase().slice(0, Math.min(8, core.length)));
    if (!(hasNegation && corePresent) && !(negator && optLower.includes(negator.toLowerCase()) && corePresent)) {
      violations.push(`constraint removed: ${clause}`);
    }
  }

  // 3. model self-report
  const self = llmFidelity || {};
  if (Array.isArray(self.removedRequirements) && self.removedRequirements.length) {
    cautions.push(...self.removedRequirements.map((r) => `requirement removed: ${r}`));
  }
  if (Array.isArray(self.addedAssumptions) && self.addedAssumptions.length) {
    cautions.push(...self.addedAssumptions.map((a) => `assumption added: ${a}`));
  }
  if (Array.isArray(self.semanticChanges) && self.semanticChanges.length > 2) {
    cautions.push(`many semantic changes: ${self.semanticChanges.length}`);
  }

  // 4. score: hard violations are expensive, cautions are cheap
  let local = 1 - 0.25 * violations.length - 0.06 * cautions.length;
  local = Math.max(0, Math.min(1, local));

  const selfScore = typeof self.intentFidelity === "number" && self.intentFidelity > 0
    ? self.intentFidelity : null;
  const score = selfScore === null ? local : Math.min(local, (local + selfScore) / 2);

  const verdict = score >= 0.9 ? "PASS" : score >= 0.75 ? "CAUTION" : "FAIL";
  return { score, verdict, violations, cautions };
}
