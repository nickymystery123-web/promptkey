/* Creative Inbox tests (Phase 3C-2A + 3C-2B, spec §8–§25).
   Covers: add/edit/delete/copy/expand-collapse/clear-all, original vs refined
   separation (refinement never overwrites originalText), 3C-2B entry policy
   (the ONLY way a Thought enters the inbox is REFINE — ADD routes capture into
   the Composer, voice is INPUT ONLY), USE take-back (no auto-submit), non-blocking
   local ops (inbox ops never call AI), and lifecycle (NEW_THOUGHT keeps the inbox,
   RESET clears it). Zero delays, controllable mock AI. No DOM. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/state/store.js";
import { act, ERR } from "../src/state/actions.js";
import { createFlows } from "../src/flows/prompt-flow.js";
import {
  inboxThoughts, inboxCount, inboxExpandedIds, isInboxExpanded
} from "../src/state/selectors.js";
import {
  createThought, withRefinedText, withOriginalText, thoughtCopyText, thoughtPreview
} from "../src/models/thought.js";

const zeroDelays = {
  understandStep: 0, understandFirst: 0, structuringSettle: 0,
  readyToSend: 0, sending: 0, transcribing: 0
};

async function tick(n = 8) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/* controllable mock AI — same shape as voice-loop.test.js */
function mockAI() {
  const calls = { analyze: 0, improve: 0, rewrite: 0 };
  const gates = [];
  let fail = 0;
  const api = {
    calls,
    lastOptions: null,
    hangNext() {
      const gate = {};
      gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
      gate.resolved = false;
      gates.push(gate);
    },
    releaseNext() {
      const gate = gates.find((g) => !g.resolved);
      if (gate) { gate.resolved = true; gate.resolve(); }
    },
    failNext() { fail++; },
    analyzePrompt(input, options = {}) {
      calls.analyze++;
      api.lastOptions = options;
      const respond = () => ({
        prompt: {
          role: "Expert Assistant",
          objective: "OPTIMIZED ▸ " + input,
          context: "",
          requirements: ["Clear"],
          style: ["Minimal"],
          output: ""
        },
        detectedIntent: "general"
      });
      if (fail > 0) {
        fail--;
        return Promise.reject(Object.assign(new Error("mock AI failure"), { code: "AI_ERROR" }));
      }
      const gate = gates.find((g) => !g.consumed);
      if (gate) { gate.consumed = true; return gate.promise.then(respond); }
      return Promise.resolve(respond());
    },
    async improvePrompt(p) { calls.improve++; return p; },
    async rewritePrompt(p) { calls.rewrite++; return p; }
  };
  return api;
}

function mockVoice() {
  const cbs = { transcript: () => {}, end: () => {}, error: () => {} };
  const calls = { start: 0, stop: 0, abort: 0 };
  return {
    calls,
    isAvailable() { return true; },
    async start() { calls.start++; },
    async stop() { calls.stop++; },
    async abort() { calls.abort++; },
    onTranscript(cb) { cbs.transcript = cb; },
    onEnd(cb) { cbs.end = cb; },
    onError(cb) { cbs.error = cb; },
    emitTranscript(text, isFinal) { cbs.transcript(text, isFinal); },
    emitEnd() { return cbs.end(); },
    emitError(code) { cbs.error(code); }
  };
}

function harness() {
  const store = createStore();
  const ai = mockAI();
  const voice = mockVoice();
  const storage = {
    saveSession: async () => {}, loadSession: async () => null, clearSession: async () => {},
    savePosition: async () => {}, loadPosition: async () => null
  };
  const delivered = { calls: 0, copies: [], prompts: [] };
  const delivery = {
    deliver: async (prompt) => { delivered.calls++; delivered.prompts.push(prompt); return { ok: true }; },
    copy: async (text) => { delivered.copies.push(text); }
  };
  const flows = createFlows({ store, ai, voice, delivery, storage, delays: zeroDelays });
  flows.bindVoiceCallbacks();
  return { store, ai, voice, flows, delivered };
}

