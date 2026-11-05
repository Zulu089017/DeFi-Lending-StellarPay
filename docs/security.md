# Security Model

> **Status: testnet-stage — not yet audited.** Intended security model and the
> plan to close remaining gaps before mainnet.

## Threat model

| Adversary           | Capability                    | Mitigation                                         |
| ------------------- | ----------------------------- | -------------------------------------------------- |
| Attester key leak   | Sign malicious wrap/release   | 2-of-3 `BridgeSet` (ed25519, sorted-index)         |
| Source-chain reorg  | Replay a `Locked` event       | Salts + `confirmations` on EVM watcher             |
| Stale oracle        | Borrow at bad prices          | Heartbeat + median of ≥2 publishers                |
| Underwater position | No liquidator                 | Permissionless `liquidate()`                       |
| Rate-limit bypass   | Mint $1B/hour                 | Per-hour mint circuit breaker                      |
| Admin compromise    | Upgrade/drain                 | Multi-admin threshold + 24h timelock; direct pause |
| Cross-chain replay  | Reuse an attestation          | `chain_id` in payload; EIP-712 on EVM              |
| ECDSA malleability  | Second valid sig for a digest | OZ `ECDSA` (s bound to half-order)                 |

> Economic risk design: [`docs/risk.md`](risk.md).

## Open findings from the 2026-11-04 live testnet run

These were found by executing the deployed contracts, not by reading them.
Evidence (transaction hashes, state readings) is in
[`docs/verification/testnet-e2e-2026-11-04.json`](verification/testnet-e2e-2026-11-04.json).

| ID                             | Severity     | Finding                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LIQ-RAW-UNITS**              | **Critical** | `liquidation.liquidate` decides whether a position is underwater by comparing **raw token units** (`vault.position >= pool.debt_of`) instead of oracle-priced USD values. A position with $100.01 collateral and $60 debt was liquidated on testnet (tx `0a8a4cfb…`). Invariant Q-1 as documented is not implemented. |
| **LIQ-NO-ORACLE**              | **Critical** | The same defect in the other direction: a position that is genuinely insolvent after a price drop ($10.00 collateral vs $16 debt) **cannot** be liquidated — `liquidate` reverts because raw collateral units still exceed raw debt units. The protocol accrues uncollectable bad debt.                               |
| **NO-ASSET-CUSTODY**           | **High**     | No Soroban contract moves tokens. `lending_pool.supply/withdraw/borrow/repay`, `collateral_vault.deposit/seize` and `wrapped_asset.mint/burn` only mutate internal storage; there is no `token::Client` / SAC transfer anywhere in the workspace. Balances are an internal ledger, not custody of real assets.        |
| **ADMIN-NOT-MULTISIG**         | **Medium**   | `lending_controller.require_admin` and `require_admin_multisig` both `require_auth()` on the **first** admin only. The stored `threshold` is never enforced, so the documented N-of-M admin model does not exist; any single admin can pause or rotate the bridge set (the latter is at least timelocked).            |
| **MISSING-USER-ENTRYPOINTS**   | **Medium**   | The controller exposes `supply_collateral` and `borrow` but no `repay`, `withdraw`, or `liquidate` entry point. Users must call `lending_pool` / `liquidation` directly, which bypasses the controller's oracle-based LTV checks for those paths.                                                                     |
| **BORROW-REQUIRES-COLLATERAL** | **Low**      | `lending_controller.borrow` requires `collateral_amount > 0` and re-deposits every call, so a borrower cannot draw additional debt against an existing position without posting more collateral.                                                                                                                      |

### Remediation status (2026-11-05)

Source-level fixes landed for three of the six findings. **They have not yet
been re-verified with `cargo`/Soroban in the current environment** (no
`cargo`/`rustc`/`rustup` on PATH), so the status below is "fixed in source,
pending toolchain verification" — not "verified fixed".

