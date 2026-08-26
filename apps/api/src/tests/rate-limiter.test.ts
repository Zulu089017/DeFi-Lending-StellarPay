import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../index.js";

/**
 * Rate limiting + Prometheus metrics tests.
 *
 * The limiter defaults to the in-memory backend (no REDIS_URL in tests);
 * the Redis path is exercised manually against a running instance (see
 * docs/monitoring.md). Counters accumulate across tests in the same fork,
 * so assertions are relative (increase) or presence-based, never absolute.
 */

const LIMIT_ENV = "RATE_LIMIT_PER_MIN";

afterEach(() => {
  delete process.env[LIMIT_ENV];
});

describe("rate limiting", () => {
  it("returns 429 once the per-IP limit is exceeded, with headers", async () => {
    process.env[LIMIT_ENV] = "5";
    const app = await buildApp({ logger: false, rateLimit: true });
    try {
      for (let i = 0; i < 5; i++) {
        const ok = await app.inject({ method: "GET", url: "/v1/markets" });
        expect(ok.statusCode).toBe(200);
      }
      const res = await app.inject({ method: "GET", url: "/v1/markets" });
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe("Too Many Requests");
      expect(res.headers["retry-after"]).toBeDefined();
      expect(Number(res.headers["x-ratelimit-remaining"])).toBe(0);
      expect(Number(res.headers["x-ratelimit-limit"])).toBe(5);
    } finally {
      await app.close();
    }
  });

  it("never rate-limits /health and /metrics", async () => {
    process.env[LIMIT_ENV] = "2";
    const app = await buildApp({ logger: false, rateLimit: true });
    try {
      for (let i = 0; i < 10; i++) {
        const health = await app.inject({ method: "GET", url: "/health" });
        expect(health.statusCode).toBe(200);
        const metrics = await app.inject({ method: "GET", url: "/metrics" });
        expect(metrics.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("increments http_ratelimit_hits_total when a request is rejected", async () => {
    process.env[LIMIT_ENV] = "1";
    const app = await buildApp({ logger: false, rateLimit: true });
    try {
      const before = await app.inject({ method: "GET", url: "/metrics" });
      const beforeHits = Number(/http_ratelimit_hits_total (\d+)/.exec(before.body)?.[1] ?? 0);

      await app.inject({ method: "GET", url: "/v1/markets" }); // allowed
      const rejected = await app.inject({ method: "GET", url: "/v1/markets" });
      expect(rejected.statusCode).toBe(429);

      const after = await app.inject({ method: "GET", url: "/metrics" });
      const afterHits = Number(/http_ratelimit_hits_total (\d+)/.exec(after.body)?.[1] ?? 0);
      expect(afterHits).toBeGreaterThan(beforeHits);
    } finally {
      await app.close();
    }
  });
});

describe("Prometheus /metrics", () => {
  it("serves prometheus-format metrics including the documented series", async () => {
    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      for (const metric of [
        "http_requests_total",
        "http_request_duration_ms_bucket",
        "http_ratelimit_hits_total",
        "ws_connections",
      ]) {
        expect(res.body).toContain(metric);
      }
    } finally {
      await app.close();
    }
  });

  it("records http_requests_total by method and status", async () => {
    const app = await buildApp({ logger: false });
    try {
      await app.inject({ method: "GET", url: "/health" });
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.body).toContain('http_requests_total{method="GET",status="200"}');
    } finally {
      await app.close();
    }
  });
});
