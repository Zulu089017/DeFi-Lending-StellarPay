# Protocol Invariants

> Invariants are properties of the system that must hold in **every reachable
> state**, for every input, on every block. This document is the canonical list
> an audit will check against. Each invariant references the contract(s) it
> lives in and the test that exercises it.

## Notation

- `Σ` — total supply of an asset
- `D` — total deposits in a market
- `B` — total borrows in a market
- `S` — total deposit shares
- `U` — utilization, `U = B / D`
- `C[u, a]` — collateral balance of user `u` in asset `a`
- `P[u, a]` — debt (principal × index / snap.index) of user `u` in asset `a`
- `HF[u]` — health factor of user `u`

## 1. Wrapped Asset (`wrapped_asset`)

| #   | Invariant                                             | Type                       |
| --- | ----------------------------------------------------- | -------------------------- |
| W-1 | `Σ_wTKN = sum over all accounts of balance`           | Conservation               |
| W-2 | `Σ_wTKN >= 0` always (no `mint` ever reduces supply)  | Monotone-increasing supply |
| W-3 | A `burn` that is not authorised by the holder reverts | Access control             |
| W-4 | Only the configured `minter` may call `mint`          | Access control             |
| W-5 | `initialize` is callable exactly once                 | One-shot                   |
| W-6 | `mint`/`burn` amounts are `> 0`                       | Input validation           |

## 2. Oracle (`oracle`)

| #   | Invariant                                                                                 | Type             |
| --- | ----------------------------------------------------------------------------------------- | ---------------- |
| O-1 | A `set_price` from a non-publisher reverts                                                | Access control   |
| O-2 | A `get_price` for an asset that is stale reverts (stale = `now - updated_at > heartbeat`) | Liveness         |
| O-3 | `set_price` with `price <= 0` reverts                                                     | Input validation |
| O-4 | `value_of(asset, amount) == amount * get_price(asset) / 10^7` (definition)                | Algebraic        |
| O-5 | Only the admin can add a publisher or change an asset config                              | Access control   |

## 3. Collateral Vault (`collateral_vault`)

| #   | Invariant                                                                      | Type             |
| --- | ------------------------------------------------------------------------------ | ---------------- |
| V-1 | `total_by_asset(a) = sum over all users of position(u, a)`                     | Conservation     |
| V-2 | `withdraw` cannot reduce a position below zero                                 | Solvency         |
| V-3 | Only an operator may `deposit`, `withdraw`, or `seize`                         | Access control   |
| V-4 | `seize` transfers value atomically: `from` loses `amount`, `to` gains `amount` | Conservation     |
| V-5 | `set_liq_threshold` rejects `bps > 10_000`                                     | Input validation |

## 4. Lending Pool (`lending_pool`)

| #    | Invariant                                                                         | Type                                         | Status |
| ---- | --------------------------------------------------------------------------------- | -------------------------------------------- | ------ |
| L-1  | `Σ B <= Σ D` for every market (protocol is fully collateralised)                  | Solvency                                     | ✅     |
| L-2  | `borrow_index(asset)` is monotone non-decreasing                                  | Monotonicity                                 | ✅     |
| L-3  | `debt_of(u, a) = principal(u, a) * borrow_index(a) / snap.index(u, a)`            | Algebraic                                    | ✅     |
| L-4  | First supplier receives shares `1:1`; later suppliers receive proportional shares | Share math                                   | ✅     |
| L-5  | `withdraw` rejects if the user has insufficient shares                            | Input validation                             | ✅     |
| L-6  | `repay` does not over-pay a user's outstanding debt                               | Bounded repayment                            | ✅     |
| L-7  | `total_deposit_shares(asset) >= 0` always                                         | Storage safety                               | ✅     |
| L-8  | `accrue_interest` does not change `total_borrow`                                  | Interest is index-based, not principal-based | ✅     |
| L-9  | `borrow_apy_bps` is continuous across the kink (within rounding)                  | Rate model                                   | ✅     |
| L-10 | `borrow` must verify `HF(u) >= 1` after the borrow                                | Risk control                                 | ✅     |

