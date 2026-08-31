/* Environment configuration — the ONLY place process.env is read (lint-enforced).
   .env is parsed manually (no dependency); real .env is git-ignored. */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // server/config → project root

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2];
  }
  return out;
}

export function loadConfig(overrides = {}) {
  const fileEnv = parseEnvFile(join(root, ".env"));
  const get = (key, fallback) =>
    overrides[key] ?? process.env[key] ?? fileEnv[key] ?? fallback;

  return {
    PORT: Number(get("PORT", "8787")),
    HOST: get("HOST", "127.0.0.1"),
    AI_MODE: get("AI_MODE", "demo"),
    AI_PROVIDER: get("AI_PROVIDER", "demo"),
    AI_MODEL: get("AI_MODEL", ""),
    AI_API_KEY: get("AI_API_KEY", ""),        // server-side only, never shipped to browser
    AI_BASE_URL: get("AI_BASE_URL", ""),
    AI_TIMEOUT_MS: Number(get("AI_TIMEOUT_MS", "30000")),
    BODY_LIMIT_BYTES: Number(get("BODY_LIMIT_BYTES", "65536")),
    RATE_LIMIT_PER_MIN: Number(get("RATE_LIMIT_PER_MIN", "60")),
    CORS_ORIGIN: get("CORS_ORIGIN", "*"),
    LOG_INPUT_PREVIEW: get("LOG_INPUT_PREVIEW", "false") === "true"
  };
}
