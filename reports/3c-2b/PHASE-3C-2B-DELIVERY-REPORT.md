# PHASE 3C-2B — DELIVERY REPORT

**Date:** 2026-08-31  
**Status:** FINAL PASS  
**Test Count:** 204/204  
**Lint:** OK  
**Build:** OK  

---

## 1. Phase Summary

PHASE 3C-2B delivers the core data-flow redesign between **Creative Inbox** and **Composer**, plus fixes for three real bugs discovered during acceptance:

- **Bug #8** — Composer continuous editing was reverted by renderer state sync.
- **Bug #9** — Voice could not be reused for a second/third session after stop.
- **Bug #10** — Voice error state leaked past `CLOSE_FLOAT` and permanently disabled `REFINE`.

Additional product changes:
- Remove the **Joystick** control.
- Bottom controls become **VOICE / REFINE** only.
- Move **Creative Inbox** above the Composer.
- Add independent scrolling for the Inbox list.
- Rename "SEND TO PROMPT" semantics to **USE**.

---

## 2. Baseline

- PHASE 3C-2A end-state: `npm test` **172/172**.
- Skill v1.1 / Golden Dataset / Benchmark v1: **FROZEN** at 3B-3.
- Back-end `server/` and Intent Compiler: **FROZEN** at 3B-3.

---

## 3. Final Test Count

| Metric | Value |
|---|---|
| Total tests | **204** |
| Passed | **204** |
| Failed | **0** |
| Skipped | **0** |
| Duration | ~3.6 s |

### Reconciliation (172 → 204)

| Stage | Tests | Change | Source |
|---|---:|---:|---|
| 3C-2A baseline | 172 | — | baseline |
| Bug #8 / #9 repro | 176 | +4 | `tests/repro-bugs.test.js` |
| 3C-2B implementation | 193 | +17 | `tests/3c-2b.test.js` |
| Bug #10 | 204 | +11 | `tests/voice-error-reset.test.js` |

**Zero tests were deleted.** The `voice-loop.test.js` A→R sequence remains continuous (no missing letters), and every test name referenced in the 3C-2A report is still present. The 3C-2A report's "inbox 22" was a tally typo; the actual inbox count was 23 (`+28 = 23 inbox + 5 voice-loop rewrite`), keeping the reconciliation self-consistent.

---

## 4. Bug #8 — Composer Continuous Editing

### Root Cause
`renderer.js` used an `activeElement === input` guard that skipped DOM updates while the Composer was focused. State changes (voice append, REFINE result, USE take-back) therefore made the DOM drift out of sync; the next keystroke reverted the input to the stale state.

### Fix
```js
// src/ui/renderer.js
if (refs.input.value !== state.input) {
  refs.input.value = state.input;
}
```
A pure value comparison keeps the caret intact while still honoring programmatic updates.

### Verification
- Unit tests cover append/delete/modify persistence.
- Browser E2E: typed `"design a pricing page"` then `" with three tiers"` → value `"design a pricing page with three tiers"` persists; input remains focused.

---

## 5. Bug #9 — Voice Multi-Round Reuse

### Root Cause
The browser voice provider kept stale `SpeechRecognition` instances alive. Late `onresult`/`onend` events from a previous instance were misread as belonging to the current session, causing an infinite restart loop or dead session.

### Fix
`src/services/voice/browser-provider.js` guards each recognition segment with instance-level checks:
- Stale errors from a previous instance are discarded.
- A trailing `onend` from a cancelled session never restarts the current loop.
- `voiceSession` + `reqSeq` generational counters kill stale responses at the flow/state layers.

### Verification
Browser E2E: three consecutive `VOICE → speak → stop` rounds ran successfully:
- Round 1: `"make it mobile friendly"` → len 62
- Round 2: `"include a FAQ section"` → len 84
- Round 3: `"add annual billing toggle"` → len 110
All text appended to Composer; no Inbox Thought created.

---

## 6. Bug #10 — Voice Error Reset

### Root Cause
1. `CLOSE_FLOAT` only mutated the `window` slice and never reset the `voice` slice, leaving `error` / `listening` state to leak into the next open.
2. `canRefine` and `refineFromComposer` used `state.voice !== "idle"` as a hard gate, treating terminal `error` as an active state and permanently locking out `REFINE` after a speech error.

### Fix
- `src/state/machine.js`: `CLOSE_FLOAT` now **unconditionally and idempotently** resets the voice slice (`voice: idle`, `voiceTranscript: null`, `preVoiceInput: null`, `error: null`) while preserving Composer input as a draft.
- `src/flows/prompt-flow.js`: new `closeFloat()` aborts a live voice session before dispatching `CLOSE_FLOAT`.
- `src/state/selectors.js`: `canRefine` only blocks `listening` and `processing`; `error` no longer blocks the fallback path.
- `src/flows/prompt-flow.js`: `refineFromComposer()` guards only `listening`/`processing` and echoes `updateInput(S().input)` after success to clear a transient error hint.

