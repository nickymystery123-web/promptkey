/* Action types — single source of truth for everything that can happen.
   Flow: Action → Machine → State → Renderer → UI */

// Window
export const OPEN_FLOAT = "OPEN_FLOAT";
export const CLOSE_FLOAT = "CLOSE_FLOAT";
export const MINIMIZE_FLOAT = "MINIMIZE_FLOAT";
export const RESTORE_FLOAT = "RESTORE_FLOAT";
export const SET_POSITION = "SET_POSITION";

// Input
export const START_INPUT = "START_INPUT";
export const UPDATE_INPUT = "UPDATE_INPUT";
export const SUBMIT_THOUGHT = "SUBMIT_THOUGHT";

// Understanding / Structuring
export const UNDERSTANDING_STEP = "UNDERSTANDING_STEP";
export const COMPLETE_UNDERSTANDING = "COMPLETE_UNDERSTANDING";
export const STRUCTURE_PROMPT = "STRUCTURE_PROMPT";

// Section navigation & editing
export const SELECT_SECTION = "SELECT_SECTION";
export const MOVE_SECTION = "MOVE_SECTION"; // payload: { delta: +1 | -1 }
export const START_EDIT = "START_EDIT";
export const SAVE_EDIT = "SAVE_EDIT";       // payload: { key, value }
export const CANCEL_EDIT = "CANCEL_EDIT";

// Improve / Rewrite (async pairs)
export const IMPROVE_PROMPT = "IMPROVE_PROMPT";         // request → improving
export const IMPROVE_SUCCESS = "IMPROVE_SUCCESS";       // payload: { prompt }
export const REWRITE_PROMPT = "REWRITE_PROMPT";         // request → rewriting
export const REWRITE_SUCCESS = "REWRITE_SUCCESS";       // payload: { prompt }

// Confirm / Send / Deliver
export const CONFIRM_PROMPT = "CONFIRM_PROMPT";   // review → ready_to_send
export const SEND_PROMPT = "SEND_PROMPT";         // ready_to_send → sending
export const DELIVERY_COMPLETE = "DELIVERY_COMPLETE";

// Voice
export const START_VOICE = "START_VOICE";
export const STOP_VOICE = "STOP_VOICE";
export const VOICE_TRANSCRIPT = "VOICE_TRANSCRIPT"; // payload: { text, isFinal }
export const VOICE_DONE = "VOICE_DONE";
export const VOICE_ERROR = "VOICE_ERROR";           // payload: { code }
export const VOICE_CANCEL = "VOICE_CANCEL";         // user abandons voice input (≠ stop/done)
export const VOICE_ENDED = "VOICE_ENDED";           // 3C-2B: explicit stop → final transcript already merged into Composer; resets voice slice

// Creative Inbox (Phase 3C-2A) — thought memory, independent of the single session
export const INBOX_ADD_REFINED = "INBOX_ADD_REFINED"; // 3C-2B: the ONLY way a Thought enters the inbox — always AI-refined content
export const INBOX_UPDATE_DRAFT = "INBOX_UPDATE_DRAFT"; // payload: { text }
export const INBOX_EDIT = "INBOX_EDIT";         // payload: { id, text }
export const INBOX_DELETE = "INBOX_DELETE";     // payload: { id }
export const INBOX_TOGGLE_EXPANDED = "INBOX_TOGGLE_EXPANDED"; // payload: { id }
export const INBOX_TOGGLE_OPEN = "INBOX_TOGGLE_OPEN";         // panel open/collapsed
export const INBOX_COPY = "INBOX_COPY";         // payload: { id, variant } — side effect in flow
export const INBOX_REFINE = "INBOX_REFINE";     // payload: { id, refinedText } — async refinement result
export const INBOX_CLEAR_ALL = "INBOX_CLEAR_ALL";

// Review version choice (Original = exact user input; Optimized = Prompt Intelligence output)
export const USE_ORIGINAL = "USE_ORIGINAL";
export const USE_OPTIMIZED = "USE_OPTIMIZED";

// Result actions
export const COPY_PROMPT = "COPY_PROMPT";
export const NEW_THOUGHT = "NEW_THOUGHT";

// Feedback / errors
export const SHOW_MESSAGE = "SHOW_MESSAGE"; // payload: { text }
export const SHOW_TOAST = "SHOW_TOAST";     // payload: { text }
export const ERROR = "ERROR";               // payload: { code, message }
export const RESET = "RESET";