/* ============ model-level: Thought semantics ============ */
test("thought: createThought keeps originalText byte-for-byte, refined separate, correct source", () => {
  const exact = "把 HT mail 页面改成深色, 别动 LOGO!!";
  const t = createThought(exact, "voice");
  assert.equal(t.originalText, exact);
  assert.equal(t.refinedText, null);
  assert.equal(t.source, "voice");
  assert.ok(t.id);
  assert.ok(t.createdAt);
  assert.equal(t.createdAt, t.updatedAt);
  const t2 = createThought("typed", "text");
  assert.equal(t2.source, "text");
});

test("thought: withRefinedText sets refined without touching original; empty refinement → null", () => {
  const t = createThought("orig", "text");
  const r = withRefinedText(t, "refined version");
  assert.equal(r.originalText, "orig");
  assert.equal(r.refinedText, "refined version");
  assert.ok(r.updatedAt >= r.createdAt || r.updatedAt >= t.updatedAt);
  assert.equal(withRefinedText(t, "  ").refinedText, null);
});

test("thought: withOriginalText edits original in place — same id, no new thought, other thoughts untouched", () => {
  const a = createThought("idea A", "text");
  const b = createThought("idea B", "text");
  const a2 = withOriginalText(a, "idea A edited");
  assert.equal(a2.id, a.id);
  assert.equal(a2.originalText, "idea A edited");
  assert.equal(a.originalText, "idea A"); // immutable: original object unchanged
  assert.equal(b.originalText, "idea B");
  assert.ok(a2.updatedAt >= a.updatedAt);
});

test("thought: thoughtCopyText prefers refined when variant=refined, else original", () => {
  const t = createThought("orig", "text");
  assert.equal(thoughtCopyText(t, "original"), "orig");
  assert.equal(thoughtCopyText(t, "refined"), "orig"); // no refined yet → original
  const r = withRefinedText(t, "refined");
  assert.equal(thoughtCopyText(r, "refined"), "refined");
  assert.equal(thoughtCopyText(r, "original"), "orig"); // original is never masked
});

test("thought: thoughtPreview summarizes long thoughts, passes short ones through", () => {
  const long = Array.from({ length: 200 }, (_, i) => "w" + i).join(" ");
  const t = createThought(long, "text");
  const preview = thoughtPreview(t, 128);
  assert.match(preview, /…$/);
  assert.ok(preview.length < long.length);
  const short = createThought("short thought", "text");
  assert.equal(thoughtPreview(short, 128), "short thought");
});

/* ============ N. ADD places capture into the Composer (3C-2B) ============ */
test("N: ADD routes capture text into the Composer — it does NOT create an inbox Thought; REFINE is the only inbox entry", async () => {
  const h = harness();
  h.store.dispatch(act.inboxUpdateDraft("landing page idea"));
  await h.flows.addThoughtFromInbox();
  await tick();
  const s = h.store.getState();
  assert.equal(s.inbox.thoughts.length, 0); // no inbox Thought created by ADD
  assert.equal(s.input, "landing page idea"); // capture placed into the Composer
  assert.equal(s.inbox.draft, ""); // capture field consumed
  assert.equal(h.ai.calls.analyze, 0); // ADD never calls AI
  assert.match(s.message.text, /Added to your prompt/);
});

test("N2: empty draft add is a no-op (nothing placed, no AI)", async () => {
  const h = harness();
  h.store.dispatch(act.inboxUpdateDraft("   "));
  await h.flows.addThoughtFromInbox();
  await tick();
  assert.equal(h.store.getState().inbox.thoughts.length, 0);
  assert.equal(h.store.getState().input, "");
  assert.equal(h.ai.calls.analyze, 0);
});

/* ============ O. Edit ============ */
test("O: editing a thought rewrites originalText in place, keeps id/source/refined", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("original idea", "text"));
  const id = h.store.getState().inbox.thoughts[0].id;
  h.store.dispatch(act.inboxEdit(id, "edited idea"));
  const s = h.store.getState();
  assert.equal(s.inbox.thoughts.length, 1);
  assert.equal(s.inbox.thoughts[0].id, id);
  assert.equal(s.inbox.thoughts[0].originalText, "edited idea");
});