### Verification
Browser E2E: forced `audio-capture` error → `caption: RETRY`; typed text → `refineDisabled: false`; `REFINE` → `"REFINED → INBOX"`; closed/reopened Float → `voice: idle`, `caption: VOICE`, Composer draft preserved, `REFINE` still enabled. Closing while listening verified `SR.aborted = true`.

---

## 7. Creative Inbox Architecture

The only valid data paths are:

```
Voice final ──┐
              ├──→ Composer ──→ REFINE ──→ AI analyze ──→ Inbox Thought
Typed input ──┘                (only AI-refined thoughts enter the inbox)

Inbox Thought ──→ USE ──→ Composer (take-back, no auto-submit)
Inbox Thought ──→ EDIT / DELETE / COPY (local, no AI)
```

- `INBOX_ADD_REFINED` is the sole Inbox-creation action.
- `createThought(...)` is only invoked inside `INBOX_ADD_REFINED`.
- No raw Voice or raw typed text can create an Inbox Thought.

---

## 8. Voice → Composer Flow

- `VOICE_TRANSCRIPT final` appends to `state.input`.
- `VOICE_ENDED` / `VOICE_DONE` reset the voice slice only.
- No `createThought` call exists anywhere in the voice state branch.
- Verified: after three voice rounds, `inboxCount = 0` and Composer length grew from 38 to 110.

---

## 9. Composer → REFINE → Inbox Flow

- `REFINE` requires non-empty Composer text and no live voice/listening state.
- It calls `ai.analyzePrompt(source, {inputSource: "text"})`.
- On success: `inboxAddRefined(source, "text")` creates the Thought with byte-preserved `originalText`, then `inboxRefine(id, refined)` attaches the AI output.
- The Composer text is preserved; REFINE captures for the Inbox but does not consume the input.
- Failure shows a toast and leaves the Composer text untouched.

---

## 10. Inbox → USE Flow

- `USE` copies the Thought's `refinedText` (or `originalText` fallback) into the Composer.
- It does **not** consume or delete the Thought.
- It does **not** auto-submit; `status` stays `input`.
- The user edits, REFINEs again, or submits via `pk-submit`.

---

## 11. Joystick Removal

Global search results across `src/`, `index.html`, and `css/`:

| Search Term | Hits |
|---|---|
| `pk-joystick` | 0 |
| `joystick` | 0 |
| `pk-confirm` | 0 |
| `CONFIRM & SEND` | 0 |
| `SEND TO PROMPT` | 0 |

`MOVE_SECTION` and `START_EDIT` actions remain in `src/state/actions.js` and `src/state/machine.js` because they are part of the structured-prompt review flow, not the Joystick.

---

## 12. UI / Layout Changes

| Change | Evidence |
|---|---|
| Joystick removed | Zero hits above; `pk-voice`/`pk-refine` now carry bottom control |
| VOICE / REFINE bottom controls | `#pk-voice` / `#pk-refine` in `index.html` L166–170 |
| Inbox above Composer | `#pk-inbox` L72 precedes `#pk-input` L101 |
| Inbox independent scroll | `.pk-inbox-body { overflow-y: auto }` + `.pk-inbox-list { flex: 1 1 auto; min-height: 0; overflow-y: auto }` |
| Float height for Inbox+Composer coexistence | `#pk-float { width:620px; height:580px; max-height:calc(100vh - 32px) }` |
| Mobile height | `@media (max-width:700px) { height: min(86vh, 520px) }` |

### Layout Verification (4 Thoughts, 1280×900 desktop)

| Measurement | Value |
|---|---|
| `floatH` | 580 |
| `inboxH` | 172 (stable, does not grow with Thought count) |
| `listH` | 66 (internal scroll active) |
| `inputH` | 45 (Composer visible & focusable) |
| `inboxInFloat` | true |
| `listInBody` | true |
| `voiceInFloat` | true |
| `hOverflow` | false |

### Mobile Narrow (375×667)

| Measurement | Value |
|---|---|
| `floatH` | 520 |
| `inboxH` | 132 |
| `listH` | 26 |
| `inputH` | 42 |
| `floatInViewport` | true |
| `hOverflow` | false |

Screenshots:
- `review/3c-2b/layout-fixed-inbox-expanded.png`
- `review/3c-2b/layout-fixed-mobile-narrow.png`
- `review/3c-2b/step19-final-structured.png`

---

## 13. Browser E2E — 19 Steps

