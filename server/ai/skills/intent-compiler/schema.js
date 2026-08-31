/* Intent Compiler — input/output schemas (spec §4, §37).
   LLM output is UNTRUSTED INPUT: parse → validate → coerce → only then use. */

import { createStructuredPrompt, isValidPrompt } from "../../../../src/models/prompt.js";

export const INPUT_SOURCES = ["voice", "text"];
export const COMPILER_MODES = ["quick", "deep"];

export function parseCompilerInput(raw = {}) {
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) throw new Error("Compiler input requires non-empty text");
  return {
    text,
    rawInput: text, // §5: rawInput is immutable, always preserved
    inputSource: INPUT_SOURCES.includes(raw.inputSource) ? raw.inputSource : "text",
    mode: COMPILER_MODES.includes(raw.mode) ? raw.mode : "quick",
    context: raw.context && typeof raw.context === "object"
      ? {
          recentInputs: Array.isArray(raw.context.recentInputs) ? raw.context.recentInputs.slice(-5) : [],
          currentTask: typeof raw.context.currentTask === "string" ? raw.context.currentTask : null,
          activeDocument: raw.context.activeDocument ?? null
        }
      : { recentInputs: [], currentTask: null, activeDocument: null }
  };
}

const asStr = (v) => (typeof v === "string" ? v : "");
const asArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
const asConf = (v) => (typeof v === "number" && v >= 0 && v <= 1 ? v : 0);

export function sanitizeIntent(v = {}) {
  return {
    task: asStr(v.task) || "general",
    object: asStr(v.object),
    goal: asArr(v.goal),
    context: asArr(v.context),
    requirements: asArr(v.requirements),
    constraints: asArr(v.constraints),
    preferences: asArr(v.preferences),
    expectedOutput: asStr(v.expectedOutput) || null,
    subtasks: asArr(v.subtasks)
  };
}

export function sanitizeCorrections(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((c) => c && typeof c.original === "string" && typeof c.corrected === "string")
    .map((c) => ({
      original: c.original,
      corrected: c.corrected,
      confidence: asConf(c.confidence),
      reason: asStr(c.reason) || "contextual match"
    }));
}

export function sanitizeUncertainties(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((u) => u && typeof u === "object")
    .map((u) => ({
      type: asStr(u.type) || "unknown",
      original: asStr(u.original),
      candidates: asArr(u.candidates),
      confidence: asConf(u.confidence)
    }));
}

export function sanitizeFidelity(v = {}) {
  return {
    intentFidelity: asConf(v.intentFidelity),
    semanticChanges: asArr(v.semanticChanges),
    addedAssumptions: asArr(v.addedAssumptions),
    removedRequirements: asArr(v.removedRequirements)
  };
}

/* Validate + coerce the rich analyze JSON from the model. Throws on hard failure. */
export function sanitizeAnalyzeOutput(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Compiler output is not an object");
  const intent = sanitizeIntent(raw.intent);
  let structured = raw.structured && isValidPrompt(raw.structured)
    ? createStructuredPrompt(raw.structured)
    : null;
  return {
    correctedInput: asStr(raw.correctedInput),
    corrections: sanitizeCorrections(raw.corrections),
    intent,
    inferredIntent: asArr(raw.inferredIntent),
    aiSuggestions: asArr(raw.aiSuggestions),
    uncertainties: sanitizeUncertainties(raw.uncertainties),
    optimizedPrompt: asStr(raw.optimizedPrompt),
    structured, // may be null → caller falls back to local structuring
    fidelity: sanitizeFidelity(raw.fidelity)
  };
}

/* improve/rewrite model output */
export function sanitizeTransformOutput(raw) {
  if (!raw || typeof raw !== "object" || !isValidPrompt(raw.prompt)) {
    throw new Error("Transform output missing valid prompt");
  }
  return {
    prompt: createStructuredPrompt(raw.prompt),
    changes: asArr(raw.changes),
    fidelity: sanitizeFidelity(raw.fidelity)
  };
}
