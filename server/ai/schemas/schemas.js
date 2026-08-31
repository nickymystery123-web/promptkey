/* Request/Response schemas (spec §11).
   Trust nothing: not the browser, not the provider, not the JSON.
   StructuredPrompt shape comes from the shared model definition. */

import { isValidPrompt, createStructuredPrompt } from "../../../src/models/prompt.js";
import { Errors } from "../../errors/http-error.js";

const MAX_INPUT = 2000; // PRD: max thought length

export function validateAnalyzeRequest(body) {
  if (!body || typeof body.input !== "string") {
    throw Errors.validation('Field "input" (string) is required.');
  }
  const input = body.input.trim();
  if (!input) throw Errors.validation('Field "input" must not be empty.');
  if (input.length > MAX_INPUT) {
    throw Errors.validation(`Field "input" exceeds ${MAX_INPUT} characters.`);
  }
  // additive optional fields (Intent Compiler); invalid values fall back to defaults
  const inputSource = ["voice", "text"].includes(body.inputSource) ? body.inputSource : "text";
  const mode = ["quick", "deep"].includes(body.mode) ? body.mode : "quick";
  const context = body.context && typeof body.context === "object" ? body.context : null;
  return { input, inputSource, mode, context };
}

export function validatePromptRequest(body) {
  if (!body || typeof body.prompt !== "object" || body.prompt === null) {
    throw Errors.validation('Field "prompt" (object) is required.');
  }
  if (!isValidPrompt(body.prompt)) {
    throw Errors.validation('Field "prompt" does not match the StructuredPrompt schema.');
  }
  // normalize: strips unexpected fields, coerces arrays
  return { prompt: createStructuredPrompt(body.prompt) };
}

export function validateAnalysisResponse(result) {
  if (!result || typeof result !== "object" || !isValidPrompt(result.prompt)) {
    throw Errors.aiBadResponse();
  }
  return {
    prompt: createStructuredPrompt(result.prompt),
    detectedIntent: typeof result.detectedIntent === "string" ? result.detectedIntent : "unknown"
  };
}

export function validatePromptResponse(result) {
  if (!isValidPrompt(result)) throw Errors.aiBadResponse();
  return createStructuredPrompt(result);
}