/* Error codes (spec §23) */
export const ERR = {
  EMPTY_INPUT: "EMPTY_INPUT",
  INVALID_INPUT: "INVALID_INPUT",
  VOICE_UNAVAILABLE: "VOICE_UNAVAILABLE",
  VOICE_ERROR: "VOICE_ERROR",
  AI_TIMEOUT: "AI_TIMEOUT",
  AI_ERROR: "AI_ERROR",
  DELIVERY_ERROR: "DELIVERY_ERROR",
  STORAGE_ERROR: "STORAGE_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR"
};

/* Action creators (thin, keep call sites readable) */
export const act = {
  openFloat: () => ({ type: OPEN_FLOAT }),
  closeFloat: () => ({ type: CLOSE_FLOAT }),
  minimizeFloat: () => ({ type: MINIMIZE_FLOAT }),
  restoreFloat: () => ({ type: RESTORE_FLOAT }),
  setPosition: (x, y) => ({ type: SET_POSITION, x, y }),
  startInput: () => ({ type: START_INPUT }),
  updateInput: (text) => ({ type: UPDATE_INPUT, text }),
  submitThought: () => ({ type: SUBMIT_THOUGHT }),
  understandingStep: (step) => ({ type: UNDERSTANDING_STEP, step }),
  completeUnderstanding: (analysis) => ({ type: COMPLETE_UNDERSTANDING, analysis }),
  structurePrompt: (prompt) => ({ type: STRUCTURE_PROMPT, prompt }),
  selectSection: (key) => ({ type: SELECT_SECTION, key }),
  moveSection: (delta) => ({ type: MOVE_SECTION, delta }),
  startEdit: () => ({ type: START_EDIT }),
  saveEdit: (key, value) => ({ type: SAVE_EDIT, key, value }),
  cancelEdit: () => ({ type: CANCEL_EDIT }),
  improvePrompt: () => ({ type: IMPROVE_PROMPT }),
  improveSuccess: (prompt) => ({ type: IMPROVE_SUCCESS, prompt }),
  rewritePrompt: () => ({ type: REWRITE_PROMPT }),
  rewriteSuccess: (prompt) => ({ type: REWRITE_SUCCESS, prompt }),
  confirmPrompt: () => ({ type: CONFIRM_PROMPT }),
  sendPrompt: () => ({ type: SEND_PROMPT }),
  deliveryComplete: () => ({ type: DELIVERY_COMPLETE }),
  startVoice: () => ({ type: START_VOICE }),
  stopVoice: () => ({ type: STOP_VOICE }),
  voiceTranscript: (text, isFinal) => ({ type: VOICE_TRANSCRIPT, text, isFinal }),
  voiceDone: () => ({ type: VOICE_DONE }),
  voiceError: (code) => ({ type: VOICE_ERROR, code }),
  cancelVoice: () => ({ type: VOICE_CANCEL }),
  voiceEnded: () => ({ type: VOICE_ENDED }),
  inboxAddRefined: (text, source) => ({ type: INBOX_ADD_REFINED, text, source }),
  inboxUpdateDraft: (text) => ({ type: INBOX_UPDATE_DRAFT, text }),
  inboxEdit: (id, text) => ({ type: INBOX_EDIT, id, text }),
  inboxDelete: (id) => ({ type: INBOX_DELETE, id }),
  inboxToggleExpanded: (id) => ({ type: INBOX_TOGGLE_EXPANDED, id }),
  inboxToggleOpen: () => ({ type: INBOX_TOGGLE_OPEN }),
  inboxCopy: (id, variant) => ({ type: INBOX_COPY, id, variant }),
  inboxRefine: (id, refinedText) => ({ type: INBOX_REFINE, id, refinedText }),
  inboxClearAll: () => ({ type: INBOX_CLEAR_ALL }),
  useOriginal: () => ({ type: USE_ORIGINAL }),
  useOptimized: () => ({ type: USE_OPTIMIZED }),
  copyPrompt: () => ({ type: COPY_PROMPT }),
  newThought: () => ({ type: NEW_THOUGHT }),
  showMessage: (text) => ({ type: SHOW_MESSAGE, text }),
  showToast: (text) => ({ type: SHOW_TOAST, text }),
  error: (code, message) => ({ type: ERROR, code, message }),
  reset: () => ({ type: RESET })
};
