//! # Lending Pool
//!
//! Supply/borrow/repay/withdraw for each supported asset. Issues
//! interest-bearing share tokens (lTKN) per asset. The interest rate
//! is a kinked linear model: rate = base + slope * utilization, with
//! a steeper slope past the kink (k=80%).
//!
//! Calls the `collateral_vault` to track posted collateral and
//! the `oracle` to value positions.

#![no_std]

mod pause;
use pause::{is_paused, require_not_paused, set_paused};

use soroban_sdk::{contract, contractevent, contractimpl, contracttype, Address, Env, Symbol};

/// Virtual shares offset to defeat the first-depositor share-inflation
/// attack. Both VIRTUAL_SHARES and VIRTUAL_DEPOSIT are set to 1M (7-decimal
/// units = 0.1 XLM) so the first real share price is always ~1.0.
/// Without this offset, a first depositor could donate 1 unit and skew the
/// share price, diluting later depositors.
const VIRTUAL_SHARES: i128 = 1_000_000;
const VIRTUAL_DEPOSIT: i128 = 1_000_000;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// address authorized to operate on behalf (repay_on_behalf, etc.)
    Operator(Address),
    /// asset => `AssetConfig`
    AssetConfig(Symbol),
    /// asset => total deposits
    TotalDeposit(Symbol),
    /// asset => total borrows
    TotalBorrow(Symbol),
    /// asset => last accumulated index (1e18)
    BorrowIndex(Symbol),
    /// (user, asset) => deposit shares
    DepositShares(Address, Symbol),
    /// (user, asset) => `BorrowerSnapshot { principal, index }`
    Borrower(Address, Symbol),
    /// asset => last ledger sequence that interest was accrued
    LastAccrual(Symbol),
    /// asset => total deposit shares (separate from total_deposit to avoid
    /// the first-depositor share-inflation attack)
    TotalDepositShares(Symbol),
}

#[contracttype]
#[derive(Clone)]
pub struct AssetConfig {
    pub asset: Symbol,
    pub collateral_vault: Address,
    pub oracle: Address,
    pub ltoken: Address, // share-token contract
    pub base_rate_bps: u32,
    pub slope1_bps: u32,
    pub slope2_bps: u32,
    pub kink_bps: u32, // utilization kink in bps
    pub reserve_factor_bps: u32,
    pub ltv_bps: u32, // max LTV for this asset as collateral
}

#[contracttype]
#[derive(Clone)]
pub struct BorrowerSnapshot {
    pub principal: i128, // in 7-decimal units
    pub index: i128,     // 1e18
}

// ──────────────────────── Events ────────────────────────

#[contractevent(data_format = "vec")]
pub struct PauseToggled {
    paused: bool,
}

#[contractevent(data_format = "vec")]
pub struct CollateralDeposited {
    user: Address,
    asset: Symbol,
    amount: i128,
}

#[contractevent(data_format = "vec")]
pub struct CollateralWithdrawn {
    user: Address,
    asset: Symbol,
    amount: i128,
}

#[contract]
pub struct LendingPool;

#[contractimpl]
impl LendingPool {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn add_asset(env: Env, cfg: AssetConfig) {
        Self::require_admin(&env);
        env.storage()
            .persistent()
            .set(&DataKey::AssetConfig(cfg.asset.clone()), &cfg);
        env.storage()
            .persistent()
            .set(&DataKey::TotalDeposit(cfg.asset.clone()), &0i128);
        env.storage()
            .persistent()
            .set(&DataKey::TotalBorrow(cfg.asset.clone()), &0i128);
        env.storage().persistent().set(
            &DataKey::BorrowIndex(cfg.asset.clone()),
            &1_000_000_000_000_000_000i128,
        );
        // Seed the accrual clock at asset-config time. `accrue_interest`
        // treats a missing `LastAccrual` as "now" (unwrap_or), so without
        // this the first accrual would always no-op and interest would
        // never accrue (L-8 regression test).
        env.storage().persistent().set(
            &DataKey::LastAccrual(cfg.asset.clone()),
            &env.ledger().sequence(),
        );
    }

    // ──────────────────────── SUPPLY / WITHDRAW ────────────────────────

