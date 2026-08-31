/* PK-05 Prompt Structurer — intent → StructuredPrompt (six fields).
   PK-06 Optimizer — local polish: dedupe, trim, constraint-first ordering.
   Never mechanical templates: simple tasks stay simple (spec §21–§24). */

import { createStructuredPrompt } from "../../../../src/models/prompt.js";

export function structureFromIntent(intent) {
  const objective = intent.goal[0]
    || [intent.task !== "general" ? intent.task.replace(/_/g, " ") : "", intent.object].filter(Boolean).join(": ")
    || "";
  return createStructuredPrompt({
    role: "",
    objective,
    context: intent.context.join("；"),
    // constraints are high-priority information — always preserved (spec §26)
    requirements: [...intent.requirements, ...intent.constraints],
    style: intent.preferences,
    output: intent.expectedOutput || ""
  });
}

/* Conservative fallback when fidelity FAILS: structure the user's own
   (normalized) words instead of the model's over-reach (spec §33). */
export function structureFromRaw(normalizedInput) {
  return createStructuredPrompt({
    role: "",
    objective: normalizedInput,
    context: "",
    requirements: [],
    style: [],
    output: ""
  });
}

export function optimizeStructured(prompt) {
  const dedupe = (arr) => Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
  const p = createStructuredPrompt({
    role: prompt.role.trim(),
    objective: prompt.objective.trim(),
    context: prompt.context.trim(),
    requirements: dedupe(prompt.requirements),
    style: dedupe(prompt.style),
    output: prompt.output.trim()
  });
  return p;
}
