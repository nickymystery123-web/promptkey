/* FallbackAIService — wraps a primary AIService with a degraded-mode backup.
   Only NETWORK failures (backend down / static hosting) trigger fallback;
   real AI errors (AI_ERROR/TIMEOUT/…) propagate so the UI error state works.
   This keeps the PRD "Demo First" promise: the product is always usable.

   3C-3A §5 (AI Mode Visibility): an optional onMode(mode) callback reports
   which transport actually answered — "real" (primary succeeded) or "demo"
   (NETWORK_ERROR → local fallback engaged). Demo must never masquerade as
   Real, and a later recovery flips the indicator back to "real" (§5.4). */

export function createFallbackAIService(primary, fallback, { onMode } = {}) {
  function report(mode) {
    if (typeof onMode === "function") {
      try { onMode(mode); } catch (e) { /* indicator must never break the flow */ }
    }
  }
  function wrap(method) {
    return async (...args) => {
      try {
        const result = await primary[method](...args);
        report("real");
        return result;
      } catch (e) {
        if (e && e.code === "NETWORK_ERROR") {
          report("demo");
          return fallback[method](...args);
        }
        throw e;
      }
    };
  }
  return {
    analyzePrompt: wrap("analyzePrompt"),
    improvePrompt: wrap("improvePrompt"),
    rewritePrompt: wrap("rewritePrompt")
  };
}
