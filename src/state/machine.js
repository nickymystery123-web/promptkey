/* State Machine — the only place state transitions are decided.
   Three independent slices (spec §5):
     interaction: idle|input|understanding|structuring|review|editing|
                  improving|rewriting|ready_to_send|sending|delivered
     window:      hidden|launcher|expanded|focus|minimized
     voice:       idle|listening|processing|error
   Plus data slices: input draft, session, understandStep, error, feedback. */

import * as A from "./actions.js";
import { createStructuredPrompt, clonePrompt, visibleSectionKeys, textToSectionValue } from "../models/prompt.js";
import { createSession, withAnalysis, applyVersion, withSelectedSection, withSelection } from "../models/session.js";
import { createThought, withOriginalText } from "../models/thought.js";

export const initialState = {
  interaction: "idle",
  window: "hidden",
  prevWindow: "expanded",
  voice: "idle",
  voiceTranscript: null, // { text, final } — live preview while listening; never sent to AI until final
  preVoiceInput: null,   // input draft before the voice session (restored on cancel)
  input: "",
  session: null,
  inbox: {
    thoughts: [],     // Thought[] — independent of session (see models/thought.js)
    draft: "",        // "What are you thinking about?" textarea draft
    expandedIds: [],  // ids of cards currently expanded (long-text overflow)
    open: false       // panel open/collapsed (renderer reads this; not per-session)
  },
  editingSection: null, // section key being edited, null when not editing
  understandStep: -1,   // -1 none, 0..2 line active, 3 all done
  error: null,          // { code, message } | null
  message: null,        // { text, ts } workspace transient message
  toast: null,          // { text, ts }
  position: null        // { x, y } | null (window-manager owns pixels; mirrored here)
};

/* ---------- transition tables ---------- */
const INTERACTION = {
  idle:           { START_INPUT: "input", UPDATE_INPUT: "input", SUBMIT_THOUGHT: "understanding" },
  input:          { UPDATE_INPUT: "input", SUBMIT_THOUGHT: "understanding", START_VOICE: "input" },
  understanding:  { COMPLETE_UNDERSTANDING: "structuring" },
  structuring:    { STRUCTURE_PROMPT: "review" },
  review:         { START_EDIT: "editing", IMPROVE_PROMPT: "improving", REWRITE_PROMPT: "rewriting", CONFIRM_PROMPT: "ready_to_send" },
  editing:        { SAVE_EDIT: "review", CANCEL_EDIT: "review" },
  improving:      { IMPROVE_SUCCESS: "review" },
  rewriting:      { REWRITE_SUCCESS: "review" },
  ready_to_send:  { SEND_PROMPT: "sending", START_EDIT: "editing", IMPROVE_PROMPT: "improving", REWRITE_PROMPT: "rewriting" },
  sending:        { DELIVERY_COMPLETE: "delivered" },
  delivered:      {}
};
const INTERACTION_GLOBAL = { NEW_THOUGHT: "idle", RESET: "idle" };

const WINDOW = {
  hidden:    { OPEN_FLOAT: "expanded" },
  launcher:  { OPEN_FLOAT: "expanded" },
  expanded:  { MINIMIZE_FLOAT: "minimized", CLOSE_FLOAT: "hidden" },
  focus:     { MINIMIZE_FLOAT: "minimized", CLOSE_FLOAT: "hidden" },
  minimized: { RESTORE_FLOAT: "expanded", CLOSE_FLOAT: "hidden" }
};

const VOICE = {
  idle:       { START_VOICE: "listening", VOICE_ERROR: "error" },
  listening:  { STOP_VOICE: "processing", VOICE_ERROR: "error", VOICE_TRANSCRIPT: "listening" },
  processing: { VOICE_DONE: "idle", VOICE_ERROR: "error" },
  error:      { START_VOICE: "listening", VOICE_DONE: "idle", RESET: "idle" }
};

function transit(table, current, type) {
  const row = table[current];
  return row && row[type] ? row[type] : current;
}

/* ---------- helpers ---------- */
function msg(state, text) {
  return { ...state, message: { text, ts: Date.now() } };
}

function withError(state, code, message) {
  return { ...state, error: { code, message }, message: { text: message, ts: Date.now() } };
}

function currentPrompt(state) {
  return state.session ? state.session.currentPrompt : null;
}

/* Move selection within visible sections; returns new session */
function moveSelection(session, delta) {
  const keys = visibleSectionKeys(session.currentPrompt);
  if (!keys.length) return session;
  const idx = keys.indexOf(session.selectedSection);
  const nextIdx = idx === -1 ? 0 : (idx + delta + keys.length) % keys.length;
  return withSelectedSection(session, keys[nextIdx]);
}