/* ============ P. Delete ============ */
test("P: deleting a thought removes it and its expanded marker", () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("one", "text"));
  h.store.dispatch(act.inboxAddRefined("two", "text"));
  const [a, b] = h.store.getState().inbox.thoughts;
  h.store.dispatch(act.inboxToggleExpanded(a.id));
  assert.equal(isInboxExpanded(h.store.getState(), a.id), true);
  h.store.dispatch(act.inboxDelete(a.id));
  const s = h.store.getState();
  assert.deepEqual(s.inbox.thoughts.map((t) => t.id), [b.id]);
  assert.deepEqual(s.inbox.expandedIds, []); // marker cleaned up
});

/* ============ Q. Copy ============ */
test("Q: copy uses refined text when requested, original otherwise", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("idea", "text"));
  const id = h.store.getState().inbox.thoughts[0].id;
  h.store.dispatch(act.inboxRefine(id, "refined idea"));
  await h.flows.copyThoughtToClipboard(id, "refined");
  assert.equal(h.delivered.copies.at(-1), "refined idea");
  await h.flows.copyThoughtToClipboard(id, "original");
  assert.equal(h.delivered.copies.at(-1), "idea");
});

/* ============ R. Expand / collapse ============ */
test("R: toggle expand is a pure local flip, never touches AI", () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("long " + "x".repeat(300), "text"));
  const id = h.store.getState().inbox.thoughts[0].id;
  h.store.dispatch(act.inboxToggleExpanded(id));
  assert.equal(isInboxExpanded(h.store.getState(), id), true);
  h.store.dispatch(act.inboxToggleExpanded(id));
  assert.equal(isInboxExpanded(h.store.getState(), id), false);
  assert.equal(h.ai.calls.analyze, 0);
});

/* ============ S. Clear all ============ */
test("S: clear all empties thoughts and expanded markers but keeps the draft", () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("a", "text"));
  h.store.dispatch(act.inboxAddRefined("b", "text"));
  h.store.dispatch(act.inboxUpdateDraft("still typing…"));
  const s = h.store.getState();
  const id = s.inbox.thoughts[0].id;
  h.store.dispatch(act.inboxToggleExpanded(id));
  h.store.dispatch(act.inboxClearAll());
  const after = h.store.getState();
  assert.deepEqual(after.inbox.thoughts, []);
  assert.deepEqual(after.inbox.expandedIds, []);
  assert.equal(after.inbox.draft, "still typing…"); // draft preserved
});

/* ============ T. Voice final → Composer, not inbox (3C-2B) ============ */
test("T: voice stop appends to the Composer and never creates an inbox Thought; text+voice share the same input model", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("typed idea", "text")); // inbox seeded via REFINE-path
  await h.flows.toggleVoice();
  h.voice.emitTranscript("spoken idea", true);
  await h.voice.emitEnd();
  await tick();
  const s = h.store.getState();
  assert.equal(s.inbox.thoughts.length, 1); // voice stop did NOT append a Thought
  assert.equal(s.input, "spoken idea"); // final appended to the Composer
  assert.equal(h.ai.calls.analyze, 0); // voice commit itself never auto-AI
});

/* ============ U. USE takes a thought back into the Composer (3C-2B) ============ */
test("U: USE brings a thought back into the Composer — no auto-submit; manual submit saves it to the Inbox (3E simplified)", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("idea", "text"));
  const id = h.store.getState().inbox.thoughts[0].id;
  h.store.dispatch(act.inboxRefine(id, "refined idea"));
  await h.flows.sendThoughtToPrompt(id);
  const s0 = h.store.getState();
  assert.equal(s0.interaction, "input"); // USE does NOT auto-submit
  assert.equal(s0.input, "refined idea"); // refined text taken back (thoughtCopyText refFirst)
  assert.equal(h.ai.calls.analyze, 0);
  await h.flows.submitThought();
  await tick();
  const s = h.store.getState();
  assert.equal(s.interaction, "idle"); // 3E SUBMIT goes straight to idle
  assert.equal(s.session, null); // no old pipeline session
  assert.equal(s.inbox.thoughts.length, 2); // original thought + new submitted thought
  assert.equal(s.inbox.thoughts[1].originalText, "refined idea");
});

