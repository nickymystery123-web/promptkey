/* Backend — server startup & health API (spec §5) */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.js";

test("server starts and /api/v1/health returns 200 + schema + request id", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: "ok" });
    assert.ok(res.headers.get("x-request-id")?.startsWith("pk_req_"));
  } finally {
    await close();
  }
});

test("static frontend is served (index.html at /)", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("PromptKey"));
  } finally {
    await close();
  }
});

test("unknown API route → 404 with unified error shape", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/api/v1/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "NOT_FOUND");
    assert.ok(body.error.requestId.startsWith("pk_req_"));
  } finally {
    await close();
  }
});

test("GET on POST-only endpoint → 405", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/api/v1/ai/analyze`);
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
  } finally {
    await close();
  }
});