/* ---------- root reducer ---------- */
export function reducer(state = initialState, action) {
  const type = action.type;

  /* ----- window slice ----- */
  if (type === A.OPEN_FLOAT || type === A.CLOSE_FLOAT || type === A.MINIMIZE_FLOAT || type === A.RESTORE_FLOAT) {
    const next = transit(WINDOW, state.window, type);
    // CLOSE_FLOAT = a full teardown of the floating surface. The voice slice
    // must be reset even if the window is already hidden (idempotent — no stale
    // listening/processing/error may survive under ANY close path; Bug #10).
    // The Composer input is intentionally KEPT (user's draft persists across
    // close/reopen), only the transient voice/error state is cleared. (The
    // provider itself is torn down in flows.closeFloat — this branch only
    // guarantees the state invariant.)
    if (type === A.CLOSE_FLOAT) {
      const voiceCleared = state.voice !== "idle" || state.voiceTranscript !== null
        || state.preVoiceInput !== null || state.error !== null;
      const base = {
        ...state,
        voice: "idle",
        voiceTranscript: null,
        preVoiceInput: null,
        error: null
      };
      if (next === state.window) return voiceCleared ? base : state;
      return { ...base, window: next, prevWindow: state.prevWindow };
    }
    if (next === state.window) return state;
    return {
      ...state,
      window: next,
      prevWindow: type === A.MINIMIZE_FLOAT ? state.window : state.prevWindow
    };
  }
  if (type === A.SET_POSITION) {
    return { ...state, position: { x: action.x, y: action.y } };
  }

  /* ----- voice slice ----- */
  if ([A.START_VOICE, A.STOP_VOICE, A.VOICE_TRANSCRIPT, A.VOICE_DONE, A.VOICE_ERROR, A.VOICE_CANCEL, A.VOICE_ENDED].includes(type)) {
    if (type === A.START_VOICE) {
      const nextVoice = transit(VOICE, state.voice, type);
      if (nextVoice === state.voice) return state;
      // Start a fresh voice session: clear live preview, snapshot the pre-voice
      // Composer draft so cancel() can restore it (3C-2B: voice is INPUT ONLY —
      // it appends to the Composer; it never creates a Thought by itself).
      return {
        ...state,
        voice: nextVoice,
        voiceTranscript: null,
        preVoiceInput: state.input,
        error: null
      };
    }
    if (type === A.VOICE_TRANSCRIPT) {
      if (state.voice !== "listening") return state; // stale recognition events are dropped
      const transcript = { text: action.text || "", final: !!action.isFinal };
      // Interim transcript is preview-only and never reaches the AI backend.
      // A FINAL transcript appends to the Composer input (3C-2B): merge strategy
      // is "set if empty, else append" so each spoken segment accumulates in the
      // Composer instead of overwriting what the user already typed.
      if (action.isFinal) {
        const incoming = action.text || "";
        const current = state.input || "";
        const merged = current ? current + (incoming ? " " + incoming : "") : incoming;
        return { ...state, voiceTranscript: transcript, input: merged };
      }
      return { ...state, voiceTranscript: transcript };
    }
    if (type === A.VOICE_CANCEL) {
      if (!["listening", "processing"].includes(state.voice)) return state;
      return {
        ...state,
        voice: "idle",
        voiceTranscript: null,
        input: state.preVoiceInput != null ? state.preVoiceInput : state.input,
        preVoiceInput: null,
        message: { text: "Voice input cancelled.", ts: Date.now() }
      };
    }
    if (type === A.VOICE_DONE) {
      return { ...state, voice: transit(VOICE, state.voice, type), voiceTranscript: null, preVoiceInput: null };
    }
    if (type === A.VOICE_ENDED) {
      // 3C-2B: explicit stop → the final transcript is already merged into the
      // Composer (VOICE_TRANSCRIPT final). VOICE_ENDED just resets the voice slice
      // so the user can start a fresh round of listening right away. No Thought
      // is created here — Creative Inbox is reached ONLY via REFINE.
      return {
        ...state,
        voice: "idle",
        voiceTranscript: null,
        preVoiceInput: null
      };
    }
    if (type === A.VOICE_ERROR) {
      const code = action.code || A.ERR.VOICE_UNAVAILABLE;
      const message = code === A.ERR.VOICE_UNAVAILABLE
        ? "Voice input is not available. You can still type your thought."
        : "Didn't catch that — tap the mic to retry, or type instead.";
      return withError({ ...state, voice: transit(VOICE, state.voice, type), voiceTranscript: null, preVoiceInput: null }, code, message);
    }
    return { ...state, voice: transit(VOICE, state.voice, type) };
  }

  /* ----- creative inbox (independent data slice) -----
     3C-2B entry policy: Creative Inbox is reached ONLY via the REFINE path —
     Composer content → AI refine → createThought(refined). A raw ADD of
     un-refined text is no longer a valid inbox entry; addThoughtFromInbox()
     now routes capture text into the Composer instead (see flows). We keep
     INBOX_ADD_REFINED as the single, explicit inbox-creation action so the
     invariant "inbox content is always AI-refined" is enforced in the machine. */
  if (type === A.INBOX_ADD_REFINED) {
    // 3C-2B: the ONLY inbox-creation action. text = the user's ORIGINAL words
    // (originalText is preserved byte-for-byte — see models/thought.js). The AI
    // refined version is attached afterwards via INBOX_REFINE, never here, so a
    // Thought never enters the inbox with refinedText = originalText.
    const text = (action.text || "").trim();
    if (!text) return state;
    return {
      ...state,
      inbox: {
        ...state.inbox,
        thoughts: state.inbox.thoughts.concat(createThought(text, action.source === "voice" ? "voice" : "text")),
        draft: "",
        expandedIds: state.inbox.expandedIds
      }
    };
  }
  if (type === A.INBOX_UPDATE_DRAFT) {
    return { ...state, inbox: { ...state.inbox, draft: action.text || "" } };
  }
  if (type === A.INBOX_EDIT) {
    const thoughts = state.inbox.thoughts.map((t) =>
      t.id === action.id ? withOriginalText(t, action.text) : t
    );
    return { ...state, inbox: { ...state.inbox, thoughts } };
  }
  if (type === A.INBOX_DELETE) {
    const thoughts = state.inbox.thoughts.filter((t) => t.id !== action.id);
    return {
      ...state,
      inbox: {
        ...state.inbox,
        thoughts,
        expandedIds: state.inbox.expandedIds.filter((id) => id !== action.id)
      }
    };
  }
  if (type === A.INBOX_TOGGLE_EXPANDED) {
    const has = state.inbox.expandedIds.includes(action.id);
    const expandedIds = has
      ? state.inbox.expandedIds.filter((id) => id !== action.id)
      : state.inbox.expandedIds.concat(action.id);
    return { ...state, inbox: { ...state.inbox, expandedIds } };
  }
  if (type === A.INBOX_TOGGLE_OPEN) {
    return { ...state, inbox: { ...state.inbox, open: !state.inbox.open } };
  }
  if (type === A.INBOX_COPY) {
    return state; // side effect (clipboard) lives in the flow
  }
  if (type === A.INBOX_REFINE) {
    const thoughts = state.inbox.thoughts.map((t) =>
      t.id === action.id && action.refinedText
        ? { ...t, refinedText: action.refinedText, updatedAt: new Date().toISOString() }
        : t
    );
    return { ...state, inbox: { ...state.inbox, thoughts } };
  }
  if (type === A.INBOX_CLEAR_ALL) {
    return { ...state, inbox: { ...state.inbox, thoughts: [], expandedIds: [] } };
  }

  /* ----- feedback ----- */
  if (type === A.SHOW_MESSAGE) return msg(state, action.text);
  if (type === A.SHOW_TOAST) return { ...state, toast: { text: action.text, ts: Date.now() } };
  if (type === A.ERROR) {
    // recoverable: interaction falls back to a stable state
    const stable = ["understanding", "structuring"].includes(state.interaction) ? "input"
      : ["improving", "rewriting"].includes(state.interaction) ? "review"
      : state.interaction === "sending" ? "ready_to_send"
      : state.interaction;
    return withError({ ...state, interaction: stable }, action.code || A.ERR.UNKNOWN_ERROR, action.message || "Something interrupted the flow. Try again.");
  }

  /* ----- input ----- */
  if (type === A.START_INPUT) {
    if (state.interaction !== "idle") return state;
    return { ...state, interaction: "input" };
  }
  if (type === A.UPDATE_INPUT) {
    const text = action.text || "";
    let interaction = state.interaction;
    if (interaction === "idle" && text.trim()) interaction = "input";
    if (interaction === "input" && !text.trim()) interaction = "idle";
    return { ...state, input: text, interaction, error: null };
  }

  /* ----- thought flow ----- */
  if (type === A.SUBMIT_THOUGHT) {
    if (state.interaction !== "idle" && state.interaction !== "input") return state;
    const thought = state.input.trim();
    if (!thought) {
      return withError(state, A.ERR.EMPTY_INPUT, "Tell me what's on your mind first.");
    }
    return {
      ...state,
      interaction: "understanding",
      understandStep: -1,
      error: null,
      session: createSession(thought)
    };
  }
  if (type === A.UNDERSTANDING_STEP) {
    if (state.interaction !== "understanding") return state;
    return { ...state, understandStep: action.step };
  }
  if (type === A.COMPLETE_UNDERSTANDING) {
    if (state.interaction !== "understanding") return state;
    return {
      ...state,
      interaction: "structuring",
      understandStep: 3,
      session: state.session ? withAnalysis(state.session, action.analysis) : state.session
    };
  }
  if (type === A.STRUCTURE_PROMPT) {
    if (state.interaction !== "structuring") return state;
    const prompt = createStructuredPrompt(action.prompt);
    return {
      ...state,
      interaction: "review",
      understandStep: -1,
      session: applyVersion(state.session, prompt, "structured")
    };
  }

  /* ----- Original / Optimized choice (review) -----
     Original = exact user words (session.rawThought, never mutated).
     Optimized = Prompt Intelligence output (version chain head). */
  if (type === A.USE_ORIGINAL || type === A.USE_OPTIMIZED) {
    if (!state.session) return state;
    if (!["review", "ready_to_send"].includes(state.interaction)) return state;
    const selection = type === A.USE_ORIGINAL ? "original" : "optimized";
    if (state.session.selection === selection) return state;
    return { ...state, session: withSelection(state.session, selection) };
  }

  /* ----- section navigation & editing ----- */
  if (type === A.SELECT_SECTION) {
    if (!state.session || state.session.selection === "original") return state;
    if (!["review", "ready_to_send"].includes(state.interaction)) return state;
    return { ...state, session: withSelectedSection(state.session, action.key) };
  }
  if (type === A.MOVE_SECTION) {
    if (!state.session || state.session.selection === "original") return state;
    if (!["review", "ready_to_send"].includes(state.interaction)) return state;
    return { ...state, session: moveSelection(state.session, action.delta) };
  }
  if (type === A.START_EDIT) {
    if (!["review", "ready_to_send"].includes(state.interaction)) return state;
    if (!state.session || state.session.selection === "original") return state;
    if (!state.session.selectedSection) return state;
    return { ...state, interaction: "editing", editingSection: state.session.selectedSection };
  }
  if (type === A.SAVE_EDIT) {
    if (state.interaction !== "editing" || !state.session) return state;
    const key = state.editingSection;
    const next = clonePrompt(state.session.currentPrompt);
    next[key] = textToSectionValue(key, action.value);
    return {
      ...state,
      interaction: "review",
      editingSection: null,
      session: applyVersion(state.session, next, "edited")
    };
  }
  if (type === A.CANCEL_EDIT) {
    if (state.interaction !== "editing") return state;
    return { ...state, interaction: "review", editingSection: null };
  }

  /* ----- improve / rewrite (request halves; success halves below) ----- */
  if (type === A.IMPROVE_PROMPT || type === A.REWRITE_PROMPT) {
    if (!currentPrompt(state)) return state;
    if (state.session && state.session.selection === "original") return state; // edit the optimized version instead
    const next = transit(INTERACTION, state.interaction, type);
    return next === state.interaction ? state : { ...state, interaction: next, error: null };
  }
  if (type === A.IMPROVE_SUCCESS || type === A.REWRITE_SUCCESS) {
    const source = type === A.IMPROVE_SUCCESS ? "improved" : "rewritten";
    const expected = type === A.IMPROVE_SUCCESS ? "improving" : "rewriting";
    if (state.interaction !== expected || !state.session) return state;
    const prompt = createStructuredPrompt(action.prompt);
    return {
      ...state,
      interaction: "review",
      session: applyVersion(state.session, prompt, source)
    };
  }

  /* ----- confirm / send / deliver ----- */
  if (type === A.CONFIRM_PROMPT) {
    const next = transit(INTERACTION, state.interaction, type);
    return next === state.interaction ? state : { ...state, interaction: next };
  }
  if (type === A.SEND_PROMPT) {
    const next = transit(INTERACTION, state.interaction, type);
    return next === state.interaction ? state : { ...state, interaction: next };
  }
  if (type === A.DELIVERY_COMPLETE) {
    const next = transit(INTERACTION, state.interaction, type);
    return next === state.interaction ? state : { ...state, interaction: next };
  }
  if (type === A.COPY_PROMPT) {
    return state; // side effect lives in flows; state unchanged
  }

  /* ----- lifecycle ----- */
  if (type === A.NEW_THOUGHT) {
    // New prompt session, but the Creative Inbox survives (user's ideas persist).
    return {
      ...state,
      interaction: "idle",
      voice: "idle",
      voiceTranscript: null,
      preVoiceInput: null,
      input: "",
      session: null,
      editingSection: null,
      understandStep: -1,
      error: null,
      inbox: { ...state.inbox, draft: "" } // inbox survives; only the draft is cleared
    };
  }
  if (type === A.RESET) {
    // Full reset also clears the Creative Inbox.
    return {
      ...state,
      interaction: "idle",
      voice: "idle",
      voiceTranscript: null,
      preVoiceInput: null,
      input: "",
      session: null,
      editingSection: null,
      understandStep: -1,
      error: null,
      inbox: { thoughts: [], draft: "", expandedIds: [], open: false }
    };
  }

  return state;
}

export { INTERACTION, WINDOW, VOICE };
