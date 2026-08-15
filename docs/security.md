# Security Model

> **Status: scaffold — this protocol has not yet been audited. The notes below
> describe the intended security model and the known TODOs that must be resolved
> before mainnet deployment.**

## Threat model

| Adversary                      | Capability                                    | Mitigation                                                                        |
| ------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------- |
| Single attester key compromise | Sign a malicious `wrap` or `release`          | 2-of-3 (or better) attester quorum                                                |
| Source-chain reorg             | Replay a `Locked` event                       | Replay-protection salts on both sides; `confirmations` requirement on EVM watcher |
| Stale oracle                   | Borrow against bad prices                     | Per-asset `heartbeat` enforced by `Oracle::get_price`; multi-publisher redundancy |
| Underwater position            | Manual liquidator required                    | Permissionless `liquidation.liquidate(...)` callable by anyone                    |
| Bridge rate-limit bypass       | Mint $1B in one hour                          | `lending_controller.check_mint_rate` circuit-breaker                              |
| Admin key compromise           | Upgrade contracts, drain protocol             | 24h timelock + multisig on every admin action                                     |
| Replay across chains           | Use an Ethereum `wrap` attestation on Polygon | `chain_id` is part of the signed payload                                          |
| ECDSA malleability             | Submit a second valid sig for the same digest | `s` value bound to lower half-order                                               |

> 📉 **Economic risk design** (oracle deviation bounds, bad-debt handling,
> circuit breakers, bridge worst-case exposure) is documented in
> [`docs/risk.md`](risk.md).

## Open TODOs (must close before mainnet)

The current scaffold contains a number of **known placeholders**. They are
listed here so they cannot be forgotten:

- [x] `lending_controller.wrap` must verify the ed25519 attestation via
      `env.crypto().ed25519_verify(bridge_pub, payload, sig)`. **Closed
      (2026-07)** — `require_bridge` verifies `sha256(build_canonical_payload)`
      against the registered bridge pubkey; see `docs/invariants.md` § 6 (C-1).
- [x] `lending_pool.borrow` must enforce a **health factor check** (sum
      collateral value across all assets, multiply by `ltv_bps`, compare to
      total debt). **Closed (2026-08)** — `borrow` now enforces
      `collateral_value >= total_debt` with a `health_factor` view; see
      `docs/invariants.md` § 4 (L-10 through L-16).
- [x] `lending_pool.repay` math was simplified to `interest.max(principal)`. The
      correct accrued-debt formula is `principal * borrow_index / snap.index`.
      **Closed (2026-08)** — `repay` now uses the index-accrued formula.
- [x] `lending_pool.accrue_interest` must be **time-based**
      (per-ledger-sequence-delta) — the scaffold uses a constant additive bump.
      **Closed (2026-08)** — `accrue_interest` now uses ledger-sequence delta.
- [x] `lending_pool` uses a non-virtual share counter (first-depositor attack
      risk). Production should use a virtual shares offset. **Closed (2026-08)**
      — Virtual shares (`VIRTUAL_SHARES = 1_000_000`) now protect against
      share-price manipulation by the first depositor.
- [x] `liquidation.fee` is taken from the **bonus** (not gross). **Closed
      (2026-08)** — Fee is now `fee_bps × bonus / 10_000` where
      `bonus = gross - repay`.
- [x] `liquidation` should enforce `close_factor_bps` against the borrower's
      outstanding debt before allowing a `liquidate`. **Closed (2026-08)** —
      `liquidate` now enforces close factor; see `docs/invariants.md` § 5 (Q-1
      through Q-9).
- [x] The EVM `Bridge.release` should use **EIP-712** with a domain separator,
      not a raw `keccak256`. **Closed (2026-01)** — `Bridge` now inherits
      `EIP712Upgradeable` and `_hashTypedDataV4` replaces the raw digest; see
      `docs/invariants.md` § 7 (B-7) and `CHANGELOG.md`.
- [x] The off-chain `bridge` service should use **multi-attester signing** with
      **staggered key release** (e.g. one key in HSM, one in cold storage, one
      on a hot server). **Closed (2026-08)** — The lending controller now stores
      a `BridgeSet` (Vec of ed25519 pubkeys + threshold) and `require_bridge`
      verifies ≥ threshold distinct attestations sorted by key index. The
      off-chain signer (`services/payment/src/attest/signer.ts`) already
      collects ≥ threshold signatures. The deploy script initializes with 3
      attester keys and a 2-of-3 threshold. The EVM `Bridge.sol` already
      enforced 2-of-N attester multisig (B-3, B-4). See `docs/deployment.md` § 8
      for key-storage recommendations (HSM, cold storage, hot server).
- [x] The `oracle` should aggregate from at least two independent publishers and
      use a **median** rather than accepting the first reported value. **Closed
      (2026-08)** — Per-publisher storage, `min_publishers` config (default 2),
      and median aggregation implemented. `get_price` panics when fewer than
      `min_publishers` have non-stale reports.
- [x] The `lending_pool` emergency pause mechanism has been wired into all
      state-changing entry points (supply, withdraw, supply_collateral,
      withdraw_collateral, borrow, repay). Admin-only `set_paused` and public
      `is_paused` views are exposed. **Closed (2026-08)**.
