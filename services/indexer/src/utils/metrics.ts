import { Registry, Counter, Gauge, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics for the indexer service.
 *
 * Exposed at `/metrics` (see `src/index.ts`, default port 4200). Scrape
 * config and dashboard live in `infra/monitoring/`; the documented metric
 * contract is in `docs/monitoring.md`.
 */
const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "spg_node_" });

export const indexerEventsIngested = new Counter({
  name: "indexer_events_ingested_total",
  help: "Events persisted to Postgres",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const indexerLagSeconds = new Gauge({
  name: "indexer_lag_seconds",
  help: "Indexer lag behind the chain tip (EVM only; 0 when caught up)",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const indexerErrorsTotal = new Counter({
  name: "indexer_errors_total",
  help: "Indexer poll/parse failures",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export function metricsContentType(): string {
  return registry.contentType;
}

export async function metricsBody(): Promise<string> {
  return registry.metrics();
}
