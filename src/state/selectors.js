/* Selectors — all derived UI-facing reads in one place. */

import { visibleSectionKeys, createStructuredPrompt, promptToText } from "../models/prompt.js";
import { canUndo, canRedo } from "./history.js";

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
  if (s === "idle" || s === "input") return state.input.trim().length > 0;
  return false;
}

export function confirmEnabled(state) {
  if (state.refinePending) return false;
  if (state.voice !== "idle") return false;
  const s = state.interaction;
  if (s === "input") return state.input.trim().length > 0;
  if (s === "idle") return true; // clickable to show empty-input hint
  return false;
}

export function customButtonsEnabled(state) {
  return false; // C1/C2 retired in 3E
}

export function isProcessing(state) {
  return state.refinePending || state.voice === "processing";
}

/* 3E: can the user REFINE the Composer content into a Creative Inbox Thought?
   Requires non-empty Composer text, a calm interaction, and no live voice/refine. */
export function canRefine(state) {
  const s = state.interaction;
  if (!["idle", "input"].includes(s)) return false;
  if (state.refinePending) return false;
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

/* ---- 3C-3A: Composer draft badge (§8) ----
   EMPTY / DRAFT / DRAFT · VOICE / DRAFT · THOUGHT — provenance of the last
   Composer write. Manual typing resets to plain DRAFT. */
export function draftBadgeLabel(state) {
  const text = (state.input || "").trim();
  if (!text) return "EMPTY";
  if (state.inputOrigin === "voice") return "DRAFT · VOICE";
  if (state.inputOrigin === "thought") return "DRAFT · THOUGHT";
  return "DRAFT";
}

/* SAVED / UNSAVED — the draft-persistence state (NOT the flow statusLabel). */
export function draftSavedLabel(state) {
  const text = (state.input || "").trim();
  if (!text) return ""; // nothing to save — indicator hidden
  return state.draftSaved ? "SAVED" : "UNSAVED";
}

/* ---- 3C-3A: edit history (§7) ----
   Buttons/shortcuts reflect BOTH the history stack and the machine guard
   (UNDO/REDO only operate while the Composer is live — idle/input). */
export function canUndoInput(state) {
  return ["idle", "input"].includes(state.interaction) && canUndo(state.history);
}

export function canRedoInput(state) {
  return ["idle", "input"].includes(state.interaction) && canRedo(state.history);
}

/* ---- 3C-3A: AI mode visibility (§5) ---- */
export function aiModeLabel(state) {
  if (state.aiMode === "real") return "AI · REAL";
  if (state.aiMode === "demo") return "AI · DEMO";
  return ""; // unknown until the first AI call — indicator hidden
}
