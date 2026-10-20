# Feature Evidence Inventory

> **Purpose.** For every feature advertised in the README, record where it is
> implemented, which tests exercise it, what it needs to be configured or
> deployed, where it is documented, and — most importantly — **what has actually
> been verified and by which command**.
>
> **Last verified:** 2026-10-20, in the container described in
> [`docs/verification-status.md`](verification-status.md).

## Legend

| Status                      | Meaning                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ **Verified**             | The command that exercises the feature was executed here and passed.                                                                                                                |
| ⚠️ **Source-verified only** | The code and its tests exist and were inspected, but the toolchain needed to execute them is not available in this environment (no Rust toolchain, no `slither`, no Docker daemon). |
| 🟡 **Partial**              | Part of the feature is verified; a named part is not.                                                                                                                               |
| ⛔ **Not implemented**      | Documented gap — no implementation and no test.                                                                                                                                     |
| 📋 **Planned**              | Intended work; nothing to run yet.                                                                                                                                                  |

---

## 1. Soroban lending protocol

### 1.1 Supply / withdraw (share-priced deposits)

| Aspect          | Detail                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Implementation  | `contracts/lending/soroban/src/lib.rs` (`supply`, `withdraw`, `deposit_shares_of`, `total_deposit_shares`)                                                                                       |
| Tests           | 18 `invariant_*` tests in the same file (L-1…L-10 family) + `prop_lending_pool_random_ops` in `contracts/integration-tests/src/property.rs`                                                      |
| Config / deploy | Asset must be registered with `add_asset` (base rate, slopes, kink, reserve factor, LTV) and a `collateral_vault` + `oracle` address                                                             |
| Docs            | [`docs/contracts.md`](../docs/contracts.md), [`docs/invariants.md`](../docs/invariants.md) §4                                                                                                    |
| Verification    | ⚠️ **Source-verified only** — 113 Rust `#[test]` functions exist; `cargo test --workspace --locked` could not be executed here (no Rust toolchain). CI runs it on Rust 1.91.0 / `wasm32v1-none`. |

### 1.2 Borrow / repay (index-based debt)

| Aspect          | Detail                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Implementation  | `contracts/lending/soroban/src/lib.rs` (`borrow`, `repay`, `borrow_raw`, `repay_on_behalf`, `debt_of`, `borrow_index`) |
| Tests           | `invariant_*` tests (L-2, L-3, L-6, L-8, L-10), `prop_repay_bounded`, `prop_health_factor_monotonic`                   |
| Config / deploy | Oracle price for the collateral asset; LTV ≤ 10 000 bps                                                                |
| Docs            | [`docs/invariants.md`](../docs/invariants.md) §4, [`docs/rate-model.md`](../docs/rate-model.md)                        |
| Verification    | ⚠️ Source-verified only (see 1.1)                                                                                      |

### 1.3 Collateral vault

| Aspect          | Detail                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Implementation  | `contracts/collateral/soroban/src/lib.rs` (`deposit`, `withdraw`, `seize`, `position`, `total_by_asset`, `set_liq_threshold`) |
| Tests           | 4 `invariant_*` tests (V-1…V-5 family) + `prop_collateral_vault_invariants`                                                   |
| Config / deploy | Operator allow-list (`add_operator`) — the lending pool must be an operator                                                   |
| Docs            | [`docs/invariants.md`](../docs/invariants.md) §3                                                                              |
| Verification    | ⚠️ Source-verified only                                                                                                       |

### 1.4 Health factor and LTV enforcement

| Aspect          | Detail                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Implementation  | `contracts/lending/soroban/src/lib.rs` (`health_factor`, borrow-time LTV check), `contracts/lending/controller/src/lib.rs` (`borrow` cross-call) |
| Tests           | `prop_health_factor_monotonic` (asserts HF never increases after a borrow), `invariant_C8` (controller cross-call)                               |
| Config / deploy | Oracle price freshness window                                                                                                                    |
| Docs            | [`docs/invariants.md`](../docs/invariants.md) L-10, C-8                                                                                          |
| Verification    | ⚠️ Source-verified only                                                                                                                          |

### 1.5 Interest accrual

| Aspect          | Detail                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Implementation  | `contracts/lending/soroban/src/lib.rs` (`accrue_interest`, `borrow_apy_bps`) — utilisation curve with kink, index-based |
| Tests           | `invariant_*` tests for index monotonicity (L-2) and "accrue does not change `total_borrow`" (L-8)                      |
| Config / deploy | `base_rate_bps`, `slope1_bps`, `slope2_bps`, `kink_bps`, `reserve_factor_bps` per asset                                 |
| Docs            | [`docs/rate-model.md`](../docs/rate-model.md)                                                                           |
| Verification    | ⚠️ Source-verified only                                                                                                 |

### 1.6 Liquidation engine

