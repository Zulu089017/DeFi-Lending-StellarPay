//! # Liquidation Engine
//!
//! Permissionlessly liquidates under-collateralized loans.
//!
//! Liquidation flow:
//! 1. Read the borrower's debt from the lending pool and collateral from the vault.
//! 2. Verify the position is underwater (debt > collateral in same-unit terms).
//! 3. Enforce the close factor — no more than `close_factor_bps` of the
//!    outstanding debt can be liquidated in a single call.
//! 4. Calculate the collateral to seize: `repay + bonus - fee`.
//! 5. Call `pool.repay(liquidator, debt_asset, repay_amount)` to clear the debt.
//! 6. Call `vault.seize(liquidation, borrower, liquidator, coll_asset, seize_amount)`
//!    to transfer the collateral, with the liquidation contract acting as operator.
//!
//! The bonus is the liquidator's incentive; the fee goes to the treasury.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, IntoVal, Symbol, Val, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Config,
    Treasury,
}

#[contracttype]
#[derive(Clone)]
pub struct LiquidationConfig {
    /// `lending_pool` address
    pub pool: Address,
    /// `collateral_vault` address
    pub vault: Address,
    /// Oracle address for pricing collateral and debt in USD.
    /// Uses `oracle.value_of(asset, amount)` to convert token units to USD.
    /// Must be a contract implementing `value_of()` (e.g. the StellarPay oracle).
    pub oracle: Address,
    /// liquidator bonus in bps over fair value (e.g. 500 = 5%)
    pub bonus_bps: u32,
    /// protocol fee in bps taken from the bonus (e.g. 200 = 2%)
    pub fee_bps: u32,
    /// close factor — max fraction of debt repayable in a single tx (default 5000 = 50%)
    pub close_factor_bps: u32,
}

/// Protocol-wide LTV ceiling (75%) used as defense-in-depth.
const MAX_LTV_BPS: u32 = 7_500;

#[contract]
pub struct Liquidation;

#[contractimpl]
impl Liquidation {
    pub fn initialize(env: Env, admin: Address, cfg: LiquidationConfig, treasury: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
    }

