/* AIProvider interface (spec §8) — same three-method contract as the
   frontend AIService, so any provider slots in on either side:

   interface AIProvider {
     analyzePrompt(input: string): Promise<AnalysisResult>
     improvePrompt(prompt: StructuredPrompt): Promise<StructuredPrompt>
     rewritePrompt(prompt: StructuredPrompt): Promise<StructuredPrompt>
   }

   Interchangeable: DemoAIProvider | HttpAIProvider | ProviderA/B | LocalModel */

export function assertAIProvider(provider, name = "provider") {
  ["analyzePrompt", "improvePrompt", "rewritePrompt"].forEach((m) => {
    if (typeof provider[m] !== "function") {
      throw new Error(`AIProvider "${name}" missing method: ${m}`);
    }
  });
  return provider;
}
