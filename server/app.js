/* App — router, middleware chain, static hosting. No listen() here
   (tests import createApp and bind to ephemeral ports themselves). */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config/env.js";
import { createLogger } from "./lib/logger.js";
import { toHttpError, Errors } from "./errors/http-error.js";
import { assignRequestId } from "./middleware/request-id.js";
import { createRateLimiter } from "./middleware/rate-limit.js";
import { applyCors } from "./middleware/cors.js";
import { createProviderRegistry } from "./ai/registry.js";
import { createServerDemoProvider } from "./ai/providers/demo.js";
import { createDeepSeekProvider } from "./ai/providers/deepseek.js";
import { createGateway } from "./ai/gateway/gateway.js";
import { createIntentCompiler } from "./ai/skills/intent-compiler/index.js";
import { createHealthController, createAIController } from "./controllers/controllers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

export function createApp({ config: configOverride, registry: registryOverride, logger: loggerOverride } = {}) {
  const config = configOverride || loadConfig();
  const logger = loggerOverride || createLogger({ logInputPreview: config.LOG_INPUT_PREVIEW });

  // All providers registered here; the registry is the ONLY place that
  // knows provider names. AI_MODE=demo forces the demo provider (spec §13);
  // otherwise config.AI_PROVIDER selects.
  const registry = registryOverride || createProviderRegistry()
    .register("demo", createServerDemoProvider())
    .register("deepseek", createDeepSeekProvider({
      apiKey: config.AI_API_KEY,
      model: config.AI_MODEL || "deepseek-chat",
      baseUrl: config.AI_BASE_URL
    }));
  const activeProvider = config.AI_MODE === "demo" ? "demo" : config.AI_PROVIDER;
  const gateway = createGateway({ registry, config: { ...config, AI_PROVIDER: activeProvider }, logger });

  // Intent Compiler (Phase 3B-2): the product intelligence layer sits between
  // controllers and the gateway. Engaged only when the active provider offers
  // generic chatJson transport; demo mode and legacy providers pass through
  // unchanged. Compiler-side failures degrade to the plain gateway (spec §48).
  const intelligence = (() => {
    if (activeProvider === "demo") return gateway;
    try {
      if (typeof registry.get(activeProvider).chatJson !== "function") return gateway;
    } catch (e) { return gateway; }
    const compiler = createIntentCompiler({ gateway });
    const withFallback = (compilerFn, gatewayFn) => async (payload, ctx, opts) => {
      try {
        return await compilerFn(payload, ctx, opts);
      } catch (e) {
        if (e && e.status) throw e; // gateway/provider errors → normal error system
        return gatewayFn(payload, ctx); // compiler-local failure → degraded path
      }
    };
    return {
      analyze: withFallback(compiler.analyze, gateway.analyze),
      improve: withFallback(compiler.improve, gateway.improve),
      rewrite: withFallback(compiler.rewrite, gateway.rewrite)
    };
  })();

  const health = createHealthController();
  const ai = createAIController({ gateway: intelligence, config });
  const checkRateLimit = createRateLimiter(config.RATE_LIMIT_PER_MIN);

  const API_ROUTES = {
    "GET /api/v1/health": health.handle,
    "POST /api/v1/ai/analyze": ai.analyze,
    "POST /api/v1/ai/improve": ai.improve,
    "POST /api/v1/ai/rewrite": ai.rewrite
  };

  async function serveStatic(req, res, pathname) {
    let rel = pathname === "/" ? "/index.html" : pathname;
    const filePath = normalize(join(root, rel));
    if (!filePath.startsWith(root)) throw Errors.notFound(); // path traversal guard
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
      res.end(data);
    } catch (e) {
      throw Errors.notFound();
    }
  }

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(payload);
  }

  const server = http.createServer(async (req, res) => {
    assignRequestId(req, res);
    try {
      if (applyCors(req, res, config.CORS_ORIGIN)) {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;

      if (pathname.startsWith("/api/")) {
        checkRateLimit(req);
        const handler = API_ROUTES[`${req.method} ${pathname}`];
        if (!handler) {
          const isApiPath = Object.keys(API_ROUTES).some((k) => k.endsWith(` ${pathname}`));
          throw isApiPath ? Errors.methodNotAllowed() : Errors.notFound();
        }
        const result = await handler(req, res);
        sendJson(res, result.status, result.body);
        return;
      }

      if (req.method !== "GET") throw Errors.methodNotAllowed();
      await serveStatic(req, res, pathname);
    } catch (err) {
      const httpErr = toHttpError(err, req.requestId);
      if (!res.headersSent) {
        sendJson(res, httpErr.status, httpErr.toResponse(req.requestId));
      } else {
        res.end();
      }
      if (!err.status || err.status >= 500) {
        logger.request({
          requestId: req.requestId, route: req.url, provider: "-", model: "-",
          durationMs: 0, status: httpErr.status, errorCode: httpErr.code
        });
      }
    }
  });

  return { server, config, registry, gateway, logger };
}
