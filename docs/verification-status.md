# Verification Status

> A record of **what was actually executed**, in which environment, and what
> could not be executed and why. A green check here means the command was run
> and its exit status was inspected — not that it was assumed.

**Pass date:** 2026-11-04 **Environment:** Linux container (x86_64), no Docker
daemon, no `stellar` CLI, no `slither`.

## Toolchain in this environment

| Tool    | Version here                                                                 | Pinned by the repo            |
| ------- | ---------------------------------------------------------------------------- | ----------------------------- |
| Node.js | v24.22.2                                                                     | CI: 22                        |
| pnpm    | 10.0.0                                                                       | `packageManager: pnpm@10.0.0` |
| npm     | 11.19.1                                                                      | used only by `contracts/`     |
| Rust    | **1.91.0** (+ `wasm32v1-none`, rustfmt, clippy — installed during this pass) | CI: 1.91.0                    |
| Docker  | not available                                                                | optional (Postgres/Redis)     |
| slither | not installed                                                                | CI: `crytic/slither-action`   |

## Executed and passing (2026-11-04)

| Command                                                                                 | Result                                                                                             |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                        | ✅ lockfile in sync                                                                                |
| `pnpm exec prettier --check "**/*.{json,md,yml,yaml}" …`                                | ✅ clean after formatting the files changed in this pass                                           |
| `pnpm lint`                                                                             | ✅ 2/2 turbo tasks, **0 errors**, 3 warnings (`bridge`)                                            |
| `pnpm typecheck`                                                                        | ✅ 12/12 turbo tasks                                                                               |
| `pnpm test`                                                                             | ✅ 35/35 turbo tasks, **144 tests** (api 30, bridge 52, indexer 51, sdk 7, dashboard 3, relayer 1) |
| `cd contracts && cargo build --workspace --locked --target wasm32v1-none --release`     | ✅ finished in 1m46s                                                                               |     | `cd contracts && cargo test --workspace --locked` | ✅ **112 passed, 0 failed** |
| `cd contracts && npm ci && npx hardhat test`                                            | ✅ **17 passing** (Solidity `Bridge.sol`)                                                          |
| `cd contracts && node scripts/deploy-testnet.mjs`                                       | ✅ 21 successful transactions; all 7 contracts verified initialized                                |
| `node scripts/verify-deployments.mjs --wasm-dir contracts/target/wasm32v1-none/release` | ✅ 7/7 IDs resolve · **6/6 WASM hashes match the local build**                                     |
| `cd contracts && node scripts/e2e-testnet.mjs`                                          | ✅ **45 steps, 0 failures** (live supply/borrow/repay/withdraw, pause, liquidation)                |

### Defect found and fixed in this pass

`pnpm test` initially **failed** (`PNPM_TEST_EXIT=2`):

```
@stellar-payment-gateway/indexer:build: src/reconcile/service.ts(121,53):
  error TS7006: Parameter 'r' implicitly has an 'any' type.
```

Root cause: `turbo.json` had `build.dependsOn = ["^build"]`, so the indexer's
`tsc` ran before `prisma generate`, leaving Prisma model types unresolved. Fix:
`build.dependsOn = ["^build", "prisma:generate"]`. With that change the suite
runs 35/35; the file was not modified and no test or check was weakened.

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
| Indexer/reconciler against real activity  | requires Postgres + a populated event stream; no Docker here                                          | start the stack, index the 2026-11-04 events, run the reconciler       |

## Findings that change the project's status

The live run did not merely pass — it surfaced defects. These are recorded in
[`docs/security.md`](security.md) and [`docs/invariants.md`](invariants.md):

| ID                            | Severity | Status                                               |
| ----------------------------- | -------- | ---------------------------------------------------- |
| LIQ-RAW-UNITS / LIQ-NO-ORACLE | Critical | **Open** — liquidation prices in raw units, not USD  |
| NO-ASSET-CUSTODY              | High     | **Open** — no token transfers anywhere on Stellar    |
| ADMIN-NOT-MULTISIG            | Medium   | **Open** — admin threshold stored but never enforced |
| MISSING-USER-ENTRYPOINTS      | Medium   | **Open** — controller has no repay/withdraw          |

Evidence:
[`docs/verification/testnet-e2e-2026-11-04.md`](verification/testnet-e2e-2026-11-04.md)
and its JSON sibling.

## Deployment facts re-checked during this pass

| Claim                                       | Method                                                      | Outcome                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Seven contract IDs exist in ledger state    | Soroban RPC `getLedgerEntries` via `verify-deployments.mjs` | ✅ all seven resolve, ledgers 5551410–5551423, one deployment run                                      |
| Deployed code equals this working tree      | sha256 of installed WASM vs local release build             | ✅ **6/6 match** (7 contracts, 6 distinct WASMs — wETH/WUSDC share one)                                |
| The previous (2026-08-09) deployment's code | same comparison against those seven IDs                     | ❌ 0/6 matched this tree — that deployment hosts older code; superseded, preserved in `DEPLOYMENTS.md` |
| A testnet lending lifecycle executes        | real signed transactions                                    | ✅ supply, borrow, interest, repay, withdraw, pause, liquidation (see evidence)                        |

> The earlier explanation "deployed ≠ local because the local toolchain differs"
> was only half right: the 2026-08-09 deployment also predated contract code
> changes on `main`. Both causes are documented in `DEPLOYMENTS.md`.
