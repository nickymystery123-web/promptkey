/* PromptKey Intent Compiler (Phase 3B-2) — the product intelligence layer.

   Position: Controller → IntentCompiler → Gateway → Registry → Provider.
   Decoupled from any concrete provider: it only knows gateway.chatJson().
   Strategy (spec §3): ONE LLM call + local schema validation +
   local rule-based safety checks + fidelity validation.

   rawInput is immutable and always traceable (spec §5). */

import { parseCompilerInput, sanitizeAnalyzeOutput, sanitizeTransformOutput } from "./schema.js";
import { normalizeInput } from "./normalizer.js";
import { createTerminologyResolver } from "./terminology.js";
import { resolveContext } from "./context.js";
import { structureFromIntent, structureFromRaw, optimizeStructured } from "./structurer.js";
import { evaluateFidelity } from "./fidelity.js";
import { evaluateQuality } from "./evaluator.js";
import { analyzeSystemPrompt, improveSystemPrompt, rewriteSystemPrompt, buildAnalyzeUserContent } from "./prompts.js";
import { isKnownTask } from "./intent.js";

/* Skill version (Phase 3B-3 §14) — bump on every calibration change so
   benchmark reports can compare before/after.
   1.1 (2026-08-31): task-classification rules + user-term preservation +
   ASR homophone examples in the system prompt; negation-aware anti-OI in
   the evaluator; word-boundary matching for acronym tech-terms (no more
   "mail"→"AI" false positive in the fidelity guard). */
export const SKILL_VERSION = "1.1";

export function createIntentCompiler({ gateway, terminology } = {}) {
  const terms = terminology || createTerminologyResolver();

  /* ---------- analyze: raw input → intent → structured prompt ---------- */
  async function analyze(rawInput, ctx, options = {}) {
    const startedAt = Date.now();
    const input = parseCompilerInput({ text: rawInput, ...options });

    // PK-01 local normalization (model sees both raw + normalized)
    const normalizedInput = normalizeInput(input.rawInput);

    // PK-02 terminology candidates (hints, never auto-applied)
    const termHints = terms.scan(input.rawInput);

    // PK-04 context (engaged only when references exist)
    const ctxResolution = resolveContext(input.rawInput, input.context);

    // ONE LLM CALL (spec §3/§35)
    const llmStartedAt = Date.now();
    const rawOutput = await gateway.chatJson({
      system: analyzeSystemPrompt(),
      user: buildAnalyzeUserContent({
        rawInput: input.rawInput,
        normalizedInput,
        inputSource: input.inputSource,
        mode: input.mode,
        context: ctxResolution.used ? input.context : null,
        termHints
      })
    }, ctx);
    const llmDuration = Date.now() - llmStartedAt;

    // validate untrusted model output
    const out = sanitizeAnalyzeOutput(rawOutput);
    if (!isKnownTask(out.intent.task)) out.intent.task = "general";

    // PK-05/06 structure + local polish (model structured preferred, local fallback)
    let structured = optimizeStructured(out.structured || structureFromIntent(out.intent));
    let optimizedPrompt = out.optimizedPrompt || structured.objective;

    // PK-07 fidelity guard
    const fidelityStartedAt = Date.now();
    const techTerms = terms.techTermsIn(input.rawInput);
    const fidelity = evaluateFidelity({
      rawInput: input.rawInput,
      optimizedText: optimizedPrompt + " " + structured.objective + " " + structured.requirements.join(" "),
      llmFidelity: out.fidelity,
      techTerms
    });
    let conservative = false;
    if (fidelity.verdict === "FAIL") {
      // reduce optimization intensity → return the conservative version (spec §33)
      conservative = true;
      structured = structureFromRaw(normalizedInput);
      optimizedPrompt = normalizedInput;
      fidelity.score = Math.max(fidelity.score, 0.6); // reflect the downgrade honestly
    }
    const validationDuration = Date.now() - fidelityStartedAt;

    // PK-08 quality score
    const quality = evaluateQuality({ optimizedText: optimizedPrompt, structured, fidelityScore: fidelity.score });

    return {
      prompt: structured,
      detectedIntent: out.intent.task,
      meta: {
        rawInput: input.rawInput, // original, always traceable (spec §43)
        normalizedInput,
        correctedInput: out.correctedInput || normalizedInput,
        corrections: out.corrections,
        intent: out.intent,
        inferredIntent: out.inferredIntent,
        aiSuggestions: out.aiSuggestions,
        uncertainties: out.uncertainties,
        optimizedPrompt,
        conservative,
        fidelityVerdict: fidelity.verdict,
        fidelityViolations: fidelity.violations,
        quality,
        performance: {
          intentCompilerDuration: Date.now() - startedAt,
          llmDuration,
          validationDuration,
          mode: input.mode,
          inputSource: input.inputSource
        }
      }
    };
  }

  /* ---------- improve / rewrite: existing prompt → better prompt ---------- */
  async function transform(kind, prompt, ctx) {
    const system = kind === "improve" ? improveSystemPrompt() : rewriteSystemPrompt();
    const rawOutput = await gateway.chatJson({ system, user: JSON.stringify(prompt) }, ctx);
    const out = sanitizeTransformOutput(rawOutput); // throws AI_BAD_RESPONSE upstream

    let next = optimizeStructured(out.prompt);

    // fidelity: the transform must not have changed the intent
    const fidelity = evaluateFidelity({
      rawInput: [prompt.objective, prompt.context, ...prompt.requirements].join(" "),
      optimizedText: [next.objective, next.context, ...next.requirements].join(" "),
      llmFidelity: out.fidelity,
      techTerms: terms.techTermsIn(prompt.objective + " " + prompt.context)
    });
    if (fidelity.verdict === "FAIL") {
      return prompt; // conservative: keep the user's original (spec §33)
    }
    return next;
  }

  return {
    analyze,
    improve: (prompt, ctx) => transform("improve", prompt, ctx),
    rewrite: (prompt, ctx) => transform("rewrite", prompt, ctx)
  };
}
