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
    loadPosition: async () => null,
    saveDraft: async () => {}, loadDraft: async () => null, clearDraft: async () => {},
    saveInbox: async () => {}, loadInbox: async () => [], clearInbox: async () => {}
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

test("Input → SUBMIT → Creative Inbox (3E simplified)", async () => {
  const { store, flows } = harness();
  store.dispatch(act.updateInput("I want to create a premium AI product website"));
  await flows.submitThought();
  const s = store.getState();
  assert.equal(s.interaction, "idle");
  assert.equal(s.inbox.thoughts.length, 1);
  assert.equal(s.inbox.thoughts[0].originalText, "I want to create a premium AI product website");
  assert.equal(s.input, "");
});

test("Input → REFINE → SUBMIT → Creative Inbox with refinedText", async () => {
  const { store, flows } = harness();
  store.dispatch(act.updateInput("create a website"));
  await flows.refineFromComposer();
  let s = store.getState();
  assert.equal(s.interaction, "input");
  assert.equal(s.input, "Create a website", "REFINE 写 Composer");
  assert.equal(s.inbox.thoughts.length, 0, "REFINE 本身不入箱");
  await flows.submitThought();
  s = store.getState();
  assert.equal(s.interaction, "idle");
  assert.equal(s.inbox.thoughts.length, 1);
  assert.equal(s.inbox.thoughts[0].originalText, "create a website");
  assert.ok(s.inbox.thoughts[0].refinedText);
  assert.equal(s.input, "");
});

test("SUBMIT → New Thought clears Composer and keeps Inbox", async () => {
  const { store, flows } = harness();
  store.dispatch(act.updateInput("create a website"));
  await flows.submitThought();
  assert.equal(store.getState().inbox.thoughts.length, 1);

  flows.newThought();
  const s = store.getState();
  assert.equal(s.interaction, "idle");
  assert.equal(s.session, null);
  assert.equal(s.input, "");
  assert.equal(s.inbox.thoughts.length, 1, "New Thought 不清空 Inbox");
});

test("empty submit → EMPTY_INPUT, no inbox thought created", async () => {
  const { store, flows } = harness();
  await flows.submitThought();
  const s = store.getState();
  assert.equal(s.interaction, "idle");
  assert.equal(s.error.code, ERR.EMPTY_INPUT);
  assert.equal(s.inbox.thoughts.length, 0);
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
  assert.equal(store.getState().interaction, "idle");
  assert.equal(store.getState().inbox.thoughts.length, 1);
});
