//! # Collateral Vault
//!
//! Tracks collateral deposits per (user, asset) pair. Authorized callers
//! (the `lending_pool`) deposit and withdraw; the `liquidation` contract
//! may seize collateral under preset conditions.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// address authorized to move funds
    Operator(Address),
    /// (user, asset) => amount
    Position(Address, Symbol),
    /// asset => total
    TotalByAsset(Symbol),
    /// asset => liquidation threshold in bps (e.g. 8500 = 85%)
    LiqThreshold(Symbol),
    /// asset => token contract address
    TokenAddress(Symbol),
}

#[contract]
pub struct CollateralVault;

#[contractimpl]
impl CollateralVault {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn add_operator(env: Env, op: Address) {
        Self::require_admin(&env);
        env.storage()
            .persistent()
            .set(&DataKey::Operator(op), &true);
    }

    pub fn set_liq_threshold(env: Env, asset: Symbol, bps: u32) {
        Self::require_admin(&env);
        if bps > 10_000 {
            panic!("bps > 100%");
        }
        env.storage()
            .persistent()
            .set(&DataKey::LiqThreshold(asset), &bps);
    }

    pub fn set_token_address(env: Env, asset: Symbol, token_address: Address) {
        Self::require_admin(&env);
        env.storage()
            .persistent()
            .set(&DataKey::TokenAddress(asset), &token_address);
    }

    /// Operator deposits `amount` of `asset` on behalf of `user` as collateral.
    pub fn deposit(env: Env, op: Address, user: Address, asset: Symbol, amount: i128) {
        Self::require_operator(&env, &op);
        if amount <= 0 {
            panic!("amount must be positive");
        }

        // Transfer tokens from user to vault
        if let Some(token_addr) = env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::TokenAddress(asset.clone()))
        {
            let token_client = token::Client::new(&env, &token_addr);
            token_client.transfer(&user, &env.current_contract_address(), &amount);
        }

        let pos_key = DataKey::Position(user.clone(), asset.clone());
        let pos: i128 = env.storage().persistent().get(&pos_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&pos_key, &pos.checked_add(amount).expect("overflow"));

