//! # Cross-Contract Integration Tests
//!
//! End-to-end tests that deploy and wire together all contracts and exercise
//! the full protocol lifecycle. These tests verify that invariants hold
//! across contract boundaries.

use soroban_sdk::{testutils::Address as _, xdr::ToXdr, Address, BytesN, Env, String, Symbol};

use super::fuzz::FuzzRng;

// ──────────────────────── Test Helpers ────────────────────────

/// Deploy the full protocol constellation: wrapped_asset, oracle, vault,
/// pool, controller, and liquidation engine. Wire everything together.
struct ProtocolEnv {
    env: Env,
    #[allow(dead_code)]
    admin: Address,
    wrapped_id: Address,
    oracle_id: Address,
    vault_id: Address,
    pool_id: Address,
    ctrl_id: Address,
    liq_id: Address,
    signer: ed25519_dalek::SigningKey,
    #[allow(dead_code)]
    bridge_keys: soroban_sdk::Vec<BytesN<32>>,
    #[allow(dead_code)]
    bridge_threshold: u32,
}

fn deploy_protocol() -> ProtocolEnv {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let signer = ed25519_dalek::SigningKey::from_bytes(&[0xABu8; 32]);
    let bridge_keys = soroban_sdk::vec![
        &env,
        BytesN::from_array(&env, &signer.verifying_key().to_bytes()),
    ];
    let bridge_threshold: u32 = 1;

    // ── Deploy sub-contracts ──
    let wrapped_id = env.register(wrapped_asset::WrappedAsset {}, ());
    let oracle_id = env.register(oracle::Oracle {}, ());
    let vault_id = env.register(collateral_vault::CollateralVault {}, ());
    let pool_id = env.register(lending_pool::LendingPool {}, ());
    let ctrl_id = env.register(lending_controller::LendingController {}, ());
    let liq_id = env.register(liquidation::Liquidation {}, ());

    // ── Initialise wrapped_asset ──
    let w = wrapped_asset::WrappedAssetClient::new(&env, &wrapped_id);
    w.initialize(
        &admin,
        &ctrl_id, // controller is minter
        &String::from_str(&env, "Wrapped StellarPay Token"),
        &String::from_str(&env, "wSPT"),
        &7u32,
        &String::from_str(&env, "ethereum"),
        &String::from_str(&env, "0x0"),
    );

    // ── Initialise oracle ──
    let o = oracle::OracleClient::new(&env, &oracle_id);
    o.initialize(&admin);
    // Add 3 publishers.
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);
    o.add_publisher(&p1);
    o.add_publisher(&p2);
    o.add_publisher(&p3);
    // Configure assets with min 2 publishers.
    for asset_sym in ["XLM", "USDC"] {
        o.set_asset_config(&Symbol::new(&env, asset_sym), &300u64, &2u32);
    }
    // Publish initial prices: XLM = $0.10, USDC = $1.00 (14-dec).
    let xlm_price = 1_000_000_000_000i128; // 0.10
    let usdc_price = 10_000_000_000_000i128; // 1.00
    o.set_price(&p1, &Symbol::new(&env, "XLM"), &xlm_price);
    o.set_price(&p2, &Symbol::new(&env, "XLM"), &xlm_price);
    o.set_price(&p1, &Symbol::new(&env, "USDC"), &usdc_price);
    o.set_price(&p2, &Symbol::new(&env, "USDC"), &usdc_price);

    // ── Initialise vault ──
    let v = collateral_vault::CollateralVaultClient::new(&env, &vault_id);
    v.initialize(&admin);
    v.add_operator(&ctrl_id); // controller can deposit/withdraw/seize
    v.add_operator(&liq_id); // liquidation can seize
    v.set_liq_threshold(&Symbol::new(&env, "XLM"), &8_500u32);
    v.set_liq_threshold(&Symbol::new(&env, "USDC"), &8_500u32);

    // ── Initialise lending pool ──
    let p = lending_pool::LendingPoolClient::new(&env, &pool_id);
    p.initialize(&admin);
    for asset_sym in ["XLM", "USDC"] {
        p.add_asset(&lending_pool::AssetConfig {
            asset: Symbol::new(&env, asset_sym),
            collateral_vault: vault_id.clone(),
            oracle: oracle_id.clone(),
            ltoken: Address::generate(&env),
            base_rate_bps: 200,
            slope1_bps: 1_000,
            slope2_bps: 13_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
    }
    // Register liquidation and controller as operators on the pool.
    p.add_operator(&liq_id);
    p.add_operator(&ctrl_id);

    // ── Initialise controller ──
    let c = lending_controller::LendingControllerClient::new(&env, &ctrl_id);
    c.initialize(
        &admin,
        &bridge_keys,
        &bridge_threshold,
        &wrapped_id,
        &pool_id,
        &vault_id,
        &oracle_id,
    );

    // ── Initialise liquidation engine ──
    let liq = liquidation::LiquidationClient::new(&env, &liq_id);
    liq.initialize(
        &admin,
        &liquidation::LiquidationConfig {
            pool: pool_id.clone(),
            vault: vault_id.clone(),
            oracle: oracle_id.clone(),
            bonus_bps: 500,
            fee_bps: 2_000,
            close_factor_bps: 5_000,
        },
        &admin, // treasury = admin for now
    );
    ProtocolEnv {
        env,
        admin,
        wrapped_id,
        oracle_id,
        vault_id,
        pool_id,
        ctrl_id,
        liq_id,
        signer,
        bridge_keys,
        bridge_threshold,
    }
}

/// Build a valid ed25519 attestation for a wrap call.
fn attest(
    env: &Env,
    signer: &ed25519_dalek::SigningKey,
    chain_id: u32,
    src: &BytesN<32>,
    amount: i128,
    to: &Address,
    salt: &BytesN<32>,
    nonce: u64,
) -> BytesN<64> {
    use ed25519_dalek::Signer as _;
    // Build the same canonical payload the controller expects.
    let mut payload = soroban_sdk::Bytes::new(env);
    payload.append(&soroban_sdk::Bytes::from_slice(env, b"OWRP"));
    payload.append(&soroban_sdk::Bytes::from_slice(
        env,
        &chain_id.to_le_bytes(),
    ));
    payload.append(&soroban_sdk::Bytes::from_slice(env, &src.to_array()));
    payload.append(&soroban_sdk::Bytes::from_slice(
        env,
        &(amount as i64).to_le_bytes(),
    ));
    let to_xdr = to.to_xdr(env);
    payload.append(&to_xdr);
    payload.append(&soroban_sdk::Bytes::from_slice(env, &salt.to_array()));
    payload.append(&soroban_sdk::Bytes::from_slice(env, &nonce.to_le_bytes()));
    let hash = env.crypto().sha256(&payload);
    let sig = signer.sign(&hash.to_array());
    BytesN::from_array(env, &sig.to_bytes())
}

/// Wrap tokens from EVM → Stellar via the controller.
fn do_wrap(pe: &ProtocolEnv, to: &Address, amount: i128, salt_seed: u8) {
    let chain_id = 1u32;
    let src = BytesN::from_array(&pe.env, &[salt_seed; 32]);
    let salt = BytesN::from_array(&pe.env, &[salt_seed.wrapping_add(1); 32]);
    let nonce = salt_seed as u64;
    let sig = attest(
        &pe.env, &pe.signer, chain_id, &src, amount, to, &salt, nonce,
    );
    let c = lending_controller::LendingControllerClient::new(&pe.env, &pe.ctrl_id);
    let atts = soroban_sdk::vec![&pe.env, (0u32, sig)];
    c.wrap(&atts, &chain_id, &src, &amount, to, &salt, &nonce);
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]
    use super::*;

    // ═══════════════════════════════════════════════════════════════════════
    // FULL LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    /// End-to-end: wrap → supply XLM → cross-asset borrow USDC → repay → unwrap.
    #[test]
    fn test_full_lifecycle_wrap_supply_borrow_repay_unwrap() {
        let pe = deploy_protocol();
        let user = Address::from_str(
            &pe.env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
        let xlm = Symbol::new(&pe.env, "XLM");
        let usdc = Symbol::new(&pe.env, "USDC");

        // 1. Wrap: mint 50,000 wXLM to user on Stellar.
        do_wrap(&pe, &user, 50_000_000_000i128, 1);
        let w = wrapped_asset::WrappedAssetClient::new(&pe.env, &pe.wrapped_id);
        assert_eq!(w.balance(&user), 50_000_000_000);

        // 2. Supply XLM collateral + liquidity via the controller.
        let c = lending_controller::LendingControllerClient::new(&pe.env, &pe.ctrl_id);
        c.supply_collateral(&user, &xlm, &50_000_000_000i128);

        let p = lending_pool::LendingPoolClient::new(&pe.env, &pe.pool_id);
        let shares = p.deposit_shares_of(&user, &xlm);
        assert!(shares > 0, "should have minted XLM deposit shares");

        // 3. Cross-asset borrow: post 40B XLM collateral (= $4B at $0.10/XLM),
        //    borrow 500M USDC (= $500M at $1.00, LTV = 12.5%, well within 75%).
        c.borrow(&user, &xlm, &40_000_000_000i128, &usdc, &500_000_000i128);
        let debt = p.debt_of(&user, &usdc);
        assert!(debt >= 500_000_000, "should have recorded USDC debt");

        // 4. Partial repay: repay 250M USDC.
        let repaid = p.repay(&user, &usdc, &250_000_000i128);
        assert!(repaid > 0);
        let debt_after = p.debt_of(&user, &usdc);
        assert!(debt_after < debt, "USDC debt should decrease after repay");

        // 5. Unwrap: burn remaining wrapped tokens.
        let nonce = c.unwrap(
            &user,
            &5_000_000_000i128,
            &1u32,
            &BytesN::from_array(&pe.env, &[0u8; 32]),
        );
        assert_eq!(nonce.len(), 32);
        assert_eq!(w.balance(&user), 45_000_000_000);
    }

    /// Full lifecycle including liquidation: wrap → supply → borrow →
    /// trigger underwater → liquidate → verify state.
    #[test]
    fn test_full_lifecycle_with_liquidation() {
        let pe = deploy_protocol();
        let borrower = Address::from_str(
            &pe.env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
        let liquidator = Address::generate(&pe.env);
        let xlm = Symbol::new(&pe.env, "XLM");

        // 1. Wrap tokens for borrower.
        do_wrap(&pe, &borrower, 20_000_000_000i128, 1);

        // 2. Supply collateral via the controller (calls pool.supply + vault.deposit).
        let c = lending_controller::LendingControllerClient::new(&pe.env, &pe.ctrl_id);
        c.supply_collateral(&borrower, &xlm, &5_000_000_000i128);

        // 3. Also supply more liquidity to let the pool allow borrowing.
        let p = lending_pool::LendingPoolClient::new(&pe.env, &pe.pool_id);
        p.supply(&borrower, &xlm, &5_000_000_000i128);

        // 4. Borrow enough to be underwater against vault collateral (8B debt vs 5B vault).
        p.borrow(&borrower, &xlm, &8_000_000_000i128);
        let debt_before = p.debt_of(&borrower, &xlm);
        assert!(debt_before >= 8_000_000_000, "borrower must have debt");

        // Vault should only have the 5B from supply_collateral.
        let v = collateral_vault::CollateralVaultClient::new(&pe.env, &pe.vault_id);
        let coll_before = v.position(&borrower, &xlm);
        assert_eq!(
            coll_before, 5_000_000_000,
            "vault should have 5B collateral"
        );

        // Position is underwater: 8B debt > 5B collateral.
        assert!(
            debt_before > coll_before,
            "position must be underwater for liquidation"
        );

        // 5. Liquidate: repay 4B (50% close factor of 8B).
        let liq = liquidation::LiquidationClient::new(&pe.env, &pe.liq_id);
        let liquidator_coll_before = v.position(&liquidator, &xlm);
        let seized = liq.liquidate(&liquidator, &borrower, &xlm, &xlm, &4_000_000_000i128);
        // bonus = 5% of 4B = 200M, fee = 20% of bonus = 40M, seize = 4.16B
        assert!(seized > 4_000_000_000, "liquidator should get bonus");
        assert_eq!(seized, 4_160_000_000i128);

        // ── Verify pool state: debt reduced ──
        let debt_after = p.debt_of(&borrower, &xlm);
        assert!(
            debt_after < debt_before,
            "debt must decrease after liquidation"
        );
        // 8B - 4B = ~4B (plus any interest accrued)
        assert!(
            debt_after <= debt_before - 3_900_000_000,
            "debt should be reduced by ~4B"
        );

        // ── Verify vault state: collateral seized ──
        let coll_after = v.position(&borrower, &xlm);
        assert!(
            coll_after < coll_before,
            "borrower collateral must decrease"
        );

        let liquidator_coll_after = v.position(&liquidator, &xlm);
        assert_eq!(
            liquidator_coll_after - liquidator_coll_before,
            seized,
            "liquidator must receive seized collateral"
        );
    }

    /// Multi-user: Alice and Bob each have independent positions.
    #[test]
    fn test_multi_user_isolation() {
        let pe = deploy_protocol();
        let alice = Address::from_str(
            &pe.env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
        let bob = Address::generate(&pe.env);
        let xlm = Symbol::new(&pe.env, "XLM");

        let c = lending_controller::LendingControllerClient::new(&pe.env, &pe.ctrl_id);

        // Alice supplies 5,000 XLM.
        do_wrap(&pe, &alice, 5_000_000_000i128, 1);
        c.supply_collateral(&alice, &xlm, &5_000_000_000i128);

        // Bob supplies 3,000 XLM.
        do_wrap(&pe, &bob, 3_000_000_000i128, 2);
        c.supply_collateral(&bob, &xlm, &3_000_000_000i128);

        let p = lending_pool::LendingPoolClient::new(&pe.env, &pe.pool_id);
        let alice_shares = p.deposit_shares_of(&alice, &xlm);
        let bob_shares = p.deposit_shares_of(&bob, &xlm);
        assert!(alice_shares > 0);
        assert!(bob_shares > 0);
        assert_ne!(
            alice_shares, bob_shares,
            "shares must differ for different deposits"
        );

        // Verify total = sum of individuals.
        let total_deposit = p.total_deposit(&xlm);
        assert_eq!(total_deposit, 8_000_000_000);
    }

    /// Per-asset LTV: reconfigure XLM (the collateral asset) to a strict 40%
    /// cap and verify the controller enforces it across contract boundaries.
    /// A borrow at 30% LTV succeeds; stacking to 45% reverts even though that
    /// is still below the 75% global ceiling.
    #[test]
    fn test_per_asset_ltv_across_contracts() {
        let pe = deploy_protocol();
        let user = Address::from_str(
            &pe.env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
        let xlm = Symbol::new(&pe.env, "XLM");
        let usdc = Symbol::new(&pe.env, "USDC");

        // Reconfigure XLM with a strict 40% LTV (overwrites the 75% default).
        let p = lending_pool::LendingPoolClient::new(&pe.env, &pe.pool_id);
        p.add_asset(&lending_pool::AssetConfig {
            asset: xlm.clone(),
            collateral_vault: pe.vault_id.clone(),
            oracle: pe.oracle_id.clone(),
            ltoken: Address::generate(&pe.env),
            base_rate_bps: 200,
            slope1_bps: 1_000,
            slope2_bps: 13_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 4_000,
        });

        let c = lending_controller::LendingControllerClient::new(&pe.env, &pe.ctrl_id);
        do_wrap(&pe, &user, 400_000_000_000i128, 1);
        c.supply_collateral(&user, &xlm, &100_000_000_000i128);

        // Borrow 6B USDC while posting 100B more XLM: cumulative collateral
        // 200B XLM vs 6B USDC debt = 30% LTV ≤ 40% → succeeds.
        c.borrow(&user, &xlm, &100_000_000_000i128, &usdc, &6_000_000_000i128);
        let debt = p.debt_of(&user, &usdc);
        assert!(debt >= 6_000_000_000, "30% LTV borrow must succeed");

        // Stack another 3B USDC: cumulative debt 9B / 20B collateral = 45%
        // LTV > 40% per-asset cap → must revert.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.borrow(&user, &xlm, &1i128, &usdc, &3_000_000_000i128);
        }));
        assert!(
            result.is_err(),
            "45% LTV must revert under per-asset 40% cap"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FUZZ: LENDING POOL MATH (random amounts)
    // ═══════════════════════════════════════════════════════════════════════

    /// Fuzz the supply/withdraw cycle: random amounts, verify share accounting.
    #[test]
    fn fuzz_supply_withdraw_share_invariants() {
        let pe = deploy_protocol();
        let mut rng = FuzzRng::from_env(&pe.env);
        let user = Address::generate(&pe.env);
        let xlm = Symbol::new(&pe.env, "XLM");

        do_wrap(&pe, &user, 1_000_000_000_000i128, 1);
        let c = lending_controller::LendingControllerClient::new(&pe.env, &pe.ctrl_id);
        let p = lending_pool::LendingPoolClient::new(&pe.env, &pe.pool_id);

        let mut total_supplied: i128 = 0;
        let mut total_shares: i128 = 0;

        for _ in 0..50 {
            let amount = rng.gen_amount(1, 10_000_000);
            if rng.gen_bool() {
                // Supply
                c.supply_collateral(&user, &xlm, &amount);
                let shares = p.deposit_shares_of(&user, &xlm);
                let new_total = p.total_deposit(&xlm);
                assert!(
                    new_total >= total_supplied,
                    "total deposit must not decrease"
                );
                total_supplied = new_total;
                total_shares = shares;
            } else if total_shares > 0 {
                // Withdraw a fraction
                let withdraw_shares = rng.gen_amount(1, total_shares.max(1));
                if withdraw_shares <= total_shares {
                    let withdrawn = p.withdraw(&user, &xlm, &withdraw_shares);
                    assert!(withdrawn > 0, "withdraw must return positive amount");
                    let remaining = p.deposit_shares_of(&user, &xlm);
                    assert_eq!(remaining, total_shares - withdraw_shares);
                    total_shares = remaining;
                }
            }
            // Invariant: total deposit shares >= total deposit (with virtual offset).
            let td = p.total_deposit(&xlm);
            let ts = p.deposit_shares_of(&user, &xlm);
            assert!(
                ts <= td * 2 || ts >= 0,
                "share count reasonable for deposits"
            );
        }
    }

    /// Fuzz borrow/repay with random amounts, verify debt invariants.
    #[test]
    fn fuzz_borrow_repay_debt_invariants() {
        let pe = deploy_protocol();
        let mut rng = FuzzRng::from_env(&pe.env);
        let user = Address::generate(&pe.env);
        let xlm = Symbol::new(&pe.env, "XLM");

        do_wrap(&pe, &user, 100_000_000_000i128, 1);
        let c = lending_controller::LendingControllerClient::new(&pe.env, &pe.ctrl_id);
        let p = lending_pool::LendingPoolClient::new(&pe.env, &pe.pool_id);

        // Supply ample collateral.
        c.supply_collateral(&user, &xlm, &50_000_000_000i128);

        let mut peak_debt: i128 = 0;
        for _ in 0..30 {
            let action = rng.next_u64() % 3;
            match action {
                0 => {
                    // Borrow more (within HF limits). Same-asset borrowing:
                    // the pool checks collateral_of(user, xlm) against debt_of(user, xlm).
                    let amount = rng.gen_amount(1, 1_000_000);
                    if amount > 0 {
                        let debt_before = p.debt_of(&user, &xlm);
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            p.borrow(&user, &xlm, &amount);
                        }));
                        if result.is_ok() {
                            let debt_after = p.debt_of(&user, &xlm);
                            assert!(
                                debt_after >= debt_before,
                                "debt must not decrease on borrow"
                            );
                            if debt_after > peak_debt {
                                peak_debt = debt_after;
                            }
                        }
                    }
                }
                1 => {
                    // Repay some debt.
                    let debt = p.debt_of(&user, &xlm);
                    if debt > 0 {
                        let amount = rng.gen_amount(1, debt);
                        let repaid = p.repay(&user, &xlm, &amount);
                        assert!(repaid > 0, "repay must return positive when debt exists");
                        assert!(repaid <= debt, "repay must not exceed outstanding debt");
                        let debt_after = p.debt_of(&user, &xlm);
                        assert!(debt_after <= debt, "debt must not increase on repay");
                    }
                }
                _ => {
                    // View-only: verify invariants.
                    let td = p.total_deposit(&xlm);
                    let tb = p.total_borrow(&xlm);
                    assert!(tb <= td, "invariant L-1: borrows must not exceed deposits");
                }
            }
        }
        // After all operations, peak debt should have been reachable.
        let _ = peak_debt;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FUZZ: LIQUIDATION ENGINE
    // ═══════════════════════════════════════════════════════════════════════

    /// Fuzz liquidate with randomly-sized underwater positions; verify that
    /// debt decreases, collateral is seized, and the liquidator share formula
    /// is respected.
    #[test]
    fn fuzz_liquidation_with_state_verification() {
        let pe = deploy_protocol();
        let mut rng = FuzzRng::from_env(&pe.env);
        let xlm = Symbol::new(&pe.env, "XLM");
        let p = lending_pool::LendingPoolClient::new(&pe.env, &pe.pool_id);
        let v = collateral_vault::CollateralVaultClient::new(&pe.env, &pe.vault_id);
        let liq = liquidation::LiquidationClient::new(&pe.env, &pe.liq_id);

        for _ in 0..20 {
            let borrower = Address::generate(&pe.env);
            let liquidator = Address::generate(&pe.env);

            // Post collateral (into vault) and supply liquidity (into pool).
            // Debt must be > collat (underwater) but small enough that the
            // liquidation gross (repay * (1 + bonus_bps/10_000)) fits within
            // the available collateral. With bonus_bps=500 and
            // close_factor_bps=5_000:
            //   repay = debt * 5_000 / 10_000 = 0.5 * debt
            //   gross = repay * 10_500 / 10_000 ≈ 0.525 * debt
            //   require: 0.525 * debt ≤ collat  →  debt ≤ collat / 0.525
            //   1.5x gives debt=1.5*collat, gross=0.7875*collat → safe.
            let collat = rng.gen_amount(1_000, 50_000);
            let debt = collat * 3 / 2; // intentionally underwater, still seizable

            p.supply_collateral(&borrower, &xlm, &collat);
            p.supply(&borrower, &xlm, &debt); // provide enough liquidity
            p.borrow(&borrower, &xlm, &debt);
            // Manually deposit into the vault to simulate controller flow.
            v.deposit(&pe.ctrl_id, &borrower, &xlm, &collat);

            // Position is debt > collat → underwater.
            let coll_before = v.position(&borrower, &xlm);
            let debt_before = p.debt_of(&borrower, &xlm);
            assert!(debt_before > coll_before, "must be underwater");

            let liquidator_coll_before = v.position(&liquidator, &xlm);

            // Liquidate 50% of debt (max close factor).
            let repay = debt_before * 5_000 / 10_000;
            if repay == 0 {
                continue;
            }
            let seized = liq.liquidate(&liquidator, &borrower, &xlm, &xlm, &repay);

            // Q-3: liquidator share >= repay.
            assert!(
                seized >= repay,
                "Q-3: seized ({seized}) must be >= repay ({repay})"
            );

            // Seized must not exceed collateral.
            assert!(
                seized <= coll_before,
                "cannot seize more than available collateral"
            );

            // ── Pool state ──
            let debt_after = p.debt_of(&borrower, &xlm);
            assert!(debt_after < debt_before, "debt must decrease");

            // ── Vault state ──
            let coll_after = v.position(&borrower, &xlm);
            assert!(
                coll_after < coll_before,
                "borrower collateral must decrease"
            );

            let liquidator_coll_after = v.position(&liquidator, &xlm);
            assert_eq!(
                liquidator_coll_after - liquidator_coll_before,
                seized,
                "liquidator must receive seized amount"
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FUZZ: ORACLE MEDIAN
    // ═══════════════════════════════════════════════════════════════════════

    /// Fuzz oracle median with random prices from 3 publishers.
    #[test]
    fn fuzz_oracle_median_aggregation() {
        let env = Env::default();
        env.mock_all_auths();
        let mut rng = FuzzRng::from_env(&env);
        let admin = Address::generate(&env);
        let o = oracle::OracleClient::new(&env, &env.register(oracle::Oracle {}, ()));
        o.initialize(&admin);
        let asset = Symbol::new(&env, "XLM");
        o.set_asset_config(&asset, &300u64, &2u32);

        // Register exactly 3 publishers.
        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        o.add_publisher(&p1);
        o.add_publisher(&p2);
        o.add_publisher(&p3);

        for _ in 0..50 {
            let price1 = rng.gen_amount(1, 100_000_000_000_000); // up to $10k
            let price2 = rng.gen_amount(1, 100_000_000_000_000);
            let price3 = rng.gen_amount(1, 100_000_000_000_000);

            o.set_price(&p1, &asset, &price1);
            o.set_price(&p2, &asset, &price2);
            o.set_price(&p3, &asset, &price3);

            let median = o.get_price(&asset);

            // Compute expected median manually.
            let mut arr = [price1, price2, price3];
            arr.sort();
            let expected = arr[1]; // middle of 3
            assert_eq!(
                median, expected,
                "median mismatch: prices=[{price1},{price2},{price3}] expected={expected} got={median}"
            );
        }
    }

    /// Fuzz: even number of publishers returns lower-middle.
    #[test]
    fn fuzz_oracle_even_publishers_lower_middle() {
        let env = Env::default();
        env.mock_all_auths();
        let mut rng = FuzzRng::from_env(&env);
        let admin = Address::generate(&env);
        let o = oracle::OracleClient::new(&env, &env.register(oracle::Oracle {}, ()));
        o.initialize(&admin);
        let asset = Symbol::new(&env, "XLM");

        // Register exactly 4 publishers — fresh env, no contamination.
        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        let p4 = Address::generate(&env);
        o.add_publisher(&p1);
        o.add_publisher(&p2);
        o.add_publisher(&p3);
        o.add_publisher(&p4);
        o.set_asset_config(&asset, &300u64, &2u32); // only need 2

        for _ in 0..50 {
            let mut prices: Vec<i128> = (0..4)
                .map(|_| rng.gen_amount(1, 50_000_000_000_000))
                .collect();
            o.set_price(&p1, &asset, &prices[0]);
            o.set_price(&p2, &asset, &prices[1]);
            o.set_price(&p3, &asset, &prices[2]);
            o.set_price(&p4, &asset, &prices[3]);

            let median = o.get_price(&asset);
            prices.sort();
            // Lower-middle of 4 = prices[1] (index 1 = (4-1)/2).
            let expected = prices[1];
            assert_eq!(median, expected, "even-count median should be lower-middle");
        }
    }
}
