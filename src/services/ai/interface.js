/* AIService contract (spec §10).
   UI never calls a concrete model — only this interface:

   interface AIService {
     analyzePrompt(input: string): Promise<AnalysisResult>
     improvePrompt(prompt: StructuredPrompt): Promise<StructuredPrompt>
     rewritePrompt(prompt: StructuredPrompt): Promise<StructuredPrompt>
   }

   AnalysisResult = { prompt: StructuredPrompt, detectedIntent: string }

   Implementations:
     - DemoAIProvider      (this phase, deterministic, offline)
     - HttpAIProvider      (Phase 3 — thin backend proxy, real LLM)
     - FallbackAIProvider  (wraps another provider, degrades to Demo on failure)
*/

export function assertAIService(service) {
  ["analyzePrompt", "improvePrompt", "rewritePrompt"].forEach((m) => {
    if (typeof service[m] !== "function") {
      throw new Error("AIService missing method: " + m);
    }
  });
  return service;
}