test("U2: USE does not re-refine the thought (no AI on take-back; 3E SUBMIT also calls no AI)", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("idea", "text"));
  const id = h.store.getState().inbox.thoughts[0].id;
  await h.flows.sendThoughtToPrompt(id);
  assert.equal(h.ai.calls.analyze, 0); // USE itself never calls AI
  await h.flows.submitThought();
  await tick();
  assert.equal(h.ai.calls.analyze, 0); // 3E SUBMIT stores the words directly, no AI
});

test("U3: refinement failure is best-effort — no half-baked Thought is ever created", async () => {
  const h = harness();
  h.ai.failNext();
  h.store.dispatch(act.updateInput("fragile idea"));
  await h.flows.refineFromComposer(); // AI fails
  await tick();
  const s = h.store.getState();
  assert.equal(s.inbox.thoughts.length, 0); // AI failure → no Thought at all
  assert.equal(s.input, "fragile idea"); // Composer text never lost
  assert.match(s.toast.text, /REFINE UNAVAILABLE/);
});

/* ============ V. Non-blocking: inbox ops never block on AI ============ */
test("V: local inbox ops are synchronous — no AI, no async gate, even while an AI refine hangs; no half-baked Thought mid-flight", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("seeded idea", "text")); // existing thought
  h.ai.hangNext(); // a REFINE will hang forever until released
  h.store.dispatch(act.updateInput("hanging idea"));
  const p = h.flows.refineFromComposer(); // async refine that hangs
  await tick();
  // 3E: while the refine is in flight, NO new Thought exists yet (created only
  // after SUBMIT) — and local ops on existing thoughts stay instant.
  const mid = h.store.getState();
  assert.equal(mid.inbox.thoughts.length, 1); // no half-baked Thought mid-flight
  assert.equal(mid.input, "hanging idea"); // Composer text never lost
  const seededId = mid.inbox.thoughts[0].id;
  h.store.dispatch(act.inboxEdit(seededId, "seeded idea v2"));
  h.store.dispatch(act.inboxToggleExpanded(seededId));
  let s = h.store.getState();
  assert.equal(s.inbox.thoughts.length, 1);
  assert.equal(s.inbox.thoughts[0].originalText, "seeded idea v2");
  assert.equal(isInboxExpanded(s, seededId), true);
  // the hung refinement never blocked any of the above (they returned immediately)
  h.ai.releaseNext();
  await p; // now the refine resolves → writes optimized text to Composer
  await tick();
  s = h.store.getState();
  assert.equal(s.input, "OPTIMIZED ▸ hanging idea", "REFINE 结果写入 Composer");
  assert.equal(s.inbox.thoughts.length, 1, "REFINE 本身不入箱");
  await h.flows.submitThought();
  await tick();
  s = h.store.getState();
  assert.equal(s.inbox.thoughts.length, 2);
  assert.equal(s.inbox.thoughts[1].originalText, "hanging idea");
  assert.equal(s.inbox.thoughts[1].refinedText, "OPTIMIZED ▸ hanging idea");
});

/* ============ W. REFINE adds exactly one thought per call ============ */
test("W: REFINE → SUBMIT creates exactly one Thought per successful refine, with originalText = user's words and refinedText = AI output", async () => {
  const h = harness();
  h.store.dispatch(act.updateInput("one"));
  await h.flows.refineFromComposer();
  await tick();
  await h.flows.submitThought();
  await tick();
  h.store.dispatch(act.updateInput("two"));
  await h.flows.refineFromComposer();
  await tick();
  await h.flows.submitThought();
  await tick();
  const s = h.store.getState();
  assert.equal(s.inbox.thoughts.length, 2);
  assert.equal(h.ai.calls.analyze, 2); // one refine per REFINE tap
  const [one, two] = s.inbox.thoughts;
  assert.equal(one.originalText, "one"); // user's exact words preserved
  assert.equal(one.refinedText, "OPTIMIZED ▸ one"); // AI output attached as refined
  assert.equal(two.originalText, "two");
  assert.equal(two.refinedText, "OPTIMIZED ▸ two");
});