> ⚠️ The scaffold did **not** enforce L-10 in the initial version. **Closed
> (2026-08).** L-10 through L-16 are now fully implemented and tested; see
> `contracts/lending/soroban/src/lib.rs` for the test suite.
>
> **✅ Status of the invariant tests in this repo.** All invariants below now
> have executing tests. On the pinned toolchain (Rust 1.91.0, soroban-sdk
> 27.0.6, `wasm32v1-none`), `cargo test --workspace --locked` runs the full
> suite — zero failures. `invariant_*`-named tests: 18 lending pool (L-1…L-16,
> incl. L-10 sub-cases), 6 liquidation (Q-3…Q-9, with Q-1/Q-2 covered by
> `test_healthy_position_reverts` / `test_close_factor_enforced`), 6 controller
> (C-2, C-3, C-4, C-5, C-6×2), 4 oracle (O-1, O-2, O-3, O-5), 4 collateral vault
> (V-1, V-2, V-3, V-5), 4 wrapped asset (W-3…W-6). L-7 and L-8 were added
> (2026-08) along with the `LastAccrual` initialization fix they exposed.
> Migration history:
> [`contracts/BUILD_ENV_NOTES.md`](../contracts/BUILD_ENV_NOTES.md).
>
> **Counts as of 2026-10-20.** The workspace contains **113 `#[test]`
> functions**, of which **42 are named `invariant_*`** (18 lending pool, 6
> liquidation, 6 controller, 4 oracle, 4 collateral vault, 4 wrapped asset) —
> the breakdown above matches the source. The remaining 71 are unit,
> cross-contract (`contracts/integration-tests/src/cross_contract.rs`),
> governance/rewards and fuzz-helper tests. See
> [`docs/verification-status.md`](verification-status.md) for which of these
> were executed in the last verification pass.

## 5. Liquidation Engine (`liquidation`)

| #   | Invariant                                                                                                                                | Type                      | Status |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------ |
| Q-1 | `liquidate(borrower, ...)` reverts if `HF(borrower) >= 1`                                                                                | Only-liquidate-underwater | ✅     |
| Q-2 | `liquidate` reverts if `repay_amount > close_factor_bps / 10_000 * debt_of(borrower, debt_asset)`                                        | Close-factor              | ✅     |
| Q-3 | `liquidator_share = repay + bonus - fee`, where `fee = fee_bps * bonus / 10_000`                                                         | Algebraic                 | ✅     |
| Q-4 | The protocol never receives more than `fee_bps * bonus / 10_000` of seized collateral                                                    | Fee bounded               | ✅     |
| Q-5 | **(Closed 2026-08)** The on-chain engine cross-calls `lending_pool.repay_on_behalf` and `collateral_vault.seize` in a single transaction | Atomicity                 | ✅     |
| Q-6 | **(Closed 2026-08)** `lending_pool.repay_on_behalf` succeeds before `collateral_vault.seize` runs                                        | Ordering                  | ✅     |

## 6. Lending Controller (`lending_controller`)

| #   | Invariant                                                                                  | Type              |
| --- | ------------------------------------------------------------------------------------------ | ----------------- |
| C-1 | `wrap` is callable only with a valid ed25519 attestation from the registered bridge pubkey | Access control    |
| C-2 | A `wrap` with a `salt` that has already been used reverts                                  | Replay protection |
| C-3 | The rate of `wrap` calls cannot exceed `MAX_PER_HOUR` over a rolling window                | Circuit breaker   |
| C-4 | When `paused = true`, all user-facing entry points revert                                  | Pause surface     |
| C-5 | `set_bridge` and `set_paused` are admin-only                                               | Access control    |
| C-6 | `(chain_id, source_addr, amount, to, salt, nonce)` is bound to the attestation             | Domain separation |

> ✅ **Closed (2026-07).** `wrap` now verifies the ed25519 attestation via
> `env.crypto().ed25519_verify` over `sha256(build_canonical_payload)` against
> the registered bridge pubkey, and `invariant_C2_salt_replay_reverts` is
> re-enabled with a real signature to exercise the replay branch. See
> `CHANGELOG.md`.

> ✅ **C-6 cross-language drift canary — closed on both sides.** The off-chain
> signer pins the canonical payload digest in
> `services/payment/tests/signer.test.ts` (`CANONICAL_DIGEST`), and the Rust
> side now has the matching `invariant_C6_payload_digest_matches_ts` asserting
> the same 64-hex digest (`fd426f52…`). C-3 (mint rate limit) and C-5
> (`set_paused`/`set_bridge` admin-only) also have dedicated tests (2026-08).

