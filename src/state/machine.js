/* State Machine — the only place state transitions are decided.
   Three independent slices (spec §5):
     interaction: idle|input|understanding|structuring|review|editing|
                  improving|rewriting|ready_to_send|sending|delivered
     window:      hidden|launcher|expanded|focus|minimized
     voice:       idle|listening|processing|error
   Plus data slices: input draft, session, understandStep, error, feedback. */

import * as A from "./actions.js";
import { createHistory, pushEntry, undo as undoHistory, redo as redoHistory } from "./history.js";
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
  voiceSeq: 0,           // per-session seq of the last finalized transcript (VOICE-DUP-01/02)
  voiceCommittedLen: 0,  // provider-reported total transcript length already merged (VOICE-DUP-03)
  input: "",
  inputOrigin: null,     // "voice" | "thought" | null — provenance of the last Composer write (draft badge)
  draftSaved: true,      // Composer draft persistence state (SAVED / UNSAVED)
  inputSelection: null,  // { start, end } — caret to restore after UNDO/REDO
  history: createHistory(""), // application-level Composer edit history (3C-3A §7)
  aiMode: "unknown",     // "real" | "demo" | "unknown" — Demo must never masquerade as Real (3C-3A §5)
  session: null,
  inbox: {
    thoughts: [],     // Thought[] — independent of session (see models/thought.js)
    draft: "",        // "What are you thinking about?" textarea draft
    expandedIds: [],  // ids of cards currently expanded (long-text overflow)
    open: true        // 3C-3B: Inbox is a primary content surface — expanded by default (user can still collapse)
  },
  editingSection: null, // section key being edited, null when not editing
  understandStep: -1,   // -1 none, 0..2 line active, 3 all done
  error: null,          // { code, message } | null
  message: null,        // { text, ts } workspace transient message
  toast: null,          // { text, ts }
  refinePending: false, // REFINE 异步进行中 (3C-3C §P1)
  refineOriginal: null, // 3E: original Composer text before REFINE (for Inbox pair)
  refineResult: null,   // 3E: AI-refined text now in Composer
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
  // 3D-RC2 GATE C: × is a COLLAPSE, not an exit — both MINIMIZE and CLOSE
  // shrink the Float to the always-present PromptKey Orb on the desktop.
  // "hidden" exists only as the pre-boot state; nothing reaches it afterwards.
  expanded:  { MINIMIZE_FLOAT: "minimized", CLOSE_FLOAT: "minimized" },
  focus:     { MINIMIZE_FLOAT: "minimized", CLOSE_FLOAT: "minimized" },
  minimized: { RESTORE_FLOAT: "expanded", OPEN_FLOAT: "expanded" }
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

/* Shared Composer-write helper (3C-3A): every path that writes the Composer
   (user typing, voice append, USE append, inbox ADD, cancel-restore) funnels
   through here so the draft-dirty flag, the provenance badge and the
   application-level edit history stay consistent.
     origin:       "voice" | "thought" | null → DRAFT · VOICE / DRAFT · THOUGHT badge
     programmatic: true → the history entry is an INDEPENDENT step (no typing
                   coalescing), per 3C-3A §7.4
   Interior text is never modified — only the whole value is set by the caller. */
