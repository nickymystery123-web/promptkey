/* PK-08 Evaluator (spec §34).
   qualityScore = 0.40·fidelity + 0.20·clarity + 0.20·specificity + 0.20·executability */

const VAGUE_TOKENS = ["弄一下", "搞一下", "东西", "something", "stuff", "thing", "whatever", "啥的"];

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

export function evaluateQuality({ optimizedText, structured, fidelityScore }) {
  const text = optimizedText || "";
  const lower = text.toLowerCase();

  // clarity: penalize vague tokens; reward sane length
  const vagueCount = VAGUE_TOKENS.filter((t) => lower.includes(t)).length;
  const lenScore = text.length >= 15 && text.length <= 600 ? 1 : text.length < 15 ? 0.6 : 0.8;
  const clarity = clamp01(lenScore - 0.2 * vagueCount);

  // specificity: concrete requirements/constraints/output present
  let specificity = 0.4;
  if (structured.requirements.length) specificity += 0.25;
  if (structured.context) specificity += 0.15;
  if (structured.output) specificity += 0.2;
  specificity = clamp01(specificity);

  // executability: clear objective with an action verb
  const hasVerb = /(create|design|write|build|analyze|translate|plan|check|fix|生成|创建|设计|写|规划|分析|翻译|检查|修复|优化|做|查)/i.test(structured.objective);
  const executability = clamp01((structured.objective ? 0.5 : 0) + (hasVerb ? 0.5 : 0.2));

  const qualityScore = clamp01(
    0.4 * fidelityScore + 0.2 * clarity + 0.2 * specificity + 0.2 * executability
  );

  return {
    intentFidelity: fidelityScore,
    clarity: Number(clarity.toFixed(3)),
    specificity: Number(specificity.toFixed(3)),
    executability: Number(executability.toFixed(3)),
    qualityScore: Number(qualityScore.toFixed(3))
  };
}
