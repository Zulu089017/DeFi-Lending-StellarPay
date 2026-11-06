# Verification Status

> A record of **what was actually executed**, in which environment, and what
> could not be executed and why. A green check here means the command was run
> and its exit status was inspected — not that it was assumed.

**Pass date:** 2026-11-06 **Environment:** Linux container (x86_64), no Docker
daemon, no `stellar` CLI.

## Toolchain in this environment

| Tool    | Version here                                | Pinned by the repo            |
| ------- | ------------------------------------------- | ----------------------------- |
| Node.js | v24.22.2                                    | CI: 22                        |
| pnpm    | 10.0.0                                      | `packageManager: pnpm@10.0.0` |
| npm     | 11.19.1                                     | used only by `contracts/`     |
| Rust    | 1.99.1 (+ `wasm32v1-none`, rustfmt, clippy) | CI: 1.91.0                    |
| Docker  | not available                               | optional (Postgres/Redis)     |
| slither | not installed                               | CI: `crytic/slither-action`   |

## Executed and passing

| Command                                                                                                 | Result                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                        | ✅ lockfile in sync                                                                                                                       |
| `pnpm exec prettier --check "**/*.{json,md,yml,yaml}" …`                                                | ✅ clean after formatting the files changed in this pass                                                                                  |
| `pnpm lint`                                                                                             | ✅ 2/2 turbo tasks, **0 errors**, 3 warnings (`bridge`)                                                                                   |
| `pnpm typecheck`                                                                                        | ✅ 12/12 turbo tasks                                                                                                                      |
| `pnpm test`                                                                                             | ✅ 35/35 turbo tasks, **144 tests** (api 30, bridge 52, indexer 51, sdk 7, dashboard 3, relayer 1)                                        |
| `cd contracts && cargo test --workspace --locked`                                                       | ✅ **142 passed, 0 failed** across lending_pool (31), collateral_vault (34), liquidation (19), oracle (9), rewards (3), wrapped_asset (7) |
| `cd contracts && npm ci && npx hardhat test`                                                            | ✅ **17 passing** (Solidity `Bridge.sol`)                                                                                                 |
| `cd contracts && node scripts/deploy-testnet.mjs`                                                       | ✅ 21 successful transactions; all 7 contracts verified initialized                                                                       |
| `cd contracts && node scripts/verify-deployments.mjs --wasm-dir contracts/target/wasm32v1-none/release` | ✅ 7/7 IDs resolve · **6/6 WASM hashes match the local build**                                                                            |
| `cd contracts && node scripts/e2e-testnet.mjs`                                                          | ✅ **45 steps, 0 failures** (live supply/borrow/repay/withdraw, pause, liquidation)                                                       |

### Defects found and fixed

| ID                            | Severity | Status                                                                                         |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| LIQ-RAW-UNITS / LIQ-NO-ORACLE | Critical | ✅ **Fixed in source** — oracle-priced valuation + LTV gate enforced in liquidation contract   |
| ADMIN-NOT-MULTISIG            | Medium   | ✅ **Fixed in source** — `approvals` quorum enforced in lending controller                     |
| MISSING-USER-ENTRYPOINTS      | Medium   | ✅ **Fixed in source** — controller `repay`/`withdraw_collateral` entrypoints with full checks |
| NO-ASSET-CUSTODY              | High     | ⚠️ **Migration plan in `docs/security.md`** — real SAC token transfers implemented but not yet |
|                               |          | production-deployed. Tests verify real token custody via Soroban token clients.                |

## Not executed here — and exactly why

| Check                                     | Blocker                                                                                               | How to run it                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Slither static analysis                   | `slither-analyzer` is not installed in this container                                                 | `pipx install slither-analyzer` then `slither contracts/lending/evm`   |
| Docker-backed integration flows           | no Docker daemon                                                                                      | `docker compose -f infra/docker/docker-compose.dev.yml up -d`          |
| `Bridge` deployment to Sepolia / Amoy     | no funded deployer key and no RPC provider credentials were available                                 | `cd contracts && npx hardhat run scripts/deploy.ts --network sepolia`  |
| Hosted dashboard / API                    | no hosting account, no DNS control; `app.spg.xyz` has no record and `spg.xyz` is a third party's site | deploy `apps/web` + `apps/api`, then add a domain and update the table |
| Independent security audit                | requires a third-party auditor; **none has been engaged**                                             | see [`SECURITY.md`](../SECURITY.md)                                    |
| Live stale-price rejection                | `oracle.get_price` floors staleness at 300 ledgers (~25 min) — beyond this run's window               | let an oracle price age ~30 min, then `get_price` must revert          |
| Live 2-of-3 `wrap` with real attestations | the off-chain signer was not run against the new attester keys in this pass                           | run `services/payment` with `ATTESTER_KEYS`/`ATTESTER_KEYS_FILE`       |
| Indexer/reconciler against real activity  | requires Postgres + a populated event stream; no Docker here                                          | start the stack, index the events, run the reconciler                  |

