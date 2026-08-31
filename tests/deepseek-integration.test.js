/* DeepSeek integration tests (spec §16/§17):
   HTTP → Controller → Gateway → Registry → DeepSeekProvider → mocked transport
   + security verification (no secrets anywhere browser-visible) */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, postJson } from "./helpers.js";
import { createProviderRegistry } from "../server/ai/registry.js";
import { createServerDemoProvider } from "../server/ai/providers/demo.js";
import { createDeepSeekProvider } from "../server/ai/providers/deepseek.js";
import { isValidPrompt } from "../src/models/prompt.js";

const KEY = "test-key-integration";

function makeMockTransport(calls) {
  return async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{
          message: {
            // Intent Compiler rich format (Phase 3B-2): the compiler validates
            // and maps this to the public API contract
            content: JSON.stringify({
              correctedInput: "Create a presentation about AI adoption in universities.",
              corrections: [],
              intent: {
                task: "presentation",
                object: "AI adoption in universities",
                goal: ["Create a presentation about AI adoption in universities"],
                context: ["For university administrators"],
                requirements: ["Evidence-based", "Clear structure"],
                constraints: [],
                preferences: ["Professional", "Engaging"],
                expectedOutput: "Slide outline",
                subtasks: []
              },
              inferredIntent: [],
              aiSuggestions: [],
              uncertainties: [],
              optimizedPrompt: "Create a presentation about AI adoption in universities, evidence-based and clearly structured.",
              structured: {
                role: "Education Consultant",
                objective: "Create a presentation about AI adoption in universities",
                context: "For university administrators",
                requirements: ["Evidence-based", "Clear structure"],
                style: ["Professional", "Engaging"],
                output: "Slide outline"
              },
              fidelity: { intentFidelity: 0.96, semanticChanges: [], addedAssumptions: [], removedRequirements: [] }
            })
          }
        }]
      })
    };
  };
}

test("integration: POST /api/v1/ai/analyze with AI_PROVIDER=deepseek (mocked transport)", async () => {
  const calls = [];
  const registry = createProviderRegistry()
    .register("demo", createServerDemoProvider({ latency: { analyze: 0, improve: 0, rewrite: 0 } }))
    .register("deepseek", createDeepSeekProvider({
      apiKey: KEY, model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: makeMockTransport(calls)
    }));

  const { baseUrl, close } = await startServer({
    config: { AI_MODE: "real", AI_PROVIDER: "deepseek", AI_API_KEY: KEY },
    registry
  });
  try {
    const res = await postJson(`${baseUrl}/api/v1/ai/analyze`, {
      input: "Create a presentation about AI adoption in universities."
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.analysis.detectedIntent, "presentation");
    assert.ok(isValidPrompt(body.structuredPrompt));
    assert.equal(body.structuredPrompt.role, "Education Consultant");

    // the mock transport was hit with the key server-side
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${KEY}`);
    // response carries no secret
    assert.ok(!JSON.stringify(body).includes(KEY));
  } finally { await close(); }
});

test("integration: AI_MODE=demo still forces demo provider", async () => {
  const calls = [];
  const registry = createProviderRegistry()
    .register("demo", createServerDemoProvider({ latency: { analyze: 0, improve: 0, rewrite: 0 } }))
    .register("deepseek", createDeepSeekProvider({
      apiKey: KEY, fetchImpl: makeMockTransport(calls)
    }));
  const { baseUrl, close } = await startServer({
    config: { AI_MODE: "demo", AI_PROVIDER: "deepseek" },
    registry
  });
  try {
    const res = await postJson(`${baseUrl}/api/v1/ai/analyze`, { input: "I want to create a website" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.structuredPrompt.role, "Senior Product Designer"); // demo rules
    assert.equal(calls.length, 0); // deepseek transport never touched
  } finally { await close(); }
});

test("integration: gateway logger never records Authorization or key", async () => {
  const calls = [];
  const logEntries = [];
  const capturingLogger = { request: (e) => logEntries.push(e) };
  const registry = createProviderRegistry()
    .register("deepseek", createDeepSeekProvider({
      apiKey: KEY, fetchImpl: makeMockTransport(calls)
    }));
  const { createApp } = await import("../server/app.js");
  const { loadConfig } = await import("../server/config/env.js");
  const app = createApp({
    config: loadConfig({ PORT: "0", AI_MODE: "real", AI_PROVIDER: "deepseek", AI_API_KEY: KEY, RATE_LIMIT_PER_MIN: "10000" }),
    registry,
    logger: capturingLogger
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = app.server.address().port;
  try {
    await postJson(`http://127.0.0.1:${port}/api/v1/ai/analyze`, { input: "hello world" });
    assert.ok(logEntries.length >= 1);
    const blob = JSON.stringify(logEntries);
    assert.ok(!blob.includes(KEY));
    assert.ok(!blob.includes("Authorization"));
    assert.ok(!blob.includes("Bearer"));
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test("security (§17): frontend sources and HTML contain no secrets or provider credentials", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const FORBIDDEN = [/AI_API_KEY/, /Bearer\s+[A-Za-z0-9._-]{6,}/, /api\.deepseek\.com/, new RegExp(KEY)];

  async function* walk(dir) {
    for (const entry of await readdir(dir)) {
      const full = join(dir, entry);
      if ((await stat(full)).isDirectory()) yield* walk(full);
      else if (/\.(js|html|css)$/.test(entry)) yield full;
    }
  }
  const targets = [join(root, "src"), join(root, "dist", "src")];
  for (const dir of targets) {
    for await (const file of walk(dir)) {
      const code = await readFile(file, "utf8");
      for (const pattern of FORBIDDEN) {
        assert.ok(!pattern.test(code), `forbidden pattern ${pattern} in ${file}`);
      }
    }
  }
  const html = await readFile(join(root, "index.html"), "utf8");
  for (const pattern of FORBIDDEN) assert.ok(!pattern.test(html));

  const gitignore = await readFile(join(root, ".gitignore"), "utf8");
  assert.ok(gitignore.includes(".env"));
});
