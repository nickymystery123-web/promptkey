/* Frontend HttpAIService + FallbackAIService tests */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpAIService } from "../src/services/ai/http-service.js";
import { createFallbackAIService } from "../src/services/ai/fallback-service.js";
import { createDemoAIProvider } from "../src/services/ai/demo-provider.js";
import { VALID_PROMPT } from "./helpers.js";

function stubFetch(routes) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const route = Object.keys(routes).find((k) => url.endsWith(k));
    if (!route) throw new TypeError("fetch failed");
    const r = routes[route];
    if (r.throw) throw r.throw;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body
    };
  };
  fetcher.calls = calls;
  return fetcher;
}

const ANALYZE_OK = {
  analysis: { detectedIntent: "website" },
  structuredPrompt: VALID_PROMPT
};

test("http service maps analyze response to AnalysisResult", async () => {
  const fetcher = stubFetch({ "/api/v1/ai/analyze": { body: ANALYZE_OK } });
  const ai = createHttpAIService({ fetchImpl: fetcher });
  const r = await ai.analyzePrompt("Create a website");
  assert.equal(r.detectedIntent, "website");
  assert.deepEqual(r.prompt, VALID_PROMPT);
  // request body contract
  assert.equal(JSON.parse(fetcher.calls[0].options.body).input, "Create a website");
});

test("http service maps improve/rewrite responses", async () => {
  const fetcher = stubFetch({
    "/api/v1/ai/improve": { body: { prompt: { ...VALID_PROMPT, objective: "I2" } } },
    "/api/v1/ai/rewrite": { body: { prompt: { ...VALID_PROMPT, objective: "R2" } } }
  });
  const ai = createHttpAIService({ fetchImpl: fetcher });
  assert.equal((await ai.improvePrompt(VALID_PROMPT)).objective, "I2");
  assert.equal((await ai.rewritePrompt(VALID_PROMPT)).objective, "R2");
});

test("server error body → throws its error code (no fallback trigger)", async () => {
  const fetcher = stubFetch({
    "/api/v1/ai/analyze": {
      ok: false, status: 504,
      body: { error: { code: "AI_TIMEOUT", message: "t", requestId: "pk_req_1" } }
    }
  });
  const ai = createHttpAIService({ fetchImpl: fetcher });
  await assert.rejects(() => ai.analyzePrompt("x"), (e) => e.code === "AI_TIMEOUT" && e.requestId === "pk_req_1");
});

test("network failure / non-JSON error → NETWORK_ERROR", async () => {
  const fetcher = stubFetch({ "/api/v1/ai/analyze": { throw: new TypeError("fetch failed") } });
  const ai = createHttpAIService({ fetchImpl: fetcher });
  await assert.rejects(() => ai.analyzePrompt("x"), (e) => e.code === "NETWORK_ERROR");

  const html404 = stubFetch({ "/api/v1/ai/analyze": { ok: false, status: 404, body: null } });
  const ai2 = createHttpAIService({ fetchImpl: html404 });
  await assert.rejects(() => ai2.analyzePrompt("x"), (e) => e.code === "NETWORK_ERROR");
});

test("abort → AI_ABORTED", async () => {
  const fetcher = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
  const ai = createHttpAIService({ fetchImpl: fetcher });
  await assert.rejects(() => ai.analyzePrompt("x"), (e) => e.code === "AI_ABORTED");
});

test("fallback: NETWORK_ERROR falls back to demo; AI_TIMEOUT does not", async () => {
  const demo = createDemoAIProvider({ latency: { analyze: 0, improve: 0, rewrite: 0 } });

  const down = createHttpAIService({ fetchImpl: async () => { throw new TypeError("down"); } });
  const withFallback = createFallbackAIService(down, demo);
  const r = await withFallback.analyzePrompt("I want to create a website");
  assert.equal(r.prompt.role, "Senior Product Designer"); // served by demo

  const failing = createHttpAIService({
    fetchImpl: async () => ({
      ok: false, status: 504,
      json: async () => ({ error: { code: "AI_TIMEOUT", message: "t", requestId: "pk_req_2" } })
    })
  });
  const noFallback = createFallbackAIService(failing, demo);
  await assert.rejects(() => noFallback.analyzePrompt("x"), (e) => e.code === "AI_TIMEOUT");
});
