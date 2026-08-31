/* DeepSeekProvider tests (spec §15) — mock fetch only, never a real key */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeepSeekProvider } from "../server/ai/providers/deepseek.js";
import { isValidPrompt } from "../src/models/prompt.js";
import { VALID_PROMPT } from "./helpers.js";

const KEY = "test-key-12345";

function dsEnvelope(contentObj) {
  return {
    choices: [{ message: { role: "assistant", content: JSON.stringify(contentObj) } }]
  };
}

function mockFetch(impl) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return impl(url, options);
  };
  fetcher.calls = calls;
  return fetcher;
}

function okFetch(contentObj) {
  return mockFetch(async () => ({ ok: true, status: 200, json: async () => dsEnvelope(contentObj) }));
}

const ANALYZE_CONTENT = {
  detectedIntent: "website",
  prompt: { role: "Senior Designer", objective: "Build a site", context: "", requirements: ["Clear"], style: ["Minimal"], output: "" }
};

function makeProvider(fetchImpl) {
  return createDeepSeekProvider({
    apiKey: KEY, model: "deepseek-chat", baseUrl: "https://api.deepseek.com", fetchImpl
  });
}

/* 1. successful analyze */
test("1. analyze: envelope → AnalysisResult with valid prompt", async () => {
  const fetcher = okFetch(ANALYZE_CONTENT);
  const p = makeProvider(fetcher);
  const r = await p.analyzePrompt("create a website");
  assert.equal(r.detectedIntent, "website");
  assert.ok(isValidPrompt(r.prompt));
  // request shape: endpoint, auth header, model, json_object mode
  const { url, options } = fetcher.calls[0];
  assert.equal(url, "https://api.deepseek.com/chat/completions");
  assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(options.body);
  assert.equal(body.model, "deepseek-chat");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].role, "user");
});

/* 2. successful improve */
test("2. improve: returns schema-valid transformed prompt", async () => {
  const fetcher = okFetch({ prompt: { ...VALID_PROMPT, objective: "Improved objective" } });
  const p = makeProvider(fetcher);
  const r = await p.improvePrompt(VALID_PROMPT);
  assert.equal(r.objective, "Improved objective");
  assert.ok(isValidPrompt(r));
});

/* 3. successful rewrite */
test("3. rewrite: returns schema-valid transformed prompt", async () => {
  const fetcher = okFetch({ prompt: { ...VALID_PROMPT, objective: "Rewritten objective" } });
  const p = makeProvider(fetcher);
  const r = await p.rewritePrompt(VALID_PROMPT);
  assert.equal(r.objective, "Rewritten objective");
});

/* 4. authentication error (401/403) */
test("4. HTTP 401/403 → AI_AUTH_ERROR", async () => {
  const p401 = makeProvider(mockFetch(async () => ({ ok: false, status: 401, json: async () => ({}) })));
  await assert.rejects(() => p401.analyzePrompt("x"), (e) => e.code === "AI_AUTH_ERROR");
  const p403 = makeProvider(mockFetch(async () => ({ ok: false, status: 403, json: async () => ({}) })));
  await assert.rejects(() => p403.improvePrompt(VALID_PROMPT), (e) => e.code === "AI_AUTH_ERROR");
});

/* 5. HTTP 4xx (other) */
test("5. HTTP 400 → AI_BAD_REQUEST", async () => {
  const p = makeProvider(mockFetch(async () => ({ ok: false, status: 400, json: async () => ({}) })));
  await assert.rejects(() => p.analyzePrompt("x"), (e) => e.code === "AI_BAD_REQUEST");
});

/* 6. HTTP 429 */
test("6. HTTP 429 → AI_RATE_LIMITED", async () => {
  const p = makeProvider(mockFetch(async () => ({ ok: false, status: 429, json: async () => ({}) })));
  await assert.rejects(() => p.rewritePrompt(VALID_PROMPT), (e) => e.code === "AI_RATE_LIMITED");
});

/* 7. HTTP 5xx */
test("7. HTTP 500/503 → AI_PROVIDER_UNAVAILABLE", async () => {
  const p500 = makeProvider(mockFetch(async () => ({ ok: false, status: 500, json: async () => ({}) })));
  await assert.rejects(() => p500.analyzePrompt("x"), (e) => e.code === "AI_PROVIDER_UNAVAILABLE");
  const p503 = makeProvider(mockFetch(async () => ({ ok: false, status: 503, json: async () => ({}) })));
  await assert.rejects(() => p503.analyzePrompt("x"), (e) => e.code === "AI_PROVIDER_UNAVAILABLE");
});