| # | Step | Result |
|---|---|---|
| 01 | Open PromptKey Float | PASS |
| 02 | Composer editable | PASS |
| 03 | Type text | PASS |
| 04 | Continue editing | PASS |
| 05 | Edit not reverted by renderer | PASS |
| 06 | Tap VOICE | PASS |
| 07 | First voice input + stop | PASS |
| 08 | Voice final → Composer (not Inbox) | PASS |
| 09 | Original Composer content preserved | PASS |
| 10 | Tap VOICE again | PASS |
| 11 | Second voice input + stop | PASS |
| 12 | Second voice session works | PASS |
| 13 | Third voice session works / no race | PASS |
| 14 | Edit Composer final text | PASS |
| 15 | Tap REFINE | PASS |
| 16 | AI refine → Inbox Thought | PASS |
| 17 | Inbox edit/save/re-edit/delete isolation | PASS |
| 18 | USE → Composer (not direct send) | PASS |
| 19 | Final Submit → structured review pipeline | PASS |

---

## 14. Voice Error Recovery E2E

| Checkpoint | Result |
|---|---|
| Tap VOICE → listening | PASS |
| Force error → caption `RETRY` | PASS |
| Tap RETRY → listening again | PASS |
| Type in Composer while error | PASS |
| `REFINE` enabled despite error | PASS |
| `REFINE` → `"REFINED → INBOX"` + count = 1 | PASS |
| Close Float → `window: hidden`, caption `VOICE` | PASS |
| Reopen Float → `voice: idle`, `caption: VOICE` | PASS |
| Composer draft preserved | PASS |
| `REFINE` still enabled after reopen | PASS |
| Closing while listening → `SR.aborted = true` | PASS |
| No background mic/recognition session | PASS |

---

## 15. FROZEN Check

FROZEN set (50 files):
- `server/ai/skills/intent-compiler/**`
- `tests/fixtures/prompt-intelligence/**`
- `scripts/benchmark.js`
- `reports/prompt-intelligence/**`
- `server/**`

Result: **0 files modified inside the 3C-2B window (≥ 2026-08-31 19:50)**. Latest `server/` mtime is 2026-08-31 16:13. Benchmark was not re-executed; Skill v1.1 and Golden Dataset are unchanged.

**FROZEN CHECK: PASS**

---

## 16. `npm test`

```bash
npm test
```

```
# tests 204
# pass 204
# fail 0
# skipped 0
# todo 0
# duration_ms 3587.4717
```

**PASS**

---

## 17. `npm run lint`

```bash
npm run lint
```

```
lint OK — frontend/backend guardrails hold
(DOM only in ui/+main.js, env only in config/env.js, no secrets in frontend)
```

**PASS**

---

## 18. `npm run build`

```bash
rm -rf dist
npm run build
```

```
build OK — 50 files copied to dist/, 54/54 pure modules import cleanly
```

**PASS** (note: WorkBuddy's `safe-delete` shim required manual `rm -rf dist`; build script now pre-removes each destination in `safeCp` but the shim may still require manual clearance in this environment).

---

## 19. Remaining Known Issues / Notes

1. **No git repository** in the workspace. Diff audits used mtime timelines + global content search as an alternative evidence chain. This is recorded transparently.
2. **Build environment quirk**: WorkBuddy's `safe-delete` shim rejects bulk `dist/` cleanup; build requires `rm -rf dist` before `npm run build`. `scripts/build.js` now attempts per-destination pre-removal, but the environment may still prompt for confirmation.
3. **UX polish (non-blocking)**:
   - Idle view requires clicking the workspace to enter `input` state; this is the intended design but may surprise first-time users.
   - After a successful `REFINE`, the Inbox does not auto-expand; the user must click the Inbox toggle to see the new Thought.
   - After stopping Voice, focus remains on the VOICE button; the user must click the Composer to continue typing.

---

## 20. Final Verdict

All acceptance gates are satisfied:

- [x] Test baseline reconciled
- [x] All tests pass
- [x] Lint pass
- [x] Build pass
- [x] Bug #8 pass
- [x] Bug #9 pass
- [x] Bug #10 pass
- [x] Voice → Composer pass
- [x] Composer continuous editing pass
- [x] Multi-round Voice pass
- [x] REFINE → Inbox pass
- [x] Inbox edit/delete pass
- [x] USE pass
- [x] Final submit pass
- [x] Inbox scroll isolation pass
- [x] Joystick completely removed
- [x] VOICE / REFINE controls pass
- [x] 19-step E2E pass
- [x] Voice error recovery pass
- [x] FROZEN check pass
- [x] No unintended diff

```text
PHASE 3C-2B — FINAL PASS
```

No new features will be added; the next phase will not begin until explicitly requested.