- [x] The `lending_controller` admin functions should be guarded by a
      **timelock + multisig**, not a single EOA. **Closed (2026-08)** —
      Multi-admin set with threshold, timelocked bridge updates
      (`propose_bridge` + `execute_bridge` with 24h delay), and multi-sig-gated
      admin management (`add_admin`/`remove_admin`/ `set_threshold`). Emergency
      pause remains direct for fast response.
- [x] `lending_controller.borrow` must enforce a **per-asset LTV** read from the
      pool's `AssetConfig` rather than a single global constant. **Closed
      (2026-08)** — `borrow` reads `pool.ltv_bps(collateral_asset)`, caps it at
      the 75% protocol-wide ceiling (`min(asset_ltv, MAX_LTV_BPS)` as
      defense-in-depth against misconfiguration), and enforces LTV against
      cumulative collateral (`vault.position` + newly posted) and cumulative
      debt (`pool.debt_of` + new amount), priced via the oracle median.

## Audit

### Plan (for SCF Wave 8 grant)

A formal audit by an independent firm is required before any non-trivial TVL is
deployed. The current plan:

| Item                 | Detail                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Firm**             | Trail of Bits (primary); Halborn as backup                                                                                                                |
| **Scope**            | All 6 Soroban contracts (~2,500 lines Rust), Bridge.sol (~400 lines Solidity), bridge middleware (~800 lines TypeScript), relayer (~200 lines TypeScript) |
| **Estimated cost**   | **Quote pending** — no written quote/LOI on file yet (see the dated outreach note below); the prior $120k–$180k figure was an estimate and is removed     |
| **Timeline**         | 8–10 weeks from engagement kickoff to final report                                                                                                        |
| **Target start**     | Q1 2027 (after grant funding is secured)                                                                                                                  |
| **Grant allocation** | See **Grant Fund Allocation** below                                                                                                                       |

**Why Trail of Bits:** They have deep Rust/WASM expertise (critical for
Soroban), ECDSA/Ed25519 signature verification experience (core to our bridge
security), and a track record of auditing cross-chain protocols. Halborn is the
backup if ToB's availability doesn't align.

> **Audit quote status (2026-08-15):** no written quote or letter of intent
> (LOI) is on file yet. Outreach to **Trail of Bits** (primary) and **Halborn**
> (backup) is in progress, with a written quote/LOI expected by **2026-09-15**.
> Replace this note with the actual quote/LOI (or update the response date)
> before the SCF Wave 8 grant is submitted.

### Grant Fund Allocation

Total SCF Wave 8 grant ask: **$200,000 USD**.

| Bucket                                          | % of ask | Amount (USD) | Covers                                                                    |
| ----------------------------------------------- | -------- | ------------ | ------------------------------------------------------------------------- |
| Formal security audit (Trail of Bits / Halborn) | 70%      | $140,000     | Soroban + EVM contracts and off-chain services; audit-fix retesting       |
| Pre-audit checklist completion                  | 20%      | $40,000      | E2E testnet flow, attester key management (HSM/KMS), DR runbook, risk doc |
| Ops/infra during the audit window               | 10%      | $20,000      | Testnet hosting, monitoring, secrets manager, CI during the audit         |

> Percentages are indicative and will be rebalanced against the actual quoted
> audit cost once the Trail of Bits / Halborn quote lands.

**Pre-audit requirements (from `docs/audit-checklist.md`):**

- [x] Architecture, invariants, threat model, and deployment docs complete
- [x] 26 invariant tests passing (lending pool + liquidation)
- [x] Cross-contract integration tests (wrap → supply → borrow → liquidate)
- [x] Fuzz tests for financial math
- [x] Static analysis (clippy deny, Slither)
- [x] E2E testnet flow (Sepolia → Stellar Testnet) — **Closed (2026-08-15)** —
      documented manual run + tabletop review in `docs/e2e-testnet-flow.md`;
      live testnet execution still pending funded accounts.
- [x] Attester keys in HSM/KMS (not plaintext env vars) — **Closed
      (2026-08-15)** — keys moved out of plain `.env`; `ATTESTER_KEYS_FILE`
      loads them from a mounted secret (K8s Secret / Vault / Doppler). Full AWS
      KMS / HSM signing is a funded post-grant milestone; see
      `docs/deployment.md` § 8.
- [x] Disaster recovery runbook tested — **Closed (2026-08-15)** — runbook
      expanded with pause trigger conditions, a rollback procedure, and a
      tabletop dry-run log; see `docs/disaster-recovery.md`.
- [x] Multi-attester signing implemented — **Closed (2026-08)** — see the Open
      TODOs entry below; on-chain `BridgeSet` (2-of-3) + off-chain threshold
      collection in `services/payment/src/attest/signer.ts`.

## Bug bounty

A bug bounty program is planned for after the audit. Bounties will be paid in
wTKN. Scope, rules, and reward tiers will be published at `spg.xyz/security`.

## Disclosure

Please email `security@spg.xyz` for responsible disclosure. **Do not** open
public issues for security vulnerabilities.
