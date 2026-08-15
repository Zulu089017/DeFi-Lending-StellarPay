# Risk & Economic Design

> Concise economic-risk notes for the SCF Wave 8 grant review. Each section
> references the live contracts (never re-implements them); where a control does
> not yet exist, that is stated explicitly and marked a **known limitation**
> with a target milestone. Testnet-only numbers below.

## Oracle manipulation

- Each asset requires ≥ `min_publishers` (deployed testnet config: **2**)
  independent publishers to have reported a fresh price before `get_price`
  returns; otherwise it panics ("price stale").
- Prices are aggregated via **median**, not first-reported, so a single
  malicious publisher cannot move the price alone.
- Freshness is bounded by a per-asset `heartbeat` (deployed testnet config:
  **300s**); a report older than the heartbeat is treated as stale.
- **Deviation bound — known limitation.** There is currently **no explicit
  per-update deviation cap** (e.g. reject a report that moves the median more
  than X% between updates). If publishers disagree, the median is taken and the
  outlier simply discarded. A deviation/reorg guard on the oracle is a target
  post-grant hardening milestone.
  - Ref: `contracts/oracle/soroban/src/lib.rs` (`get_price`, `set_price`,
    `min_publishers`, `heartbeat`).

## Bad debt handling

- Liquidations are **permissionless and atomic**: the engine repays the
  borrower's debt and seizes collateral in one transaction
  (`lending_pool.repay_on_behalf` + `collateral_vault.seize`), with a **50%**
  close factor per tx, **5%** liquidator bonus, and **2%** protocol fee (of the
  bonus) — deployed testnet config in `contracts/scripts/deploy-testnet.mjs`.
- **Shortfall risk — known limitation.** If a liquidation does not fully cover a
  position (gas spike, slippage, or a price gap that jumps past the close-factor
  window), there is **no reserve fund, insurance, or socialized-loss mechanism**
  yet. Residual bad debt would accrue to the lending pool and threaten the L-1
  solvency invariant (`Σ B <= Σ D`). **Target milestone:** a protocol
  insurance/reserve module and/or progressive-liquidation fallback, funded after
  the audit.
  - Ref: `docs/invariants.md` § 4 (L-1), § 5 (Q-1…Q-6).

## Circuit breakers (economic controls)

- **Mint rate limit — `lending_controller.check_mint_rate`.** Enforces a rolling
  window of **1,800 ledgers** (~1 hour at 5s/ledger) with a cap of
  `MAX_PER_HOUR = 1_000_000_000_000`. **Caveat:** as implemented this counts
  **wrap transactions**, not minted _value_ (the "10B in 7 dec" comment records
  the intent, but the code increments a counter per call). It therefore does not
  meaningfully bound minted value today. See the bridge exposure note below.
  - Ref: `contracts/lending/controller/src/lib.rs` (`wrap`, `check_mint_rate`).
- **Emergency pause.** Admin-only `set_paused` (multi-admin threshold, direct —
  no timelock by design) halts all state-changing entry points (supply,
  withdraw, supply_collateral, withdraw_collateral, borrow, repay) on the
  controller, and `Bridge.setPaused` on each EVM chain. This is the primary
  containment control for economic and security events.
  - Ref: `contracts/lending/controller/src/lib.rs`; `docs/disaster-recovery.md`.
- **Per-asset LTV ceiling.** `borrow` enforces `min(asset_ltv_bps, MAX_LTV_BPS)`
  with a protocol-wide `MAX_LTV_BPS = 7_500` (75%) — defense in depth against a
  misconfigured asset LTV.
  - Ref: `contracts/lending/controller/src/lib.rs` (`borrow`).
- **Timelocked bridge rotation.** `propose_bridge` → `execute_bridge` carries a
  24h timelock (`TIMELOCK_LEDGERS = 17_280`), so a single compromised admin
  cannot silently swap the attester set.

## Bridge economic risk (worst case)

- If **2 of 3 attester keys** are compromised, the attacker meets the 2-of-3
  threshold and can sign a valid `wrap` to mint wrapped assets at will.
- **Automatic backstop:** the only on-chain backstop is `check_mint_rate`, which
  — as noted above — is a transaction-count limiter and therefore does **not**
  bound minted value. The practical bound is the **emergency pause**: once
  detected, `set_paused(true)` (admin, direct) stops minting immediately, and
  attester rotation completes within the 24h timelock.
  - Ref: `docs/disaster-recovery.md` § Scenario 3.
- **Residual risk — known limitation.** A value-based mint cap (derived from the
  wrapped asset's oracle-priced value) and a per-asset cap are **not yet
  implemented**. Making `check_mint_rate` value-based is a **funded pre-audit
  milestone** and is the highest-severity economic gap identified for this
  review.
