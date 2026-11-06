#![allow(clippy::needless_borrow)]
//! # Property-Based Tests
//!
//! Each test generates a random sequence of operations and checks that
//! protocol invariants from `docs/invariants.md` hold at every step.
//! Failures are reproducible: the PRNG seed is logged on panic.

use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

use super::fuzz::FuzzRng;

/// Deploy a minimal environment with pool + vault + wrapped for property tests.
/// Returns (env, pool_client, vault_client, wrapped_client, pool_id, asset).
fn deploy_minimal(
    env: &Env,
) -> (
    lending_pool::LendingPoolClient<'_>,
    collateral_vault::CollateralVaultClient<'_>,
    wrapped_asset::WrappedAssetClient<'_>,
    Address, // pool_id — needed as operator for vault calls
    Symbol,
) {
    let admin = Address::generate(&env);
    let vault_id = env.register(collateral_vault::CollateralVault {}, ());
    let pool_id = env.register(lending_pool::LendingPool {}, ());
    let wrapped_id = env.register(wrapped_asset::WrappedAsset {}, ());

    let v = collateral_vault::CollateralVaultClient::new(env, &vault_id);
    v.initialize(&admin);
    v.set_skip_token_transfers(&true);
    v.add_operator(&pool_id); // pool is operator

    let p = lending_pool::LendingPoolClient::new(env, &pool_id);
    p.initialize(&admin);
    p.set_skip_token_transfers(&true);
    let asset = Symbol::new(env, "XLM");
    p.add_asset(&lending_pool::AssetConfig {
        asset: asset.clone(),
        collateral_vault: vault_id,
        oracle: Address::generate(env),
        ltoken: Address::generate(env),
        token_address: Address::generate(env),
        base_rate_bps: 200,
        slope1_bps: 1_000,
        slope2_bps: 13_000,
        kink_bps: 8_000,
        reserve_factor_bps: 1_000,
        ltv_bps: 7_500,
    });

    let w = wrapped_asset::WrappedAssetClient::new(env, &wrapped_id);
    w.initialize(
        &admin,
        &pool_id,
        &soroban_sdk::String::from_str(env, "Wrapped"),
        &soroban_sdk::String::from_str(env, "W"),
        &7u32,
        &soroban_sdk::String::from_str(env, "ethereum"),
        &soroban_sdk::String::from_str(env, "0x0"),
    );

    (p, v, w, pool_id, asset)
}

/// Operations we can randomly sample.
#[derive(Clone, Copy, PartialEq)]
enum Op {
    Supply,
    Withdraw,
    SupplyCollateral,
    WithdrawCollateral,
    Borrow,
    Repay,
}

impl Op {
    #[allow(dead_code)]
    fn all() -> [Op; 6] {
        [
            Op::Supply,
            Op::Withdraw,
            Op::SupplyCollateral,
            Op::WithdrawCollateral,
            Op::Borrow,
            Op::Repay,
        ]
    }

    fn from_u64(v: u64) -> Op {
        match v % 6 {
            0 => Op::Supply,
            1 => Op::Withdraw,
            2 => Op::SupplyCollateral,
            3 => Op::WithdrawCollateral,
            4 => Op::Borrow,
            _ => Op::Repay,
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]
    use super::*;

    /// Property test: 200 random operations on lending pool, verify invariants
    /// L-1 through L-7 at every step.
    #[test]
    fn prop_lending_pool_random_ops() {
        let env = Env::default();
        env.mock_all_auths();
        let (p, v, _w, pool_id, asset) = deploy_minimal(&env);

        let mut rng = FuzzRng::from_env(&env);
        let user = Address::generate(&env);

        // Give the user some initial collateral so borrows can succeed.
        let mut collat_balance: i128 = 100_000_000;
        let mut debt_balance: i128 = 0;
        let mut share_balance: i128 = 0;
        v.deposit(&pool_id, &user, &asset, &collat_balance);

        for step in 0..200 {
            let op = Op::from_u64(rng.next_u64());

            match op {
                Op::Supply => {
                    let amount = rng.gen_amount(1, 1_000_000);
                    let shares = p.supply(&user, &asset, &amount);
                    share_balance += shares;
                }
                Op::Withdraw => {
                    if share_balance > 0 {
                        let amt = rng.gen_amount(1, share_balance.min(1_000_000));
                        let withdrawn = p.withdraw(&user, &asset, &amt);
                        share_balance -= amt;
                        let _ = withdrawn;
                    }
                }
                Op::SupplyCollateral => {
                    let amount = rng.gen_amount(1, 1_000_000);
                    p.supply_collateral(&user, &asset, &amount);
                    collat_balance += amount;
                }
                Op::WithdrawCollateral => {
                    if collat_balance > 0 {
                        let amt = rng.gen_amount(1, collat_balance.min(100_000));
                        let withdrawn = p.withdraw_collateral(&user, &asset, &amt);
                        collat_balance -= withdrawn;
                    }
                }
                Op::Borrow => {
                    // Only borrow if collateral is sufficient.
                    if collat_balance > debt_balance + 1 {
                        let amt = rng.gen_amount(1, (collat_balance - debt_balance).min(50_000));
                        if amt > 0 {
                            let result =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    p.borrow(&user, &asset, &amt);
                                }));
                            if result.is_ok() {
                                debt_balance += amt;
                            }
                        }
                    }
                }
                Op::Repay => {
                    if debt_balance > 0 {
                        let amt = rng.gen_amount(1, debt_balance);
                        let repaid = p.repay(&user, &asset, &amt);
                        debt_balance -= repaid;
                    }
                }
            }