| ID                            | Status                                   | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LIQ-RAW-UNITS / LIQ-NO-ORACLE | **Fixed in source, unverified by cargo** | `liquidation.liquidate` now values collateral and debt via `oracle.value_of`, gates on `debt_value > coll_value * min(pool.ltv_bps, 7500) / 10_000`, and converts the repay value (+ bonus, − fee) back into collateral units with `oracle.get_price`. Regression tests R-1…R-7 cover solvent, insolvent, LTV boundary, missing price, repeated partial liquidation and bonus inclusion.                                                                          |
| ADMIN-NOT-MULTISIG            | **Fixed in source, unverified by cargo** | `require_admin_multisig(approvals)` now enforces a real threshold: `approvals.len() >= threshold`, membership, no duplicates, and `require_auth()` on every listed approver. `add_admin`, `remove_admin`, `set_threshold`, `propose_bridge`, `execute_bridge` and `set_bridge` all take `approvals`. Raising the mint cap requires quorum; tightening it stays single-admin so an emergency brake cannot be blocked. `set_paused` remains single-admin by design. |
| MISSING-USER-ENTRYPOINTS      | **Fixed in source, unverified by cargo** | Controller gained `repay(user, asset, amount)` (returns the amount actually applied) and `withdraw_collateral(user, asset, amount)`, which aggregates debt across every asset from the new `lending_pool.assets()` view and rejects withdrawals that breach LTV.                                                                                                                                                                                                  |
| NO-ASSET-CUSTODY              | **Open**                                 | No token moves yet. This is a cross-cutting migration across pool, vault, treasury and every test fixture; see the migration plan below.                                                                                                                                                                                                                                                                                                                          |
| BORROW-REQUIRES-COLLATERAL    | **Open**                                 | `borrow` still requires `collateral_amount > 0`.                                                                                                                                                                                                                                                                                                                                                                                                                  |

#### NO-ASSET-CUSTODY migration plan (not implemented)

1. Add `token: Address` to `lending_pool::AssetConfig` and
   `DataKey::Token(asset)` to the collateral vault, set by admin at
   asset-configuration time.
2. Pool: `supply`/`withdraw` transfer between user and pool; `borrow` pays out
   from pool balance; `repay` pulls from the payer; `supply_collateral` moves
   tokens to the vault.
3. Vault: `deposit`/`withdraw`/`seize` perform real SAC `transfer` calls
   (`from.require_auth()` is satisfied by the user's top-level authorization
   propagating through the controller).
4. Add a `solvent(asset)` view comparing `token.balance(pool)` with
   `total_deposit - total_borrow` and a CI/runtime reconciliation check.
5. Update every test fixture to deploy a Stellar Asset Contract
   (`env.register_stellar_asset_contract_v2`), mint to users, and assert real
   balance deltas — this is why the change must land in an environment with a
   working Rust toolchain.

### What the live run did **not** cover

- Stale-price rejection: `get_price` uses
  `effective_ttl = max(heartbeat, 300 ledgers)`, so ~25 minutes of ledgers are
  needed. Covered by the Rust `oracle` invariant suite only.
- `wrap` with a valid 2-of-3 attestation: the off-chain signer was not run
  against the new keys in this pass. The rejection path (no attestations → no
  mint) was verified live.
- Asset-custody behaviour, for the reason given by NO-ASSET-CUSTODY.

## Status of known gaps

Contract TODOs are **not** all closed — the live run above contradicts several
documented invariants (Q-1 in particular). The Rust suite covers the rest — see
[`docs/invariants.md`](invariants.md) (L-1…L-16, Q-1…Q-9, C-1…C-8, O-1…O-5,
V-1…V-5, W-3…W-6, B-1…B-7).

**Remaining:**

- [x] X-1…X-4 cross-system predicates tested
      (`services/payment/src/invariants.ts`) and the unwrap → `Bridge.release`
      pipeline wired with state-machine tests
- [ ] Live reconciliation job feeding X-1…X-4 from chain + database
- [ ] Release pipeline exercised against a deployed EVM `Bridge` (none exists
      yet)
- [ ] Fix LIQ-RAW-UNITS / LIQ-NO-ORACLE (oracle-priced liquidation) and add
      regression tests
- [ ] Decide whether the protocol is meant to custody SAC tokens; if so,
      implement transfers
- [ ] Enforce the admin threshold, or document it as single-admin
- [x] Live on-testnet lifecycle run (2026-11-04, funded via Friendbot)
- [ ] Load test (1,000 users); chaos tests
- [ ] `cargo audit` / `npm audit` clean (dev/test findings only)

## Audit

Target **Q1 2027** — **Trail of Bits** (primary) / **Halborn** (backup),
confirmed in budget under the SCF Wave 8 grant; **quote pending** (expected
**2026-09-15**). Scope and full plan: [`SECURITY.md`](../SECURITY.md).

## Grant Fund Allocation

SCF Wave 8 ask: **$200,000 USD** — audit 70% ($140,000), pre-audit checklist 20%
($40,000), ops/infra 10% ($20,000).

## Bug bounty & disclosure

Bounty scope, tiers, payouts (post-audit, within 60 days; amounts are
placeholders) and the disclosure policy (90-day coordinated window, safe
harbor): [`SECURITY.md`](../SECURITY.md).
