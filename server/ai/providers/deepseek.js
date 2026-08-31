/* DeepSeekProvider — real LLM transport layer (Phase 3B-1).

   Implements the existing AIProvider interface via DeepSeek's
   Chat Completions API. This is deliberately a *transport* layer:
   no product intelligence (ASR correction / intent reconstruction /
   scoring) lives here — that is Phase 3B-2's Prompt Intelligence Skill.

   - API key read ONLY from server env (constructor arg from config)
   - native fetch, AbortSignal passed straight through
   - model output is untrusted input: JSON.parse + schema validation
   - all failures map to the safe error system, never raw provider errors */

import { Errors } from "../../errors/http-error.js";
import { isValidPrompt, createStructuredPrompt } from "../../../src/models/prompt.js";
import { assertAIProvider } from "./provider-interface.js";

const SYSTEM_PROMPTS = {
  analyze:
    "You are a prompt structuring engine inside an AI input device. " +
    "Read the user's raw thought and respond with ONLY a JSON object (no markdown, no prose): " +
    '{"detectedIntent": string, "prompt": {"role": string, "objective": string, "context": string, "requirements": string[], "style": string[], "output": string}}. ' +
    "Fields may be empty strings or empty arrays when not applicable. Preserve the user's language.",
  improve:
    "You improve structured prompts: clearer expression, necessary context, better structure, no redundancy. " +
    "Respond with ONLY a JSON object (no markdown, no prose): " +
    '{"prompt": {"role": string, "objective": string, "context": string, "requirements": string[], "style": string[], "output": string}}. ' +
    "Keep the user's original intent and language.",
  rewrite:
    "You rewrite structured prompts: reorganize and rephrase them into a better-structured equivalent. " +
    "Respond with ONLY a JSON object (no markdown, no prose): " +
    '{"prompt": {"role": string, "objective": string, "context": string, "requirements": string[], "style": string[], "output": string}}. ' +
    "Keep the user's original intent and language."
};

export function createDeepSeekProvider({ apiKey, model, baseUrl, fetchImpl } = {}) {
  const fetcher = fetchImpl || globalThis.fetch;
  const endpoint = `${(baseUrl || "https://api.deepseek.com").replace(/\/+$/, "")}/chat/completions`;
  const modelName = model || "deepseek-chat";

  /* Generic JSON-mode call — the Intent Compiler owns its prompts and calls
     this directly. The provider stays a pure transport (spec §62). */
  async function chatJson({ system, user, signal }) {
    if (!apiKey) throw Errors.aiAuth("AI provider is not configured.");

    let res;
    try {
      res = await fetcher(endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          response_format: { type: "json_object" },
          temperature: 0.3,
          stream: false
        }),
        signal
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw Errors.aiAborted();
      throw Errors.aiError(); // network failure — no details leak
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw Errors.aiAuth();
      if (res.status === 429) throw Errors.aiRateLimited();
      if (res.status >= 500) throw Errors.aiProviderUnavailable();
      throw Errors.aiBadRequest();
    }

    let envelope;
    try {
      envelope = await res.json();
    } catch (e) {
      throw Errors.aiBadResponse();
    }

    const content = envelope && envelope.choices && envelope.choices[0]
      && envelope.choices[0].message && envelope.choices[0].message.content;
    if (typeof content !== "string") throw Errors.aiBadResponse();

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw Errors.aiBadResponse(); // model didn't honor the JSON contract
    }
    return parsed;
  }

  function requireValidPrompt(obj) {
    if (!obj || !isValidPrompt(obj.prompt)) throw Errors.aiBadResponse();
    return createStructuredPrompt(obj.prompt);
  }

  const provider = {
    name: "deepseek",
    model: modelName,

    // generic transport for the Intent Compiler (prompts supplied by caller)
    chatJson: (payload, options = {}) => chatJson({ system: payload.system, user: payload.user, signal: options.signal }),

    async analyzePrompt(input, options = {}) {
      const parsed = await chatJson({ system: SYSTEM_PROMPTS.analyze, user: String(input), signal: options.signal });
      const prompt = requireValidPrompt(parsed);
      return {
        prompt,
        detectedIntent: typeof parsed.detectedIntent === "string" ? parsed.detectedIntent : "unknown"
      };
    },

    async improvePrompt(prompt, options = {}) {
      const parsed = await chatJson({ system: SYSTEM_PROMPTS.improve, user: JSON.stringify(prompt), signal: options.signal });
      return requireValidPrompt(parsed);
    },

    async rewritePrompt(prompt, options = {}) {
      const parsed = await chatJson({ system: SYSTEM_PROMPTS.rewrite, user: JSON.stringify(prompt), signal: options.signal });
      return requireValidPrompt(parsed);
    }
  };

  return assertAIProvider(provider, "deepseek");
}
