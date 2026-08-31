/* Unit tests — State Machine transitions & guards */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer, initialState } from "../src/state/machine.js";
import { act, ERR } from "../src/state/actions.js";

function run(actions, start = initialState) {
  return actions.reduce((s, a) => reducer(s, a), start);
}

test("window slice: hidden → expanded → minimized → expanded → hidden", () => {
  let s = run([act.openFloat()]);
  assert.equal(s.window, "expanded");
  s = run([act.minimizeFloat()], s);
  assert.equal(s.window, "minimized");
  assert.equal(s.prevWindow, "expanded");
  s = run([act.restoreFloat()], s);
  assert.equal(s.window, "expanded");
  s = run([act.closeFloat()], s);
  assert.equal(s.window, "hidden");
});

test("input: typing flips idle↔input, clearing flips back", () => {
  let s = run([act.updateInput("hello")]);
  assert.equal(s.interaction, "input");
  s = run([act.updateInput("")], s);
  assert.equal(s.interaction, "idle");
});

test("submit with empty input → EMPTY_INPUT error, stays idle", () => {
  const s = run([act.submitThought()]);
  assert.equal(s.interaction, "idle");
  assert.equal(s.error.code, ERR.EMPTY_INPUT);
});

test("full happy path: input → understanding → structuring → review", () => {
  let s = run([act.updateInput("I want to create a website"), act.submitThought()]);
  assert.equal(s.interaction, "understanding");
  assert.equal(s.session.rawThought, "I want to create a website");
  s = run([act.understandingStep(0), act.understandingStep(1), act.understandingStep(2)], s);
  assert.equal(s.understandStep, 2);
  const analysis = { prompt: { role: "Designer", objective: "X", context: "", requirements: ["a"], style: ["b"], output: "" }, detectedIntent: "website" };
  s = run([act.completeUnderstanding(analysis)], s);
  assert.equal(s.interaction, "structuring");
  s = run([act.structurePrompt(analysis.prompt)], s);
  assert.equal(s.interaction, "review");
  assert.equal(s.session.versions.length, 1);
  assert.equal(s.session.versions[0].version, 1);
  assert.equal(s.session.versions[0].source, "structured");
});

test("section selection moves with wrap-around", () => {
  let s = run([
    act.updateInput("make a website"), act.submitThought(),
    act.completeUnderstanding({ prompt: {}, detectedIntent: "website" }),
    act.structurePrompt({ role: "R", objective: "O", context: "", requirements: [], style: [], output: "" })
  ]);
  assert.equal(s.session.selectedSection, "role");
  s = run([act.moveSection(1)], s);
  assert.equal(s.session.selectedSection, "objective");
  s = run([act.moveSection(1)], s);
  assert.equal(s.session.selectedSection, "role"); // wrapped (only 2 visible)
  s = run([act.moveSection(-1)], s);
  assert.equal(s.session.selectedSection, "objective");
});

test("edit flow: start → save creates 'edited' version", () => {
  let s = run([
    act.updateInput("make a website"), act.submitThought(),
    act.completeUnderstanding({ prompt: {}, detectedIntent: "website" }),
    act.structurePrompt({ role: "R", objective: "O", context: "", requirements: [], style: [], output: "" }),
    act.selectSection("objective"),
    act.startEdit()
  ]);
  assert.equal(s.interaction, "editing");
  assert.equal(s.editingSection, "objective");
  s = run([act.saveEdit("objective", "Build something great")], s);
  assert.equal(s.interaction, "review");
  assert.equal(s.session.currentPrompt.objective, "Build something great");
  assert.equal(s.session.versions.length, 2);
  assert.equal(s.session.versions[1].source, "edited");
});

test("improve: request → success creates 'improved' version", () => {
  let s = run([
    act.updateInput("make a website"), act.submitThought(),
    act.completeUnderstanding({ prompt: {}, detectedIntent: "website" }),
    act.structurePrompt({ role: "R", objective: "O", context: "", requirements: [], style: [], output: "" }),
    act.improvePrompt()
  ]);
  assert.equal(s.interaction, "improving");
  s = run([act.improveSuccess({ role: "R", objective: "O2", context: "", requirements: [], style: [], output: "" })], s);
  assert.equal(s.interaction, "review");
  assert.equal(s.session.versions[1].source, "improved");
  assert.equal(s.session.currentPrompt.objective, "O2");
});

test("confirm chain: review → ready_to_send → sending → delivered", () => {
  let s = run([
    act.updateInput("x thought"), act.submitThought(),
    act.completeUnderstanding({ prompt: {}, detectedIntent: "general" }),
    act.structurePrompt({ role: "R", objective: "O", context: "", requirements: [], style: [], output: "" }),
    act.confirmPrompt()
  ]);
  assert.equal(s.interaction, "ready_to_send");
  s = run([act.sendPrompt()], s);
  assert.equal(s.interaction, "sending");
  s = run([act.deliveryComplete()], s);
  assert.equal(s.interaction, "delivered");
  s = run([act.newThought()], s);
  assert.equal(s.interaction, "idle");
  assert.equal(s.session, null);
});

test("ERROR action recovers to a stable interaction state", () => {
  let s = run([
    act.updateInput("x"), act.submitThought(),
    act.completeUnderstanding({ prompt: {}, detectedIntent: "g" }),
    act.structurePrompt({ role: "R", objective: "O", context: "", requirements: [], style: [], output: "" }),
    act.improvePrompt(),
    act.error(ERR.AI_ERROR, "Something interrupted the flow. Try again.")
  ]);
  assert.equal(s.interaction, "review");
  assert.equal(s.error.code, ERR.AI_ERROR);
});

test("voice slice: idle → listening → processing → idle; error recoverable", () => {
  let s = run([act.startVoice()]);
  assert.equal(s.voice, "listening");
  s = run([act.voiceTranscript("hello world", true)], s); // final transcript commits to input
  assert.equal(s.input, "hello world");
  s = run([act.stopVoice()], s);
  assert.equal(s.voice, "processing");
  s = run([act.voiceDone()], s);
  assert.equal(s.voice, "idle");
  s = run([act.startVoice(), act.voiceError(ERR.VOICE_UNAVAILABLE)], s);
  assert.equal(s.voice, "error");
  assert.equal(s.error.code, ERR.VOICE_UNAVAILABLE);
  s = run([act.startVoice()], s);
  assert.equal(s.voice, "listening");
});
