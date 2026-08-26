import { Registry, Counter, Gauge, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics for the bridge (payment) service.
 *
 * Exposed at `/metrics` (see `src/index.ts`). Scrape config and dashboard
 * live in `infra/monitoring/`; the documented metric contract is in
 * `docs/monitoring.md`.
 */
const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "spg_node_" });

export const bridgeMintsTotal = new Counter({
  name: "bridge_mints_total",
  help: "Total wTKN mint requests successfully submitted on Stellar",
  registers: [registry],
});

export const bridgeMintFailuresTotal = new Counter({
  name: "bridge_mint_failures_total",
  help: "Mint requests that failed on submission (submitTransaction error)",
  registers: [registry],
});

export const bridgeAttestErrorsTotal = new Counter({
  name: "bridge_attest_errors_total",
  help: "Individual attester signing errors (per failed key)",
  registers: [registry],
});

export const bridgeQuorumFailuresTotal = new Counter({
  name: "bridge_quorum_failures_total",
  help: "Mint attempts that collected fewer than ATTESTER_THRESHOLD signatures",
  registers: [registry],
});

export const bridgePendingMints = new Gauge({
  name: "bridge_pending_queue_size",
  help: "Number of mint requests currently in the pending queue",
  registers: [registry],
});

export const bridgeEventLagSeconds = new Gauge({
  name: "bridge_event_lag_seconds",
  help: "Seconds since the last source-chain event was observed",
  registers: [registry],
});

export const bridgeEventsIngestedTotal = new Counter({
  name: "bridge_events_ingested_total",
  help: "Source-chain Locked/Burned events enqueued for minting",
  registers: [registry],
});

/** Increment on any per-key signing failure in `attest/signer.ts`. */
export function recordAttestError(): void {
  bridgeAttestErrorsTotal.inc();
}

/** Increment when a mint attempt cannot reach the attester quorum. */
export function recordQuorumFailure(): void {
  bridgeQuorumFailuresTotal.inc();
}

export function metricsContentType(): string {
  return registry.contentType;
}

export async function metricsBody(): Promise<string> {
  return registry.metrics();
}
