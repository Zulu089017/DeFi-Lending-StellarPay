# StellarPay Monitoring & Observability Guide

> **Status: implemented (2026-08).** Every TypeScript service exposes a
> Prometheus `/metrics` endpoint, and `infra/monitoring/` ships the scrape
> config, alerting rules, and a Grafana dashboard. Local bring-up is
> `docker compose -f infra/docker/docker-compose.yml up prometheus grafana`;
> Kubernetes manifests are in `infra/kubernetes/08-monitoring.yaml`.

## Architecture overview

```
  ┌──────────┐    ┌───────────┐    ┌──────────┐
  │  Bridge  │    │  Relayer  │    │ Indexer  │
  │  (TS)    │    │  (TS)     │    │  (TS)    │
  └────┬─────┘    └─────┬─────┘    └────┬─────┘
       │                │               │
       ▼                ▼               ▼
  ┌──────────────────────────────────────────┐
  │              Prometheus                   │
  │  (scrapes /metrics from each service)    │
  └────────────────────┬─────────────────────┘
                       │
                       ▼
              ┌────────────────┐
              │    Grafana     │
              │  (dashboards,  │
              │   alerts)      │
              └────────────────┘
```

## Metrics endpoints

Each TypeScript service exposes `/metrics` (Prometheus text format) plus
`/health` for k8s probes:

| Service   | Port | Endpoint        | Metrics                                                                                          |
| --------- | ---- | --------------- | ------------------------------------------------------------------------------------------------ |
| `bridge`  | 4100 | `:4100/metrics` | `bridge_*` (see below)                                                                           |
| `relayer` | 4300 | `:4300/metrics` | `relayer_*` (see below)                                                                          |
| `indexer` | 4200 | `:4200/metrics` | `indexer_*` (see below)                                                                          |
| `api`     | 4000 | `:4000/metrics` | `http_requests_total`, `http_request_duration_ms`, `http_ratelimit_hits_total`, `ws_connections` |

> Note: `relayer` (the `services/cron` package) is on **4300** — the indexer
> owns 4200. Earlier drafts of this doc said 4200; that was a conflict.

Every process also exports Node.js runtime metrics under the `spg_node_` prefix
(via `prom-client` `collectDefaultMetrics`).

## Key metrics to monitor

### Bridge

| Metric                         | Description                                   | Alert if             |
| ------------------------------ | --------------------------------------------- | -------------------- |
| `bridge_mints_total`           | Successful wTKN mint submissions              | Queue draining alert |
| `bridge_mint_failures_total`   | Failed mint submissions                       | Any increase         |
| `bridge_attest_errors_total`   | Per-key attester signing errors               | Any increase         |
| `bridge_quorum_failures_total` | Mints that couldn't reach the attester quorum | Any increase         |
| `bridge_events_ingested_total` | Source-chain events enqueued for minting      | Drops to zero        |
| `bridge_event_lag_seconds`     | Seconds since the last observed event         | > 120 s              |
| `bridge_pending_queue_size`    | Mint requests waiting in the queue            | > 25 for 10 min      |

### Relayer

| Metric                       | Description                        | Alert if                  |
| ---------------------------- | ---------------------------------- | ------------------------- |
| `relayer_submissions_total`  | Txs submitted (by chain)           | Drops to zero for > 5 min |
| `relayer_failures_total`     | Failed submissions (by chain)      | > 3 in 5 min              |
| `relayer_attempts_total`     | Job processing attempts (by chain) | —                         |
| `relayer_pending_queue_size` | Queued jobs waiting to be sent     | > 100                     |

### Indexer

| Metric                          | Description                 | Alert if      |
| ------------------------------- | --------------------------- | ------------- |
| `indexer_events_ingested_total` | Events persisted (by chain) | Drops to zero |
| `indexer_lag_seconds`           | EVM blocks behind chain tip | > 60          |
| `indexer_errors_total`          | Poll/parse failures         | Any increase  |

### API

