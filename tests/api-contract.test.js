/* API contract tests (spec §10/§11/§12) + E2E chain (§21) over real HTTP */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, postJson, VALID_PROMPT } from "./helpers.js";
import { isValidPrompt } from "../src/models/prompt.js";

test("POST /api/v1/ai/analyze — contract: {analysis, structuredPrompt}", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await postJson(`${baseUrl}/api/v1/ai/analyze`, { input: "Create a website" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(typeof body.analysis.detectedIntent === "string");
    assert.ok(isValidPrompt(body.structuredPrompt));
    assert.ok(res.headers.get("x-request-id")?.startsWith("pk_req_"));
  } finally { await close(); }
});

test("POST /api/v1/ai/improve & /api/v1/ai/rewrite — contract: {prompt}", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const imp = await postJson(`${baseUrl}/api/v1/ai/improve`, { prompt: VALID_PROMPT });
    assert.equal(imp.status, 200);
    const impBody = await imp.json();
    assert.ok(isValidPrompt(impBody.prompt));
    assert.ok(impBody.prompt.objective.includes("with a clear structure"));

    const rw = await postJson(`${baseUrl}/api/v1/ai/rewrite`, { prompt: VALID_PROMPT });
    assert.equal(rw.status, 200);
    const rwBody = await rw.json();
    assert.ok(isValidPrompt(rwBody.prompt));
    assert.ok(rwBody.prompt.objective.startsWith("Deliver "));
  } finally { await close(); }
});

test("invalid requests → 400 VALIDATION_ERROR with unified error shape", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const r1 = await postJson(`${baseUrl}/api/v1/ai/analyze`, { wrong: 1 });
    assert.equal(r1.status, 400);
    assert.equal((await r1.json()).error.code, "VALIDATION_ERROR");

    const r2 = await postJson(`${baseUrl}/api/v1/ai/improve`, { prompt: { role: 123 } });
    assert.equal(r2.status, 400);

    const r3 = await postJson(`${baseUrl}/api/v1/ai/analyze`, "{not json");
    assert.equal(r3.status, 400);
    assert.equal((await r3.json()).error.code, "MALFORMED_JSON");

    // every error carries a request id and no stack trace
    const body = await postJson(`${baseUrl}/api/v1/ai/analyze`, {});
    const err = (await body.json()).error;
    assert.ok(err.requestId.startsWith("pk_req_"));
    assert.ok(!JSON.stringify(err).includes("at "));
  } finally { await close(); }
});

test("E2E (§21): analyze → improve → rewrite chain over HTTP", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const a = await (await postJson(`${baseUrl}/api/v1/ai/analyze`, {
      input: "Create a presentation about AI adoption in universities."
    })).json();
    assert.ok(isValidPrompt(a.structuredPrompt));

    const i = await (await postJson(`${baseUrl}/api/v1/ai/improve`, { prompt: a.structuredPrompt })).json();
    assert.ok(isValidPrompt(i.prompt));

    const r = await (await postJson(`${baseUrl}/api/v1/ai/rewrite`, { prompt: i.prompt })).json();
    assert.ok(isValidPrompt(r.prompt));
    assert.ok(r.prompt.objective.length > 0);
  } finally { await close(); }
});
