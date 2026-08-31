/* Build — no bundler needed (native ES modules). This script:
   1. copies deployable files to dist/
   2. smoke-imports all pure (DOM-free) modules to prove they load
   3. prints a manifest */

import { mkdir, rm, cp, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const PURE_MODULES = [
  "src/state/actions.js",
  "src/state/machine.js",
  "src/state/store.js",
  "src/state/selectors.js",
  "src/models/prompt.js",
  "src/models/version.js",
  "src/models/session.js",
  "src/services/ai/interface.js",
  "src/services/ai/demo-provider.js",
  "src/services/ai/http-service.js",
  "src/services/ai/fallback-service.js",
  "src/services/voice/interface.js",
  "src/services/delivery/interface.js",
  "src/services/storage/local-storage.js",
  "src/flows/prompt-flow.js",
  "server/config/env.js",
  "server/errors/http-error.js",
  "server/lib/logger.js",
  "server/lib/json-body.js",
  "server/middleware/request-id.js",
  "server/middleware/rate-limit.js",
  "server/middleware/cors.js",
  "server/ai/providers/provider-interface.js",
  "server/ai/providers/demo.js",
  "server/ai/providers/deepseek.js",
  "server/ai/skills/intent-compiler/index.js",
  "server/ai/skills/intent-compiler/schema.js",
  "server/ai/skills/intent-compiler/normalizer.js",
  "server/ai/skills/intent-compiler/terminology.js",
  "server/ai/skills/intent-compiler/intent.js",
  "server/ai/skills/intent-compiler/context.js",
  "server/ai/skills/intent-compiler/structurer.js",
  "server/ai/skills/intent-compiler/fidelity.js",
  "server/ai/skills/intent-compiler/evaluator.js",
  "server/ai/skills/intent-compiler/prompts.js",
  "server/ai/registry.js",
  "server/ai/schemas/schemas.js",
  "server/ai/gateway/gateway.js",
  "server/controllers/controllers.js",
  "server/app.js"
];

async function listFiles(dir, base = dir, out = []) {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) await listFiles(full, base, out);
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

try {
  await rm(dist, { recursive: true, force: true });
} catch (e) {
  // Some environments shim fs.rm (trash-based safe delete) and it can fail on
  // large dirs. Overwrite-copy is safe here; warn instead of failing the build.
  console.warn("build: could not clean dist/ (" + e.message.slice(0, 60) + ") — overwriting instead");
}
await mkdir(dist, { recursive: true });

async function safeCp(src, dest, options = {}) {
  // Some environments shim fs.rm as a trash-based safe delete and it can fail
  // on individual files/directories. Pre-remove the destination so cp never
  // has to overwrite, avoiding trash errors during the copy.
  try { await rm(dest, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  await cp(src, dest, options);
}

await safeCp(join(root, "index.html"), join(dist, "index.html"));
await safeCp(join(root, "css"), join(dist, "css"), { recursive: true });
await safeCp(join(root, "src"), join(dist, "src"), { recursive: true });
await safeCp(join(root, "server"), join(dist, "server"), { recursive: true });
await safeCp(join(root, "package.json"), join(dist, "package.json"));
await safeCp(join(root, ".env.example"), join(dist, ".env.example"));

let ok = 0;
for (const m of PURE_MODULES) {
  await import(pathToFileURL(join(root, m)).href);
  ok++;
}

const files = await listFiles(dist);
console.log(`build OK — ${files.length} files copied to dist/, ${ok}/${PURE_MODULES.length} pure modules import cleanly`);
files.forEach((f) => console.log("  dist/" + f));