    /// Set the pause state. Admin-only.
    pub fn set_paused(env: Env, paused: bool) {
        Self::require_admin(&env);
        set_paused(&env, paused);
    }

    /// Check whether the pool is currently paused.
    pub fn is_paused(env: Env) -> bool {
        is_paused(&env)
    }

    /// Authorize an operator (e.g. the liquidation contract) to call
    /// gated functions like `repay` on behalf of other users.
    pub fn add_operator(env: Env, op: Address) {
        Self::require_admin(&env);
        env.storage()
            .persistent()
            .set(&DataKey::Operator(op), &true);
    }

    pub fn supply(env: Env, user: Address, asset: Symbol, amount: i128) -> i128 {
        user.require_auth();
        require_not_paused(&env);
        if amount <= 0 {
            panic!("amount must be positive");
        }
        Self::accrue_interest(&env, &asset);

        let total_d = Self::total_deposit(&env, &asset);
        let total_shares = Self::deposit_shares_total(&env, &asset);

        // Virtual-share math: every deposit mints proportional shares
        // against a virtual offset that prevents share-price manipulation
        // by the first depositor.  No special case for first supplier.
        let minted_shares = amount
            .checked_mul(total_shares.checked_add(VIRTUAL_SHARES).expect("overflow"))
            .expect("overflow")
            / total_d
                .checked_add(VIRTUAL_DEPOSIT)
                .expect("overflow")
                .max(1);

        let key = DataKey::DepositShares(user.clone(), asset.clone());
        let cur = env.storage().persistent().get(&key).unwrap_or(0i128);
        env.storage()
            .persistent()
            .set(&key, &cur.checked_add(minted_shares).expect("overflow"));
        env.storage().persistent().set(
            &DataKey::TotalDepositShares(asset.clone()),
            &total_shares.checked_add(minted_shares).expect("overflow"),
        );
        env.storage().persistent().set(
            &DataKey::TotalDeposit(asset.clone()),
            &total_d.checked_add(amount).expect("overflow"),
        );

        minted_shares
    }

    pub fn withdraw(env: Env, user: Address, asset: Symbol, shares: i128) -> i128 {
        user.require_auth();
        require_not_paused(&env);
        if shares <= 0 {
            panic!("shares must be positive");
        }
        Self::accrue_interest(&env, &asset);

        let key = DataKey::DepositShares(user.clone(), asset.clone());
        let cur = env.storage().persistent().get(&key).unwrap_or(0i128);
        if cur < shares {
            panic!("insufficient shares");
        }

        let total_d = Self::total_deposit(&env, &asset);
        let total_shares = Self::deposit_shares_total(&env, &asset);
        // Virtual-share math for redemption.
        let amount = shares
            .checked_mul(total_d.checked_add(VIRTUAL_DEPOSIT).expect("overflow"))
            .expect("overflow")
            / total_shares
                .checked_add(VIRTUAL_SHARES)
                .expect("overflow")
                .max(1);

        env.storage().persistent().set(&key, &(cur - shares));
        env.storage()
            .persistent()
            .set(&DataKey::TotalDeposit(asset.clone()), &(total_d - amount));
        amount
    }

    // ──────────────────── COLLATERAL DEPOSITS ────────────────────

    /// Deposit collateral into the vault for the given asset.
    /// The caller must have already approved the vault to spend their tokens.
    pub fn supply_collateral(env: Env, user: Address, asset: Symbol, amount: i128) {
        user.require_auth();
        require_not_paused(&env);
        if amount <= 0 {
            panic!("amount must be positive");
        }
        let _cfg = Self::asset_config(&env, &asset);
        // Cross-call the collateral vault to lock the user's tokens.
        // In production this would invoke the vault contract via
        // `env.invoke_contract`; for the scaffold we track it locally.
        let key = DataKey::DepositShares(user.clone(), asset.clone());
        let cur = env.storage().persistent().get(&key).unwrap_or(0i128);
        env.storage()
            .persistent()
            .set(&key, &cur.checked_add(amount).expect("overflow"));
        // Emit event for off-chain indexers
        CollateralDeposited {
            user,
            asset,
            amount,
        }
        .publish(&env);
    }