| Aspect          | Detail                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Implementation  | `contracts/liquidation/soroban/src/lib.rs` (`liquidate`, close factor, bonus, fee)                                               |
| Tests           | 6 `invariant_*` tests (Q-3…Q-9) + `contracts/integration-tests/src/cross_contract.rs` for the atomic repay→seize path (Q-5, Q-6) |
| Config / deploy | `close_factor_bps`, `liquidation_bonus_bps`, `fee_bps`; the liquidation contract must be authorised by the lending pool          |
| Docs            | [`docs/invariants.md`](../docs/invariants.md) §5, [`docs/risk.md`](../docs/risk.md)                                              |
| Verification    | ⚠️ Source-verified only                                                                                                          |

### 1.7 Oracle

| Aspect          | Detail                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| Implementation  | `contracts/oracle/soroban/src/lib.rs` (`set_price`, `get_price`, `value_of`, publisher allow-list, heartbeat) |
| Tests           | 4 `invariant_*` tests (O-1, O-2, O-3, O-5)                                                                    |
| Config / deploy | `add_publisher`, per-asset heartbeat, price scaling (10⁻⁷)                                                    |
| Docs            | [`docs/invariants.md`](../docs/invariants.md) §2, [`docs/risk.md`](../docs/risk.md)                           |
| Verification    | ⚠️ Source-verified only                                                                                       |

### 1.8 Bridge attestation pipeline (Soroban side)

| Aspect          | Detail                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Implementation  | `contracts/lending/controller/src/lib.rs` (`wrap`, `unwrap`, ed25519 attestation verification, salt replay protection, per-hour mint cap, pause surface)                                                                                                                                                                                                           |
| Tests           | 6 `invariant_*` tests (C-2…C-6) incl. the cross-language canonical-digest canary `invariant_C6_payload_digest_matches_ts`                                                                                                                                                                                                                                          |
| Config / deploy | `set_bridge` (ed25519 public key), admin-only `set_paused`                                                                                                                                                                                                                                                                                                         |
| Docs            | [`docs/invariants.md`](../docs/invariants.md) §6, [`docs/contracts.md`](../docs/contracts.md)                                                                                                                                                                                                                                                                      |
| Verification    | ✅ **Cross-language digest verified** — the matching digest `fd426f52…` is asserted on both sides: `contracts/lending/controller/src/lib.rs` (Rust) and `services/payment/tests/signer.test.ts` (TypeScript). The TypeScript side **was executed here** (`pnpm --filter @stellar-payment-gateway/bridge test` → 17 passed). The Rust side is source-verified only. |

### 1.9 Governance and rewards

| Aspect          | Detail                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation  | `contracts/governance/soroban/src/lib.rs`, `contracts/rewards/soroban/src/lib.rs`                                                                                            |
| Tests           | `contracts/integration-tests/src/governance.rs` (9 tests), `contracts/integration-tests/src/rewards.rs` (6 tests)                                                            |
| Config / deploy | Governance admin / multisig configuration                                                                                                                                    |
| Docs            | [`docs/governance.md`](../docs/governance.md)                                                                                                                                |
| Verification    | ⚠️ Source-verified only. Note: `governance` and `rewards` are **not** part of the 7 contracts listed in `DEPLOYMENTS.md` — see the deployment table for which ones are live. |

## 2. EVM bridge

| Aspect          | Detail                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation  | `contracts/lending/evm/Bridge.sol` (upgradeable, EIP-712 `release`, quorum-gated attester set, pause, salt replay protection)            |
| Tests           | `contracts/lending/evm/test/Bridge.test.ts` — **17 tests passing**, executed here with `npx hardhat compile && npx hardhat test`         |
| Config / deploy | `DEPLOYER_PK`, `SEPOLIA_RPC`, `MUMBAI_RPC` env vars; `contracts/package-lock.json` for `npm ci`                                          |
| Docs            | [`docs/invariants.md`](../docs/invariants.md) §7, [`docs/contracts.md`](../docs/contracts.md)                                            |
| Verification    | ✅ Compile + tests verified locally. ⛔ **Not deployed** to Sepolia/Amoy — the addresses in `DEPLOYMENTS.md` are `0x000…0` placeholders. |

## 3. Off-chain services

| Feature                                                          | Implementation                                                                  | Tests                                                                    | Verification                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Bridge middleware (attestation, event watching, release signing) | `services/payment/src/` (`attest/signer.ts`, `stellarPayment.ts`, `receipt.ts`) | `services/payment/tests/{signer,validation,index}.test.ts`               | ✅ 17 tests passed (`pnpm --filter @stellar-payment-gateway/bridge test`), `tsc --noEmit` clean |
| Transaction relayer                                              | `services/cron/src/`                                                            | `services/cron/tests/index.test.ts`                                      | ✅ 1 test passed, `tsc --noEmit` clean                                                          |
| Event indexer (Postgres)                                         | `services/indexer/src/`                                                         | `services/indexer/tests/index.test.ts`                                   | ✅ 1 test passed, `tsc --noEmit` clean, `prisma generate` OK                                    |
| Public REST + WebSocket API                                      | `apps/api/src/routes/`, `apps/api/src/index.ts`                                 | `apps/api/src/tests/{markets,quote,rate-limiter,positions,auth}.test.ts` | ✅ 27 tests passed, `tsc --noEmit` clean                                                        |
| Notification service                                             | `services/notification/src/websocket.ts`                                        | none                                                                     | ⚠️ Source-verified only (no test file) — see backlog issue                                      |
| Analytics service                                                | `services/analytics/`                                                           | none                                                                     | ⚠️ Source-verified only (no test file)                                                          |