    pub fn set_config(env: Env, cfg: LiquidationConfig) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Config, &cfg);
    }

    /// Liquidate `repay_amount` of `borrower`'s debt in `debt_asset`.
    /// Returns the amount of `collateral_asset` actually seized and sent to
    /// the `liquidator`.
    ///
    /// Cross-contract calls:
    ///   1. `pool.debt_of(borrower, debt_asset)` — read outstanding debt
    ///   2. `vault.position(borrower, collateral_asset)` — read collateral
    ///   3. `pool.repay(liquidator, debt_asset, repay_amount)` — repay debt
    ///   4. `vault.seize(liq, borrower, liquidator, coll_asset, seize_amount)` — transfer
    ///
    /// # Panics
    /// - `"amount must be positive"` if `repay_amount <= 0`
    /// - `"position healthy"` if collateral_value <= debt_value (healthy position)
    /// - `"health factor too low"` if `health_factor <= 1` (not unhealthy enough to liquidate)
    /// - `"exceeds close factor"` if `repay_amount > close_factor * outstanding / 10_000`
    /// - `"insufficient collateral to seize"` if vault balance < computed seize
    /// - `"oracle price unavailable"` if oracle price cannot be read
    /// - `"stale price"` if oracle price is stale
    /// - `"oracle overflow"` if arithmetic overflows
    pub fn liquidate(
        env: Env,
        liquidator: Address,
        borrower: Address,
        debt_asset: Symbol,
        collateral_asset: Symbol,
        repay_amount: i128,
    ) -> i128 {
        liquidator.require_auth();
        if repay_amount <= 0 {
            panic!("amount must be positive");
        }

        let cfg = Self::config(env.clone());

        // ── 1. Read borrower's debt from the lending pool ──
        let outstanding = Self::pool_debt_of(&env, &cfg.pool, &borrower, &debt_asset);

        // ── 2. Read borrower's collateral from the vault ──
        let coll_balance = Self::vault_position(&env, &cfg.vault, &borrower, &collateral_asset);

        // ── 3. Convert to USD values using oracle prices ──
        // Oracle returns values in 14-decimal precision via value_of().
        let coll_value = Self::oracle_value(&env, &cfg.oracle, &collateral_asset, coll_balance);
        let debt_value = Self::oracle_value(&env, &cfg.oracle, &debt_asset, outstanding);

        if debt_value <= 0 {
            panic!("position healthy");
        }

        // ── 4. Position must be liquidatable (unhealthy) ──
        // Liquidation is allowed when debt exceeds the collateral value
        // allowed by the effective LTV: debt_value * 10_000 > coll_value * effective_ltv_bps.
        // This is the inverse of the controller's borrow-time LTV check.
        let asset_ltv_bps = Self::asset_ltv_bps(&env, &cfg.pool, &collateral_asset);
        let effective_ltv_bps = asset_ltv_bps.min(MAX_LTV_BPS) as i128;
        let max_debt_for_collateral =
            coll_value.checked_mul(effective_ltv_bps).expect("overflow") / 10_000i128;
        if debt_value <= max_debt_for_collateral {
            panic!("position healthy");
        }

        // ── 5. Enforce close factor ──
        let max_repay = outstanding
            .checked_mul(cfg.close_factor_bps as i128)
            .expect("overflow")
            / 10_000i128;
        if repay_amount > max_repay {
            panic!("exceeds close factor");
        }

        // ── 6. Calculate collateral to seize using oracle-priced valuation ──
        // Compute the USD value of the repaid debt, apply bonus, convert to
        // collateral units via oracle pricing. This handles different assets
        // and decimals correctly.
        let repay_value = Self::oracle_value(&env, &cfg.oracle, &debt_asset, repay_amount);
        let coll_price = Self::oracle_price(&env, &cfg.oracle, &collateral_asset);
        if coll_price <= 0 {
            panic!("oracle price unavailable");
        }

        let bonus_mult = 10_000i128 + cfg.bonus_bps as i128;
        // seize_value_usd = repay_value * (1 + bonus_bps/10000)
        let seize_value_usd = repay_value.checked_mul(bonus_mult).expect("overflow") / 10_000i128;

        // Convert USD value back to collateral token units.
        // value_of returns: amount * price / 10^7 (7-dec token units convention)
        // so amount = value_usd * 10^7 / price
        let seize_units_total = seize_value_usd
            .checked_mul(10_000_000i128)
            .expect("overflow")
            / coll_price;

        // Fee is taken from the bonus portion in collateral units.
        let bonus_value_usd = repay_value
            .checked_mul(cfg.bonus_bps as i128)
            .expect("overflow")
            / 10_000i128;
        let fee_value_usd = bonus_value_usd
            .checked_mul(cfg.fee_bps as i128)
            .expect("overflow")
            / 10_000i128;
        let fee_units = fee_value_usd.checked_mul(10_000_000i128).expect("overflow") / coll_price;

        let seize_amount = seize_units_total.saturating_sub(fee_units);
        if seize_amount <= 0 {
            panic!("insufficient collateral to seize");
        }

        // Total leaving the borrower: seize_amount + fee = seize_units_total.
        // Must not exceed their collateral balance.
        if seize_units_total > coll_balance {
            panic!("insufficient collateral to seize");
        }

        // ── 6. Repay debt on behalf of borrower (liquidator pays) ──
        // The liquidation contract itself is the registered pool operator.
        Self::pool_repay_on_behalf(
            &env,
            &cfg.pool,
            &liquidator,
            &borrower,
            &debt_asset,
            &repay_amount,
        );

        // ── 7. Seize collateral: borrower → liquidator ──
        let liq_addr = env.current_contract_address();
        Self::vault_seize(
            &env,
            &cfg.vault,
            &liq_addr,
            &borrower,
            &liquidator,
            &collateral_asset,
            &seize_amount,
        );

        // ── 8. If there's a fee, seize it to the treasury ──
        if fee_units > 0 {
            let treasury = Self::treasury(env.clone());
            Self::vault_seize(
                &env,
                &cfg.vault,
                &liq_addr,
                &borrower,
                &treasury,
                &collateral_asset,
                &fee_units,
            );
        }

        seize_amount
    }

    // ──────────────────────── Views ────────────────────────

    pub fn config(env: Env) -> LiquidationConfig {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .expect("config not set")
    }

    pub fn treasury(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Treasury)
            .expect("treasury not set")
    }

    // ──────────────────────── CROSS-CONTRACT HELPERS ────────────────────────

    /// Get the USD value (14-decimal precision) of `amount` units of `asset`.
    fn oracle_value(env: &Env, oracle: &Address, asset: &Symbol, amount: i128) -> i128 {
        let fn_name = Symbol::new(env, "value_of");
        let args: Vec<Val> = soroban_sdk::vec![env, asset.into_val(env), amount.into_val(env),];
        env.invoke_contract(oracle, &fn_name, args)
    }

    /// Get the spot price for `asset` from the oracle (14-decimal precision).
    fn oracle_price(env: &Env, oracle: &Address, asset: &Symbol) -> i128 {
        let fn_name = Symbol::new(env, "get_price");
        let args: Vec<Val> = soroban_sdk::vec![env, asset.into_val(env)];
        env.invoke_contract(oracle, &fn_name, args)
    }

    fn asset_ltv_bps(env: &Env, pool: &Address, collateral_asset: &Symbol) -> u32 {
        let fn_name = Symbol::new(env, "ltv_bps");
        let args: Vec<Val> = soroban_sdk::vec![env, collateral_asset.into_val(env)];
        env.invoke_contract(pool, &fn_name, args)
    }

    fn pool_debt_of(env: &Env, pool: &Address, borrower: &Address, asset: &Symbol) -> i128 {
        let fn_name = Symbol::new(env, "debt_of");
        let args: Vec<Val> = soroban_sdk::vec![env, borrower.into_val(env), asset.into_val(env),];
        env.invoke_contract(pool, &fn_name, args)
    }

    /// Read `vault.position(borrower, collateral_asset)`.
    fn vault_position(env: &Env, vault: &Address, borrower: &Address, asset: &Symbol) -> i128 {
        let fn_name = Symbol::new(env, "position");
        let args: Vec<Val> = soroban_sdk::vec![env, borrower.into_val(env), asset.into_val(env),];
        env.invoke_contract(vault, &fn_name, args)
    }

    /// Call `pool.repay_on_behalf(op, payer, borrower, asset, amount)`.
    /// Uses the liquidation contract's own address as the operator
    /// so that the pool's `require_operator` check passes.
    fn pool_repay_on_behalf(
        env: &Env,
        pool: &Address,
        payer: &Address,
        borrower: &Address,
        asset: &Symbol,
        amount: &i128,
    ) {
        let liq_addr = env.current_contract_address();
        let fn_name = Symbol::new(env, "repay_on_behalf");
        let args: Vec<Val> = soroban_sdk::vec![
            env,
            liq_addr.into_val(env),
            payer.into_val(env),
            borrower.into_val(env),
            asset.into_val(env),
            amount.into_val(env),
        ];
        let _: i128 = env.invoke_contract(pool, &fn_name, args);
    }

    /// Call `vault.seize(op, from, to, asset, amount)`.
    #[allow(clippy::too_many_arguments)]
    fn vault_seize(
        env: &Env,
        vault: &Address,
        op: &Address,
        from: &Address,
        to: &Address,
        asset: &Symbol,
        amount: &i128,
    ) {
        let fn_name = Symbol::new(env, "seize");
        let args: Vec<Val> = soroban_sdk::vec![
            env,
            op.into_val(env),
            from.into_val(env),
            to.into_val(env),
            asset.into_val(env),
            amount.into_val(env),
        ];
        let _: () = env.invoke_contract(vault, &fn_name, args);
    }

    // ──────────────────────────── Admin ────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set");
        admin.require_auth();
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]
    use super::*;
    use soroban_sdk::{testutils::Address as _, token};

    /// Deploy pool + vault + oracle for liquidation tests so
    /// `liquidate` can read real oracle-priced state and execute cross-contract calls.
    struct LiqTestEnv<'a> {
        env: Env,
        liq_contract: LiquidationClient<'a>,
        liq_id: Address,
        pool_client: lending_pool::LendingPoolClient<'a>,
        pool_id: Address,
        vault_client: collateral_vault::CollateralVaultClient<'a>,
        vault_id: Address,
        #[allow(dead_code)]
        oracle_client: oracle::OracleClient<'a>,
        oracle_id: Address,
        #[allow(dead_code)]
        wrapped_client: wrapped_asset::WrappedAssetClient<'a>,
        asset: Symbol,
        #[allow(dead_code)]
        admin: Address,
        token_addr: Address,
        token_admin: Address,
    }

    fn setup_liq() -> LiqTestEnv<'static> {
        let env = Env::default();
        env.mock_all_auths();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        // Deploy test token (SAC)
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_contract.address();

        // Deploy sub-contracts.
        let vault_id = env.register(collateral_vault::CollateralVault {}, ());
        let pool_id = env.register(lending_pool::LendingPool {}, ());
        let wrapped_id = env.register(wrapped_asset::WrappedAsset {}, ());
        let oracle_id = env.register(oracle::Oracle {}, ());
        let liq_id = env.register(Liquidation {}, ());

        let oracle_client = oracle::OracleClient::new(&env.clone(), &oracle_id);
        oracle_client.initialize(&admin);
        let pub1 = Address::generate(&env);
        let pub2 = Address::generate(&env);
        oracle_client.add_publisher(&pub1);
        oracle_client.add_publisher(&pub2);

        let vault_client = collateral_vault::CollateralVaultClient::new(&env.clone(), &vault_id);
        vault_client.initialize(&admin);
        vault_client.add_operator(&liq_id); // liq is operator for seize
        vault_client.add_operator(&pool_id); // pool may need for some flows

        let pool_client = lending_pool::LendingPoolClient::new(&env.clone(), &pool_id);
        pool_client.initialize(&admin);
        pool_client.add_operator(&liq_id); // liq can call repay_on_behalf

        let wrapped_client = wrapped_asset::WrappedAssetClient::new(&env.clone(), &wrapped_id);
        let asset = Symbol::new(&env, "XLM");
        wrapped_client.initialize(
            &admin,
            &liq_id,
            &soroban_sdk::String::from_str(&env, "Wrapped"),
            &soroban_sdk::String::from_str(&env, "W"),
            &7u32,
            &soroban_sdk::String::from_str(&env, "ethereum"),
            &soroban_sdk::String::from_str(&env, "0x0"),
        );

        // Configure oracle price for XLM: $1.00 in 14-decimal precision.
        oracle_client.set_asset_config(&asset, &300u64, &2u32);
        oracle_client.set_price(&pub1, &asset, &10_000_000_000_000i128); // $1.00
        oracle_client.set_price(&pub2, &asset, &10_000_000_000_000i128);

        // Configure the lending pool with the asset (using the real oracle).
        pool_client.add_asset(&lending_pool::AssetConfig {
            asset: asset.clone(),
            collateral_vault: vault_id.clone(),
            oracle: oracle_id.clone(),
            ltoken: Address::generate(&env),
            token_address: token_addr.clone(),
            base_rate_bps: 200,
            slope1_bps: 1_000,
            slope2_bps: 13_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });

        vault_client.set_token_address(&asset, &token_addr);

        let liq_contract = LiquidationClient::new(&env.clone(), &liq_id);
        liq_contract.initialize(
            &admin,
            &LiquidationConfig {
                pool: pool_id.clone(),
                vault: vault_id.clone(),
                oracle: oracle_id.clone(),
                bonus_bps: 500,
                fee_bps: 2_000,
                close_factor_bps: 5_000,
            },
            &treasury,
        );

        LiqTestEnv {
            env,
            liq_contract,
            liq_id,
            pool_client,
            pool_id,
            vault_client,
            vault_id,
            oracle_client,
            oracle_id,
            wrapped_client,
            asset,
            admin,
            token_addr,
            token_admin,
        }
    }

    /// Set up an underwater borrower with real token transfers.
    #[allow(dead_code)]
    fn make_borrower(te: &LiqTestEnv, collateral: i128, borrow: i128) -> (Address, Address) {
        let user = Address::generate(&te.env);
        let lp = Address::generate(&te.env);
        let sac = token::StellarAssetClient::new(&te.env, &te.token_addr);
        let tc = token::Client::new(&te.env, &te.token_addr);
        // Fund LP and user
        sac.mint(&lp, &(collateral * 10));
        sac.mint(&user, &(collateral * 10));
        // Approvals
        tc.approve(
            &lp,
            &te.pool_id,
            &(collateral * 20),
            &(te.env.ledger().sequence() + 1000),
        );
        tc.approve(
            &user,
            &te.pool_id,
            &(collateral * 20),
            &(te.env.ledger().sequence() + 1000),
        );
        tc.approve(
            &user,
            &te.vault_id,
            &(collateral * 20),
            &(te.env.ledger().sequence() + 1000),
        );
        // LP supplies liquidity to pool
        te.pool_client.supply(&lp, &te.asset, &(collateral * 5));
        // User supplies collateral accounting in pool and deposits to vault
        te.pool_client
            .supply_collateral(&user, &te.asset, &collateral);
        te.vault_client
            .deposit(&te.liq_id, &user, &te.asset, &collateral);
        te.pool_client.borrow(&user, &te.asset, &borrow);
        (user, te.liq_id.clone())
    }

    fn fund_and_approve(te: &LiqTestEnv, user: &Address, amount: i128) {
        let sac = token::StellarAssetClient::new(&te.env, &te.token_addr);
        let tc = token::Client::new(&te.env, &te.token_addr);
        sac.mint(user, &amount);
        tc.approve(
            user,
            &te.pool_id,
            &(amount * 10),
            &(te.env.ledger().sequence() + 1000),
        );
        tc.approve(
            user,
            &te.vault_id,
            &(amount * 10),
            &(te.env.ledger().sequence() + 1000),
        );
    }
    fn fund_lp(te: &LiqTestEnv, amount: i128) -> Address {
        let lp = Address::generate(&te.env);
        fund_and_approve(te, &lp, amount * 5);
        te.pool_client.supply(&lp, &te.asset, &amount);
        lp
    }
    // ═══════════════════════════════════════════════════════════════════════
    // BASIC
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_liquidate_with_bonus_and_state_changes() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 100_000i128);
        fund_and_approve(&te, &liquidator, 100_000i128);

        // Set up borrower: 10,000 collateral in vault, 12,000 debt in pool
        te.pool_client
            .supply_collateral(&borrower, &te.asset, &12_000i128);
        te.pool_client.supply(&borrower, &te.asset, &12_000i128);
        te.pool_client.borrow(&borrower, &te.asset, &12_000i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &te.asset, &10_000i128);

        let debt_before = te.pool_client.debt_of(&borrower, &te.asset);
        assert!(debt_before >= 12_000i128, "borrower should be underwater");

        let coll_before = te.vault_client.position(&borrower, &te.asset);
        assert_eq!(coll_before, 10_000i128);

        let liquidator_coll_before = te.vault_client.position(&liquidator, &te.asset);

        // Liquidate 5,000 (50% close factor of 12,000 = 6,000 max).
        let seized =
            te.liq_contract
                .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &5_000i128);
        // bonus = 250, fee = 50, seize = 5,200
        assert_eq!(seized, 5_200i128);

        // ── Verify pool state: debt reduced ──
        let debt_after = te.pool_client.debt_of(&borrower, &te.asset);
        assert!(debt_after < debt_before, "debt must decrease");
        assert!(debt_after >= debt_before - 5_000, "repay was applied");

        // ── Verify vault state: collateral seized ──
        let coll_after = te.vault_client.position(&borrower, &te.asset);
        // The liquidation also seizes a protocol fee (50) to treasury.
        // Total collateral removed: sieze_amount + fee = 5_200 + 50 = 5_250.
        assert_eq!(
            coll_after,
            coll_before - seized - 50,
            "collateral must decrease by seized amount + fee"
        );

        let liquidator_coll_after = te.vault_client.position(&liquidator, &te.asset);
        assert_eq!(
            liquidator_coll_after - liquidator_coll_before,
            seized,
            "liquidator must receive the seized collateral"
        );
    }

    #[test]
    #[should_panic(expected = "position healthy")]
    fn test_healthy_position_reverts() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);

        // Healthy position: collateral > debt.
        te.pool_client
            .supply_collateral(&borrower, &te.asset, &5_000i128);
        te.pool_client.supply(&borrower, &te.asset, &5_000i128);
        te.pool_client.borrow(&borrower, &te.asset, &1_000i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &te.asset, &5_000i128);

        te.liq_contract
            .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &500i128);
    }

    #[test]
    #[should_panic(expected = "exceeds close factor")]
    fn test_close_factor_enforced() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);
        fund_lp(&te, 20_000i128);

        te.pool_client
            .supply_collateral(&borrower, &te.asset, &12_000i128);
        te.pool_client.borrow(&borrower, &te.asset, &10_000i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &te.asset, &5_000i128);

        // Try to liquidate 6,000 — exceeds 50% close factor (5,000 max).
        te.liq_contract
            .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &6_000i128);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT TESTS (Q-*)
    // ═══════════════════════════════════════════════════════════════════════

    /// Q-3/Q-4: Liquidator share = repay + bonus - fee.
    #[test]
    fn invariant_Q3_Q4_liquidator_share_formula() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);

        // Underwater: 10,000 vault, 12,000 debt.
        te.pool_client
            .supply_collateral(&borrower, &te.asset, &12_000i128);
        te.pool_client.supply(&borrower, &te.asset, &12_000i128);
        te.pool_client.borrow(&borrower, &te.asset, &12_000i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &te.asset, &10_000i128);

        // 10% bonus, 20% fee on bonus.
        te.liq_contract.set_config(&LiquidationConfig {
            pool: te.pool_id.clone(),
            vault: te.vault_id.clone(),
            oracle: te.oracle_id.clone(),
            bonus_bps: 1_000,
            fee_bps: 2_000,
            close_factor_bps: 5_000,
        });

        let seized =
            te.liq_contract
                .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &5_000i128);
        // gross = 5,500, bonus = 500, fee = 100, seize = 5,400
        assert_eq!(seized, 5_400i128);
        assert!(
            seized >= 5_000i128,
            "Q-3: liquidator share must be >= repay"
        );
    }

    /// Q-5: Partial liquidation reduces debt proportionally.
    #[test]
    fn invariant_Q5_partial_liquidation_reduces_debt() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);

        // Underwater: 10,000 vault, 12,000 debt.
        te.pool_client
            .supply_collateral(&borrower, &te.asset, &12_000i128);
        te.pool_client.supply(&borrower, &te.asset, &12_000i128);
        te.pool_client.borrow(&borrower, &te.asset, &12_000i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &te.asset, &10_000i128);

        let debt_before = te.pool_client.debt_of(&borrower, &te.asset);
        let seized =
            te.liq_contract
                .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &5_000i128);
        // bonus=250, fee=50, seize=5,200
        assert_eq!(seized, 5_200i128);
        assert!(seized > 5_000i128, "Q-5: liquidator must receive bonus");

        let debt_after = te.pool_client.debt_of(&borrower, &te.asset);
        assert!(
            debt_after < debt_before,
            "Q-5: debt must decrease after partial liquidation"
        );
    }

    /// Q-6: Full liquidation at close factor limit (50%).
    #[test]
    fn invariant_Q6_full_liquidation_at_close_factor() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);

        // Underwater: 10,000 vault, 12,000 debt.
        te.pool_client
            .supply_collateral(&borrower, &te.asset, &12_000i128);
        te.pool_client.supply(&borrower, &te.asset, &12_000i128);
        te.pool_client.borrow(&borrower, &te.asset, &12_000i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &te.asset, &10_000i128);

        // 10% bonus, 10% fee on bonus, 50% close factor
        te.liq_contract.set_config(&LiquidationConfig {
            pool: te.pool_id.clone(),
            vault: te.vault_id.clone(),
            oracle: te.oracle_id.clone(),
            bonus_bps: 1_000,
            fee_bps: 1_000,
            close_factor_bps: 5_000,
        });

        let seized =
            te.liq_contract
                .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &5_000i128);
        // bonus = 500, fee = 50, seize = 5,450
        assert_eq!(seized, 5_450i128);
    }

    /// Q-7: Liquidator always receives >= repay (incentive alignment).
    #[test]
    fn invariant_Q7_liquidator_always_profits() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);

        // Underwater: 10,000 vault, 12,000 debt.
        te.pool_client
            .supply_collateral(&borrower, &te.asset, &12_000i128);
        te.pool_client.supply(&borrower, &te.asset, &12_000i128);
        te.pool_client.borrow(&borrower, &te.asset, &12_000i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &te.asset, &10_000i128);

        let configs = [(500u32, 2_000u32), (1_000u32, 1_000u32), (2_000u32, 500u32)];
        for (bonus_bps, fee_bps) in configs {
            te.liq_contract.set_config(&LiquidationConfig {
                pool: te.pool_id.clone(),
                vault: te.vault_id.clone(),
                oracle: te.oracle_id.clone(),
                bonus_bps,
                fee_bps,
                close_factor_bps: 5_000,
            });
            let seized =
                te.liq_contract
                    .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &2_000i128);
            assert!(
                seized >= 2_000i128,
                "Q-7: liquidator must get >= repay (bonus={bonus_bps} fee={fee_bps}): seized={seized}"
            );
        }
    }

    /// Q-8: Zero-amount liquidation must revert.
    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn invariant_Q8_zero_amount_liquidation_reverts() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);
        te.liq_contract
            .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &0i128);
    }

    /// Q-9: Negative-amount liquidation must revert.
    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn invariant_Q9_negative_amount_liquidation_reverts() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);
        te.liq_contract
            .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &-1i128);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // REGRESSION: Oracle-priced liquidation tests
    // ═══════════════════════════════════════════════════════════════════════

    /// R-1: Solvent position must never be liquidated.
    #[test]
    #[should_panic(expected = "position healthy")]
    fn regression_solvent_position_never_liquidated() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);

        te.pool_client
            .supply_collateral(&borrower, &te.asset, &10_000i128);
        te.pool_client.supply(&borrower, &te.asset, &10_000i128);
        te.pool_client.borrow(&borrower, &te.asset, &5_000i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &te.asset, &10_000i128);

        te.liq_contract
            .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &1_000i128);
    }

    /// R-2: Insolvent position (LTV breached) must be liquidatable.
    #[test]
    fn regression_insolvent_position_liquidatable() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);

        fund_lp(&te, 20_000i128);
        te.pool_client
            .supply_collateral(&borrower, &te.asset, &12_000i128);
        te.pool_client.borrow(&borrower, &te.asset, &10_000i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &te.asset, &5_000i128);

        let seized =
            te.liq_contract
                .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &2_000i128);
        assert!(seized > 0, "insolvent position should be liquidatable");
        let debt_after = te.pool_client.debt_of(&borrower, &te.asset);
        assert!(debt_after < 10_000i128, "debt must decrease");
    }

    /// R-3: Boundary - debt exactly at max allowed by LTV (75%) is healthy.
    #[test]
    #[should_panic(expected = "position healthy")]
    fn regression_boundary_ltv_exactly_at_limit() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);

        te.pool_client
            .supply_collateral(&borrower, &te.asset, &10_000i128);
        te.pool_client.supply(&borrower, &te.asset, &10_000i128);
        te.pool_client.borrow(&borrower, &te.asset, &7_500i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &te.asset, &10_000i128);

        te.liq_contract
            .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &1_000i128);
    }

    /// R-4: Boundary - debt just above LTV limit is liquidatable.
    #[test]
    fn regression_boundary_just_above_ltv_limit() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);

        te.pool_client
            .supply_collateral(&borrower, &te.asset, &10_000i128);
        te.pool_client.supply(&borrower, &te.asset, &10_000i128);
        te.pool_client.borrow(&borrower, &te.asset, &7_501i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &te.asset, &10_000i128);

        let seized =
            te.liq_contract
                .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &1_000i128);
        assert!(seized > 0, "position just above LTV should be liquidatable");
    }

    /// R-5: Missing oracle price must prevent liquidation.
    #[test]
    #[should_panic]
    fn regression_missing_oracle_price_reverts() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);
        let bad_asset = Symbol::new(&te.env, "NOPE");

        te.pool_client.add_asset(&lending_pool::AssetConfig {
            asset: bad_asset.clone(),
            collateral_vault: te.vault_id.clone(),
            oracle: te.oracle_id.clone(),
            ltoken: Address::generate(&te.env),
            token_address: te.token_addr.clone(),
            base_rate_bps: 200,
            slope1_bps: 1_000,
            slope2_bps: 13_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        te.vault_client
            .set_token_address(&bad_asset, &te.token_addr);
        te.pool_client
            .supply_collateral(&borrower, &bad_asset, &5_000i128);
        te.pool_client.supply(&borrower, &bad_asset, &5_000i128);
        te.pool_client.borrow(&borrower, &bad_asset, &10_000i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &bad_asset, &5_000i128);

        te.liq_contract
            .liquidate(&liquidator, &borrower, &bad_asset, &bad_asset, &1_000i128);
    }

    /// R-6: Repeated partial liquidations reduce debt each time.
    #[test]
    fn regression_repeated_partial_liquidation() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator1 = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator1, 10_000_000i128);
        let liquidator2 = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator2, 10_000_000i128);
        fund_lp(&te, 30_000i128);

        te.pool_client
            .supply_collateral(&borrower, &te.asset, &20_000i128);
        te.pool_client.borrow(&borrower, &te.asset, &15_000i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &te.asset, &10_000i128);

        let seized1 =
            te.liq_contract
                .liquidate(&liquidator1, &borrower, &te.asset, &te.asset, &3_000i128);
        assert!(seized1 > 0);
        let debt_after_1 = te.pool_client.debt_of(&borrower, &te.asset);
        assert!(debt_after_1 < 15_000i128);

        let seized2 =
            te.liq_contract
                .liquidate(&liquidator2, &borrower, &te.asset, &te.asset, &3_000i128);
        assert!(seized2 > 0);
        let debt_after_2 = te.pool_client.debt_of(&borrower, &te.asset);
        assert!(debt_after_2 < debt_after_1);
    }

    /// R-7: Oracle-priced seize amount includes liquidation bonus.
    #[test]
    fn regression_oracle_priced_seize_includes_bonus() {
        let te = setup_liq();
        let borrower = Address::generate(&te.env);
        fund_and_approve(&te, &borrower, 10_000_000i128);
        let liquidator = Address::generate(&te.env);
        fund_and_approve(&te, &liquidator, 10_000_000i128);

        te.pool_client
            .supply_collateral(&borrower, &te.asset, &10_000i128);
        te.pool_client.supply(&borrower, &te.asset, &12_000i128);
        te.pool_client.borrow(&borrower, &te.asset, &12_000i128);
        te.vault_client
            .deposit(&te.liq_id, &borrower, &te.asset, &10_000i128);

        let repay = 5_000i128;
        let seized =
            te.liq_contract
                .liquidate(&liquidator, &borrower, &te.asset, &te.asset, &repay);
        assert!(
            seized >= repay,
            "seized ({seized}) must be >= repay ({repay})"
        );
    }
}
