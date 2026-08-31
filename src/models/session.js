/* PromptSession — one "thought → structured prompt" lifecycle. */

import { createVersion, nextVersionNumber } from "./version.js";

let counter = 0;

export function createSession(rawThought, now) {
  counter += 1;
  const t = now || Date.now();
  return {
    id: "ps-" + t.toString(36) + "-" + counter,
    rawThought,
    analysis: null,
    structuredPrompt: null, // first AI output (v1)
    currentPrompt: null,    // head of the version chain
    versions: [],
    selection: "optimized", // "original" (exact user words) | "optimized" (Prompt Intelligence)
    selectedSection: null,  // section key, e.g. "objective"
    createdAt: new Date(t).toISOString(),
    updatedAt: new Date(t).toISOString()
  };
}

export function touch(session, now) {
  return { ...session, updatedAt: new Date(now || Date.now()).toISOString() };
}

export function withAnalysis(session, analysis, now) {
  return touch({ ...session, analysis }, now);
}

/* Apply a new prompt as a new version (source: structured|edited|improved|rewritten) */
export function applyVersion(session, prompt, source, now) {
  const version = createVersion(prompt, source, nextVersionNumber(session.versions), now);
  const next = {
    ...session,
    currentPrompt: prompt,
    versions: session.versions.concat(version)
  };
  if (source === "structured") next.structuredPrompt = prompt;
  if (!next.selectedSection && session.versions.length === 0) next.selectedSection = "role";
  return touch(next, now);
}

export function withSelectedSection(session, key, now) {
  return touch({ ...session, selectedSection: key }, now);
}

/* Which version the user will send: their exact words or the optimized prompt.
   Never mutates rawThought and never touches the version chain. */
export function withSelection(session, selection, now) {
  return touch({ ...session, selection }, now);
}
