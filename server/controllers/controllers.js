/* Controllers — thin: parse → validate → gateway → respond. */

import { readJsonBody } from "../lib/json-body.js";
import { validateAnalyzeRequest, validatePromptRequest } from "../ai/schemas/schemas.js";

export function createHealthController() {
  return {
    async handle(req, res) {
      return { status: 200, body: { status: "ok" } };
    }
  };
}

export function createAIController({ gateway, config }) {
  function ctx(req, route) {
    // cancellation: browser closed/navigated away mid-request (spec §15)
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    return { requestId: req.requestId, route, signal: controller.signal };
  }

  return {
    async analyze(req, res) {
      const body = await readJsonBody(req, config.BODY_LIMIT_BYTES);
      const { input, inputSource, mode, context } = validateAnalyzeRequest(body);
      // optional additive fields (inputSource/mode/context) are used by the
      // Intent Compiler and ignored by the plain gateway — contract unchanged
      const result = await gateway.analyze(input, ctx(req, "/api/v1/ai/analyze"), { inputSource, mode, context });
      return {
        status: 200,
        body: {
          analysis: { detectedIntent: result.detectedIntent, ...(result.meta ? { compiler: result.meta } : {}) },
          structuredPrompt: result.prompt
        }
      };
    },
    async improve(req, res) {
      const body = await readJsonBody(req, config.BODY_LIMIT_BYTES);
      const { prompt } = validatePromptRequest(body);
      const next = await gateway.improve(prompt, ctx(req, "/api/v1/ai/improve"));
      return { status: 200, body: { prompt: next } };
    },
    async rewrite(req, res) {
      const body = await readJsonBody(req, config.BODY_LIMIT_BYTES);
      const { prompt } = validatePromptRequest(body);
      const next = await gateway.rewrite(prompt, ctx(req, "/api/v1/ai/rewrite"));
      return { status: 200, body: { prompt: next } };
    }
  };
}