/* 8. malformed JSON content */
test("8. model content not parseable → AI_BAD_RESPONSE", async () => {
  const fetcher = mockFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: "sure! here you go: {broken" } }] })
  }));
  const p = makeProvider(fetcher);
  await assert.rejects(() => p.analyzePrompt("x"), (e) => e.code === "AI_BAD_RESPONSE");
});

/* 9. invalid model response (JSON but wrong schema) */
test("9. model JSON fails schema → AI_BAD_RESPONSE", async () => {
  const p = makeProvider(okFetch({ prompt: { role: 42 } }));
  await assert.rejects(() => p.improvePrompt(VALID_PROMPT), (e) => e.code === "AI_BAD_RESPONSE");
  const p2 = makeProvider(okFetch({ nope: true }));
  await assert.rejects(() => p2.analyzePrompt("x"), (e) => e.code === "AI_BAD_RESPONSE");
});

/* 10. timeout-style hang + external abort → AI_ABORTED */
test("10. hanging fetch + AbortSignal → AI_ABORTED", async () => {
  const fetcher = mockFetch((url, options) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }));
  const p = makeProvider(fetcher);
  const controller = new AbortController();
  const promise = p.analyzePrompt("x", { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => promise, (e) => e.code === "AI_ABORTED");
});

/* 11. pre-aborted signal → AI_ABORTED */
test("11. pre-aborted signal → AI_ABORTED", async () => {
  const p = makeProvider(okFetch(ANALYZE_CONTENT));
  const controller = new AbortController();
  controller.abort();
  // fetch honors the aborted signal
  const fetcher = mockFetch((url, options) => {
    if (options.signal.aborted) {
      return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }
    return okFetch(ANALYZE_CONTENT)(url, options);
  });
  const p2 = makeProvider(fetcher);
  await assert.rejects(() => p2.analyzePrompt("x", { signal: controller.signal }), (e) => e.code === "AI_ABORTED");
});

/* 12. API key never exposed in errors */
test("12. thrown errors never contain the API key", async () => {
  const leakyFetch = mockFetch(async () => ({
    ok: false, status: 401,
    json: async () => ({ error: { message: `invalid key ${KEY}` } })
  }));
  const p = makeProvider(leakyFetch);
  const err = await p.analyzePrompt("x").catch((e) => e);
  assert.ok(!err.message.includes(KEY));
  assert.ok(!String(err.stack).includes(KEY));

  const networkDown = makeProvider(mockFetch(async () => { throw new Error(`ECONNREFUSED ${KEY}`); }));
  const err2 = await networkDown.analyzePrompt("x").catch((e) => e);
  assert.equal(err2.code, "AI_ERROR");
  assert.ok(!err2.message.includes(KEY));
});

/* 13. missing key → AI_AUTH_ERROR, and key is only sent server-side in headers */
test("13. unconfigured provider → AI_AUTH_ERROR; key only travels in Authorization header", async () => {
  const noKey = createDeepSeekProvider({ apiKey: "", fetchImpl: okFetch(ANALYZE_CONTENT) });
  await assert.rejects(() => noKey.analyzePrompt("x"), (e) => e.code === "AI_AUTH_ERROR");

  const fetcher = okFetch(ANALYZE_CONTENT);
  const p = makeProvider(fetcher);
  await p.analyzePrompt("x");
  const body = fetcher.calls[0].options.body;
  assert.ok(!body.includes(KEY)); // key never in request body, only the header
});

/* 14. registry resolves deepseek by name; demo stays intact */
test("14. registry resolves deepseek and demo side by side", async () => {
  const { createProviderRegistry } = await import("../server/ai/registry.js");
  const { createServerDemoProvider } = await import("../server/ai/providers/demo.js");
  const registry = createProviderRegistry()
    .register("demo", createServerDemoProvider({ latency: { analyze: 0, improve: 0, rewrite: 0 } }))
    .register("deepseek", makeProvider(okFetch(ANALYZE_CONTENT)));
  assert.ok(registry.has("deepseek"));
  assert.ok(registry.has("demo"));
  const r = await registry.get("deepseek").analyzePrompt("x");
  assert.equal(r.detectedIntent, "website");
  const d = await registry.get("demo").analyzePrompt("I want to create a website");
  assert.equal(d.prompt.role, "Senior Product Designer");
});

/* 15. network-level fetch failure → safe AI_ERROR (no raw error leak) */
test("15. fetch network failure → AI_ERROR without internals", async () => {
  const p = makeProvider(mockFetch(async () => { throw new Error("ENOTFOUND api.deepseek.com"); }));
  await assert.rejects(
    () => p.analyzePrompt("x"),
    (e) => e.code === "AI_ERROR" && !e.message.includes("ENOTFOUND")
  );
});
