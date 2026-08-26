//! # Wrapped Asset (wTKN)
//!
//! The canonical wrapped token on Stellar. Mints and burns are gated by the
//! `lending_controller`, which in turn is fed by the off-chain bridge middleware
//! that watches `Locked` / `Burned` events on source chains (Ethereum, Solana, Polygon).

#![no_std]

use soroban_sdk::{contract, contractevent, contractimpl, contracttype, Address, Env, String};

// ────────────────────────────── Storage Types ──────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin (upgradeable, multisig in production)
    Admin,
    /// Address authorized to mint/burn — i.e. the lending_controller
    Minter,
    /// Token metadata
    Metadata,
    /// Per-account balance
    Balance(Address),
    /// Total supply
    TotalSupply,
}

#[contracttype]
#[derive(Clone)]
pub struct TokenMetadata {
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
    /// Source chain identifier (e.g. "ethereum", "solana", "polygon")
    pub origin_chain: String,
    /// Canonical source-chain contract address
    pub origin_address: String,
}

// ──────────────────────────────── Contract ────────────────────────────────

// ──────────────────────── Events ────────────────────────
//
// `#[contractevent]` replaces the deprecated `env.events().publish(...)`
// API (soroban-sdk >= 22). The topic symbol is the snake_case struct
// name; `data_format = "vec"` keeps the previous Vec-shaped event data.

#[contractevent(data_format = "vec")]
pub struct Init {
    admin: Address,
    minter: Address,
}

#[contractevent(data_format = "vec")]
pub struct Mint {
    to: Address,
    amount: i128,
}

#[contractevent(data_format = "vec")]
pub struct Burn {
    from: Address,
    amount: i128,
}

#[contractevent(data_format = "vec")]
pub struct SetMinter {
    new_minter: Address,
}

#[contract]
pub struct WrappedAsset;

#[contractimpl]
impl WrappedAsset {
    /// One-time initialization. Called exactly once by the deployer.
    pub fn initialize(
        env: Env,
        admin: Address,
        minter: Address,
        name: String,
        symbol: String,
        decimals: u32,
        origin_chain: String,
        origin_address: String,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Minter, &minter);
        env.storage().instance().set(
            &DataKey::Metadata,
            &TokenMetadata {
                name,
                symbol,
                decimals,
                origin_chain,
                origin_address,
            },
        );
        env.storage().instance().set(&DataKey::TotalSupply, &0i128);

        Init {
            admin: admin.clone(),
            minter,
        }
        .publish(&env);
    }

    // ──────────────────────────── Mint / Burn ────────────────────────────

    /// Mint new wrapped tokens. Restricted to the registered minter (controller).
    pub fn mint(env: Env, to: Address, amount: i128) {
        let minter: Address = env
            .storage()
            .instance()
            .get(&DataKey::Minter)
            .expect("minter not set");
        minter.require_auth();

        if amount <= 0 {
            panic!("amount must be positive");
        }

        let key = DataKey::Balance(to.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&key, &(bal.checked_add(amount).expect("overflow")));

        let supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::TotalSupply,
            &supply.checked_add(amount).expect("overflow"),
        );

        Mint { to, amount }.publish(&env);
    }

    /// Burn wrapped tokens. Anyone holding tokens may burn their own; the
    /// controller calls this for unwrap flows.
    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }

        let key = DataKey::Balance(from.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if bal < amount {
            panic!("insufficient balance");
        }
        env.storage().persistent().set(&key, &(bal - amount));

        let supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(supply - amount));

        Burn { from, amount }.publish(&env);
    }

    // ──────────────────────────── Views ────────────────────────────

    pub fn balance(env: Env, owner: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(owner))
            .unwrap_or(0)
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    pub fn metadata(env: Env) -> TokenMetadata {
        env.storage()
            .instance()
            .get(&DataKey::Metadata)
            .expect("not initialized")
    }

    pub fn minter(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Minter)
            .expect("not initialized")
    }

    // ──────────────────────────── Admin ────────────────────────────

    /// Rotate the minter (controller). 24h timelock recommended in production.
    pub fn set_minter(env: Env, new_minter: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Minter, &new_minter);
        SetMinter { new_minter }.publish(&env);
    }
}

