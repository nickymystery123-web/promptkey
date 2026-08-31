/* Shared test helpers — start a real server on an ephemeral port. */

import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config/env.js";

export const silentLogger = { request() {} };

export function startServer({ config = {}, registry } = {}) {
  const app = createApp({
    // Tests must never depend on a real .env or API key: demo is the default.
    config: loadConfig({ PORT: "0", AI_MODE: "demo", AI_PROVIDER: "demo", AI_API_KEY: "", RATE_LIMIT_PER_MIN: "10000", ...config }),
    registry,
    logger: silentLogger
  });
  return new Promise((resolve) => {
    app.server.listen(0, "127.0.0.1", () => {
      const { port } = app.server.address();
      resolve({
        app,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => app.server.close(r))
      });
    });
  });
}

export async function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

export const VALID_PROMPT = {
  role: "Designer",
  objective: "Create something",
  context: "",
  requirements: ["Clear"],
  style: ["Minimal"],
  output: ""
};