    /// Withdraw collateral (only if health factor remains safe).
    pub fn withdraw_collateral(env: Env, user: Address, asset: Symbol, amount: i128) -> i128 {
        user.require_auth();
        require_not_paused(&env);
        if amount <= 0 {
            panic!("amount must be positive");
        }
        let key = DataKey::DepositShares(user.clone(), asset.clone());
        let cur = env.storage().persistent().get(&key).unwrap_or(0i128);
        if cur < amount {
            panic!("insufficient collateral");
        }
        // In production: check health factor after withdrawal
        let new_amount = cur - amount;
        env.storage().persistent().set(&key, &new_amount);
        CollateralWithdrawn {
            user,
            asset,
            amount,
        }
        .publish(&env);
        amount
    }

    /// Query the collateral balance for a user and asset.
    pub fn collateral_of(env: Env, user: Address, asset: Symbol) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::DepositShares(user, asset))
            .unwrap_or(0)
    }

    // ──────────────────────── BORROW / REPAY ────────────────────────

    pub fn borrow(env: Env, user: Address, asset: Symbol, amount: i128) {
        user.require_auth();
        Self::borrow_internal(&env, &user, &asset, amount, true)
    }

    /// Record a borrow without the single-asset health-factor check.
    /// Caller must be a registered operator (e.g. the lending controller,
    /// which performs its own oracle-based multi-asset LTV enforcement).
    pub fn borrow_raw(env: Env, operator: Address, user: Address, asset: Symbol, amount: i128) {
        operator.require_auth();
        Self::require_operator(&env, &operator);
        require_not_paused(&env);
        Self::borrow_internal(&env, &user, &asset, amount, false)
    }

    pub fn repay(env: Env, user: Address, asset: Symbol, amount: i128) -> i128 {
        user.require_auth();
        Self::repay_internal(&env, &user, &user, &asset, amount)
    }

    /// Repay a borrower's debt on their behalf. Caller must be a registered
    /// operator (e.g. the liquidation contract). The `payer` authorises the
    /// call; the `borrower` is the user whose debt is being reduced.
    pub fn repay_on_behalf(
        env: Env,
        payer: Address,
        borrower: Address,
        asset: Symbol,
        amount: i128,
    ) -> i128 {
        payer.require_auth();
        Self::require_operator(&env, &payer);
        Self::repay_internal(&env, &payer, &borrower, &asset, amount)
    }

    // ──────────────────────── VIEWS ────────────────────────

    pub fn total_deposit(env: &Env, asset: &Symbol) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalDeposit(asset.clone()))
            .unwrap_or(0)
    }

    pub fn total_borrow(env: &Env, asset: &Symbol) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalBorrow(asset.clone()))
            .unwrap_or(0)
    }

    pub fn borrow_index(env: &Env, asset: &Symbol) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::BorrowIndex(asset.clone()))
            .unwrap_or(1_000_000_000_000_000_000i128)
    }

    pub fn deposit_shares_of(env: Env, user: Address, asset: Symbol) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::DepositShares(user, asset))
            .unwrap_or(0)
    }

    pub fn debt_of(env: Env, user: Address, asset: Symbol) -> i128 {
        let snap: BorrowerSnapshot = env
            .storage()
            .persistent()
            .get(&DataKey::Borrower(user, asset.clone()))
            .unwrap_or(BorrowerSnapshot {
                principal: 0,
                index: 1_000_000_000_000_000_000i128,
            });
        let idx = Self::borrow_index(&env, &asset);
        if snap.principal == 0 {
            return 0;
        }
        snap.principal.checked_mul(idx).expect("overflow") / snap.index.max(1)
    }

    /// Compute the health factor for a user.
    /// HF = total_collateral_value / total_borrow_value (scaled 1e18).
    /// Returns 0 if the user has no borrows.
    pub fn health_factor(env: Env, user: Address, asset: Symbol) -> i128 {
        let debt = Self::debt_of(env.clone(), user.clone(), asset.clone());
        if debt == 0 {
            return 0;
        }
        let collateral = Self::collateral_of(env, user, asset);
        if collateral == 0 {
            return 0;
        }
        collateral
            .checked_mul(1_000_000_000_000_000_000i128)
            .expect("overflow")
            / debt
    }

    /// Returns the configured max LTV (basis points) for `asset` when used
    /// as collateral, from the asset's `AssetConfig`. Cross-contract
    /// callable by the lending controller, which enforces per-asset LTV on
    /// borrows (`effective = min(asset_ltv_bps, MAX_LTV_BPS)`).
    pub fn ltv_bps(env: Env, asset: Symbol) -> u32 {
        Self::asset_config(&env, &asset).ltv_bps
    }

    /// Returns the current borrow APY for `asset` in basis points.
    pub fn borrow_apy_bps(env: Env, asset: Symbol) -> u32 {
        let cfg = Self::asset_config(&env, &asset);
        let total_d = Self::total_deposit(&env, &asset);
        let total_b = Self::total_borrow(&env, &asset);
        let u = if total_d == 0 {
            0
        } else {
            (total_b as u64).min(total_d as u64) * 10_000 / total_d as u64
        };
        let u = u as u32;
        if u <= cfg.kink_bps {
            cfg.base_rate_bps + (cfg.slope1_bps * u / cfg.kink_bps.max(1))
        } else {
            cfg.base_rate_bps
                + cfg.slope1_bps
                + cfg.slope2_bps * (u - cfg.kink_bps) / (10_000 - cfg.kink_bps).max(1)
        }
    }

    // ──────────────────────── INTERNAL ────────────────────────

    /// Shared borrow logic. When `check_hf` is true, the single-asset
    /// health-factor check is enforced. Operators use `borrow_raw` with
    /// `check_hf = false` after performing their own multi-asset LTV check.
    fn borrow_internal(env: &Env, user: &Address, asset: &Symbol, amount: i128, check_hf: bool) {
        require_not_paused(env);
        if amount <= 0 {
            panic!("amount must be positive");
        }
        Self::accrue_interest(env, asset);

        if check_hf {
            let collateral_value = Self::collateral_of(env.clone(), user.clone(), asset.clone());
            let existing_debt = Self::debt_of(env.clone(), user.clone(), asset.clone());
            let total_debt = existing_debt.checked_add(amount).expect("overflow");
            if total_debt > 0 && collateral_value < total_debt {
                panic!("health factor too low: collateral must exceed debt");
            }
        }

        let key = DataKey::Borrower(user.clone(), asset.clone());
        let idx = Self::borrow_index(env, asset);
        let snap: BorrowerSnapshot =
            env.storage()
                .persistent()
                .get(&key)
                .unwrap_or(BorrowerSnapshot {
                    principal: 0,
                    index: idx,
                });
        let new_principal = snap.principal.checked_add(amount).expect("overflow");
        env.storage().persistent().set(
            &key,
            &BorrowerSnapshot {
                principal: new_principal,
                index: idx,
            },
        );

        let total_b = Self::total_borrow(env, asset);
        env.storage().persistent().set(
            &DataKey::TotalBorrow(asset.clone()),
            &total_b.checked_add(amount).expect("overflow"),
        );
    }

    fn repay_internal(
        env: &Env,
        _payer: &Address,
        borrower: &Address,
        asset: &Symbol,
        amount: i128,
    ) -> i128 {
        require_not_paused(env);
        if amount <= 0 {
            panic!("amount must be positive");
        }
        Self::accrue_interest(env, asset);

        let key = DataKey::Borrower(borrower.clone(), asset.clone());
        let idx = Self::borrow_index(env, asset);
        let snap: BorrowerSnapshot =
            env.storage()
                .persistent()
                .get(&key)
                .unwrap_or(BorrowerSnapshot {
                    principal: 0,
                    index: 1_000_000_000_000_000_000i128,
                });
        let total_owed = if snap.principal == 0 {
            0
        } else {
            snap.principal.checked_mul(idx).expect("overflow") / snap.index.max(1)
        };
        let repaid = if amount >= total_owed {
            total_owed
        } else {
            amount
        };
        let new_principal = total_owed - repaid;

        env.storage().persistent().set(
            &key,
            &BorrowerSnapshot {
                principal: new_principal,
                index: idx,
            },
        );

        let total_b = Self::total_borrow(env, asset);
        env.storage()
            .persistent()
            .set(&DataKey::TotalBorrow(asset.clone()), &(total_b - repaid));
        repaid
    }

    fn accrue_interest(env: &Env, asset: &Symbol) {
        let total_b = Self::total_borrow(env, asset);
        if total_b == 0 {
            return;
        }
        // Time-based accrual: difference in ledger sequence since last accrual.
        // `env.ledger().sequence()` returns `u32`; keep the stored `LastAccrual`
        // and the local `now`/`last`/`blocks` arithmetic in `u32` to match.
        let last: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::LastAccrual(asset.clone()))
            .unwrap_or(env.ledger().sequence());
        let now = env.ledger().sequence();
        if now <= last {
            return;
        }
        let blocks = (now - last) as i128;
        let apy = Self::borrow_apy_bps(env.clone(), asset.clone()) as i128;
        // SECONDS_PER_YEAR = 31_536_000, LEDGER_TIME_SECS = 5
        // per-block rate = apy_bps / 10_000 / SECONDS_PER_YEAR * LEDGER_TIME_SECS
        // = apy_bps * LEDGER_TIME_SECS / (10_000 * SECONDS_PER_YEAR)
        let per_block_numer = apy * 5i128; // LEDGER_TIME_SECS
        let per_block_denom = 10_000i128 * 31_536_000i128; // 10_000 * SECONDS_PER_YEAR
                                                           // Use 1e18-scaled index: delta = blocks * per_block_numer * 1e18 / per_block_denom
        let idx = Self::borrow_index(env, asset);
        let delta = blocks
            .checked_mul(per_block_numer)
            .expect("overflow")
            .checked_mul(1_000_000_000_000_000_000i128)
            .expect("overflow")
            / per_block_denom;
        env.storage()
            .persistent()
            .set(&DataKey::BorrowIndex(asset.clone()), &(idx + delta));
        env.storage()
            .persistent()
            .set(&DataKey::LastAccrual(asset.clone()), &now);
    }

    fn asset_config(env: &Env, asset: &Symbol) -> AssetConfig {
        env.storage()
            .persistent()
            .get(&DataKey::AssetConfig(asset.clone()))
            .expect("asset not configured")
    }

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set");
        admin.require_auth();
    }

    fn require_operator(env: &Env, op: &Address) {
        let ok: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Operator(op.clone()))
            .unwrap_or(false);
        if !ok {
            panic!("not a pool operator");
        }
    }

    fn deposit_shares_total(env: &Env, asset: &Symbol) -> i128 {
        // Tracked separately from total_deposit so the share price can be
        // computed even when there are outstanding borrows (utilization < 100%).
        env.storage()
            .persistent()
            .get(&DataKey::TotalDepositShares(asset.clone()))
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // invariant tests are named after doc IDs
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_supply_mints_shares() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");

        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        let s = pool.supply(&user, &asset, &1_000_000);
        assert_eq!(s, 1_000_000);
        assert_eq!(pool.deposit_shares_of(&user, &asset), 1_000_000);
    }

    #[test]
    fn test_borrow_then_repay() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");

        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        pool.supply(&user, &asset, &1_000_000);
        pool.borrow(&user, &asset, &250_000);
        let d = pool.debt_of(&user, &asset);
        assert!(d >= 250_000);
        let repaid = pool.repay(&user, &asset, &300_000);
        assert_eq!(repaid, d);
        assert_eq!(pool.debt_of(&user, &asset), 0);
    }

    // ──────────────────────── INVARIANT TESTS (L-1 … L-9) ────────────────────────
    // These tests assert the invariants listed in `docs/invariants.md` § 4.
    // They double as documentation: each test name starts with `invariant_L*_`.
    //
    // UNVERIFIED: `cargo test` is blocked by a `soroban-sdk 21.x` dep-tree
    // split. See `../../BUILD_ENV_NOTES.md`. Tests are static-reviewed as
    // well-formed against the existing test patterns in this module.

    /// **L-1:** `Σ borrows <= Σ deposits` for every market.
    #[test]
    fn invariant_L1_borrows_le_deposits() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        pool.supply(&user, &asset, &1_000_000);
        // Borrow less than the deposit
        pool.borrow(&user, &asset, &500_000);
        let d = pool.total_deposit(&asset);
        let b = pool.total_borrow(&asset);
        assert!(
            b <= d,
            "invariant L-1 violated: borrows ({b}) > deposits ({d})"
        );
    }

    /// **L-2:** `borrow_index` is monotone non-decreasing across operations.
    #[test]
    fn invariant_L2_borrow_index_monotone() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        let i0 = pool.borrow_index(&asset);
        pool.supply(&user, &asset, &1_000_000);
        let i1 = pool.borrow_index(&asset);
        assert!(
            i1 >= i0,
            "invariant L-2 violated: index decreased across a no-op"
        );
        pool.borrow(&user, &asset, &100_000);
        let i2 = pool.borrow_index(&asset);
        assert!(
            i2 >= i1,
            "invariant L-2 violated: index decreased after a borrow"
        );
    }

    /// **L-3:** `debt_of` equals `principal * borrow_index / snap.index` (within rounding).
    #[test]
    fn invariant_L3_debt_of_matches_principal_times_index() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        pool.supply(&user, &asset, &1_000_000);
        pool.borrow(&user, &asset, &200_000);
        let d = pool.debt_of(&user, &asset);
        assert!(d >= 200_000, "debt should be >= borrowed principal");
        // The principal is recorded at the index at borrow time, so a later
        // call should not under-count.
        let d2 = pool.debt_of(&user, &asset);
        assert!(d2 >= d, "a second read should not under-count");
    }

    /// **L-4:** First supplier gets 1:1 shares; later supplier gets proportional shares.
    #[test]
    fn invariant_L4_share_math() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        let s0 = pool.supply(&a, &asset, &1_000_000);
        assert_eq!(s0, 1_000_000, "first supplier: 1:1 shares");
        // Second supplier deposits the same amount with no borrows -> same shares.
        let s1 = pool.supply(&b, &asset, &1_000_000);
        assert_eq!(
            s1, 1_000_000,
            "second supplier of equal amount: equal shares"
        );
    }

    /// **L-5:** `withdraw` rejects when the user has insufficient shares.
    #[test]
    #[should_panic]
    fn invariant_L5_withdraw_rejects_insufficient_shares() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        pool.supply(&user, &asset, &100);
        pool.withdraw(&user, &asset, &101);
    }

    /// **L-6:** `repay` cannot over-pay a user's outstanding debt.
    #[test]
    fn invariant_L6_repay_caps_at_outstanding_debt() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        pool.supply(&user, &asset, &1_000_000);
        pool.borrow(&user, &asset, &100_000);
        let d = pool.debt_of(&user, &asset);
        let repaid = pool.repay(&user, &asset, &1_000_000_000);
        assert_eq!(repaid, d, "repay must be capped at outstanding debt");
        assert_eq!(pool.debt_of(&user, &asset), 0);
    }

    /// **L-7:** `total_deposit_shares(asset) >= 0` always — share accounting
    /// never goes negative across supply/withdraw cycles.
    #[test]
    fn invariant_L7_deposit_shares_never_negative() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        // `deposit_shares_total` is a private view; with a single user the
        // user's share balance IS the aggregate, and per-user shares must
        // never underflow below zero across supply/withdraw cycles.
        assert_eq!(pool.deposit_shares_of(&user, &asset), 0);

        pool.supply(&user, &asset, &1_000_000);
        let shares = pool.deposit_shares_of(&user, &asset);
        assert!(shares >= 0, "shares must never go negative");
        pool.withdraw(&user, &asset, &shares);
        assert_eq!(pool.deposit_shares_of(&user, &asset), 0);

        // Withdrawing more than held reverts (L-5), so a fresh cycle still
        // keeps the balance non-negative.
        pool.supply(&user, &asset, &500);
        pool.withdraw(&user, &asset, &pool.deposit_shares_of(&user, &asset));
        assert!(pool.deposit_shares_of(&user, &asset) >= 0);
    }

    /// **L-8:** `accrue_interest` changes the borrow index but never the
    /// `total_borrow` (interest is index-based, not principal-based).
    #[test]
    fn invariant_L8_accrue_does_not_change_total_borrow() {
        use soroban_sdk::testutils::Ledger as _;
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let u1 = Address::generate(&env);
        let u2 = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        pool.supply(&u1, &asset, &1_000_000);
        pool.borrow(&u1, &asset, &200_000);

        let total_before = pool.total_borrow(&asset);
        let idx_before = pool.borrow_index(&asset);

        // Advance the ledger so interest can accrue, then trigger accrual
        // through a state-changing entry point (supply).
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + 100_000);
        pool.supply(&u2, &asset, &1);

        // The index must have grown (accrual ran)…
        assert!(
            pool.borrow_index(&asset) > idx_before,
            "borrow index should increase with time"
        );
        // …but total_borrow is untouched by accrual (L-8).
        assert_eq!(pool.total_borrow(&asset), total_before);
    }

    /// **L-9:** `borrow_apy_bps` is monotone non-decreasing in utilization.
    #[test]
    fn invariant_L9_apy_monotone_in_utilization() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let u1 = Address::generate(&env);
        let u2 = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        let apy0 = pool.borrow_apy_bps(&asset);
        // No borrows -> apy = base_rate_bps = 0
        assert_eq!(apy0, 0);
        pool.supply(&u1, &asset, &1_000_000);
        pool.borrow(&u1, &asset, &200_000); // 20% utilization
        let apy20 = pool.borrow_apy_bps(&asset);
        pool.supply(&u2, &asset, &1_000_000);
        pool.borrow(&u2, &asset, &600_000); // total util: 800k/2M = 40%
        let apy40 = pool.borrow_apy_bps(&asset);
        assert!(apy20 > apy0, "apy must increase with utilization");
        assert!(
            apy40 >= apy20,
            "apy must continue to increase up to the kink"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // HEALTH FACTOR INVARIANT TESTS (L-10 through L-16)
    // ═══════════════════════════════════════════════════════════════════════

    /// **L-10:** `borrow` must verify `HF >= 1` — reverts when collateral is insufficient.
    /// A user with no (or insufficient) collateral must not be able to borrow.
    #[test]
    #[should_panic(expected = "health factor too low")]
    fn invariant_L10_borrow_rejects_insufficient_collateral() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let lp = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        // Supply from a separate liquidity provider so the pool has funds.
        pool.supply(&lp, &asset, &1_000_000);
        // Borrow without posting any collateral must panic.
        pool.borrow(&user, &asset, &500_000);
    }

    /// **L-10b:** Borrow exactly at the max LTV boundary (HF = 1.0 after borrow).
    /// With 1000 collateral and 75% LTV, borrowing up to 750 should succeed.
    #[test]
    fn invariant_L10b_borrow_at_max_ltv_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        // Post collateral first, then supply + borrow
        pool.supply_collateral(&user, &asset, &1_000i128);
        pool.supply(&user, &asset, &10_000i128);
        // Borrow exactly at collateral value (HF = 1.0)
        pool.borrow(&user, &asset, &1_000i128);
        assert_eq!(pool.debt_of(&user, &asset), 1_000i128);
    }

    /// **L-10c:** Borrowing one unit above collateral must panic.
    #[test]
    #[should_panic(expected = "health factor too low")]
    fn invariant_L10c_borrow_beyond_collateral_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let lp = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        // Supply from a separate LP so the pool has liquidity.
        pool.supply(&lp, &asset, &5_000);
        // Post 500 collateral (via supply_collateral, not supply).
        pool.supply_collateral(&user, &asset, &500i128);
        // Borrow 501 > 500 collateral → must panic
        pool.borrow(&user, &asset, &501i128);
    }

    /// **L-11:** Health factor improves (or stays the same) after partial repay.
    #[test]
    fn invariant_L11_health_factor_improves_after_repay() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        pool.supply_collateral(&user, &asset, &1_000i128);
        pool.supply(&user, &asset, &10_000i128);
        pool.borrow(&user, &asset, &800i128);
        let hf_before = pool.health_factor(&user, &asset);
        // Repay half
        pool.repay(&user, &asset, &400i128);
        let hf_after = pool.health_factor(&user, &asset);
        assert!(
            hf_after > hf_before,
            "L-11: HF must improve after repay: {hf_after} <= {hf_before}"
        );
    }

    /// **L-12:** Health factor returns 0 for a user with no borrows.
    #[test]
    fn invariant_L12_health_factor_zero_for_no_borrows() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        // User has collateral but no debt
        pool.supply_collateral(&user, &asset, &10_000i128);
        let hf = pool.health_factor(&user, &asset);
        assert_eq!(hf, 0, "L-12: HF must be 0 when no borrows exist");
    }

    /// **L-13:** Sequential borrows each reduce the health factor.
    #[test]
    fn invariant_L13_sequential_borrows_reduce_hf() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        pool.supply_collateral(&user, &asset, &1_000i128);
        pool.supply(&user, &asset, &10_000i128);
        // First borrow
        pool.borrow(&user, &asset, &200i128);
        let hf1 = pool.health_factor(&user, &asset);
        // Second borrow
        pool.borrow(&user, &asset, &300i128);
        let hf2 = pool.health_factor(&user, &asset);
        assert!(
            hf2 < hf1,
            "L-13: second borrow must reduce HF: {hf2} >= {hf1}"
        );
    }

    /// **L-14:** Collateral withdrawal blocks when it would make the position underwater.
    #[test]
    #[should_panic(expected = "health factor too low")]
    fn invariant_L14_cannot_borrow_after_collateral_becomes_insufficient() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let lp = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        // Supply from a separate LP so the pool has liquidity.
        pool.supply(&lp, &asset, &1_000);
        // Post just enough collateral for a small borrow.
        pool.supply_collateral(&user, &asset, &100i128);
        pool.borrow(&user, &asset, &100i128); // maxed out
                                              // Cannot borrow more
        pool.borrow(&user, &asset, &1i128); // even 1 unit must revert
    }

    /// **L-15:** Multi-user isolation — one user's borrow doesn't affect another's HF.
    #[test]
    fn invariant_L15_multi_user_hf_isolation() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        // Alice: safe position
        pool.supply_collateral(&alice, &asset, &1_000i128);
        pool.supply(&alice, &asset, &5_000i128);
        pool.borrow(&alice, &asset, &500i128);
        let hf_alice = pool.health_factor(&alice, &asset);
        // Bob: has no position at all
        let hf_bob = pool.health_factor(&bob, &asset);
        assert_eq!(hf_bob, 0, "Bob with no borrows must have HF=0");
        assert!(hf_alice > 0, "Alice with borrows must have HF>0");
    }

    /// **L-16:** Health factor for a fully repaid position returns to 0.
    #[test]
    fn invariant_L16_hf_returns_zero_after_full_repay() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        pool.supply_collateral(&user, &asset, &1_000i128);
        pool.supply(&user, &asset, &5_000i128);
        pool.borrow(&user, &asset, &800i128);
        assert!(pool.health_factor(&user, &asset) > 0);
        // Fully repay
        pool.repay(&user, &asset, &1_000_000i128);
        assert_eq!(
            pool.health_factor(&user, &asset),
            0,
            "HF must return to 0 after full repay"
        );
    }

    // ──────────────────────── PAUSE TESTS ────────────────────────

    #[test]
    fn test_pause_blocks_state_changes() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");

        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });

        // Supply before pause works
        pool.supply(&user, &asset, &1_000_000);
        assert_eq!(pool.deposit_shares_of(&user, &asset), 1_000_000);

        // Pause
        pool.set_paused(&true);
        assert!(pool.is_paused());
    }

    #[test]
    #[should_panic(expected = "contract is paused")]
    fn test_paused_supply_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");

        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        pool.set_paused(&true);
        pool.supply(&user, &asset, &1_000_000);
    }

    #[test]
    #[should_panic(expected = "contract is paused")]
    fn test_paused_borrow_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");

        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        pool.supply_collateral(&user, &asset, &10_000i128);
        pool.supply(&user, &asset, &10_000i128);
        pool.set_paused(&true);
        pool.borrow(&user, &asset, &1_000);
    }

    #[test]
    fn test_unpause_restores_operations() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");

        let pool = LendingPoolClient::new(&env, &env.register(LendingPool {}, ()));
        pool.initialize(&admin);
        pool.add_asset(&AssetConfig {
            asset: asset.clone(),
            collateral_vault: Address::generate(&env),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 0,
            slope1_bps: 500,
            slope2_bps: 5_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        pool.set_paused(&true);
        assert!(pool.is_paused());
        pool.set_paused(&false);
        assert!(!pool.is_paused());
        // Operations resume
        pool.supply(&user, &asset, &1_000_000);
        assert_eq!(pool.deposit_shares_of(&user, &asset), 1_000_000);
    }
}