## 4. Frontend

| Feature                                                               | Implementation                                | Tests                            | Verification                                                                                      |
| --------------------------------------------------------------------- | --------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------- |
| Next.js dashboard (markets, positions, health factor, wrap/unwrap UI) | `apps/web/app/`, `apps/web/components/`       | `apps/web/tests/button.test.tsx` | ✅ 3 tests passed; `tsc --noEmit` clean; `next lint` clean (warnings only); `next build` succeeds |
| Standalone analytics app                                              | `apps/dashboard/`                             | none (`--passWithNoTests`)       | ⚠️ Source-verified only                                                                           |
| Docs site / explorer / treasury apps                                  | `apps/docs`, `apps/explorer`, `apps/treasury` | none                             | ⚠️ Source-verified only                                                                           |

## 5. SDK

| Aspect         | Detail                                                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation | `packages/sdk/src/{client,stellar-env,types,index}.ts` + `src/manifest.json`                                                                                                                                                       |
| Tests          | `packages/sdk/tests/client.test.ts`                                                                                                                                                                                                |
| Verification   | ✅ 7 tests passed, `tsc --noEmit` clean, `pnpm build` produces `dist/`                                                                                                                                                             |
| Docs           | [`docs/sdk.md`](../docs/sdk.md), [`packages/sdk/README.md`](../packages/sdk/README.md)                                                                                                                                             |
| Gap            | ✅ **Resolved 2026-10-20.** The SDK README and the `.env.example` files previously showed the **older** `lending_controller` id (`CDLZFC3S…`); they now carry the current one (`CBNG3R6J…`) from `packages/sdk/src/manifest.json`. |

## 6. Cross-system / operational features

| Feature                                       | Status             | Notes                                                                                |
| --------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| X-1 wrapped-asset backing                     | ⛔ Not implemented | No automated test; `unwrap` → `Bridge.release` is not wired end to end               |
| X-2/X-3 wrap/unwrap causality                 | ⛔ Not implemented | Same root cause                                                                      |
| X-4 API ↔ on-chain view consistency           | ⛔ Not implemented | No test compares `/v1/markets` totals with `lending_pool.total_deposit`              |
| Hosted dashboard (`app.spg.xyz`)              | ⛔ Not available   | No DNS record for `app.spg.xyz`; `spg.xyz` resolves to an unrelated third-party site |
| Hosted API (`api.spg.xyz`)                    | ⛔ Not available   | No DNS record                                                                        |
| EVM bridge deployment (Sepolia / Amoy)        | ⛔ Not deployed    | Placeholder addresses only                                                           |
| Smart-contract audit                          | 📋 Planned         | Target Q1 2027, quotes not yet received — see [`SECURITY.md`](../SECURITY.md)        |
| Bug bounty                                    | 📋 Planned         | Post-audit, within 60 days of the report                                             |
| `cargo audit` / Rust dependency advisory gate | 📋 Planned         | Not in CI yet                                                                        |
| Load / chaos testing                          | 📋 Planned         | Listed in `docs/security.md`                                                         |
| Live on-testnet DR dry-run                    | 📋 Planned         | Requires funded admin keys                                                           |

## 7. How to re-verify this inventory

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @stellar-payment-gateway/bridge  exec tsc --noEmit && pnpm --filter @stellar-payment-gateway/bridge  test
pnpm --filter @stellar-payment-gateway/relayer exec tsc --noEmit && pnpm --filter @stellar-payment-gateway/relayer test
pnpm --filter @stellar-payment-gateway/indexer exec tsc --noEmit && pnpm --filter @stellar-payment-gateway/indexer test
pnpm --filter @stellar-payment-gateway/api     exec tsc --noEmit && pnpm --filter @stellar-payment-gateway/api     test
pnpm --filter @stellar-payment-gateway/sdk     exec tsc --noEmit && pnpm --filter @stellar-payment-gateway/sdk     test
pnpm --filter @stellar-payment-gateway/dashboard exec tsc --noEmit && pnpm --filter @stellar-payment-gateway/dashboard test
(cd contracts && npm ci && npx hardhat compile && npx hardhat test)
(cd contracts && cargo test --workspace --locked)   # requires Rust 1.91.0 + wasm32v1-none
```
