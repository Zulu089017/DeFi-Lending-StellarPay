# E2E Testnet Flow — Sepolia → Stellar Testnet

> Documents the full cross-chain path **lock → attest → mint → supply → borrow →
> liquidate** across Ethereum Sepolia and Stellar Testnet. This is the
> documented manual run required by `docs/security.md` § Pre-audit requirements.
> Everything below is **testnet only** — never send real assets.

## Flow at a glance

```
Sepolia (Bridge.sol)                     Stellar Testnet (Soroban)
────────────────────                     ─────────────────────────
1. lock(token, amount, dest, salt)  ──▶  3. lending_controller.wrap(...)
   emits Locked(...)                         (ed25519 attestation, 2-of-3)
        │                                    └─ mints wTKN to `dest`
        ▼
2. bridge middleware watches Locked
   → attesters sign canonical payload
   (sha256 → ed25519, ≥ 2-of-3)  ─────────▶  4. supply_collateral(wTKN, n)
                                             5. borrow(asset, amount)   [LTV-enforced]
                                             6. oracle price ticks down → HF < 1
                                             7. liquidation.liquidate(borrower)  [anyone]
```

## Prerequisites

- A funded **Sepolia** wallet (test ETH) holding a bridged ERC-20 token that
  `Bridge.sol` is configured to accept.
- A **Stellar testnet** account (the `dest` pubkey) funded via Friendbot.
- The bridge middleware (`services/payment`) and relayer (`services/cron`)
  running against testnet, with attester keys configured via
  `ATTESTER_KEYS_FILE` / `ATTESTER_KEYS` (see `services/payment/.env.example`).
- Contract addresses from [`DEPLOYMENTS.md`](../DEPLOYMENTS.md).

## Documented manual run

### Step 1 — Lock on Sepolia

Call `Bridge.lock(token, amount, stellarDest, salt)` on the deployed Sepolia
`Bridge` (see `DEPLOYMENTS.md`). The contract:

1. Rejects a `salt` that has already been used (replay protection — B-1).
2. Rejects amounts outside `[min, max]` for the token (limits — B-2).
3. Emits `Locked(token, amount, stellarDest, salt)`.

Verify the `Locked` event appears in a Sepolia block explorer and note the
`txHash` + `logIndex`.

### Step 2 — Attestation (bridge middleware)

The middleware polls for the `Locked` event and each attester signs the
canonical payload. The payload layout and digest are pinned by the drift canary
in `services/payment/tests/signer.test.ts` (`CANONICAL_DIGEST`); the on-chain
side recomputes the same `sha256(build_canonical_payload)` (invariant C-6). The
middleware collects **≥ 2-of-3** distinct attester signatures
(`services/payment/src/attest/signer.ts` → `collectSignatures`).

Confirm the middleware logs "collected ≥2 attestations" and enqueues a mint.

### Step 3 — Mint on Stellar

The relayer submits
`lending_controller.wrap(chain_id, source_addr, amount, to, salt, nonce, sigs)`.
On chain:

1. `check_and_bump_nonce` rejects a reused salt (C-2).
2. `require_bridge` verifies ≥ threshold distinct ed25519 attestations (C-1).
3. `check_mint_rate` enforces the per-window mint cap (C-3).
4. `wrapped_asset.mint(to, amount)` credits the destination (C-7).

Verify `wTKN` appears in the destination wallet balance (Stellar Expert).

### Step 4 — Supply collateral

Call `lending_controller.supply_collateral(asset, amount)`. This cross-calls
`lending_pool.supply` + `collateral_vault.deposit` (C-8). Verify the dashboard
collateral value updates in real time (Horizon stream).

### Step 5 — Borrow (LTV enforced)

Call `lending_controller.borrow(asset, amount)`. On chain the controller reads
the asset LTV, caps it at `MAX_LTV_BPS = 7_500` (75%), and enforces
`collateral_value >= total_debt` (health factor ≥ 1). **Over-borrowing reverts**
— include the rejected over-borrow in the demo (it demonstrates a working
invariant, not a mocked UI).

### Step 6 — Price move → liquidation

Push a downward price update via the oracle publishers (or admin
`oracle.set_price`) until the position's health factor crosses below 1.

### Step 7 — Permissionless liquidation

Any wallet calls `liquidation.liquidate(borrower, ...)`. The engine repays the
debt and seizes collateral atomically (`lending_pool.repay_on_behalf` +
`collateral_vault.seize`), capped by the 50% close factor, with the liquidator
receiving `repay + bonus − fee` (Q-1…Q-6). Verify the liquidator's balance
increases by the bonus.

## Tabletop review log

> A tabletop (paper) walkthrough, not a live network run. It verifies the
> procedure above against the actual code and deployed configuration.

| Date       | Checked                                                                      | Result | Evidence                                                                                |
| ---------- | ---------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| 2026-08-15 | Canonical payload digest matches between Rust and TS                         | ✅     | `services/payment/tests/signer.test.ts` pins `CANONICAL_DIGEST`; invariant C-6 canary   |
| 2026-08-15 | On-chain `wrap` entry points (nonce, bridge set, mint rate, cross-call mint) | ✅     | `contracts/lending/controller/src/lib.rs` (`wrap`, `require_bridge`, `check_mint_rate`) |
| 2026-08-15 | Borrow enforces per-asset LTV + 75% ceiling (over-borrow reverts)            | ✅     | `contracts/lending/controller/src/lib.rs` (`borrow`, `MAX_LTV_BPS`)                     |
| 2026-08-15 | Liquidation is permissionless, atomic, close-factor bounded                  | ✅     | `contracts/liquidation/soroban/src/lib.rs`; `docs/invariants.md` § 5                    |
| 2026-08-15 | Deployed addresses + 2-of-3 attester set are pinned                          | ✅     | `DEPLOYMENTS.md`                                                                        |

## Live execution checklist (pending)

- [ ] Funded Sepolia wallet + ERC-20 token (bridge `[min, max]` configured).
- [ ] Bridge middleware + relayer running against testnet with real attester
      keys.
- [ ] Record a run log (timestamps, tx hashes, what worked / what didn't) here.

> **Status (2026-08-15):** procedure drafted and statically verified above. Live
> testnet execution is pending funded accounts and running off-chain services.
