# API Reference

The StellarPay API is a Fastify-based REST + WebSocket service.

- **Base URL:** `http://localhost:4000` (local). **No hosted API is deployed
  yet** — `api.spg.xyz` has no DNS record, so the production URL is not
  advertised (see [`DEPLOYMENTS.md`](../DEPLOYMENTS.md)).
- **WebSocket:** `ws://localhost:4000/v1/stream`
- **Content type:** `application/json`
- **CORS:** open in dev, restricted in prod

## REST

### `GET /health`

Returns `{ ok: true, service: "spg-api" }`.

### `GET /v1/markets`

Returns a list of supported markets.

```json
[
  {
    "asset": "XLM",
    "totalSupply": "1234567890",
    "totalBorrow": "800000000",
    "utilization": 0.65,
    "supplyApy": 0.034,
    "borrowApy": 0.051
  }
]
```

### `GET /v1/markets/:asset`

Single-market detail, e.g. `/v1/markets/XLM`.

### `GET /v1/positions/:user`

```json
{
  "user": "G...",
  "collateral": { "XLM": "1000000000" },
  "debt": { "USDC": "50000000" }
}
```

### `GET /v1/health-factor/:user`

```json
{ "user": "G...", "healthFactor": 1.85, "status": "ok" }
```

### `POST /v1/quote/wrap`

```json
// request
{ "sourceChain": "ethereum", "token": "0x...", "amount": "1000000", "stellarDest": "G..." }
// response
{ "bridgeFee": "1000000", "estimatedTime": "30-90s", "rate": "1:1" }
```

### `POST /v1/quote/unwrap`

```json
// request
{ "amount": "1000000", "sourceChain": "ethereum", "sourceAddr": "0x..." }
```

### `GET /v1/wrap-events` / `GET /v1/unwrap-events` / `GET /v1/lending-events`

Lists recent protocol events (max 100). Filter lending-events with `?user=...`
and `?asset=...`.

## WebSocket

Connect to `ws://localhost:4000/v1/stream` (or the deployed API URL). The server
pushes JSON frames:

```json
{ "type": "wrap",    "data": { "id": "...", "txHash": "...", "amount": "1000000", ... } }
{ "type": "unwrap",  "data": { ... } }
{ "type": "lending", "data": { "type": "supply|borrow|repay|withdraw|liquidate", ... } }
{ "type": "bridge",  "data": { "type": "locked|burned|released", "chain": "ethereum", ... } }
```

## Error format

```json
{ "error": { "formErrors": [...], "fieldErrors": {...} } }
```

## Auth

The public API is unauthenticated. The `relayer` and `bridge` services
authenticate via Postgres-issued JWTs (out of scope for this doc).
