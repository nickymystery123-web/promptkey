/* AI Gateway tests (spec §20) — all 8 required cases */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../server/ai/gateway/gateway.js";
import { createProviderRegistry } from "../server/ai/registry.js";
import { createServerDemoProvider } from "../server/ai/providers/demo.js";
import { assignRequestId } from "../server/middleware/request-id.js";
import { validateAnalyzeRequest } from "../server/ai/schemas/schemas.js";
import { silentLogger, VALID_PROMPT } from "./helpers.js";

function makeGateway({ providerName = "demo", timeoutMs = 30000, providers = {} } = {}) {
  const registry = createProviderRegistry();
  registry.register("demo", createServerDemoProvider({ latency: { analyze: 0, improve: 0, rewrite: 0 } }));
  for (const [name, p] of Object.entries(providers)) registry.register(name, p);
  return createGateway({
    registry,
    config: { AI_PROVIDER: providerName, AI_TIMEOUT_MS: timeoutMs, AI_MODEL: "" },
    logger: silentLogger
  });
}

const ctx = () => ({ requestId: "pk_req_test", route: "/api/v1/ai/analyze", signal: undefined });

test("1. demo provider works through the gateway", async () => {
  const gw = makeGateway();
  const r = await gw.analyze("I want to create a website", ctx());
  assert.equal(r.prompt.role, "Senior Product Designer");
  assert.equal(r.detectedIntent, "website");
});

test("2. provider not found → PROVIDER_NOT_FOUND", async () => {
  const gw = makeGateway({ providerName: "does-not-exist" });
  await assert.rejects(() => gw.analyze("x", ctx()), (e) => e.code === "PROVIDER_NOT_FOUND");
});

test("3. malformed request → VALIDATION_ERROR (schema layer)", () => {
  assert.throws(() => validateAnalyzeRequest({}), (e) => e.code === "VALIDATION_ERROR");
  assert.throws(() => validateAnalyzeRequest({ input: "   " }), (e) => e.code === "VALIDATION_ERROR");
  assert.throws(() => validateAnalyzeRequest({ input: "x".repeat(2001) }), (e) => e.code === "VALIDATION_ERROR");
});

test("4. malformed provider response → AI_BAD_RESPONSE", async () => {
  const junk = {
    analyzePrompt: async () => ({ nope: true }),
    improvePrompt: async () => "not-a-prompt",
    rewritePrompt: async () => null
  };
  const gw = makeGateway({ providerName: "junk", providers: { junk } });
  await assert.rejects(() => gw.analyze("x", ctx()), (e) => e.code === "AI_BAD_RESPONSE");
  await assert.rejects(() => gw.improve(VALID_PROMPT, ctx()), (e) => e.code === "AI_BAD_RESPONSE");
});

test("5. slow provider + timeout → AI_TIMEOUT", async () => {
  const slow = {
    analyzePrompt: () => new Promise((r) => setTimeout(r, 500)),
    improvePrompt: () => new Promise((r) => setTimeout(r, 500)),
    rewritePrompt: () => new Promise((r) => setTimeout(r, 500))
  };
  const gw = makeGateway({ providerName: "slow", timeoutMs: 40, providers: { slow } });
  await assert.rejects(() => gw.analyze("x", ctx()), (e) => e.code === "AI_TIMEOUT" && e.status === 504);
});

test("6. provider throws → safe AI_ERROR (no internal leak)", async () => {
  const broken = {
    analyzePrompt: async () => { throw new Error("secret internal detail: api_key=sk-12345"); },
    improvePrompt: async () => { throw new Error("secret internal detail"); },
    rewritePrompt: async () => { throw new Error("secret internal detail"); }
  };
  const gw = makeGateway({ providerName: "broken", providers: { broken } });
  await assert.rejects(
    () => gw.analyze("x", ctx()),
    (e) => e.code === "AI_ERROR" && !e.message.includes("sk-12345")
  );
});

test("7. abort signal → AI_ABORTED", async () => {
  const slow = {
    analyzePrompt: () => new Promise((r) => setTimeout(r, 500)),
    improvePrompt: async () => ({}),
    rewritePrompt: async () => ({})
  };
  const gw = makeGateway({ providerName: "slow", timeoutMs: 5000, providers: { slow } });
  const controller = new AbortController();
  const promise = gw.analyze("x", { ...ctx(), signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => promise, (e) => e.code === "AI_ABORTED");
});

test("8. request id exists and follows the pk_req_ format", () => {
  const req = {}, headers = {};
  const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; } };
  const id = assignRequestId(req, res);
  assert.ok(id.startsWith("pk_req_"));
  assert.equal(req.requestId, id);
  assert.equal(headers["x-request-id"], id);
});

test("architecture acceptance (§22): swapping demo for another provider needs no caller change", async () => {
  // MockHttpProvider-shaped replacement registered under a different name;
  // callers still just call gateway.analyze/improve/rewrite.
  const mockHttp = {
    model: "mock-http-v1",
    analyzePrompt: async (input) => ({
      prompt: { role: "MockRole", objective: input, context: "", requirements: [], style: [], output: "" },
      detectedIntent: "mock"
    }),
    improvePrompt: async (p) => ({ ...p, objective: p.objective + " [mock-improved]" }),
    rewritePrompt: async (p) => ({ ...p, objective: "[mock-rewritten] " + p.objective })
  };
  const gw = makeGateway({ providerName: "mock-http", providers: { "mock-http": mockHttp } });
  const a = await gw.analyze("hello", ctx());
  assert.equal(a.prompt.role, "MockRole");
  const i = await gw.improve(VALID_PROMPT, ctx());
  assert.ok(i.objective.includes("[mock-improved]"));
});
