/* PK-04 Context Resolver (spec §18–§20).
   Context may ONLY: resolve references / complete omissions /
   resolve terminology / maintain task continuity. Never to invent. */

import { hasContextReference } from "./intent.js";

/* Decide whether the supplied context is even relevant to this input.
   Irrelevant context is dropped entirely (spec §20). */
export function resolveContext(input, context) {
  const empty = { used: false, summary: null };
  if (!context) return empty;
  const hasContext = context.currentTask || (context.recentInputs && context.recentInputs.length);
  if (!hasContext) return empty;

  // Only engage context when the input actually references it
  if (!hasContextReference(input)) return empty;

  const parts = [];
  if (context.currentTask) parts.push(`current task: ${context.currentTask}`);
  if (context.recentInputs && context.recentInputs.length) {
    parts.push(`recent inputs: ${context.recentInputs.join(" | ")}`);
  }
  return { used: true, summary: parts.join("; ") };
}
