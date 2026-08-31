/* StructuredPrompt model — schema locked by PRD (开发提示词 §23):
   { role, objective, context, requirements[], style[], output }
   Fields may be empty; requirements & style are arrays. */

export const SECTION_ORDER = ["role", "objective", "context", "requirements", "style", "output"];

export const SECTION_NAMES = {
  role: "ROLE",
  objective: "OBJECTIVE",
  context: "CONTEXT",
  requirements: "REQUIREMENTS",
  style: "STYLE",
  output: "OUTPUT"
};

export function createStructuredPrompt(partial = {}) {
  return {
    role: typeof partial.role === "string" ? partial.role : "",
    objective: typeof partial.objective === "string" ? partial.objective : "",
    context: typeof partial.context === "string" ? partial.context : "",
    requirements: Array.isArray(partial.requirements) ? partial.requirements.slice() : [],
    style: Array.isArray(partial.style) ? partial.style.slice() : [],
    output: typeof partial.output === "string" ? partial.output : ""
  };
}

export function clonePrompt(p) {
  return createStructuredPrompt(p);
}

/* Keys that currently hold visible content (arrays non-empty / strings non-blank) */
export function visibleSectionKeys(p) {
  if (!p) return [];
  return SECTION_ORDER.filter((k) => {
    const v = p[k];
    return (Array.isArray(v) && v.length > 0) || (typeof v === "string" && v.trim() !== "");
  });
}

/* Arrays are edited as one-item-per-line text; parse back on save */
export function sectionToText(p, key) {
  const v = p[key];
  return Array.isArray(v) ? v.join("\n") : v || "";
}

export function textToSectionValue(key, text) {
  const trimmed = (text || "").trim();
  if (key === "requirements" || key === "style") {
    return trimmed
      ? trimmed.split("\n").map((s) => s.replace(/^[-•]\s*/, "").trim()).filter(Boolean)
      : [];
  }
  return trimmed;
}

export function promptToText(p) {
  const lines = [];
  SECTION_ORDER.forEach((k) => {
    const v = p[k];
    if (Array.isArray(v) && v.length) {
      lines.push(SECTION_NAMES[k] + ":");
      v.forEach((item) => lines.push("- " + item));
      lines.push("");
    } else if (typeof v === "string" && v.trim()) {
      lines.push(SECTION_NAMES[k] + ": " + v.trim());
      lines.push("");
    }
  });
  return lines.join("\n").trim();
}

/* Schema guard used by services & tests */
export function isValidPrompt(p) {
  return (
    !!p &&
    typeof p.role === "string" &&
    typeof p.objective === "string" &&
    typeof p.context === "string" &&
    Array.isArray(p.requirements) &&
    Array.isArray(p.style) &&
    typeof p.output === "string"
  );
}
