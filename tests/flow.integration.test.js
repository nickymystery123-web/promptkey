/* Integration tests — full flows through store + services (spec §22).
   Zero delays, in-memory storage, stub delivery. No DOM involved. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/state/store.js";
import { act, ERR } from "../src/state/actions.js";
import { createDemoAIProvider } from "../src/services/ai/demo-provider.js";
import { createFlows } from "../src/flows/prompt-flow.js";

const zeroDelays = {
  understandStep: 0, understandFirst: 0, structuringSettle: 0,
  readyToSend: 0, sending: 0, transcribing: 0
};

function harness() {
  const store = createStore();
  const ai = createDemoAIProvider({ latency: { analyze: 0, improve: 0, rewrite: 0 } });
  const saved = { sessions: [] };
  const storage = {
    saveSession: async (s) => { saved.sessions.push(s); },
    loadSession: async () => null,
    clearSession: async () => {},
    savePosition: async () => {},
    loadPosition: async () => null
  };
  const delivered = { calls: 0, copies: [] };
  const delivery = {
    deliver: async () => { delivered.calls++; return { ok: true, channel: "clipboard", prepared: true }; },
    copy: async (text) => { delivered.copies.push(text); }
  };
  const voice = {
    isAvailable: () => false,
    start: async () => {},
    stop: async () => {},
    abort: async () => {},
    onTranscript: () => {},
    onEnd: () => {},
    onError: () => {}
  };
  const flows = createFlows({ store, ai, voice, delivery, storage, delays: zeroDelays });
  return { store, ai, flows, saved, delivered };
}

test("Input → Understanding → Structured (review, v1)", async () => {
  const { store, flows } = harness();
  store.dispatch(act.updateInput("I want to create a premium AI product website"));
  await flows.submitThought();
  const s = store.getState();
  assert.equal(s.interaction, "review");
  assert.equal(s.session.versions.length, 1);
  assert.equal(s.session.structuredPrompt.role, "Senior Product Designer");
});

test("C1 → Improve → review with v2 'improved'", async () => {
  const { store, flows } = harness();
  store.dispatch(act.updateInput("create a website"));
  await flows.submitThought();
  await flows.improve();
  const s = store.getState();
  assert.equal(s.interaction, "review");
  assert.equal(s.session.versions.length, 2);
  assert.equal(s.session.versions[1].source, "improved");
  assert.ok(s.session.currentPrompt.objective.includes("with a clear structure"));
});

test("C2 → Rewrite → review with v3 'rewritten'", async () => {
  const { store, flows } = harness();
  store.dispatch(act.updateInput("create a website"));
  await flows.submitThought();
  await flows.improve();
  await flows.rewrite();
  const s = store.getState();
  assert.equal(s.session.versions.length, 3);
  assert.equal(s.session.versions[2].source, "rewritten");
  assert.ok(s.session.currentPrompt.objective.startsWith("Deliver "));
});

test("Confirm → Send → Delivered, then Copy and New Thought", async () => {
  const { store, flows, delivered } = harness();
  store.dispatch(act.updateInput("create a website"));
  await flows.submitThought();
  await flows.confirmAndSend();
  assert.equal(store.getState().interaction, "delivered");
  assert.equal(delivered.calls, 1);

  await flows.copyPrompt();
  assert.equal(delivered.copies.length, 1);
  assert.ok(delivered.copies[0].includes("ROLE:"));

  flows.newThought();
  const s = store.getState();
  assert.equal(s.interaction, "idle");
  assert.equal(s.session, null);
  assert.equal(s.input, "");
});

test("AI error during improve → AI_ERROR, stays in review, prompt intact", async () => {
  const { store, ai, flows } = harness();
  store.dispatch(act.updateInput("create a website"));
  await flows.submitThought();
  const before = store.getState().session.currentPrompt;
  ai.failNext();
  await flows.improve();
  const s = store.getState();
  assert.equal(s.interaction, "review");
  assert.equal(s.error.code, ERR.AI_ERROR);
  assert.deepEqual(s.session.currentPrompt, before); // untouched
});

test("empty submit → EMPTY_INPUT, no session created", async () => {
  const { store, flows } = harness();
  await flows.submitThought();
  const s = store.getState();
  assert.equal(s.interaction, "idle");
  assert.equal(s.error.code, ERR.EMPTY_INPUT);
  assert.equal(s.session, null);
});

test("voice unavailable → VOICE_UNAVAILABLE error state, app alive", async () => {
  const { store, flows } = harness();
  await flows.toggleVoice();
  const s = store.getState();
  assert.equal(s.voice, "error");
  assert.equal(s.error.code, ERR.VOICE_UNAVAILABLE);
  // still usable afterwards
  store.dispatch(act.updateInput("still works"));
  await flows.submitThought();
  assert.equal(store.getState().interaction, "review");
});

test("session persisted to storage after structuring", async () => {
  const { store, flows, saved } = harness();
  store.dispatch(act.updateInput("create a website"));
  await flows.submitThought();
  assert.equal(saved.sessions.length, 1);
  assert.equal(saved.sessions[0].rawThought, "create a website");
});