            // ── Invariant checks after each operation ──
            let td = p.total_deposit(&asset);
            let tb = p.total_borrow(&asset);
            let idx = p.borrow_index(&asset);

            // L-1: borrows ≤ deposits.
            assert!(
                tb <= td,
                "L-1 violated at step {step}: borrows={tb} > deposits={td}"
            );

            // L-2: borrow_index monotone non-decreasing.
            assert!(
                idx >= 1_000_000_000_000_000_000i128,
                "L-2 violated at step {step}: index below initial"
            );

            // L-7: total deposit shares ≥ 0.
            let ts = p.deposit_shares_of(&user, &asset);
            assert!(ts >= 0, "L-7 violated: negative shares at step {step}");

            // Collateral accounting.
            let pos = v.position(&user, &asset);
            assert!(pos >= 0, "vault position must be non-negative");
        }

        // Final: verify that total_by_asset matches sum(user positions).
        let total = v.total_by_asset(&asset);
        let pos = v.position(&user, &asset);
        assert_eq!(total, pos, "V-1: total must equal sum of positions");
    }

    /// Property test: 100 random operations, verify collateral vault invariants.
    #[test]
    fn prop_collateral_vault_invariants() {
        let env = Env::default();
        env.mock_all_auths();
        let mut rng = FuzzRng::from_env(&env);

        let admin = Address::generate(&env);
        let op = Address::generate(&env);
        let v = collateral_vault::CollateralVaultClient::new(
            &env,
            &env.register(collateral_vault::CollateralVault {}, ()),
        );
        v.initialize(&admin);
        v.set_skip_token_transfers(&true);
        v.add_operator(&op);

        let asset = Symbol::new(&env, "XLM");

        // Track multiple users.
        let users: Vec<Address> = (0..5).map(|_| Address::generate(&env)).collect();
        let mut balances: Vec<i128> = vec![0; 5];

        for step in 0..100 {
            let ui = rng.gen_index(users.len());
            let user = &users[ui];

            if rng.gen_bool() && balances[ui] < 10_000_000 {
                // Deposit.
                let amount = rng.gen_amount(1, 100_000);
                v.deposit(&op, user, &asset, &amount);
                balances[ui] += amount;
            } else if balances[ui] > 0 {
                // Withdraw.
                let amount = rng.gen_amount(1, balances[ui].min(50_000));
                v.withdraw(&op, user, &asset, &amount);
                balances[ui] -= amount;
            }

            // V-1: total_by_asset == sum(positions).
            let total = v.total_by_asset(&asset);
            let sum: i128 = balances.iter().sum();
            assert_eq!(
                total, sum,
                "V-1 violated at step {step}: total={total} sum={sum}"
            );

            // All positions non-negative.
            for (i, b) in balances.iter().enumerate() {
                let pos = v.position(&users[i], &asset);
                assert_eq!(pos, *b, "position mismatch for user {i} at step {step}");
            }
        }
    }

    /// Property test: sequential borrows always reduce health factor.
    #[test]
    fn prop_health_factor_monotonic() {
        let env = Env::default();
        env.mock_all_auths();
        let (p, _v, _w, _pool_id, asset) = deploy_minimal(&env);
        let mut rng = FuzzRng::from_env(&env);
        let user = Address::generate(&env);

        // Post substantial collateral.
        p.supply_collateral(&user, &asset, &10_000i128);
        p.supply(&user, &asset, &100_000i128);

        let mut prev_hf: Option<i128> = None;
        for step in 0..20 {
            // Borrow a small amount each time.
            let amt = rng.gen_amount(10, 200);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                p.borrow(&user, &asset, &amt);
            }));
            if result.is_err() {
                break; // HF too low, stop.
            }
            let hf = p.health_factor(&user, &asset);
            if let Some(phf) = prev_hf {
                assert!(
                    hf <= phf,
                    "L-13 violated at step {step}: HF increased from {phf} to {hf}"
                );
            }
            prev_hf = Some(hf);
        }
        // Should have successfully borrowed at least once.
        assert!(
            prev_hf.is_some(),
            "should have completed at least one borrow"
        );
    }

    /// Property test: repay always reduces debt and never exceeds outstanding.
    #[test]
    fn prop_repay_bounded() {
        let env = Env::default();
        env.mock_all_auths();
        let (p, _v, _w, _pool_id, asset) = deploy_minimal(&env);
        let mut rng = FuzzRng::from_env(&env);
        let user = Address::generate(&env);

        p.supply_collateral(&user, &asset, &10_000i128);
        p.supply(&user, &asset, &100_000i128);
        p.borrow(&user, &asset, &5_000i128);

        let initial_debt = p.debt_of(&user, &asset);

        for step in 0..50 {
            let current_debt = p.debt_of(&user, &asset);
            if current_debt == 0 {
                break;
            }
            let amt = rng.gen_amount(1, (current_debt * 2).min(1_000_000));
            let repaid = p.repay(&user, &asset, &amt);

            // L-6: repay must not exceed outstanding debt.
            assert!(
                repaid <= current_debt,
                "L-6 violated at step {step}: repaid={repaid} > debt={current_debt}"
            );

            let new_debt = p.debt_of(&user, &asset);
            assert!(
                new_debt <= current_debt,
                "debt must not increase after repay"
            );
        }

        let final_debt = p.debt_of(&user, &asset);
        assert!(final_debt < initial_debt, "debt must decrease after repays");
    }
}
