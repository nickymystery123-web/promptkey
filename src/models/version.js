/* PromptVersion — every meaningful change to the prompt is a version.
   structured = v1, Improve = v2, Rewrite = v3 ... enables future Undo/Restore. */

let counter = 0;

export function createVersion(prompt, source, version, now) {
  counter += 1;
  return {
    id: "pv-" + (now || Date.now()).toString(36) + "-" + counter,
    version,
    prompt,
    source, // "structured" | "edited" | "improved" | "rewritten"
    createdAt: new Date(now || Date.now()).toISOString()
  };
}

export function nextVersionNumber(versions) {
  return versions.length ? versions[versions.length - 1].version + 1 : 1;
}