| Metric                                             | Description                     | Alert if     |
| -------------------------------------------------- | ------------------------------- | ------------ |
| `http_requests_total{method,status}`               | Requests by status              | 5xx > 5%     |
| `http_request_duration_ms{method}`                 | Duration histogram              | p95 > 500 ms |
| `http_ratelimit_hits_total`                        | Requests rejected (429)         | Spike        |
| `ws_connections` / `ws_connections_rejected_total` | Live WebSocket conns / rejected | Spike        |

## Alert severity levels

| Level             | Response                                                                     |
| ----------------- | ---------------------------------------------------------------------------- |
| **P1 — Critical** | Bridge/relayer stopped; mint queue not draining. Page on-call immediately.   |
| **P2 — Warning**  | Elevated error rate, high latency, growing queue. Investigate within 30 min. |
| **P3 — Info**     | Minor metrics anomaly, slow leak. Fix during business hours.                 |

Alerting rules ship in `infra/monitoring/prometheus/alerts.yml` (mirrored into
the k8s ConfigMap in `infra/kubernetes/08-monitoring.yaml`).

## Rate limiting

The public API rate limiter (`apps/api/src/middleware/rate-limiter.ts`):

- **Defaults**: 300 req/min per client IP, fixed window; configurable via
  `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_WINDOW_MS`.
- **Redis backend**: set `REDIS_URL` and the limit is shared across all API
  replicas (fixed-window `INCR` + `EXPIRE`). Without `REDIS_URL` it falls back
  to a per-process in-memory map (dev/tests only).
- **Fail-open**: if Redis is unreachable the request is allowed through so the
  API stays available. This trades strict limits for uptime — alert on Redis
  availability.
- **Per-route limits**: `/v1/quote/*` is capped at 60/min per IP
  (`routeRateLimiter("quote", 60)`).
- **Bypassed paths**: `/health` and `/metrics` are never rate-limited (k8s
  probes + Prometheus scrapes).
- **WebSocket**: max 10 concurrent connections per IP and 30 inbound messages
  per 10 s per connection (defensive; the stream only broadcasts).
- Responses include IETF `RateLimit`-style headers
  (`X-RateLimit-Limit/Remaining/Reset`, `Retry-After`).

## Logging

All services use **structured logging** via `pino` (JSON format). In production,
logs are shipped to Loki or Datadog.

- **Level**: `info` in production, `debug` for staging.
- **Context**: every log line includes `service`, `env`, and (where applicable)
  `txHash`, `chain`, `address`.
- **Redaction**: never log private keys, attester secrets, or user plaintext
  addresses (log the first 6 chars only for debugging).

## Health endpoints

Every service exposes a `/health` endpoint:

```bash
curl http://localhost:4000/health
# {"ok":true,"service":"spg-api","uptime":3600}
```

Kubernetes liveness and readiness probes are configured in each pod's manifest.

## Local run

```bash
# Postgres + Redis + all services + Prometheus (:9090) + Grafana (:3001)
docker compose -f infra/docker/docker-compose.yml up

# Open the dashboard (anonymous viewer):
#   http://localhost:3001  →  StellarPay Protocol dashboard
# Prometheus UI:
#   http://localhost:9090
```

> Grafana is mapped to host port **3001** because the frontend owns 3000.
> Default admin creds in the compose file are local-only; in Kubernetes the
> `GF_AUTH_ANONYMOUS_*` envs give anonymous read-only access and admin creds
> come from a `grafana-env` Secret.

## Dashboard

`infra/monitoring/grafana/dashboards/stellarpay.json` is a provisioned Grafana
dashboard showing:

- **Bridge**: mints, attestation errors, event lag, pending queue
- **Relayer**: submission/failure rates, pending queue
- **Indexer**: events ingested, EVM lag
- **API**: request rate by status, p95 latency, rate-limit hits

The same dashboard JSON is embedded in `infra/kubernetes/08-monitoring.yaml` for
k8s deployments.