/* ============ X. Lifecycle: NEW_THOUGHT keeps inbox, RESET clears it ============ */
test("X: NEW_THOUGHT keeps inbox thoughts & expansion; RESET clears the whole inbox", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("keep me", "text"));
  const id = h.store.getState().inbox.thoughts[0].id;
  h.store.dispatch(act.inboxToggleExpanded(id));

  // submit a thought, then start a new thought
  h.store.dispatch(act.updateInput("another idea"));
  await h.flows.submitThought();
  await tick();
  assert.equal(h.store.getState().inbox.thoughts.length, 2);
  h.flows.newThought();
  let s = h.store.getState();
  assert.equal(s.interaction, "idle");
  assert.equal(s.session, null);
  assert.equal(s.inbox.thoughts.length, 2); // inbox survives
  assert.equal(isInboxExpanded(s, id), true); // expansion survives

  // full reset clears everything
  h.store.dispatch(act.reset());
  s = h.store.getState();
  assert.deepEqual(s.inbox.thoughts, []);
  assert.deepEqual(s.inbox.expandedIds, []);
  assert.equal(s.inbox.draft, "");
});

/* ============ Y. USE leaves the thought intact ============ */
test("Y: using a thought (taking it back to the Composer) does not consume/delete it", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("idea", "text"));
  const id = h.store.getState().inbox.thoughts[0].id;
  await h.flows.sendThoughtToPrompt(id);
  await tick();
  const s = h.store.getState();
  assert.equal(s.interaction, "input"); // no auto-submit — user stays in control
  assert.equal(inboxCount(s), 1); // thought untouched
  assert.equal(inboxThoughts(s)[0].id, id);
});

/* ============ Z. Voice-origin thought: source flows through USE → pipeline ============ */
test("Z: voice-origin thought taken back via USE preserves origin in the Composer", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("spoken plan", "voice"));
  const id = h.store.getState().inbox.thoughts[0].id;
  await h.flows.sendThoughtToPrompt(id); // USE
  const s0 = h.store.getState();
  assert.equal(s0.inputOrigin, "thought"); // USE writes with thought provenance
  assert.equal(s0.input, "spoken plan");
  await h.flows.submitThought(); // manual submit
  await tick();
  const s = h.store.getState();
  assert.equal(s.interaction, "idle"); // 3E SUBMIT goes straight to idle
  assert.equal(h.ai.calls.analyze, 0); // no AI on submit
  assert.equal(s.inbox.thoughts.length, 2);
  assert.equal(s.inbox.thoughts[1].originalText, "spoken plan");
});

/* ============ ZB. Empty-voice stop does not add a thought ============ */
test("ZB: stopping with no final transcript adds nothing and shows a gentle hint", async () => {
  const h = harness();
  await h.flows.toggleVoice();
  await h.voice.emitEnd();
  await tick();
  const s = h.store.getState();
  assert.equal(s.voice, "idle");
  assert.equal(s.inbox.thoughts.length, 0);
  assert.match(s.message.text, /Didn't catch that/);
});

/* ============ ZC. Voice cancel leaves the Composer & inbox untouched ============ */
test("ZC: cancelling a voice session never saves anything to the inbox and restores the pre-voice draft", async () => {
  const h = harness();
  h.store.dispatch(act.inboxAddRefined("existing", "text"));
  h.store.dispatch(act.updateInput("typed draft"));
  await h.flows.toggleVoice();
  h.voice.emitTranscript("discard me", true);
  await h.flows.cancelVoice();
  const s = h.store.getState();
  assert.equal(s.inbox.thoughts.length, 1); // nothing appended
  assert.equal(s.inbox.thoughts[0].originalText, "existing");
  assert.equal(s.input, "typed draft"); // pre-voice draft restored
  assert.equal(s.voice, "idle");
});
