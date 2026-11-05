# StellarPay — Indexer & Reconciler

Subscribes to **Soroban contract events** (Stellar RPC `getEvents`) and **EVM
`Bridge` logs**, writes them to Postgres idempotently, and runs the cross-system
reconciliation for `X-1 … X-4`.

The indexer is read-only: it never signs or submits a transaction.

## Events indexed

| Event                                          | Source                  | Table          |
| ---------------------------------------------- | ----------------------- | -------------- |
| `wrap`                                         | Soroban RPC `getEvents` | `WrapEvent`    |
| `unwrap`                                       | Soroban RPC `getEvents` | `UnwrapEvent`  |
| `supply`, `borrow`                             | Soroban RPC `getEvents` | `LendingEvent` |
| `collateral_deposited`, `collateral_withdrawn` | Soroban RPC `getEvents` | `LendingEvent` |
| `Locked`, `Burned`, `Released`                 | EVM `eth_getLogs`       | `BridgeEvent`  |

Decoding is strict and shape-checked against the Rust `#[contractevent]`
definitions (`src/events/decode.ts`). An unknown event name is ignored; a
**known** event with a malformed payload increments `indexer_errors_total` and
is logged with its event id — it is never silently dropped.

### Idempotency

- The Soroban cursor is persisted **after** each page is written, so a crash
  replays at most one page.
- Rows are keyed by the RPC event id (`<toid>-<eventOrder>`), and by
  `(txHash, nonce)` / `(txHash, logIndex)` natural keys. A Stellar transaction
  can contain several unwrap operations, so `txHash` alone is not unique.

### Retention gap

Soroban RPC serves contract events for roughly 7 days (`ledgerRetentionWindow` ≈
120 960 ledgers). A cold start therefore begins at `oldestLedger` and reports
`unretrievableGap` — history before that window cannot be backfilled from RPC.

## Reconciliation (`X-1 … X-4`)

`src/reconcile/` gathers a snapshot and evaluates the cross-system invariants
from `docs/invariants.md`:

| Check | Inputs                                                                                  |
| ----- | --------------------------------------------------------------------------------------- |
| X-1   | on-chain `wrapped_asset.total_supply()` vs indexed `Locked`/`Burned`/`Released` amounts |
| X-2   | each indexed `wrap` must match exactly one `Locked`/`Burned` by salt and amount         |
| X-3   | each indexed `unwrap` must have exactly one `Released` (or be pending inside the SLA)   |
| X-4   | per-asset `lending_pool.total_deposit`/`total_borrow` vs API/DB totals                  |

On-chain views are read with `simulateTransaction` (no signature, no fee). Every
run is persisted in `ReconciliationRun` with one `ReconciliationMismatch` row
per violation, so history is auditable. Mismatches are also logged and, when
`RECONCILE_ALERT_WEBHOOK` is set, POSTed as JSON.

Checks whose inputs are not configured are reported as **skipped**, not passed.

## Endpoints

| Route                   | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `GET /health`           | cursor ledger + last reconciliation status     |
| `GET /metrics`          | Prometheus metrics                             |
| `GET /events/{kind}`    | recent indexed events (decimal-string amounts) |
| `GET /reconcile/runs`   | last 20 runs                                   |
| `GET /reconcile/latest` | latest run with its mismatches                 |
| `POST /reconcile/run`   | trigger a run now (409 if one is in flight)    |

## Configuration

See `.env.example`. The important switches:

- `SOROBAN_RPC` — Soroban RPC endpoint (not Horizon).
- `STELLAR_EVENT_CONTRACTS` — comma-separated contract ids to index.
- `STELLAR_POOL` — lending pool id for X-4.
- `RECONCILE_SOURCE_ACCOUNT` — any funded account used as the simulation source.
  Without it, X-1/X-4 are skipped.
- `RECONCILE_WRAPPED_ASSETS` — `asset=contractId,...` pairs for `total_supply`.
- `API_URL` — when set, X-4 compares the API's `/v1/markets` numbers rather than
  the database.
- `RECONCILE_INTERVAL_MS`, `RECONCILE_STALE_MS`, `RECONCILE_ALERT_WEBHOOK`.

## Run

```bash
pnpm install
cp .env.example .env
pnpm prisma:generate
pnpm dev          # or: pnpm build && pnpm start
```

The schema in `prisma/schema.prisma` is the source of truth for the tables;
`apps/api/prisma/schema.prisma` is a read-only mirror of the same database and
must be updated with it. Apply schema changes with `pnpm prisma:migrate` (or
`prisma db push` in a disposable environment) before starting the service.

```bash
# upgrade path for an existing database created before the event-id keys
# (new columns: WrapEvent.nonce, BridgeEvent.stellarTxHash/nonce,
#  ReconciliationRun/ReconciliationMismatch tables)
pnpm prisma:migrate
```

## Known limitations

- EVM indexing is wired for one configured bridge address (`ETHEREUM_BRIDGE`);
  Polygon uses the same code path but is not configured yet.
- `X-2` only checks wrap → lock; a lock with no wrap yet is treated as pending.
- Reconciliation compares token **amounts** across chains; per-token mapping is
  not modelled, so X-1 is an aggregate check (as documented).