function withComposer(state, text, { origin = null, programmatic = false, selectionStart, selectionEnd, now = Date.now() } = {}) {
  const t = typeof text === "string" ? text : "";
  const changed = t !== state.input;
  let interaction = state.interaction;
  if (interaction === "idle" && t.trim()) interaction = "input";
  if (interaction === "input" && !t.trim()) interaction = "idle";
  return {
    ...state,
    input: t,
    interaction,
    inputOrigin: changed ? (t.trim() ? origin : null) : state.inputOrigin,
    draftSaved: changed ? false : state.draftSaved,
    inputSelection: null, // typing/programmatic writes own the caret; only UNDO/REDO set it
    history: changed
      ? pushEntry(state.history, { value: t, selectionStart, selectionEnd }, { programmatic, now })
      : state.history
  };
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
        || state.preVoiceInput !== null || state.error !== null
        || state.voiceSeq !== 0 || state.voiceCommittedLen !== 0
        || state.refinePending === true
        || state.refineOriginal != null || state.refineResult != null;
      const base = {
        ...state,
        voice: "idle",
        voiceTranscript: null,
        preVoiceInput: null,
        voiceSeq: 0,
        voiceCommittedLen: 0,
        refinePending: false,
        refineOriginal: null,
        refineResult: null,
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
        // Per-session tracking for VOICE-DUP-01/02 seq-based dedup & delta-append:
        voiceSeq: 0,           // latest finalized segment seq (provider's segmentSeq; 0 ⇒ none yet)
        voiceCommittedLen: 0,  // provider-reported total transcript length that has been
                               // MERGED into Composer via a final. Next final uses this to
                               // derive the pure delta appended this session.
        error: null
      };
    }
    if (type === A.VOICE_TRANSCRIPT) {
      if (state.voice !== "listening") return state; // stale recognition events are dropped
      const rawText = action.text || "";
      const isFinal = !!action.isFinal;
      const seq = action.seq == null ? 0 : Number(action.seq) >>> 0;
      const transcript = { text: rawText, final: isFinal };
      // Interim transcript is preview-only and never reaches the AI backend.
      // A FINAL transcript appends to the Composer input (3C-2B):
      //   · Uses SEQ-BASED deduplication (VOICE-DUP-01/02) — browser can replay
      //     the same final twice; if the provider gave it the same seq number,
      //     we ignore it. Genuinely separate consecutive finals (user repeated
      //     themselves) get different seq numbers → both merged.
      //   · Uses DELTA-APPEND against voiceCommittedLen: the provider reports
      //     an accumulating session transcript; only the newly-spoken portion
      //     (since the last final) is appended to the Composer (VOICE-DUP-03/04/05).
      if (isFinal) {
        // 1. Seq dedup
        if (seq > 0 && seq === (state.voiceSeq || 0)) {
          return { ...state, voiceTranscript: transcript };
        }
        // 2. Compute pure delta (the portion spoken THIS segment that has NOT
        //    yet been written to Composer). Handles final re-seen at a higher
        //    seq without re-appending prior segments.
        let delta = "";
        if (state.voiceCommittedLen > 0 && rawText.length >= state.voiceCommittedLen) {
          delta = rawText.slice(state.voiceCommittedLen);
        } else if (state.voiceCommittedLen === 0) {
          delta = rawText; // first final in session
        }
        // Normalize delta spacing: if Composer has content AND delta has
        // content, insert one space. If delta is whitespace-only, skip writing
        // (but still bump seq counters — the browser finalized silence/pause).
        let current = state.input || "";
        const trimmedDelta = delta.replace(/\s+/g, " ").trim();
        let merged = current;
        if (trimmedDelta) {
          merged = current ? current + " " + trimmedDelta : trimmedDelta;
        }
        // 3C-3C LONG-09: Voice final overflow promotes the ENTIRE merged text
        // as a Long Thought — no silent truncation, Composer is cleared so
        // the user can continue speaking, and the full document is in the inbox.
        const mergedLen = [...merged].length;
        if (mergedLen > A.COMPOSER_LIMIT) {
          const thought = createThought(merged, "voice");
          const voiceNext = {
            ...withComposer(state, "", { origin: null, programmatic: true }),
            error: null,
            voiceTranscript: transcript,
            voiceSeq: seq || (state.voiceSeq ? state.voiceSeq + 1 : 1),
            voiceCommittedLen: Math.min(rawText.length, 0x7fffffff),
            inbox: {
              ...state.inbox,
              thoughts: state.inbox.thoughts.concat(thought),
              expandedIds: state.inbox.expandedIds.concat(thought.id)
            },
            toast: { text: "LONG VOICE → INBOX", ts: Date.now() }
          };
          return voiceNext;
        }
        // 4. A voice final is a PROGRAMMATIC Composer write — independent
        //    history step (undo removes the whole spoken append), DRAFT · VOICE
        //    provenance, draft marked dirty for the debounced save.
        const payload = { origin: "voice", programmatic: true };
        const next = withComposer(state, merged, payload);
        return {
          ...next,
          voiceTranscript: transcript,
          voiceSeq: seq || (state.voiceSeq ? state.voiceSeq + 1 : 1),
          voiceCommittedLen: Math.min(rawText.length, 0x7fffffff) // raw provider total, not clamped
        };
      }
      // Interim: preview-only, never committed to the Composer state. The
      // preview text is what the RENDERER mirrors into the Composer while
      // LISTENING (3D-RC2 GATE B 边说边浮现): the committed words already in
      // state.input + the live interim tail (delta of the provider's raw
      // cumulative transcript against voiceCommittedLen). Spacing mirrors
      // the final merge path (one space between non-empty parts), so the
      // display doesn't jump when the final lands.
      let tail = "";
      if (state.voiceCommittedLen === 0) tail = rawText;
      else if (rawText.length > state.voiceCommittedLen) tail = rawText.slice(state.voiceCommittedLen);
      const base = state.input || "";
      const preview = tail ? (base ? base + " " + tail : tail) : base;
      return { ...state, voiceTranscript: { text: preview, final: false } };
    }
    if (type === A.VOICE_CANCEL) {
      if (!["listening", "processing"].includes(state.voice)) return state;
      // 3C-3A: the pre-voice restore is a programmatic write — independent
      // history step, plain DRAFT provenance, draft dirty (may differ from disk).
      return {
        ...withComposer(state, state.preVoiceInput != null ? state.preVoiceInput : state.input, { programmatic: true }),
        voice: "idle",
        voiceTranscript: null,
        preVoiceInput: null,
        voiceSeq: 0,
        voiceCommittedLen: 0,
        message: { text: "Voice input cancelled.", ts: Date.now() }
      };
    }
    if (type === A.VOICE_DONE) {
      return {
        ...state,
        voice: transit(VOICE, state.voice, type),
        voiceTranscript: null,
        preVoiceInput: null,
        voiceSeq: 0,
        voiceCommittedLen: 0
      };
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
        preVoiceInput: null,
        voiceSeq: 0,
        voiceCommittedLen: 0
      };
    }
    if (type === A.VOICE_ERROR) {
      const code = action.code || A.ERR.VOICE_UNAVAILABLE;
      const message = code === A.ERR.VOICE_UNAVAILABLE
        ? "Voice input is not available. You can still type your thought."
        : "Didn't catch that — tap the mic to retry, or type instead.";
      return withError({
        ...state,
        voice: transit(VOICE, state.voice, type),
        voiceTranscript: null,
        preVoiceInput: null,
        voiceSeq: 0,
        voiceCommittedLen: 0
      }, code, message);
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
  if (type === A.INBOX_RESTORE) {
    // 3C-3A §4.4: boot-time restore of persisted thoughts. Order is kept
    // as stored (storage sanitizes entries). Never clobbers live thoughts.
    const list = Array.isArray(action.thoughts)
      ? action.thoughts.filter((t) => t && typeof t.id === "string" && t.id && typeof t.originalText === "string")
      : [];
    if (!list.length) return state;
    if (state.inbox.thoughts.length) return state; // runtime state wins
    return { ...state, inbox: { ...state.inbox, thoughts: list } };
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

  /* ----- input -----
     UPDATE_INPUT carries optional 3C-3A payload:
       origin: "voice" | "thought" | null — provenance for the draft badge
       programmatic: true — voice/USE/ADD writes form independent history steps
       selectionStart/selectionEnd — caret at the time of a user keystroke */
  if (type === A.START_INPUT) {
    if (state.interaction !== "idle") return state;
    return { ...state, interaction: "input" };
  }
  if (type === A.UPDATE_INPUT) {
    const rawText = action.text || "";
    // 3C-3C §P1 LONG-01..10: Composer 超过 COMPOSER_LIMIT 时 → 整段提升为
    // Long Thought 存入 Creative Inbox，Composer 清空并 toast 提示。
    // 这样用户打字/粘贴再多的字也不会丢失，且入库内容可 COPY / EDIT / USE。
    const codePointLen = [...rawText].length;
    const isRestore = state.interaction === "idle" && !rawText.trim(); // idempotent empty updates
    if (codePointLen > A.COMPOSER_LIMIT && !isRestore) {
      const trimmed = rawText; // 保留完整原文，不截断
      const thought = createThought(trimmed, (action.origin === "voice") ? "voice" : "text");
      const promoted = {
        ...withComposer(state, "", { origin: null, programmatic: true }),
        error: null,
        inbox: {
          ...state.inbox,
          thoughts: state.inbox.thoughts.concat(thought),
          expandedIds: state.inbox.expandedIds.concat(thought.id) // Long thought auto-expanded
        },
        toast: { text: "LONG → SAVED TO INBOX", ts: Date.now() }
      };
      return promoted;
    }
    const next = withComposer(state, rawText, {
      origin: action.origin || null,
      programmatic: !!action.programmatic,
      selectionStart: action.selectionStart,
      selectionEnd: action.selectionEnd,
      now: typeof action.now === "number" ? action.now : undefined // test time injection
    });
    return { ...next, error: null };
  }
  if (type === A.RESTORE_DRAFT) {
    // 3C-3A §6.3: boot-time draft restore. The EXACT saved text comes back —
    // no AI, no REFINE, no auto-submit. History baseline = restored text, so
    // the first Undo after a restore undoes the user's next edit, not the
    // restore itself. Never clobbers live state (window re-open keeps draft).
    const t = typeof action.text === "string" ? action.text : "";
    if (!t.trim() || state.input) return state;
    return {
      ...state,
      input: t,
      interaction: "input",
      inputOrigin: null,
      draftSaved: true, // restored from disk — already saved
      inputSelection: null,
      history: createHistory(t, 0),
      error: null
    };
  }
  if (type === A.DRAFT_SAVED) {
    // debounce flush completed — the persisted draft now equals state.input
    return state.draftSaved ? state : { ...state, draftSaved: true };
  }
  if (type === A.UNDO_INPUT || type === A.REDO_INPUT) {
    // Composer edit history exists only while the Composer is live (idle/input).
    // After SUBMIT (understanding…delivered) the draft has already been consumed
    // by the pipeline — undoing there would corrupt the flow (§7, X-2).
    if (!["idle", "input"].includes(state.interaction)) return state;
    const u = type === A.UNDO_INPUT ? undoHistory(state.history) : redoHistory(state.history);
    if (!u) return state;
    const entry = u.entry;
    let interaction = state.interaction;
    if (interaction === "idle" && entry.value.trim()) interaction = "input";
    if (interaction === "input" && !entry.value.trim()) interaction = "idle";
    return {
      ...state,
      input: entry.value,
      interaction,
      inputOrigin: null, // the user took manual control of the text
      draftSaved: false, // differs from the disk draft until the next flush
      inputSelection: { start: entry.selectionStart, end: entry.selectionEnd },
      history: u.history,
      error: null
    };
  }
  if (type === A.AI_MODE) {
    const mode = action.mode === "real" || action.mode === "demo" ? action.mode : "unknown";
    if (state.aiMode === mode) return state;
    return { ...state, aiMode: mode };
  }

  /* ----- thought flow (3E simplified) -----
     The old understanding → structuring → review → send pipeline is retired.
     SUBMIT places the Composer words into the Creative Inbox. If the current
     Composer text matches the last REFINE result, the Inbox Thought keeps both
     the original source and the refined version so the user can still toggle. */
  if (type === A.SUBMIT_THOUGHT) {
    if (state.interaction !== "idle" && state.interaction !== "input") return state;
    const thought = state.input.trim();
    if (!thought) {
      return withError(state, A.ERR.EMPTY_INPUT, "Tell me what's on your mind first.");
    }
    const refinedPair = state.refineResult && state.input === state.refineResult
      ? { originalText: state.refineOriginal || thought, refinedText: state.refineResult }
      : null;
    const item = refinedPair
      ? { ...createThought(refinedPair.originalText, "text"), refinedText: refinedPair.refinedText }
      : createThought(thought, "text");
    return {
      ...withComposer(state, "", { origin: null, programmatic: true }),
      interaction: "idle",
      error: null,
      refineOriginal: null,
      refineResult: null,
      inbox: {
        ...state.inbox,
        thoughts: state.inbox.thoughts.concat(item),
        expandedIds: state.inbox.expandedIds
      },
      toast: { text: "SAVED TO INBOX", ts: Date.now() }
    };
  }
  if (type === A.REFINE_RESULT) {
    const refined = (action.refined || "").trim();
    if (!refined) return state;
    const source = (action.original || state.input || "").trim();
    return {
      ...withComposer(state, refined, { origin: "thought", programmatic: true }),
      interaction: "input",
      error: null,
      refineOriginal: source,
      refineResult: refined,
      toast: { text: "REFINED", ts: Date.now() }
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
  if (type === A.REFINE_PENDING) {
    const v = !!action.value;
    return state.refinePending === v ? state : { ...state, refinePending: v };
  }

  /* ----- lifecycle ----- */
  if (type === A.NEW_THOUGHT) {
    // New prompt session, but the Creative Inbox survives (user's ideas persist).
    // 3C-3A: NEW also clears the Composer draft (persisted + history + badge).
    return {
      ...state,
      interaction: "idle",
      voice: "idle",
      voiceTranscript: null,
      preVoiceInput: null,
      voiceSeq: 0,
      voiceCommittedLen: 0,
      input: "",
      inputOrigin: null,
      draftSaved: true,
      inputSelection: null,
      history: createHistory(""),
      session: null,
      editingSection: null,
      understandStep: -1,
      error: null,
      refinePending: false,
      refineOriginal: null,
      refineResult: null,
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
      voiceSeq: 0,
      voiceCommittedLen: 0,
      input: "",
      inputOrigin: null,
      draftSaved: true,
      inputSelection: null,
      history: createHistory(""),
      session: null,
      editingSection: null,
      understandStep: -1,
      error: null,
      refinePending: false,
      refineOriginal: null,
      refineResult: null,
      inbox: { thoughts: [], draft: "", expandedIds: [], open: false }
    };
  }

  return state;
}

export { INTERACTION, WINDOW, VOICE };
