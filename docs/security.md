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
