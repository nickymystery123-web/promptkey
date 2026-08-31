/* Lint — architecture guardrails:
   Frontend (src/):
   - no debugger / console.log
   - no DOM queries or classList outside ui/ and main.js
   - no API-key-shaped secrets anywhere in src/ or index.html (spec §19)
   Backend (server/):
   - no debugger / console.log (use logger / process.stdout.write)
   - process.env only inside config/env.js
   index.html must reference the module entry */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function walk(dir, out = []) {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) await walk(full, out);
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

const violations = [];
const DOM_ALLOWED = /src[\\/]ui[\\/]|src[\\/]main\.js$/;
const SECRET_PATTERN = /AI_API_KEY|sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]\s*["'][A-Za-z0-9]|Bearer\s+[A-Za-z0-9._-]{6,}|api\.deepseek\.com/i;

/* ---- frontend rules ---- */
for (const file of await walk(join(root, "src"))) {
  const code = await readFile(file, "utf8");
  const rel = relative(root, file);
  if (/\bdebugger\b/.test(code)) violations.push(`${rel}: contains debugger`);
  if (/console\.log\(/.test(code)) violations.push(`${rel}: console.log in src`);
  if (SECRET_PATTERN.test(code)) violations.push(`${rel}: possible secret/API key in frontend (forbidden, spec §19)`);
  if (!DOM_ALLOWED.test(rel)) {
    if (/document\.querySelector|getElementById/.test(code)) {
      violations.push(`${rel}: DOM query outside ui/ (architecture leak)`);
    }
    if (/classList\.(add|remove|toggle)/.test(code)) {
      violations.push(`${rel}: classList mutation outside ui/ (architecture leak)`);
    }
  }
}

/* ---- backend rules ---- */
for (const file of await walk(join(root, "server"))) {
  const code = await readFile(file, "utf8");
  const rel = relative(root, file);
  if (/\bdebugger\b/.test(code)) violations.push(`${rel}: contains debugger`);
  if (/console\.log\(/.test(code)) violations.push(`${rel}: console.log in server (use logger)`);
  if (/process\.env/.test(code) && !/config[\\/]env\.js$/.test(rel)) {
    violations.push(`${rel}: process.env read outside config/env.js`);
  }
}

const html = await readFile(join(root, "index.html"), "utf8");
if (!html.includes('type="module" src="src/main.js"')) {
  violations.push("index.html: must load src/main.js as module");
}
if (SECRET_PATTERN.test(html)) violations.push("index.html: possible secret/API key in HTML (forbidden, spec §19)");

if (violations.length) {
  console.error("lint FAILED:");
  violations.forEach((v) => console.error("  ✗ " + v));
  process.exit(1);
}
console.log("lint OK — frontend/backend guardrails hold (DOM only in ui/+main.js, env only in config/env.js, no secrets in frontend)");
