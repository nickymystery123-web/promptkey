/* LLM-as-Judge (Phase 3B-3 §16) — OPTIONAL, evaluation-only.
   Explicitly NOT part of the default benchmark path:
   - rule-based + semantic fixture assertions are the primary evaluation
   - LLM Judge only provides a second opinion (--judge flag)
   - never modifies production results, never touches production logs
   - judge inputs are the benchmark's synthetic fixtures (no real user data)
   Interface reserved so a second model can be plugged in later. */

const JUDGE_PROMPT = `You are an impartial benchmark judge for a prompt-intelligence system.
Given the user's original input and the system's optimized output, rate each dimension 0..1.
Do not be lenient. Penalize any invented requirement or lost constraint.

Reply with ONLY JSON:
{
  "intentFidelity": number,
  "terminology": number,
  "constraints": number,
  "executability": number,
  "antiOverinterpretation": number,
  "verdict": "PASS"|"CAUTION"|"FAIL",
  "issues": [string]
}`;

export async function judgeCase(gateway, { id, input, expected }, result) {
  const delivered = [
    result.meta.optimizedPrompt,
    result.prompt.objective,
    result.prompt.context,
    ...(result.prompt.requirements || []),
    ...(result.prompt.style || []),
    result.prompt.output
  ].filter(Boolean).join("\n");

  const user = [
    `Benchmark case: ${id}`,
    `User input: ${JSON.stringify(input)}`,
    `Expected constraints: ${JSON.stringify((expected.constraints || []).map((c) => c.label))}`,
    `Forbidden inventions: ${JSON.stringify(expected.forbiddenInferences || [])}`,
    `Expected terminology corrections: ${JSON.stringify((expected.terminology || {}).correctCorrections || [])}`,
    `Forbidden terminology corrections: ${JSON.stringify((expected.terminology || {}).falseCorrections || [])}`,
    `System output:`,
    delivered
  ].join("\n");

  try {
    const raw = await gateway.chatJson({ system: JUDGE_PROMPT, user }, { requestId: `pk_judge_${id}`, route: "/benchmark/judge" });
    if (!raw || typeof raw !== "object") return { id, error: "judge returned non-object" };
    return {
      id,
      intentFidelity: clamp(raw.intentFidelity),
      terminology: clamp(raw.terminology),
      constraints: clamp(raw.constraints),
      executability: clamp(raw.executability),
      antiOverinterpretation: clamp(raw.antiOverinterpretation),
      verdict: ["PASS", "CAUTION", "FAIL"].includes(raw.verdict) ? raw.verdict : "CAUTION",
      issues: Array.isArray(raw.issues) ? raw.issues.filter((s) => typeof s === "string") : []
    };
  } catch (e) {
    return { id, error: `judge failed: ${e.message}` };
  }
}

function clamp(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}
