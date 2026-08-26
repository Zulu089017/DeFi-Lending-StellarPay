import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics for the public API.
 *
 * Exposed at `/metrics` (see `src/index.ts`). Scrape config and dashboard
 * live in `infra/monitoring/`; the documented metric contract is in
 * `docs/monitoring.md`.
 */
const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "spg_node_" });

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "HTTP requests served, by method and status code",
  labelNames: ["method", "status"] as const,
  registers: [registry],
});

export const httpRequestDurationMs = new Histogram({
  name: "http_request_duration_ms",
  help: "HTTP request duration in milliseconds",
  labelNames: ["method"] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

export const httpRatelimitHitsTotal = new Counter({
  name: "http_ratelimit_hits_total",
  help: "Requests rejected by the rate limiter (HTTP 429)",
  registers: [registry],
});

export const wsConnections = new Gauge({
  name: "ws_connections",
  help: "Currently open WebSocket connections",
  registers: [registry],
});

export const wsConnectionsRejectedTotal = new Counter({
  name: "ws_connections_rejected_total",
  help: "WebSocket connections rejected (per-IP connection cap)",
  registers: [registry],
});

export function metricsContentType(): string {
  return registry.contentType;
}

export async function metricsBody(): Promise<string> {
  return registry.metrics();
}
