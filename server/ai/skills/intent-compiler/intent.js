/* PK-03 Intent constants (spec §13/§14) + PK-04 reference detection helpers */

export const INTENT_TASKS = [
  "writing", "rewriting", "editing", "summarization", "translation",
  "coding", "debugging", "ui_design", "product_design", "data_analysis",
  "research", "presentation", "planning", "brainstorming",
  "image_generation", "multi_step", "general"
];

export function isKnownTask(task) {
  return INTENT_TASKS.includes(task);
}

/* PK-04 — context-dependent expressions (spec §18) */
const REFERENCE_PATTERN = /(刚才|刚刚|之前|上面|它|这个|那个|再|继续|换一种|再来|还)/;

export function hasContextReference(text) {
  return REFERENCE_PATTERN.test(text);
}
