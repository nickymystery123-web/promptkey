/* Unit tests — State Machine transitions & guards */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer, initialState } from "../src/state/machine.js";
import { act, ERR } from "../src/state/actions.js";

function run(actions, start = initialState) {
  return actions.reduce((s, a) => reducer(s, a), start);
}

test("window slice: hidden → expanded → minimized → expanded → × collapses to Orb (3D-RC2 GATE C)", () => {
  let s = run([act.openFloat()]);
  assert.equal(s.window, "expanded");
  s = run([act.minimizeFloat()], s);
  assert.equal(s.window, "minimized");
  assert.equal(s.prevWindow, "expanded");
  s = run([act.restoreFloat()], s);
  assert.equal(s.window, "expanded");
  // × is a COLLAPSE, not an exit — the Float shrinks to the Orb on the desktop.
  s = run([act.closeFloat()], s);
  assert.equal(s.window, "minimized");
  // CLOSE also tears down the voice slice (Bug #10 invariant) even as it collapses.
  s = run([act.startVoice(), act.closeFloat()], s);
  assert.equal(s.window, "minimized");
  assert.equal(s.voice, "idle");
  s = run([act.restoreFloat()], s);
  assert.equal(s.window, "expanded");
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
