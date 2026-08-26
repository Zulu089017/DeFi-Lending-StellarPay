import { Registry, Counter, Gauge, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics for the relayer (cron) service.
 *
 * Exposed at `/metrics` on the relayer's health/metrics HTTP server
 * (see `src/index.ts`, default port 4300). Scrape config and dashboard
 * live in `infra/monitoring/`; the documented metric contract is in
 * `docs/monitoring.md`.
 */
const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "spg_node_" });

export const relayerSubmissionsTotal = new Counter({
  name: "relayer_submissions_total",
  help: "Transactions submitted to any chain (Stellar or EVM)",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const relayerFailuresTotal = new Counter({
  name: "relayer_failures_total",
  help: "Relayer job submissions that failed",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const relayerPendingQueueSize = new Gauge({
  name: "relayer_pending_queue_size",
  help: "Number of relayer jobs currently waiting in the queue",
  registers: [registry],
});

export const relayerAttemptsTotal = new Counter({
  name: "relayer_attempts_total",
  help: "Total relayer job processing attempts",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export function metricsContentType(): string {
  return registry.contentType;
}

export async function metricsBody(): Promise<string> {
  return registry.metrics();
}
