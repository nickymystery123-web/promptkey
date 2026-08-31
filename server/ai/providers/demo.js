/* Demo provider (backend side) — reuses the frontend's pure DemoAIProvider
   module directly. One implementation, zero duplication. */

import { createDemoAIProvider } from "../../../src/services/ai/demo-provider.js";
import { assertAIProvider } from "./provider-interface.js";

export function createServerDemoProvider(options = {}) {
  const inner = createDemoAIProvider({
    latency: options.latency ?? { analyze: 300, improve: 600, rewrite: 600 }
  });
  return assertAIProvider({
    name: "demo",
    model: "demo-rules-v1",
    analyzePrompt: (input) => inner.analyzePrompt(input),
    improvePrompt: (prompt) => inner.improvePrompt(prompt),
    rewritePrompt: (prompt) => inner.rewritePrompt(prompt)
  }, "demo");
}
