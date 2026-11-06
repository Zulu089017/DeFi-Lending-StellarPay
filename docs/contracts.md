# Contract Documentation

## Soroban Contracts (Rust)

### Lending Pool (`contracts/lending/soroban`)

The core lending protocol contract.

**Entry Points:**

| Function              | Args                             | Returns        | Auth               |
| --------------------- | -------------------------------- | -------------- | ------------------ |
| `initialize`          | `admin: Address`                 | —              | `admin`            |
| `add_asset`           | `cfg: AssetConfig`               | —              | `admin`            |
| `supply`              | `user, asset, amount`            | `shares: i128` | `user`             |
| `withdraw`            | `user, asset, shares`            | `amount: i128` | `user`             |
| `supply_collateral`   | `user, asset, amount`            | —              | `user`             |
| `withdraw_collateral` | `user, asset, amount`            | `amount: i128` | `user`             |
| `borrow`              | `user, asset, amount`            | —              | `user`             |
| `borrow_raw`          | `operator, user, asset, amount`  | —              | `operator`         |
| `repay`               | `user, asset, amount`            | `repaid: i128` | `user`             |
| `repay_on_behalf`     | `payer, borrower, asset, amount` | `repaid: i128` | `payer` (operator) |
| `add_operator`        | `op: Address`                    | —              | `admin`            |
| `assets`              | —                                | `Vec<Symbol>`  | —                  |
| `health_factor`       | `user, asset`                    | `hf: i128`     | —                  |
| `debt_of`             | `user, asset`                    | `debt: i128`   | —                  |
| `collateral_of`       | `user, asset`                    | `amount: i128` | —                  |
| `borrow_apy_bps`      | `asset`                          | `apy: u32`     | —                  |
| `ltv_bps`             | `asset`                          | `ltv: u32`     | —                  |

**AssetConfig:**

```rust
struct AssetConfig {
    asset: Symbol,         // Asset identifier
    collateral_vault: Address,
    oracle: Address,
    ltoken: Address,       // Share token contract
    base_rate_bps: u32,    // 0%
    slope1_bps: u32,       // Below kink slope
    slope2_bps: u32,       // Above kink slope
    kink_bps: u32,         // 80% = 8000
    reserve_factor_bps: u32,
    ltv_bps: u32,          // Max LTV (75% = 7500)
}
```

### Lending Controller (`contracts/lending/controller`)

Top-level user entry point: routes supply/borrow/repay/withdraw to the pool and
vault, enforces oracle-priced LTV on borrow **and** withdrawal, and handles
cross-chain wrap/unwrap with N-of-M attester verification.

**User flows:**

| Function              | Args                                                                   | Returns             | Auth            |
| --------------------- | ---------------------------------------------------------------------- | ------------------- | --------------- |
| `supply_collateral`   | `user, asset, amount`                                                  | —                   | `user`          |
| `borrow`              | `user, collateral_asset, collateral_amount, debt_asset, borrow_amount` | —                   | `user`          |
| `repay`               | `user, asset, amount`                                                  | `repaid: i128`      | `user`          |
| `withdraw_collateral` | `user, collateral_asset, amount`                                       | `amount: i128`      | `user`          |
| `wrap`                | `attestations, chain_id, source_addr, amount, to, salt, nonce`         | —                   | attester quorum |
| `unwrap`              | `user, amount, chain_id, source_addr`                                  | `nonce: BytesN<32>` | `user`          |

`withdraw_collateral` values the **remaining** collateral of the withdrawn asset
against the user's **total** debt across every asset returned by
`lending_pool.assets()`, at `min(asset ltv_bps, 7500)`. Ignoring other
collateral is deliberately conservative (stricter, never more permissive).

**Admin:**

| Function              | Args                                       | Auth                                |
| --------------------- | ------------------------------------------ | ----------------------------------- |
| `set_paused`          | `paused: bool`                             | any single admin (emergency)        |
| `set_mint_rate_limit` | `approvals, max_per_hour`                  | 1 admin to tighten; quorum to raise |
| `set_bridge`          | `approvals, bridge_keys, bridge_threshold` | admin quorum (no timelock)          |
| `propose_bridge`      | `approvals, bridge_keys, bridge_threshold` | admin quorum                        |
| `execute_bridge`      | `approvals`                                | admin quorum + 24h timelock         |
| `add_admin`           | `approvals, new_admin`                     | admin quorum                        |
| `remove_admin`        | `approvals, admin_to_remove`               | admin quorum                        |
| `set_threshold`       | `approvals, new_threshold`                 | admin quorum                        |

`approvals` is a list of addresses that must be (a) at least `threshold` long,
(b) all current admins, (c) free of duplicates, and (d) each have authorized the
invocation — `require_auth()` panics for any listed admin that did not sign, so
partial approval cannot be forged.

### Collateral Vault (`contracts/collateral/soroban`)

Tracks locked collateral per user per asset.

### Oracle (`contracts/oracle/soroban`)

Price feed contract (`contracts/oracle/soroban`). Implements a `Reflector`-style
on-chain price feed adapter with publisher allow-list, median-of-≥2 aggregation
and heartbeat staleness checks. **Not** a Chainlink feed integration, and
**not** a Stellar Reflect feed integration; both are described only as intended
integration points, with Chainlink on the roadmap as a planned item.

### Liquidation Engine (`contracts/liquidation/soroban`)

Permissionless liquidation contract.

**Config:**

```rust
struct LiquidationConfig {
    pool: Address,
    vault: Address,
    oracle: Address,
    bonus_bps: u32,        // 500 = 5%
    fee_bps: u32,          // 2000 = 20% of bonus
    close_factor_bps: u32, // 5000 = 50% max per tx
}
```

### Governance (`contracts/governance/soroban`)

On-chain governance for protocol parameters.

### Rewards (`contracts/rewards/soroban`)

Rewards distribution contract (stub — to be implemented).

---

## EVM Contracts (Solidity)

### Bridge.sol (`contracts/lending/evm/Bridge.sol`)

Upgradeable bridge contract for EVM chains.

**Key Functions:**

- `lock(token, amount, stellarDest, salt)` — Locks tokens, emits `Locked`
- `burn(token, amount, stellarDest, salt)` — Burns wrapped tokens
- `release(token, recipient, amount, stellarTxHash, nonce, signatures)` —
  Releases tokens on EVM side
- `pause()` / `unpause()` — Emergency controls

**Security:**

- EIP-712 typed data for release signatures
- 2-of-N attester multisig
- ReentrancyGuard (OpenZeppelin 5.x)
- Ownable with two-step transfer

### WrappedToken.sol (`contracts/treasury/evm/WrappedToken.sol`)

ERC-20 token contract representing wrapped assets on EVM chains.

---

## Testing

All contracts have comprehensive test suites:

- **Lending pool**: 18 tests covering supply, borrow, repay, withdraw, health
  factor invariants
- **Liquidation**: 9 tests covering bonus calculation, close factor, edge cases
- **Governance**: propose/vote/execute flow
- **EVM Bridge**: lock, release, threshold, pause, EIP-712 domain separation

Run tests:

```bash
# Soroban contracts
cd contracts && cargo test --workspace

# EVM contracts
cd contracts && npx hardhat test
```