| #   | Invariant                                                                                                                                                                                   | Type                       | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------ |
| C-7 | **(Closed 2026-08)** `wrap` cross-calls `wrapped_asset.mint(to, amount)` and `unwrap` calls `wrapped_asset.burn(user, amount)`                                                              | Cross-contract integration | ✅     |
| C-8 | **(Closed 2026-08)** `supply_collateral` calls `lending_pool.supply` + `collateral_vault.deposit`; `borrow` calls `oracle.value_of` (LTV enforcement) + `vault.deposit` + `pool.borrow_raw` | Cross-contract integration | ✅     |

## 7. Bridge (`Bridge.sol`)

| #   | Invariant                                                                                                                                                                   | Type              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| B-1 | `lock` rejects a `salt` that has already been used                                                                                                                          | Replay protection |
| B-2 | `lock` rejects an amount outside `[min, max]` for the configured token                                                                                                      | Limits            |
| B-3 | `release` requires `>= threshold` distinct attester signatures                                                                                                              | Quorum            |
| B-4 | `release` rejects duplicate signatures from the same attester                                                                                                               | Uniqueness        |
| B-5 | The `attester` set cannot be `threshold == length` (must be strict-less)                                                                                                    | Quorum sanity     |
| B-6 | `setPaused(true)` halts all `lock`/`burn`/`release` calls                                                                                                                   | Pause surface     |
| B-7 | `release` uses **EIP-712** (domain `StellarPay Bridge` / `1`, type `Release(address,address,uint256,bytes32,uint256)`); replays across chains / contracts / versions revert | Domain separation |

> ✅ **Closed (2026-01).** `Bridge` now inherits `EIP712Upgradeable`, the
> `RELEASE_TYPEHASH` is pinned in storage, and `_hashTypedDataV4` replaces the
> raw `keccak256(abi.encodePacked("RELEASE", ...))` digest. Off-chain
> counterpart: `services/payment/src/attest/signer.ts` → `signEvmRelease`. A
> regression test
> (`release rejects signatures signed for a different domain (B-7)` in
> `contracts/test/Bridge.test.ts`) proves cross-contract replay protection.
> **Note:** `EIP712Upgradeable` is now in the inheritance chain. On any
> pre-existing proxy deployment, this requires a storage-layout-compatible
> upgrade path (or a redeploy). For new deployments the layout is finalised in
> this contract version.

## 8. Cross-system invariants

| #   | Invariant                                                                                                                         | Type             |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| X-1 | `Σ_wTKN_on_stellar == total canonical tokens locked + burned on EVM/source chains`                                                | Backing          |
| X-2 | Every `wrap` event on Stellar corresponds to exactly one `Locked` or `Burned` event on a source chain (within confirmation depth) | Causality        |
| X-3 | Every `unwrap` event on Stellar results in exactly one `Released` event on the destination chain                                  | Causality        |
| X-4 | The canonical API `/v1/markets` total-supply numbers equal the on-chain `lending_pool.total_deposit` summed across assets         | View consistency |

## 9. How auditors will check these

1. **Property-based testing.** The `cargo test` suite will be extended with
   `proptest`-style randomised flows that assert each invariant after every
   operation.
2. **Symbolic execution.** `certora` or `mythril` will be run on the Soroban
   WASM and the Solidity bytecode to assert the invariant predicates.
3. **Manual review.** The contract-level `*_TODO_*` markers in code point
   auditors at the specific lines that still need human review.

> **✅ Status of the invariant tests in this repo.** Every invariant in this
> document now has a corresponding executing test (see § 4 for the breakdown),
> on the pinned toolchain (Rust 1.91.0, soroban-sdk 27.0.6, `wasm32v1-none`) —
> zero failures. Cross-contract integration tests (Q-5, Q-6, C-7, C-8) are
> **closed (2026-08)** — the liquidation engine calls `pool.repay_on_behalf` and
> `vault.seize` atomically, and the controller cross-calls `wrapped_asset`,
> `lending_pool`, `collateral_vault`, and `oracle`. C-1, C-2, C-3, C-5, B-7,
> L-7, L-8, L-10 through L-16, Q-1 through Q-9, and W-3 through W-6 are all
> closed. **Remaining coverage gap:** the cross-system invariants X-1, X-2, X-3
> (backing / causality) have no automated test — they depend on the release
> pipeline (unwrap → `Bridge.release`), which is not wired end-to-end yet (see
> `docs/security.md`). Migration history:
> [`contracts/BUILD_ENV_NOTES.md`](../contracts/BUILD_ENV_NOTES.md).