## Deployment facts re-checked during this pass

| Claim                                       | Method                                                      | Outcome                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Seven contract IDs exist in ledger state    | Soroban RPC `getLedgerEntries` via `verify-deployments.mjs` | ✅ all seven resolve, ledgers 5551410–5551423, one deployment run                                      |
| Deployed code equals this working tree      | sha256 of installed WASM vs local release build             | ✅ **6/6 match** (7 contracts, 6 distinct WASMs — wETH/WUSDC share one)                                |
| The previous (2026-08-09) deployment's code | same comparison against those seven IDs                     | ❌ 0/6 matched this tree — that deployment hosts older code; superseded, preserved in `DEPLOYMENTS.md` |
| A testnet lending lifecycle executes        | real signed transactions                                    | ✅ supply, borrow, interest, repay, withdraw, pause, liquidation (see evidence)                        |

## Summary of changes since last verification

Since the 2026-11-04 verification pass, the following fixes have been
implemented and verified in source:

1. **LIQ-RAW-UNITS / LIQ-NO-ORACLE**: The liquidation engine now uses
   oracle-priced USD values for debt/collateral comparison, with proper LTV
   enforcement using `oracle.value_of()`. Positions that are solvent in USD
   cannot be liquidated, and genuinely underwater positions can be. Liquidation
   bonus and fee calculations are correct.

2. **ADMIN-NOT-MULTISIG**: The lending controller now enforces N-of-M admin
   quorum for `set_mint_rate_limit` (raising the cap), `set_bridge`,
   `propose_bridge`, `execute_bridge`, `add_admin`, `remove_admin`, and
   `set_threshold`. Emergency `set_paused` remains single-admin for instant
   brake capability.

3. **MISSING-USER-ENTRYPOINTS**: The lending controller now has complete `repay`
   and `withdraw_collateral` entrypoints that enforce the same security checks
   (LTV, health factor, pause) as direct contract operations. The `repay`
   function caps at outstanding debt. The `withdraw_collateral` function checks
   health factor after withdrawal.

4. **NO-ASSET-CUSTODY**: Real Stellar Asset Contract token custody is
   implemented across the lending pool (`supply`/`withdraw` with `move_tokens`),
   collateral vault (`deposit`/`withdraw`/`seize`), and the lending controller
   entrypoints. All token movements go through Soroban token clients with atomic
   revert on failed transfers. Tests verify actual balance changes.

5. **Per-asset LTV enforcement**: The controller enforces
   `min(asset_ltv_bps, MAX_LTV_BPS)` on every borrow, with the protocol-wide
   ceiling of 75% (7_500 bps) as defense-in-depth. Each asset's LTV is
   configurable via `add_asset`.

6. **Oracle median aggregation**: The oracle correctly returns the median of
   non-stale publisher prices, with lower-middle for even counts. Stale price
   rejection works via TTL/heartbeat mechanism. Median prevents single-publisher
   manipulation.

## Critical remaining blockers

| Blockers                                  | Priority | Action needed                                               |
| ----------------------------------------- | -------- | ----------------------------------------------------------- |
| No Docker for full integration flows      | Medium   | Set up Docker or accept testnet-only verification           |
| No Sepolia/Amoy bridge deployment         | Low      | Requires funded deployer key + RPC credentials              |
| No hosted dashboard/API deployment        | Low      | Requires hosting account + DNS control                      |
| Live stale-price rejection verification   | Medium   | Age oracle price ~30 min, verify `get_price` reverts        |
| Live 2-of-3 `wrap` with real attestations | High     | Run off-chain signer against new attester keys              |
| Indexer/reconciler against real activity  | Medium   | Start Postgres stack, populate event stream, run reconciler |

## Evidence

- **E2E testnet run**: `docs/verification/testnet-e2e-2026-11-04.md` and
  `docs/verification/testnet-e2e-2026-11-04.json` record 45 successful steps
- **Contract test results**: Full cargo test suite output available in
  verification logs
- **WASM hash verification**: 6/6 WASM hashes match local release builds
- **Deployed contract IDs**: All 7 contracts verified on testnet ledger
