import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Redis } from "ioredis";
import { httpRatelimitHitsTotal } from "../metrics.js";

/**
 * Rate limiter for the StellarPay API.
 *
 * Backed by a shared Redis counter (`REDIS_URL`) so limits hold across all
 * API pod replicas; falls back to an in-process map when REDIS_URL is
 * unset (local dev / tests). Fixed-window per client IP.
 */

interface RateLimitBucket {
  count: number;
  resetAt: number; // ms timestamp
}

const buckets = new Map<string, RateLimitBucket>();

/** Maximum requests per window (default: 300 req/min per IP). */
const DEFAULT_MAX = 300;

/** Window duration in ms (default: 60 seconds). */
const DEFAULT_WINDOW_MS = 60_000;

/** Paths that bypass the limiter entirely (probes + Prometheus scrapes). */
const BYPASS_PATHS = new Set(["/health", "/metrics"]);

let redis: Redis | null = null;
let redisUrl = process.env.REDIS_URL;

function getRedis(): Redis | null {
  if (redis) return redis;
  if (!redisUrl) return null;
  redis = new Redis(redisUrl, {
    // Fail open is dangerous for a rate limiter, but failing closed would
    // take the whole API down if Redis blips. We fail open and rely on
    // Redis uptime (documented in docs/monitoring.md). If Redis is
    // unavailable the in-memory fallback below is NOT used (to avoid
    // per-pod limits drifting); instead the limiter allows the request
    // through so the API stays available.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  redis.on("error", (err) => {
    console.error("[rate-limiter] redis error:", err?.message ?? err);
  });
  return redis;
}

/** Close the shared Redis connection (call on shutdown). */
export async function closeRateLimiter(): Promise<void> {
  if (redis) {
    const r = redis;
    redis = null;
    r.disconnect();
  }
}

/** Exposed for tests: point the limiter at a different Redis URL. */
export function _setRedisUrlForTests(url: string | undefined): void {
  redisUrl = url;
  redis = null;
}

function isBypassed(req: FastifyRequest): boolean {
  return BYPASS_PATHS.has(req.url.split("?")[0] ?? req.url);
}

/**
 * Create a Fastify preHandler hook that rate-limits requests by client IP.
 *
 * @param max      Max requests allowed within `windowMs`. Default 300.
 * @param windowMs Duration of the fixed window in ms. Default 60_000 (1 min).
 * @returns        A Fastify `preHandler` function.
 */
export function rateLimiter(max = DEFAULT_MAX, windowMs = DEFAULT_WINDOW_MS) {
  // Periodic cleanup to prevent unbounded map growth (memory backend only).
  // unref() so the timer never keeps the process alive in tests.
  const CLEANUP_MS = 60_000;
  setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
      if (now > b.resetAt) buckets.delete(key);
    }
  }, CLEANUP_MS).unref();

  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (isBypassed(req)) return;
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();

    // ── Redis backend (shared across replicas) ──
    const client = getRedis();
    if (client) {
      const key = `rl:${ip}`;
      try {
        const count = await client.incr(key);
        if (count === 1) {
          await client.expire(key, Math.ceil(windowMs / 1000));
        }
        const resetAt = now + windowMs;
        const remaining = Math.max(0, max - count);
        reply.header("X-RateLimit-Limit", max);
        reply.header("X-RateLimit-Remaining", remaining);
        reply.header("X-RateLimit-Reset", Math.ceil(resetAt / 1000));
        if (count > max) {
          httpRatelimitHitsTotal.inc();
          reply.header("Retry-After", Math.ceil(windowMs / 1000));
          return reply.code(429).send({
            error: "Too Many Requests",
            message: `Rate limit of ${max} requests per ${windowMs / 1000}s exceeded.`,
          });
        }
        return;
      } catch (err) {
        // Fail open (see getRedis comment).
        console.error(
          "[rate-limiter] redis op failed, allowing request:",
          (err as Error)?.message ?? err,
        );
        return;
      }
    }

    // ── In-memory backend (single process; dev/tests) ──
    let bucket = buckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, bucket);
    }
    bucket.count++;

    const remaining = Math.max(0, max - bucket.count);
    reply.header("X-RateLimit-Limit", max);
    reply.header("X-RateLimit-Remaining", remaining);
    reply.header("X-RateLimit-Reset", Math.ceil(bucket.resetAt / 1000));

    if (bucket.count > max) {
      httpRatelimitHitsTotal.inc();
      reply.header("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      return reply.code(429).send({
        error: "Too Many Requests",
        message: `Rate limit of ${max} requests per ${windowMs / 1000}s exceeded.`,
      });
    }
  };
}

/**
 * Per-route rate limiter with stricter limits for expensive endpoints.
 *
 * Uses a separate bucket namespace keyed by `prefix + ":" + ip` (and a
 * separate Redis key namespace) so expensive endpoints can be capped
 * independently of the global 300/min.
 */
export function routeRateLimiter(prefix: string, max: number, windowMs = DEFAULT_WINDOW_MS) {
  const CLEANUP_MS = 60_000;
  setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
      if (now > b.resetAt) buckets.delete(key);
    }
  }, CLEANUP_MS).unref();

  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (isBypassed(req)) return;
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();

    const client = getRedis();
    if (client) {
      const key = `rl:${prefix}:${ip}`;
      try {
        const count = await client.incr(key);
        if (count === 1) {
          await client.expire(key, Math.ceil(windowMs / 1000));
        }
        const remaining = Math.max(0, max - count);
        reply.header("X-RateLimit-Limit", max);
        reply.header("X-RateLimit-Remaining", remaining);
        reply.header("X-RateLimit-Reset", Math.ceil((now + windowMs) / 1000));
        if (count > max) {
          httpRatelimitHitsTotal.inc();
          reply.header("Retry-After", Math.ceil(windowMs / 1000));
          return reply.code(429).send({
            error: "Too Many Requests",
            message: `${prefix} rate limit exceeded.`,
          });
        }
        return;
      } catch (err) {
        console.error(
          "[rate-limiter] redis op failed, allowing request:",
          (err as Error)?.message ?? err,
        );
        return;
      }
    }

    const key = `${prefix}:${ip}`;
    let bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    const remaining = Math.max(0, max - bucket.count);
    reply.header("X-RateLimit-Limit", max);
    reply.header("X-RateLimit-Remaining", remaining);

    if (bucket.count > max) {
      httpRatelimitHitsTotal.inc();
      reply.header("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      return reply.code(429).send({
        error: "Too Many Requests",
        message: `${prefix} rate limit exceeded.`,
      });
    }
  };
}

/** Kept for type compatibility (used by buildApp's opts type checks). */
export type { FastifyInstance };
