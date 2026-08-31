/* Selectors — all derived UI-facing reads in one place. */

import { visibleSectionKeys, createStructuredPrompt, promptToText } from "../models/prompt.js";

/* What the System Bar + CSS data-status should show.
   Voice slice overrides interaction when active. */
export function effectiveStatus(state) {
  if (state.voice === "listening") return "listening";
  if (state.voice === "processing") return "transcribing";
  return state.interaction;
}

const STATUS_LABELS = {
  idle: "READY",
  input: "READY",
  listening: "LISTENING",
  transcribing: "TRANSCRIBING",
  understanding: "UNDERSTANDING",
  structuring: "STRUCTURING PROMPT",
  review: "READY",
  editing: "EDITING",
  improving: "IMPROVING",
  rewriting: "REWRITING",
  ready_to_send: "READY TO SEND",
  sending: "SENDING",
  delivered: "DELIVERED"
};

export function statusLabel(state) {
  return STATUS_LABELS[effectiveStatus(state)] || "READY";
}

export function currentPrompt(state) {
  return state.session ? state.session.currentPrompt : null;
}

/* The prompt the user has chosen to send.
   "original"  → exact user words (rawThought), wrapped read-only; never mutated.
   "optimized" → head of the Prompt Intelligence version chain. */
export function activePrompt(state) {
  if (!state.session) return null;
  if (state.session.selection === "original") {
    return createStructuredPrompt({ objective: state.session.rawThought });
  }
  return state.session.currentPrompt;
}

/* Plain-text form of the active prompt. Original stays byte-for-byte the user's words. */
export function activePromptText(state) {
  if (!state.session) return "";
  if (state.session.selection === "original") return state.session.rawThought;
  return state.session.currentPrompt ? promptToText(state.session.currentPrompt) : "";
}

export function sectionKeys(state) {
  return visibleSectionKeys(currentPrompt(state));
}

export function selectedSectionIndex(state) {
  const keys = sectionKeys(state);
  return state.session ? keys.indexOf(state.session.selectedSection) : -1;
}

export function canConfirm(state) {
  const s = state.interaction;
  if (s === "review") return true;
  if (s === "idle" || s === "input") return state.input.trim().length > 0;
  return false;
}

export function confirmEnabled(state) {
  const s = state.interaction;
  if (["understanding", "structuring", "improving", "rewriting", "sending", "delivered"].includes(s)) return false;
  if (state.voice !== "idle") return false;
  if (s === "input") return state.input.trim().length > 0;
  return true; // idle stays clickable so empty-input message can show (PRD behavior)
}

export function customButtonsEnabled(state) {
  return ["review", "ready_to_send"].includes(state.interaction)
    && !!currentPrompt(state)
    && !(state.session && state.session.selection === "original"); // C1/C2 transform the optimized version
}

export function isProcessing(state) {
  return ["understanding", "structuring", "improving", "rewriting", "sending"].includes(state.interaction)
    || state.voice === "processing";
}

/* 3C-2B: can the user REFINE the Composer content into a Creative Inbox Thought?
   Requires non-empty Composer text AND a calm interaction (no AI/voice in flight),
   so REFINE never races an ongoing analysis or a listening session. */
export function canRefine(state) {
  const s = state.interaction;
  if (["understanding", "structuring", "improving", "rewriting", "sending", "delivered"].includes(s)) return false;
  // Bug #10: only LIVE voice blocks REFINE — listening (mid-speech) and
  // processing (finalizing). "error" is a TERMINAL voice state, not an active
  // one: the user's words are already in the Composer (or typeable), so REFINE
  // must remain available as the fallback path after a speech error. Blocking
  // it would lock the user out of the Creative Inbox.
  if (state.voice === "listening" || state.voice === "processing") return false;
  return (state.input || "").trim().length > 0;
}

/* ---- Creative Inbox selectors (Phase 3C-2A) ---- */
export function inboxThoughts(state) {
  return state.inbox ? state.inbox.thoughts : [];
}

export function inboxCount(state) {
  return inboxThoughts(state).length;
}

export function inboxExpandedIds(state) {
  return state.inbox ? state.inbox.expandedIds : [];
}

export function isInboxExpanded(state, id) {
  return inboxExpandedIds(state).includes(id);
}