// ──────────────────────────── Tests ────────────────────────────

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // invariant tests are named after doc IDs
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        Env,
    };

    #[test]
    fn test_initialize_and_mint() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let user = Address::generate(&env);

        let contract = WrappedAssetClient::new(&env, &env.register(WrappedAsset {}, ()));

        contract.initialize(
            &admin,
            &minter,
            &String::from_str(&env, "Wrapped Ether"),
            &String::from_str(&env, "wETH"),
            &7u32,
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0x0000000000000000000000000000000000000000"),
        );

        contract.mint(&user, &1_000_000);
        assert_eq!(contract.balance(&user), 1_000_000);
        assert_eq!(contract.total_supply(), 1_000_000);
    }

    #[test]
    fn test_burn_reduces_supply() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let user = Address::generate(&env);

        let contract = WrappedAssetClient::new(&env, &env.register(WrappedAsset {}, ()));

        contract.initialize(
            &admin,
            &minter,
            &String::from_str(&env, "Wrapped Ether"),
            &String::from_str(&env, "wETH"),
            &7u32,
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0x0"),
        );
        contract.mint(&user, &500);
        contract.burn(&user, &200);
        assert_eq!(contract.balance(&user), 300);
        assert_eq!(contract.total_supply(), 300);
    }

    #[test]
    #[should_panic]
    fn test_burn_overbalance() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let user = Address::generate(&env);
        let contract = WrappedAssetClient::new(&env, &env.register(WrappedAsset {}, ()));
        contract.initialize(
            &admin,
            &minter,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "x"),
            &7u32,
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0x0"),
        );
        contract.mint(&user, &10);
        contract.burn(&user, &11);
    }

    // ──────────────────────── INVARIANT TESTS (W-3 … W-6) ────────────────────
    // Access-control invariants use selective auth mocking (`mock_auths`)
    // instead of `mock_all_auths`, because `mint`/`burn` gate on
    // `require_auth` and the blanket mock would let any caller through.

    fn initialize_with(env: &Env, admin: &Address, minter: &Address, cid: &soroban_sdk::Address) {
        use soroban_sdk::IntoVal as _;
        let name = String::from_str(env, "X");
        let symbol = String::from_str(env, "x");
        let origin = String::from_str(env, "ethereum");
        let origin_addr = String::from_str(env, "0x0");
        env.mock_auths(&[MockAuth {
            address: admin,
            invoke: &MockAuthInvoke {
                contract: cid,
                fn_name: "initialize",
                args: (admin, minter, &name, &symbol, &7u32, &origin, &origin_addr).into_val(env),
                sub_invokes: &[],
            },
        }]);
        WrappedAssetClient::new(env, cid).initialize(
            admin,
            minter,
            &name,
            &symbol,
            &7u32,
            &origin,
            &origin_addr,
        );
    }

    /// **W-3:** A `burn` that is not authorised by the holder reverts.
    #[test]
    #[should_panic]
    fn invariant_W3_unauthorized_burn_reverts() {
        use soroban_sdk::IntoVal as _;
        let env = Env::default();
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let holder = Address::generate(&env);
        let attacker = Address::generate(&env);
        let cid = env.register(WrappedAsset {}, ());
        let contract = WrappedAssetClient::new(&env, &cid);

        initialize_with(&env, &admin, &minter, &cid);
        // Give the holder a balance (authorized minter call).
        env.mock_auths(&[MockAuth {
            address: &minter,
            invoke: &MockAuthInvoke {
                contract: &cid,
                fn_name: "mint",
                args: (&holder, &100i128).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        contract.mint(&holder, &100);

        // `attacker` (not the holder) tries to burn the holder's tokens.
        env.mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &cid,
                fn_name: "burn",
                args: (&holder, &10i128).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        contract.burn(&holder, &10); // holder.require_auth() fails → revert
    }

    /// **W-4:** Only the registered `minter` may call `mint`.
    #[test]
    #[should_panic]
    fn invariant_W4_only_minter_mints() {
        use soroban_sdk::IntoVal as _;
        let env = Env::default();
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let user = Address::generate(&env);
        let cid = env.register(WrappedAsset {}, ());
        let contract = WrappedAssetClient::new(&env, &cid);

        initialize_with(&env, &admin, &minter, &cid);
        // A non-minter attempts to mint → minter.require_auth() fails.
        env.mock_auths(&[MockAuth {
            address: &user,
            invoke: &MockAuthInvoke {
                contract: &cid,
                fn_name: "mint",
                args: (&user, &100i128).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        contract.mint(&user, &100);
    }

    /// **W-5:** `initialize` is callable exactly once.
    #[test]
    #[should_panic]
    fn invariant_W5_initialize_once() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let contract = WrappedAssetClient::new(&env, &env.register(WrappedAsset {}, ()));
        let name = String::from_str(&env, "X");
        let symbol = String::from_str(&env, "x");
        let origin = String::from_str(&env, "ethereum");
        let origin_addr = String::from_str(&env, "0x0");
        contract.initialize(
            &admin,
            &minter,
            &name,
            &symbol,
            &7u32,
            &origin,
            &origin_addr,
        );
        contract.initialize(
            &admin,
            &minter,
            &name,
            &symbol,
            &7u32,
            &origin,
            &origin_addr,
        ); // revert
    }

    /// **W-6:** `mint`/`burn` amounts are strictly positive.
    #[test]
    #[should_panic]
    fn invariant_W6_zero_amounts_revert() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let user = Address::generate(&env);
        let contract = WrappedAssetClient::new(&env, &env.register(WrappedAsset {}, ()));
        let name = String::from_str(&env, "X");
        let symbol = String::from_str(&env, "x");
        let origin = String::from_str(&env, "ethereum");
        let origin_addr = String::from_str(&env, "0x0");
        contract.initialize(
            &admin,
            &minter,
            &name,
            &symbol,
            &7u32,
            &origin,
            &origin_addr,
        );
        contract.mint(&user, &0); // zero mint reverts
        contract.burn(&user, &0); // zero burn reverts
    }
}