        let total_key = DataKey::TotalByAsset(asset.clone());
        let total: i128 = env.storage().persistent().get(&total_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&total_key, &total.checked_add(amount).expect("overflow"));
    }

    /// Withdraw collateral. `op` must be the lending pool or a liquidation contract.
    pub fn withdraw(env: Env, op: Address, user: Address, asset: Symbol, amount: i128) {
        Self::require_operator(&env, &op);
        if amount <= 0 {
            panic!("amount must be positive");
        }

        let pos_key = DataKey::Position(user.clone(), asset.clone());
        let pos: i128 = env.storage().persistent().get(&pos_key).unwrap_or(0);
        if pos < amount {
            panic!("insufficient collateral");
        }

        // Transfer tokens from vault to user
        if let Some(token_addr) = env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::TokenAddress(asset.clone()))
        {
            let token_client = token::Client::new(&env, &token_addr);
            token_client.transfer(&env.current_contract_address(), &user, &amount);
        }

        env.storage().persistent().set(&pos_key, &(pos - amount));

        let total_key = DataKey::TotalByAsset(asset.clone());
        let total: i128 = env.storage().persistent().get(&total_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&total_key, &(total - amount));
    }

    /// Seize collateral from an underwater borrower to a liquidator.
    pub fn seize(env: Env, op: Address, from: Address, to: Address, asset: Symbol, amount: i128) {
        Self::require_operator(&env, &op);
        if amount <= 0 {
            panic!("amount must be positive");
        }

        let pos_key = DataKey::Position(from.clone(), asset.clone());
        let pos: i128 = env.storage().persistent().get(&pos_key).unwrap_or(0);
        if pos < amount {
            panic!("insufficient collateral to seize");
        }

        // Transfer tokens from vault to recipient
        if let Some(token_addr) = env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::TokenAddress(asset.clone()))
        {
            let token_client = token::Client::new(&env, &token_addr);
            token_client.transfer(&env.current_contract_address(), &to, &amount);
        }

        env.storage().persistent().set(&pos_key, &(pos - amount));

        let recv_key = DataKey::Position(to.clone(), asset.clone());
        let recv: i128 = env.storage().persistent().get(&recv_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&recv_key, &recv.checked_add(amount).expect("overflow"));
    }

    // ──────────────────────────── Views ────────────────────────────

    pub fn position(env: Env, user: Address, asset: Symbol) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Position(user, asset))
            .unwrap_or(0)
    }

    pub fn total_by_asset(env: Env, asset: Symbol) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalByAsset(asset))
            .unwrap_or(0)
    }

    pub fn liq_threshold_bps(env: Env, asset: Symbol) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::LiqThreshold(asset))
            .unwrap_or(8_500) // default 85%
    }

    // ──────────────────────────── Internals ────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set");
        admin.require_auth();
    }

    fn require_operator(env: &Env, op: &Address) {
        op.require_auth();
        let ok: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Operator(op.clone()))
            .unwrap_or(false);
        if !ok {
            panic!("not an operator");
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // invariant tests are named after doc IDs
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_deposit_and_withdraw() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let op = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");

        let vault = CollateralVaultClient::new(&env, &env.register(CollateralVault {}, ()));
        vault.initialize(&admin);
        vault.add_operator(&op);
        vault.deposit(&op, &user, &asset, &1_000);
        assert_eq!(vault.position(&user, &asset), 1_000);
        vault.withdraw(&op, &user, &asset, &400);
        assert_eq!(vault.position(&user, &asset), 600);
        assert_eq!(vault.total_by_asset(&asset), 600);
    }

    #[test]
    fn test_seize_transfers() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let op = Address::generate(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let vault = CollateralVaultClient::new(&env, &env.register(CollateralVault {}, ()));
        vault.initialize(&admin);
        vault.add_operator(&op);
        vault.deposit(&op, &a, &asset, &1_000);
        vault.seize(&op, &a, &b, &asset, &300);
        assert_eq!(vault.position(&a, &asset), 700);
        assert_eq!(vault.position(&b, &asset), 300);
    }

    // ──────────────────────── INVARIANT TESTS (V-*) ────────────────────────
    //
    // UNVERIFIED: `cargo test` is blocked by a `soroban-sdk 21.x` dep-tree
    // split. See `../../BUILD_ENV_NOTES.md`. Tests are static-reviewed as
    // well-formed against the existing test patterns in this module.

    /// **V-1:** `total_by_asset(a) == sum over users of position(u, a)`.
    #[test]
    fn invariant_V1_total_equals_sum_of_positions() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let op = Address::generate(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let vault = CollateralVaultClient::new(&env, &env.register(CollateralVault {}, ()));
        vault.initialize(&admin);
        vault.add_operator(&op);
        vault.deposit(&op, &a, &asset, &400);
        vault.deposit(&op, &b, &asset, &600);
        vault.deposit(&op, &c, &asset, &1_000);
        let total = vault.total_by_asset(&asset);
        let sum =
            vault.position(&a, &asset) + vault.position(&b, &asset) + vault.position(&c, &asset);
        assert_eq!(total, sum, "V-1 violated: total != sum(positions)");
    }

    /// **V-2:** `withdraw` cannot reduce a position below zero.
    #[test]
    #[should_panic]
    fn invariant_V2_withdraw_rejects_overdraw() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let op = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let vault = CollateralVaultClient::new(&env, &env.register(CollateralVault {}, ()));
        vault.initialize(&admin);
        vault.add_operator(&op);
        vault.deposit(&op, &user, &asset, &100);
        vault.withdraw(&op, &user, &asset, &101);
    }

    /// **V-3:** Only an operator may call `deposit`/`withdraw`/`seize`.
    #[test]
    #[should_panic]
    fn invariant_V3_non_operator_cannot_deposit() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let op = Address::generate(&env);
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let vault = CollateralVaultClient::new(&env, &env.register(CollateralVault {}, ()));
        vault.initialize(&admin);
        vault.add_operator(&op);
        // `op` is NOT the registered operator; the call should panic.
        let stranger_op = Address::generate(&env);
        vault.deposit(&stranger_op, &user, &asset, &100);
    }

    /// **V-5:** `set_liq_threshold` rejects bps > 10_000.
    #[test]
    #[should_panic]
    fn invariant_V5_liq_threshold_bps_bounded() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let vault = CollateralVaultClient::new(&env, &env.register(CollateralVault {}, ()));
        vault.initialize(&admin);
        vault.set_liq_threshold(&asset, &10_001u32);
    }
}
