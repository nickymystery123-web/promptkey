/* FallbackAIService — wraps a primary AIService with a degraded-mode backup.
   Only NETWORK failures (backend down / static hosting) trigger fallback;
   real AI errors (AI_ERROR/TIMEOUT/…) propagate so the UI error state works.
   This keeps the PRD "Demo First" promise: the product is always usable. */

export function createFallbackAIService(primary, fallback) {
  function wrap(method) {
    return async (...args) => {
      try {
        return await primary[method](...args);
      } catch (e) {
        if (e && e.code === "NETWORK_ERROR") {
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
