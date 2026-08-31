/* AI Gateway (spec §7) — the single doorway between API controllers and providers.

   Responsibilities:
   1. pick provider from the registry (config-driven)
   2. call provider with timeout + abort guards
   3. validate provider output against response schemas
   4. normalize all errors to safe HttpErrors
   5. log metadata (requestId/provider/model/duration/status)
   Never exposes secrets; business code never touches providers directly. */

import { Errors } from "../../errors/http-error.js";
import { validateAnalysisResponse, validatePromptResponse } from "../schemas/schemas.js";

function withGuards(fn, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn2, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn2(value);
    };
    const onAbort = () => finish(reject, Errors.aiAborted());
    const timer = setTimeout(() => finish(reject, Errors.aiTimeout()), timeoutMs);
    if (signal) {
      if (signal.aborted) return finish(reject, Errors.aiAborted());
      signal.addEventListener("abort", onAbort);
    }
    Promise.resolve()
      .then(fn)
      .then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}

export function createGateway({ registry, config, logger }) {
  async function call(kind, payload, ctx) {
    const startedAt = Date.now();
    const provider = registry.get(config.AI_PROVIDER); // throws PROVIDER_NOT_FOUND
    const model = provider.model || config.AI_MODEL || "unspecified";
    let status = 200;
    let errorCode;

    try {
      const raw = await withGuards(
        // options arg (incl. AbortSignal) is passed through to the provider (spec §6)
        () => provider[kind](payload, { signal: ctx.signal }),
        { timeoutMs: config.AI_TIMEOUT_MS, signal: ctx.signal }
      );
      // response schema validation — trust nothing from providers
      if (kind === "chatJson") {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Errors.aiBadResponse();
        return raw;
      }
      return kind === "analyzePrompt" ? validateAnalysisResponse(raw) : validatePromptResponse(raw);
    } catch (err) {
      errorCode = err.code || "AI_ERROR";
      status = err.status || 502;
      if (!err.status) throw Errors.aiError(); // unknown provider error → safe wrapper
      throw err;
    } finally {
      logger.request({
        requestId: ctx.requestId,
        route: ctx.route,
        provider: config.AI_PROVIDER,
        model,
        durationMs: Date.now() - startedAt,
        status,
        errorCode,
        inputPreview: typeof payload === "string" ? payload : undefined
      });
    }
  }

  return {
    analyze: (input, ctx) => call("analyzePrompt", input, ctx),
    improve: (prompt, ctx) => call("improvePrompt", prompt, ctx),
    rewrite: (prompt, ctx) => call("rewritePrompt", prompt, ctx),
    // generic JSON-mode passthrough for the Intent Compiler (same guards:
    // timeout, abort, logging, safe errors). Response validated as object only —
    // strict schema validation belongs to the caller (the Skill).
    chatJson: (payload, ctx) => call("chatJson", payload, ctx)
  };
}
