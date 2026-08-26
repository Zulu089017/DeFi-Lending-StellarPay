import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { marketsRoutes } from "./routes/markets.js";
import { positionsRoutes } from "./routes/positions.js";
import { quoteRoutes } from "./routes/quote.js";
import { eventsRoutes } from "./routes/events.js";
import { attachWebsocket } from "./stream.js";
import { rateLimiter, closeRateLimiter } from "./middleware/rate-limiter.js";
import {
  httpRequestsTotal,
  httpRequestDurationMs,
  metricsBody,
  metricsContentType,
} from "./metrics.js";

/**
 * Build a fully-configured Fastify instance WITHOUT calling `.listen()`.
 *
 * This is the testable surface of the API: the integration test suite
 * imports `buildApp`, calls it, and uses `app.inject()` to issue
 * in-process requests (no real port, no port collisions in CI).
 *
 * Production code in `main()` calls `buildApp()` and then `app.listen()`.
 *
 * @param opts.corsOrigin     Override the CORS origin. Defaults to `*` for
 *                            tests (we don't need browser CORS for
 *                            `app.inject()`). Pass an array of origins in
 *                            production via the `CORS_ORIGINS` env var.
 * @param opts.logger         Pass `false` for tests to silence pino output.
 *                            Pass `{ level: ... }` (or `true`) for prod.
 * @param opts.rateLimit      Whether to enable rate limiting. Default `true`.
 */
export async function buildApp(
  opts: {
    corsOrigin?: string | string[] | true;
    logger?: boolean | object;
    rateLimit?: boolean;
  } = {},
) {
  const app = Fastify({ logger: opts.logger ?? { level: config.LOG_LEVEL } });
  const origin =
    opts.corsOrigin ?? (config.CORS_ORIGINS === "*" ? true : config.CORS_ORIGINS.split(","));
  await app.register(cors, { origin });

  // Prometheus HTTP metrics: stamp the start time in onRequest, record
  // duration + status in onResponse. `startedAt` is set on the raw req
  // (not the fastify wrapper) so it survives across hooks.
  app.addHook("onRequest", (req, _reply, done) => {
    (req.raw as any).startedAt = process.hrtime.bigint();
    done();
  });
  app.addHook("onResponse", (req, reply, done) => {
    const started = (req.raw as any).startedAt as bigint | undefined;
    if (started) {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      httpRequestDurationMs.observe({ method: req.method }, ms);
    }
    httpRequestsTotal.inc({ method: req.method, status: reply.statusCode });
    done();
  });

  // Global rate limiter for all routes (300 req/min per IP, Redis-backed
  // when REDIS_URL is set). Disabled in tests via opts.rateLimit = false.
  // /health and /metrics are excluded so k8s probes and Prometheus scrapes
  // can never trip the limiter.
  if (opts.rateLimit !== false) {
    const limit = parseInt(process.env.RATE_LIMIT_PER_MIN ?? "300", 10);
    const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10);
    app.addHook("preHandler", rateLimiter(limit, windowMs));
  }

  app.get("/health", async () => ({ ok: true, service: "spg-api", uptime: process.uptime() }));

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", metricsContentType());
    return metricsBody();
  });

  await app.register(marketsRoutes);
  await app.register(positionsRoutes);
  await app.register(quoteRoutes);
  await app.register(eventsRoutes);

  attachWebsocket(app);

  return app;
}

import { fileURLToPath } from "url";

async function main() {
  const app = await buildApp();
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`🚀 StellarPay API listening on :${config.PORT}`);

  // H9 FIX: Graceful shutdown on SIGTERM/SIGINT.
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "API shutting down...");
    await app.close();
    await closeRateLimiter();
    app.log.info("API shut down cleanly");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only run `main()` when this file is the process entrypoint. Without
// this guard, importing `buildApp` from a test would start a real
// server on `config.PORT` (default 4000), colliding with any other
// process on that port and tripping EADDRINUSE.
//
// L6 FIX: Use `import.meta.url` comparison with `fileURLToPath` for a
// robust entrypoint check. This works reliably in Node ESM mode and
// doesn't rely on fragile path-ending heuristics.
const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
