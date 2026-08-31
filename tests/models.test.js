/* Unit tests — models (prompt / version / session) & selectors */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createStructuredPrompt, visibleSectionKeys, promptToText,
  textToSectionValue, isValidPrompt, SECTION_ORDER
} from "../src/models/prompt.js";
import { createVersion, nextVersionNumber } from "../src/models/version.js";
import { createSession, applyVersion } from "../src/models/session.js";
import { effectiveStatus, statusLabel, canConfirm, confirmEnabled, customButtonsEnabled } from "../src/state/selectors.js";
import { initialState } from "../src/state/machine.js";

test("createStructuredPrompt normalizes missing/wrong fields", () => {
  const p = createStructuredPrompt({ role: "R", requirements: "nope" });
  assert.equal(p.role, "R");
  assert.deepEqual(p.requirements, []);
  assert.equal(p.objective, "");
  assert.ok(isValidPrompt(p));
});

test("visibleSectionKeys skips empty fields, keeps order", () => {
  const p = createStructuredPrompt({ role: "R", style: ["Minimal"], output: "" });
  assert.deepEqual(visibleSectionKeys(p), ["role", "style"]);
  assert.deepEqual(visibleSectionKeys(createStructuredPrompt({})), []);
});

test("textToSectionValue: arrays split per line, strings trimmed", () => {
  assert.deepEqual(textToSectionValue("requirements", "a\n- b\n"), ["a", "b"]);
  assert.equal(textToSectionValue("objective", "  hi "), "hi");
});

test("promptToText renders labeled sections", () => {
  const p = createStructuredPrompt({ role: "Designer", style: ["Minimal", "Calm"] });
  const text = promptToText(p);
  assert.ok(text.includes("ROLE: Designer"));
  assert.ok(text.includes("STYLE:\n- Minimal\n- Calm"));
});

test("version numbering increments", () => {
  const v1 = createVersion(createStructuredPrompt({}), "structured", 1, 1000);
  assert.equal(v1.version, 1);
  assert.equal(nextVersionNumber([v1]), 2);
  assert.equal(nextVersionNumber([]), 1);
});

test("session: applyVersion chains structured→improved→rewritten as v1→v2→v3", () => {
  let s = createSession("thought", 1000);
  s = applyVersion(s, createStructuredPrompt({ role: "R" }), "structured", 1001);
  s = applyVersion(s, createStructuredPrompt({ role: "R2" }), "improved", 1002);
  s = applyVersion(s, createStructuredPrompt({ role: "R3" }), "rewritten", 1003);
  assert.equal(s.versions.length, 3);
  assert.deepEqual(s.versions.map((v) => v.source), ["structured", "improved", "rewritten"]);
  assert.equal(s.currentPrompt.role, "R3");
  assert.equal(s.structuredPrompt.role, "R"); // v1 preserved
  assert.ok(s.updatedAt >= s.createdAt);
});

test("selectors: voice overrides interaction for status display", () => {
  const s = { ...initialState, interaction: "input", voice: "listening" };
  assert.equal(effectiveStatus(s), "listening");
  assert.equal(statusLabel(s), "LISTENING");
  const s2 = { ...initialState, interaction: "input", voice: "processing" };
  assert.equal(effectiveStatus(s2), "transcribing");
});

test("selectors: confirm gating", () => {
  assert.equal(canConfirm({ ...initialState, interaction: "idle", input: "" }), false);
  assert.equal(canConfirm({ ...initialState, interaction: "input", input: "hi" }), true);
  assert.equal(confirmEnabled({ ...initialState, interaction: "idle", input: "" }), true); // clickable to show hint
  assert.equal(confirmEnabled({ ...initialState, interaction: "understanding" }), false);
  assert.equal(customButtonsEnabled({ ...initialState, interaction: "review", session: null }), false);
});
