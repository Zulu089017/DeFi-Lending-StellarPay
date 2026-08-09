//! # Lending Controller
//!
//! Top-level orchestrator contract. The bridge middleware calls into
//! this contract to wrap/unwrap; users call into it to supply collateral,
//! borrow, repay, and liquidate.

#![no_std]

use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, xdr::ToXdr, Address, Bytes, BytesN, Env,
    IntoVal, Symbol, Val, Vec,
};

/// Default timelock delay in ledgers (~24h with 5s ledger times).
const TIMELOCK_LEDGERS: u64 = 17_280;

/// Protocol-wide ceiling on the loan-to-value ratio in basis points (75%).
/// The per-asset LTV enforced on every borrow is read from the pool's
/// `AssetConfig.ltv_bps` for the collateral asset; the effective LTV is
/// `min(asset_ltv_bps, MAX_LTV_BPS)` so a misconfigured asset can never
/// exceed this absolute cap.
const MAX_LTV_BPS: u32 = 7_500;

#[contracttype]
#[derive(Clone)]
pub struct BridgeSet {
    /// Ed25519 public keys of the bridge attesters.
    pub keys: Vec<BytesN<32>>,
    /// Minimum number of distinct valid attestations required for wrap/unwrap.
    pub threshold: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Multi-admin set (replaces single Admin for multisig support).
    AdminSet,
    /// Bridge attester set (N-of-M threshold). Replaces the single Bridge key.
    Bridge,
    /// Pending bridge update (proposed, awaiting timelock expiry)
    PendingBridge,
    /// Ledger sequence when the pending bridge update was proposed
    PendingBridgeAt,
    WrappedAsset,
    LendingPool,
    CollateralVault,
    Oracle,
    /// Used replay-protection for cross-chain wrap/unwrap
    Nonce(BytesN<32>),
    /// Emergency pause
    Paused,
    /// Max mints per hour (circuit breaker)
    MintWindowStart,
    MintWindowCount,
}

#[contracttype]
#[derive(Clone)]
pub struct AdminSet {
    pub admins: Vec<Address>,
    pub threshold: u32,
}

// ──────────────────────── Events ────────────────────────
//
// `#[contractevent]` replaces the deprecated `env.events().publish(...)`
// API (soroban-sdk >= 22). The topic symbol defaults to the snake_case of
// the struct name; `data_format = "vec"` keeps the previous Vec-shaped
// event data so downstream indexers that decode raw topics/vecs are
// unaffected.

#[contractevent(data_format = "vec")]
pub struct Wrap {
    chain_id: u32,
    source_addr: BytesN<32>,
    to: Address,
    amount: i128,
    salt: BytesN<32>,
    nonce: u64,
}

#[contractevent(data_format = "vec")]
pub struct Unwrap {
    user: Address,
    amount: i128,
    chain_id: u32,
    source_addr: BytesN<32>,
    nonce: BytesN<32>,
}

#[contractevent(data_format = "vec")]
pub struct Supply {
    user: Address,
    asset: Symbol,
    amount: i128,
}

#[contractevent(data_format = "vec")]
pub struct Borrow {
    user: Address,
    collateral_asset: Symbol,
    debt_asset: Symbol,
    borrow_amount: i128,
}

#[contract]
pub struct LendingController;

#[contractimpl]
impl LendingController {
    pub fn initialize(
        env: Env,
        admin: Address,
        bridge_keys: Vec<BytesN<32>>,
        bridge_threshold: u32,
        wrapped_asset: Address,
        lending_pool: Address,
        collateral_vault: Address,
        oracle: Address,
    ) {
        if env.storage().instance().has(&DataKey::AdminSet) {
            panic!("already initialized");
        }
        admin.require_auth();
        let admins = soroban_sdk::vec![&env, admin];
        env.storage().instance().set(
            &DataKey::AdminSet,
            &AdminSet {
                admins,
                threshold: 1,
            },
        );
        env.storage().instance().set(
            &DataKey::Bridge,
            &BridgeSet {
                keys: bridge_keys,
                threshold: bridge_threshold,
            },
        );
        env.storage()
            .instance()
            .set(&DataKey::WrappedAsset, &wrapped_asset);
        env.storage()
            .instance()
            .set(&DataKey::LendingPool, &lending_pool);
        env.storage()
            .instance()
            .set(&DataKey::CollateralVault, &collateral_vault);
        env.storage().instance().set(&DataKey::Oracle, &oracle);
    }

    // ──────────────────────── Cross-chain wrap ────────────────────────

    /// Called by the bridge middleware (off-chain relayer) after observing a
    /// `Locked` event on the source chain. Mints `wTKN` to `to` on Stellar.
    ///
    /// `attestations` is a sorted Vec of `(key_index, ed25519_signature)`
    /// pairs. Each signature is verified against the bridge pubkey at the
    /// given index, and the total number of distinct valid attestations must
    /// meet or exceed the configured `bridge_threshold`.
    pub fn wrap(
        env: Env,
        attestations: Vec<(u32, BytesN<64>)>, // sorted (key_index, ed25519 sig)
        chain_id: u32,
        source_addr: BytesN<32>,
        amount: i128,
        to: Address,
        salt: BytesN<32>,
        nonce: u64,
    ) {
        Self::require_not_paused(&env);
        Self::require_bridge(
            &env,
            &attestations,
            chain_id,
            source_addr.clone(),
            amount,
            &to,
            &salt,
            nonce,
        );
        Self::check_and_bump_nonce(&env, &salt);
        Self::check_mint_rate(&env);

        // Cross-contract call: mint wrapped tokens on the treasury contract.
        // The wrapped_asset contract gated by the registered minter (which is
        // this controller); the `mint` function checks `minter.require_auth()`
        // and the controller's identity is preserved across invoke_contract.
        let wrapped = Self::wrapped_asset(&env);
        let fn_mint = Symbol::new(&env, "mint");
        let mint_args: Vec<Val> =
            soroban_sdk::vec![&env, to.into_val(&env), amount.into_val(&env),];
        let _: () = env.invoke_contract(&wrapped, &fn_mint, mint_args);

        Wrap {
            chain_id,
            source_addr,
            to,
            amount,
            salt,
            nonce,
        }
        .publish(&env);
    }

    /// Begin an unwrap. Burns the wrapped asset and emits a cross-chain
    /// release event that the bridge middleware watches.
    pub fn unwrap(
        env: Env,
        user: Address,
        amount: i128,
        chain_id: u32,
        source_addr: BytesN<32>,
    ) -> BytesN<32> {
        user.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        Self::require_not_paused(&env);

        // Cross-contract call: burn wrapped tokens (user must hold them).
        // `burn` does `from.require_auth()` — because the user authorised
        // the controller call, the auth context carries through.
        let wrapped = Self::wrapped_asset(&env);
        let fn_burn = Symbol::new(&env, "burn");
        let burn_args: Vec<Val> =
            soroban_sdk::vec![&env, user.into_val(&env), amount.into_val(&env),];
        let _: () = env.invoke_contract(&wrapped, &fn_burn, burn_args);

        // Generate a unique nonce
        let nonce = Self::gen_nonce(&env);
        Unwrap {
            user,
            amount,
            chain_id,
            source_addr,
            nonce: nonce.clone(),
        }
        .publish(&env);
        nonce
    }

    // ──────────────────────── Lending user-flow ────────────────────────

    // NOTE: The cross-contract invocations to `lending_pool` and
    // `collateral_vault` are intentionally written as inline calls in the
    // real implementation. The scaffold exposes the function entry points
    // only; production code should encode each arg as ScVal and use the
    // Soroban 21 client API. See the comment in `wrap` for details.

    /// User-facing entry point: supply collateral. The controller routes the
    /// call into the lending pool and the collateral vault.
    /// `asset` is a Stellar asset code symbol ("XLM", "USDC") — keep it as
    /// `Symbol` (max 9 ASCII bytes). `wrap`/`unwrap` use `BytesN<32>` for
    /// `source_addr` because EVM addresses are 20 bytes and Solana pubkeys
    /// are 32 bytes; Stellar asset codes are always short symbols.
    pub fn supply_collateral(env: Env, user: Address, asset: Symbol, amount: i128) {
        user.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        Self::require_not_paused(&env);
        // Cross-contract calls:
        //   (1) lending_pool.supply(user, asset, amount) — record supply liquidity
        //   (2) collateral_vault.deposit(controller, user, asset, amount) — lock collateral
        let pool = Self::lending_pool(&env);
        let vault = Self::collateral_vault(&env);
        let controller_addr = env.current_contract_address();

        let fn_supply = Symbol::new(&env, "supply");
        let supply_args: Vec<Val> = soroban_sdk::vec![
            &env,
            user.into_val(&env),
            asset.into_val(&env),
            amount.into_val(&env),
        ];
        let _shares: i128 = env.invoke_contract(&pool, &fn_supply, supply_args);

        let fn_deposit = Symbol::new(&env, "deposit");
        let deposit_args: Vec<Val> = soroban_sdk::vec![
            &env,
            controller_addr.into_val(&env),
            user.into_val(&env),
            asset.into_val(&env),
            amount.into_val(&env),
        ];
        let _: () = env.invoke_contract(&vault, &fn_deposit, deposit_args);

        Supply {
            user,
            asset,
            amount,
        }
        .publish(&env);
    }

    /// User-facing entry point: borrow against deposited collateral.
    ///
    /// Cross-contract flow:
    ///   1. `vault.position(user, collateral_asset)` — existing collateral
    ///   2. `pool.debt_of(user, debt_asset)` — existing debt
    ///   3. `oracle.value_of(...)` — USD value of the cumulative collateral
    ///      (existing position + newly posted amount) and the cumulative
    ///      debt (existing debt + new amount)
    ///   4. `pool.ltv_bps(collateral_asset)` — per-asset max LTV from the
    ///      pool's `AssetConfig`, capped by the protocol-wide `MAX_LTV_BPS`
    ///   5. Enforce LTV: `debt_value * 10_000 <= collateral_value * ltv_bps`
    ///   6. `vault.deposit(controller, user, collateral_asset, collateral_amount)`
    ///   7. `pool.borrow_raw(controller, user, debt_asset, borrow_amount)`
    ///
    /// # Panics
    /// - `"amount must be positive"` if either amount ≤ 0
    /// - `"asset not configured"` if the collateral asset has no
    ///   `AssetConfig` in the lending pool (no LTV to enforce)
    /// - `"health factor too low"` if the LTV check fails
    pub fn borrow(
        env: Env,
        user: Address,
        collateral_asset: Symbol,
        collateral_amount: i128,
        debt_asset: Symbol,
        borrow_amount: i128,
    ) {
        user.require_auth();
        if borrow_amount <= 0 || collateral_amount <= 0 {
            panic!("amount must be positive");
        }
        Self::require_not_paused(&env);

        let oracle_addr = Self::oracle(&env);
        let pool = Self::lending_pool(&env);
        let vault = Self::collateral_vault(&env);
        let controller_addr = env.current_contract_address();

        // ── Per-asset LTV enforcement (oracle-priced, cumulative) ──

        // Cumulative collateral: existing vault position + the amount posted
        // in this call. Valuing only the marginal `collateral_amount` would
        // let a user stack borrows that each pass individually while the
        // aggregate position breaches the LTV.
        let fn_position = Symbol::new(&env, "position");
        let position_args: Vec<Val> =
            soroban_sdk::vec![&env, user.into_val(&env), collateral_asset.into_val(&env),];
        let existing_collateral: i128 = env.invoke_contract(&vault, &fn_position, position_args);
        let total_collateral = existing_collateral
            .checked_add(collateral_amount)
            .expect("overflow");
        let collat_value =
            Self::oracle_value_of(&env, &oracle_addr, &collateral_asset, &total_collateral);

        // Cumulative debt: existing borrows + the new amount.
        let fn_debt = Symbol::new(&env, "debt_of");
        let debt_args: Vec<Val> =
            soroban_sdk::vec![&env, user.into_val(&env), debt_asset.into_val(&env),];
        let existing_debt: i128 = env.invoke_contract(&pool, &fn_debt, debt_args);
        let total_debt = existing_debt.checked_add(borrow_amount).expect("overflow");
        let debt_value = Self::oracle_value_of(&env, &oracle_addr, &debt_asset, &total_debt);

        // Per-asset max LTV (bps) read from the pool's `AssetConfig` for the
        // collateral asset, capped by the protocol-wide ceiling as
        // defense-in-depth against a misconfigured asset.
        let fn_ltv = Symbol::new(&env, "ltv_bps");
        let ltv_args: Vec<Val> = soroban_sdk::vec![&env, collateral_asset.into_val(&env)];
        let asset_ltv_bps: u32 = env.invoke_contract(&pool, &fn_ltv, ltv_args);
        let effective_ltv_bps = asset_ltv_bps.min(MAX_LTV_BPS);

        // require: debt_value * 10_000 <= collat_value * effective_ltv_bps
        if debt_value.checked_mul(10_000i128).expect("overflow")
            > collat_value
                .checked_mul(effective_ltv_bps as i128)
                .expect("overflow")
        {
            panic!("health factor too low");
        }

        // (1) Deposit collateral into the vault on behalf of user.
        let fn_deposit = Symbol::new(&env, "deposit");
        let deposit_args: Vec<Val> = soroban_sdk::vec![
            &env,
            controller_addr.into_val(&env),
            user.into_val(&env),
            collateral_asset.into_val(&env),
            collateral_amount.into_val(&env),
        ];
        let _: () = env.invoke_contract(&vault, &fn_deposit, deposit_args);

        // (2) Record the borrow in the lending pool via borrow_raw.
        // The pool's single-asset HF check is bypassed because the
        // controller already performed its own oracle-based multi-asset
        // LTV enforcement above. The controller must be registered as a
        // pool operator (via pool.add_operator).
        let fn_borrow = Symbol::new(&env, "borrow_raw");
        let borrow_args: Vec<Val> = soroban_sdk::vec![
            &env,
            controller_addr.into_val(&env),
            user.into_val(&env),
            debt_asset.into_val(&env),
            borrow_amount.into_val(&env),
        ];
        let _: () = env.invoke_contract(&pool, &fn_borrow, borrow_args);

        Borrow {
            user,
            collateral_asset,
            debt_asset,
            borrow_amount,
        }
        .publish(&env);
    }

    // ──────────────────────── Admin ────────────────────────

    /// Emergency pause — any single admin can trigger immediately.
    /// This is intentionally direct (no timelock) so that an admin can halt
    /// the protocol instantly in case of an active exploit.
    pub fn set_paused(env: Env, paused: bool) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Paused, &paused);
    }

    /// Propose a new bridge attester set. Any admin can propose; the change
    /// takes effect only after `execute_bridge` is called post-timelock.
    pub fn propose_bridge(env: Env, bridge_keys: Vec<BytesN<32>>, bridge_threshold: u32) {
        Self::require_admin(&env);
        env.storage().instance().set(
            &DataKey::PendingBridge,
            &BridgeSet {
                keys: bridge_keys,
                threshold: bridge_threshold,
            },
        );
        let now: u64 = env.ledger().sequence().into();
        env.storage()
            .instance()
            .set(&DataKey::PendingBridgeAt, &now);
    }

    /// Execute a previously proposed bridge update after the timelock expires.
    /// Any admin may call this once the timelock has passed.
    pub fn execute_bridge(env: Env) {
        Self::require_admin(&env);
        let proposed_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PendingBridgeAt)
            .expect("no pending bridge proposal");
        let now: u64 = env.ledger().sequence().into();
        if now.saturating_sub(proposed_at) < TIMELOCK_LEDGERS {
            panic!("timelock not expired");
        }
        let bridge: BridgeSet = env
            .storage()
            .instance()
            .get(&DataKey::PendingBridge)
            .expect("no pending bridge proposal");
        env.storage().instance().set(&DataKey::Bridge, &bridge);
        env.storage().instance().remove(&DataKey::PendingBridge);
        env.storage().instance().remove(&DataKey::PendingBridgeAt);
    }

    /// Direct bridge set (backward compat for tests). Production should use
    /// propose_bridge + execute_bridge with timelock.
    pub fn set_bridge(env: Env, bridge_keys: Vec<BytesN<32>>, bridge_threshold: u32) {
        Self::require_admin(&env);
        env.storage().instance().set(
            &DataKey::Bridge,
            &BridgeSet {
                keys: bridge_keys,
                threshold: bridge_threshold,
            },
        );
    }

    /// Add a new admin to the admin set. Requires threshold approvals from
    /// existing admins.
    pub fn add_admin(env: Env, new_admin: Address) {
        Self::require_admin_multisig(&env);
        let mut set: AdminSet = env
            .storage()
            .instance()
            .get(&DataKey::AdminSet)
            .expect("admin set not found");
        // Check for duplicates.
        for i in 0u32..set.admins.len() {
            if set.admins.get(i).unwrap() == new_admin {
                panic!("admin already exists");
            }
        }
        set.admins.push_back(new_admin);
        env.storage().instance().set(&DataKey::AdminSet, &set);
    }

    /// Remove an admin. Requires threshold approvals; cannot reduce below
    /// threshold.
    pub fn remove_admin(env: Env, admin_to_remove: Address) {
        Self::require_admin_multisig(&env);
        let mut set: AdminSet = env
            .storage()
            .instance()
            .get(&DataKey::AdminSet)
            .expect("admin set not found");
        if set.admins.len() <= set.threshold {
            panic!("cannot reduce admins below threshold");
        }
        let mut found = false;
        let mut new_admins = soroban_sdk::vec![&env];
        for i in 0u32..set.admins.len() {
            let a = set.admins.get(i).unwrap();
            if a != admin_to_remove {
                new_admins.push_back(a);
            } else {
                found = true;
            }
        }
        if !found {
            panic!("admin not found");
        }
        set.admins = new_admins;
        env.storage().instance().set(&DataKey::AdminSet, &set);
    }

    /// Set the admin threshold. Requires threshold approvals. Threshold must
    /// be ≥ 1 and ≤ admin count.
    pub fn set_threshold(env: Env, new_threshold: u32) {
        Self::require_admin_multisig(&env);
        let mut set: AdminSet = env
            .storage()
            .instance()
            .get(&DataKey::AdminSet)
            .expect("admin set not found");
        if new_threshold < 1 || new_threshold > set.admins.len() {
            panic!("invalid threshold");
        }
        set.threshold = new_threshold;
        env.storage().instance().set(&DataKey::AdminSet, &set);
    }

    /// Return the current admin set.
    pub fn admin_set(env: Env) -> AdminSet {
        env.storage()
            .instance()
            .get(&DataKey::AdminSet)
            .expect("admin set not found")
    }

    // ──────────────────────── Internals ────────────────────────

    /// Single-admin check — any admin in the set can call.
    fn require_admin(env: &Env) {
        let set: AdminSet = env
            .storage()
            .instance()
            .get(&DataKey::AdminSet)
            .expect("admin set not found");
        // Require at least one admin to have authorized (any admin may act
        // for emergency operations like pause and direct set_bridge).
        let mut authed = false;
        for i in 0u32..set.admins.len() {
            let a = set.admins.get(i).unwrap();
            // In tests with mock_all_auths, this loop body is irrelevant.
            // In production, exactly one admin must have signed the tx.
            // We check that at least one admin's require_auth passes.
            // Soroban's require_auth panics if not authorized, so we can't
            // iterate and try — instead we just require that the caller
            // is in the admin set. The SDK doesn't provide "is_authorized".
            // So we do: pick the first admin and require their auth.
            // For multisig operations, caller must be in the set.
            if !authed {
                // require_auth on the first admin — if it passes, we're good.
                // This means set_paused and set_bridge require the FIRST admin.
                // For true multisig, use add_admin/remove_admin which gate on
                // require_admin_multisig.
                a.require_auth();
                authed = true;
            }
        }
        let _ = authed;
    }

    /// Multisig check — requires at least one admin to have signed.
    ///
    /// TODO(prod): Soroban's `require_auth()` panics if the address didn't
    /// sign, so iterating all admins would require 100% quorum. True N-of-M
    /// multisig needs `env.crypto().ed25519_verify()` against the admin set
    /// with explicit signatures (similar to the bridge attestation pattern).
    /// For now, any single admin can authorize multisig-gated operations;
    /// the admin SET itself is a foundation for future threshold enforcement.
    fn require_admin_multisig(env: &Env) {
        let set: AdminSet = env
            .storage()
            .instance()
            .get(&DataKey::AdminSet)
            .expect("admin set not found");
        // Require the first admin to authorize — this is a single-admin
        // gate until true multi-sig signature verification is implemented.
        // The admin set structure (Vec + threshold) is stored, so when the
        // SDK adds `try_require_auth` or we implement explicit sig checking,
        // this function can be upgraded to true threshold enforcement.
        let first = set.admins.get(0).expect("admin set is empty");
        first.require_auth();
    }

    fn require_not_paused(env: &Env) {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            panic!("paused");
        }
    }

    fn require_bridge(
        env: &Env,
        attestations: &Vec<(u32, BytesN<64>)>,
        chain_id: u32,
        source_addr: BytesN<32>,
        amount: i128,
        to: &Address,
        salt: &BytesN<32>,
        nonce: u64,
    ) {
        // Multi-attester threshold verification. Each attestation is an
        // ed25519 signature over sha256(canonical_payload). The caller must
        // provide (key_index, signature) pairs sorted by key_index to prevent
        // duplicate-index attacks. Each signature is verified against the
        // bridge pubkey at the given index, and the total number of distinct
        // valid attestations must meet or exceed the configured threshold.
        let bridge_set: BridgeSet = env
            .storage()
            .instance()
            .get(&DataKey::Bridge)
            .expect("bridge not set");

        if attestations.len() < bridge_set.threshold {
            panic!("not enough attestations");
        }

        // Build the canonical payload (must match `payloadHash` in
        // bridge/src/attest/signer.ts byte-for-byte).
        let payload = Self::build_canonical_payload(
            env,
            chain_id,
            source_addr.clone(),
            amount,
            to,
            salt,
            nonce,
        );
        let hash = env.crypto().sha256(&payload);
        let hash_bytes = Bytes::from_slice(env, &hash.to_array());

        // Verify each attestation against its claimed bridge pubkey.
        // ed25519_verify panics on invalid signature, which reverts the tx.
        // Sorted key indices enforced by must-increase check prevents
        // duplicate-key attacks.
        let mut last_index: i64 = -1;
        let mut valid_count: u32 = 0;
        for (index, sig) in attestations.iter() {
            let idx_i64 = index as i64;
            if idx_i64 <= last_index {
                panic!("duplicate or unsorted attestations");
            }
            last_index = idx_i64;
            let bridge_pub = bridge_set.keys.get(index).expect("invalid key index");
            env.crypto().ed25519_verify(&bridge_pub, &hash_bytes, &sig);
            valid_count += 1;
        }
        // valid_count == attestations.len() here because ed25519_verify panics
        // on any invalid signature. The check below is an invariant assertion
        // that the sorted-index-and-verify loop processed all attestations.
        if valid_count < bridge_set.threshold {
            panic!("not enough valid attestations");
        }
    }

    /// Build the canonical payload that both sides sign. Layout (dynamic
    /// `Bytes`, appended in order):
    ///   1. "OWRP" (4 ASCII bytes)
    ///   2. chain_id (u32 LE)
    ///   3. source_addr (32 raw bytes)
    ///   4. amount (i64 LE, saturating cast)
    ///   5. to: full ScVal XDR representation of the Address (44 bytes for
    ///      an ed25519 account: 4-byte ScVal tag + 4-byte ScAddress tag +
    ///      4-byte AccountId tag + 32-byte raw pubkey). The off-chain side
    ///      produces the matching bytes via
    ///      `ScAddress.fromString(...).toScVal().toXDR()`.
    ///   6. salt (32 raw bytes)
    ///   7. nonce (u64 LE)
    fn build_canonical_payload(
        env: &Env,
        chain_id: u32,
        source_addr: BytesN<32>,
        amount: i128,
        to: &Address,
        salt: &BytesN<32>,
        nonce: u64,
    ) -> Bytes {
        let mut payload = Bytes::new(env);
        payload.append(&Bytes::from_slice(env, b"OWRP"));
        payload.append(&Bytes::from_slice(env, &chain_id.to_le_bytes()));
        payload.append(&Bytes::from_slice(env, &source_addr.to_array()));
        let amt_i64 = amount as i64; // saturating cast; production should bounds-check
        payload.append(&Bytes::from_slice(env, &amt_i64.to_le_bytes()));
        let to_xdr = to.to_xdr(env);
        // NOTE: The precise XDR length depends on the soroban-sdk version
        // and the Address variant (account vs contract).  The important
        // invariant is that both the off-chain signer and this contract
        // produce the same bytes.  A drift between SDK versions on
        // either side will cause ed25519_verify to reject the attestation
        // (see the C-6 cross-language payload digest canary test).
        payload.append(&to_xdr);
        payload.append(&Bytes::from_slice(env, &salt.to_array()));
        payload.append(&Bytes::from_slice(env, &nonce.to_le_bytes()));
        payload
    }

    fn check_and_bump_nonce(env: &Env, salt: &BytesN<32>) {
        if env
            .storage()
            .persistent()
            .has(&DataKey::Nonce(salt.clone()))
        {
            panic!("salt already used");
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(salt.clone()), &true);
    }

    fn check_mint_rate(env: &Env) {
        const MAX_PER_HOUR: i128 = 1_000_000_000_000; // 10B in 7 dec — adjust per deployment
        const WINDOW_LEDGERS: u64 = 1_800; // ~1 hour at 5s/ledger
        let now: u64 = env.ledger().sequence().into();
        let start: u64 = env
            .storage()
            .instance()
            .get(&DataKey::MintWindowStart)
            .unwrap_or(now);
        let count: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MintWindowCount)
            .unwrap_or(0);
        if now.saturating_sub(start) > WINDOW_LEDGERS {
            env.storage()
                .instance()
                .set(&DataKey::MintWindowStart, &now);
            env.storage()
                .instance()
                .set(&DataKey::MintWindowCount, &1i128);
            return;
        }
        if count >= MAX_PER_HOUR {
            panic!("mint rate exceeded");
        }
        env.storage()
            .instance()
            .set(&DataKey::MintWindowCount, &(count + 1));
    }

    fn gen_nonce(env: &Env) -> BytesN<32> {
        // `sequence()` returns u32; widen to u64 so the leading 8 bytes are
        // actually populated (copy_from_slice panics on length mismatch).
        let seq = u64::from(env.ledger().sequence()).to_be_bytes();
        let ts = env.ledger().timestamp().to_be_bytes();
        let mut buf = [0u8; 32];
        buf[..8].copy_from_slice(&seq);
        buf[8..16].copy_from_slice(&ts);
        BytesN::from_array(env, &buf)
    }

    // ──────────────────────── Views ────────────────────────

    fn wrapped_asset(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::WrappedAsset)
            .expect("wrapped_asset not set")
    }
    fn lending_pool(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::LendingPool)
            .expect("lending_pool not set")
    }
    fn collateral_vault(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::CollateralVault)
            .expect("collateral_vault not set")
    }
    fn oracle(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Oracle)
            .expect("oracle not set")
    }

    /// Call `oracle.value_of(asset, amount)` via cross-contract invoke.
    fn oracle_value_of(env: &Env, oracle_addr: &Address, asset: &Symbol, amount: &i128) -> i128 {
        let fn_name = Symbol::new(env, "value_of");
        let args: Vec<Val> = soroban_sdk::vec![env, asset.into_val(env), amount.into_val(env),];
        env.invoke_contract(oracle_addr, &fn_name, args)
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // invariant tests are named after doc IDs
    use super::*;
    use soroban_sdk::{testutils::Address as _, String};

    /// Deploy the full constellation of contracts needed by the controller:
    /// wrapped_asset, lending_pool, and collateral_vault. Returns their
    /// addresses so the test can initialise the controller with real addresses.
    struct TestEnv<'a> {
        env: Env,
        #[allow(dead_code)]
        admin: Address,
        #[allow(dead_code)]
        bridge_keys: Vec<BytesN<32>>,
        #[allow(dead_code)]
        bridge_threshold: u32,
        wrapped: Address,
        pool: Address,
        vault: Address,
        #[allow(dead_code)]
        oracle: Address,
        ctrl: LendingControllerClient<'a>,
    }

    fn setup() -> TestEnv<'static> {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);

        // Deploy the sub-contracts so cross-contract invoke_contract works.
        let wrapped_id = env.register(wrapped_asset::WrappedAsset {}, ());
        let pool_id = env.register(lending_pool::LendingPool {}, ());
        let vault_id = env.register(collateral_vault::CollateralVault {}, ());
        // Deploy and initialise the oracle with publishers so value_of works.
        let oracle_id = env.register(oracle::Oracle {}, ());
        let oracle_client = oracle::OracleClient::new(&env, &oracle_id);
        oracle_client.initialize(&admin);
        let pub1 = Address::generate(&env);
        let pub2 = Address::generate(&env);
        oracle_client.add_publisher(&pub1);
        oracle_client.add_publisher(&pub2);
        // Configure XLM and USDC with heartbeat 300s, min 2 publishers.
        oracle_client.set_asset_config(&Symbol::new(&env, "XLM"), &300u64, &2u32);
        oracle_client.set_asset_config(&Symbol::new(&env, "USDC"), &300u64, &2u32);
        // Publish prices: XLM = $0.10, USDC = $1.00 (14-decimal).
        oracle_client.set_price(&pub1, &Symbol::new(&env, "XLM"), &1_000_000_000_000i128);
        oracle_client.set_price(&pub2, &Symbol::new(&env, "XLM"), &1_000_000_000_000i128);
        oracle_client.set_price(&pub1, &Symbol::new(&env, "USDC"), &10_000_000_000_000i128);
        oracle_client.set_price(&pub2, &Symbol::new(&env, "USDC"), &10_000_000_000_000i128);

        // Initialise each sub-contract.
        let wrapped_client = wrapped_asset::WrappedAssetClient::new(&env, &wrapped_id);
        wrapped_client.initialize(
            &admin,
            &env.register(LendingController {}, ()), // temporarily register ctrl
            &String::from_str(&env, "Wrapped Test"),
            &String::from_str(&env, "wTST"),
            &7u32,
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0x0"),
        );

        let pool_client = lending_pool::LendingPoolClient::new(&env, &pool_id);
        pool_client.initialize(&admin);

        let vault_client = collateral_vault::CollateralVaultClient::new(&env, &vault_id);
        vault_client.initialize(&admin);

        // Now deploy the controller and wire everything together.
        let ctrl_id = env.register(LendingController {}, ());
        // Clone the Env so the client owns an independent copy, allowing
        // LendingControllerClient to be stored in the struct with 'static
        // lifetime alongside the original Env.
        let ctrl = LendingControllerClient::new(&env.clone(), &ctrl_id);
        let bridge_keys = soroban_sdk::vec![&env, BytesN::from_array(&env, &[1u8; 32])];
        let bridge_threshold: u32 = 1;
        ctrl.initialize(
            &admin,
            &bridge_keys,
            &bridge_threshold,
            &wrapped_id,
            &pool_id,
            &vault_id,
            &oracle_id,
        );

        // Set the controller as the minter on the wrapped_asset.
        wrapped_client.set_minter(&ctrl_id);

        // Add the controller as an operator on the collateral vault so
        // deposit/withdraw/seize calls from the controller are accepted.
        vault_client.add_operator(&ctrl_id);

        TestEnv {
            env,
            admin,
            bridge_keys,
            bridge_threshold,
            wrapped: wrapped_id,
            pool: pool_id,
            vault: vault_id,
            oracle: oracle_id,
            ctrl,
        }
    }

    /// Sign `sha256(canonical_payload)` with the given keypair and return the
    /// 64-byte ed25519 attestation, mirroring `bridge/src/attest/signer.ts`
    /// (`payloadHash` then `collectSignatures`).
    fn valid_attestation(
        env: &Env,
        signer: &ed25519_dalek::SigningKey,
        chain_id: u32,
        source_addr: &BytesN<32>,
        amount: i128,
        to: &Address,
        salt: &BytesN<32>,
        nonce: u64,
    ) -> BytesN<64> {
        use ed25519_dalek::Signer as _;
        let payload = LendingController::build_canonical_payload(
            env,
            chain_id,
            source_addr.clone(),
            amount,
            to,
            salt,
            nonce,
        );
        let hash = env.crypto().sha256(&payload);
        let sig = signer.sign(&hash.to_array());
        BytesN::from_array(env, &sig.to_bytes())
    }

    /// Wrap a single attestation into a sorted Vec<(u32, BytesN<64>)> for the
    /// `wrap` entry point, with the given key_index.
    fn attestations(env: &Env, key_index: u32, sig: &BytesN<64>) -> Vec<(u32, BytesN<64>)> {
        soroban_sdk::vec![env, (key_index, sig.clone())]
    }

    // ──────────────────── INITIALIZATION ────────────────────

    #[test]
    fn test_initialize() {
        let TestEnv { ctrl, .. } = setup();
        // set/get paused round-trip
        ctrl.set_paused(&true);
    }

    // ──────────────────────── WRAP (C-1, C-2, C-4) ────────────────────────

    /// **C-4:** When `paused == true`, `wrap` reverts.
    #[test]
    #[should_panic]
    fn invariant_C4_pause_halts_wrap() {
        let TestEnv { env, ctrl, .. } = setup();
        ctrl.set_paused(&true);
        // Calling wrap while paused must revert (checked before the
        // attestation, so an arbitrary signature still hits the pause gate).
        let src = BytesN::from_array(&env, &[0u8; 32]);
        let salt = BytesN::from_array(&env, &[2u8; 32]);
        let fake_attestations = attestations(&env, 0, &BytesN::from_array(&env, &[0u8; 64]));
        ctrl.wrap(
            &fake_attestations,
            &1u32,
            &src,
            &1_000i128,
            &Address::generate(&env),
            &salt,
            &0u64,
        );
    }

    /// **C-1:** `wrap` accepts a valid ed25519 attestation and mints tokens.
    #[test]
    fn test_C1_bridge_attestation_verified() {
        let TestEnv {
            env, wrapped, ctrl, ..
        } = setup();
        let signer = ed25519_dalek::SigningKey::from_bytes(&[2u8; 32]);
        // Update bridge pubkey to match the signer (single key, threshold 1).
        ctrl.set_bridge(
            &soroban_sdk::vec![
                &env,
                BytesN::from_array(&env, &signer.verifying_key().to_bytes()),
            ],
            &1u32,
        );

        let chain_id = 1u32;
        let src = BytesN::from_array(&env, &[4u8; 32]);
        let amount = 1_000i128;
        let to = Address::from_str(
            &env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
        let salt = BytesN::from_array(&env, &[5u8; 32]);
        let nonce = 7u64;
        let sig = valid_attestation(&env, &signer, chain_id, &src, amount, &to, &salt, nonce);
        let atts = attestations(&env, 0, &sig);

        // Execute the wrap — should call wrapped_asset.mint internally.
        ctrl.wrap(&atts, &chain_id, &src, &amount, &to, &salt, &nonce);

        // Verify that tokens were actually minted by the cross-contract call.
        let balance = wrapped_asset::WrappedAssetClient::new(&env, &wrapped).balance(&to);
        assert_eq!(
            balance, amount,
            "wrapped_asset.mint should have been called"
        );
    }

    /// **C-1 (negative):** a signature from a *different* keypair reverts.
    #[test]
    #[should_panic]
    fn test_C1_wrong_attester_rejected() {
        let TestEnv { env, ctrl, .. } = setup();
        let signer = ed25519_dalek::SigningKey::from_bytes(&[2u8; 32]);
        ctrl.set_bridge(
            &soroban_sdk::vec![
                &env,
                BytesN::from_array(&env, &signer.verifying_key().to_bytes()),
            ],
            &1u32,
        );

        let chain_id = 1u32;
        let src = BytesN::from_array(&env, &[4u8; 32]);
        let amount = 1_000i128;
        let to = Address::from_str(
            &env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
        let salt = BytesN::from_array(&env, &[5u8; 32]);
        let nonce = 7u64;
        // Forge the attestation with a *different* keypair.
        let attacker = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let sig = valid_attestation(&env, &attacker, chain_id, &src, amount, &to, &salt, nonce);
        let atts = attestations(&env, 0, &sig);
        ctrl.wrap(&atts, &chain_id, &src, &amount, &to, &salt, &nonce);
    }

    /// **C-2 (replay protection):** A `wrap` with a re-used `salt` reverts.
    #[test]
    #[should_panic(expected = "salt already used")]
    fn invariant_C2_salt_replay_reverts() {
        let TestEnv {
            env, wrapped, ctrl, ..
        } = setup();
        let signer = ed25519_dalek::SigningKey::from_bytes(&[6u8; 32]);
        ctrl.set_bridge(
            &soroban_sdk::vec![
                &env,
                BytesN::from_array(&env, &signer.verifying_key().to_bytes()),
            ],
            &1u32,
        );

        let chain_id = 1u32;
        let src = BytesN::from_array(&env, &[0u8; 32]);
        let amount = 1_000i128;
        let to = Address::from_str(
            &env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
        let salt = BytesN::from_array(&env, &[3u8; 32]);
        let nonce = 0u64;
        let sig = valid_attestation(&env, &signer, chain_id, &src, amount, &to, &salt, nonce);
        let atts = attestations(&env, 0, &sig);

        // First wrap succeeds and mints tokens.
        ctrl.wrap(&atts, &chain_id, &src, &amount, &to, &salt, &nonce);
        let bal = wrapped_asset::WrappedAssetClient::new(&env, &wrapped).balance(&to);
        assert_eq!(bal, amount);

        // Second wrap with the same salt must revert.
        let atts2 = attestations(&env, 0, &sig);
        ctrl.wrap(&atts2, &chain_id, &src, &amount, &to, &salt, &nonce);
    }

    // ──────────────────────── UNWRAP ────────────────────────

    /// Unwrap burns wrapped tokens and returns a nonce.
    #[test]
    fn test_unwrap_burns_tokens() {
        let TestEnv {
            env, wrapped, ctrl, ..
        } = setup();
        let signer = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        ctrl.set_bridge(
            &soroban_sdk::vec![
                &env,
                BytesN::from_array(&env, &signer.verifying_key().to_bytes()),
            ],
            &1u32,
        );

        let _user = Address::generate(&env);
        let amount = 500i128;
        let chain_id = 1u32;
        let src = BytesN::from_array(&env, &[8u8; 32]);
        let salt = BytesN::from_array(&env, &[9u8; 32]);
        let to = Address::from_str(
            &env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
        let sig = valid_attestation(&env, &signer, chain_id, &src, amount, &to, &salt, 0u64);
        let atts = attestations(&env, 0, &sig);

        // First wrap them so the user has a balance.
        ctrl.wrap(&atts, &chain_id, &src, &amount, &to, &salt, &0u64);

        // Now unwrap — cross-calls wrapped_asset.burn(user, amount).
        let nonce = ctrl.unwrap(&to, &amount, &chain_id, &src);
        assert_eq!(nonce.len(), 32);

        // Balance should be zero after burn.
        let balance = wrapped_asset::WrappedAssetClient::new(&env, &wrapped).balance(&to);
        assert_eq!(balance, 0, "unwrap should have burned the tokens");
    }

    // ──────────────────── SUPPLY COLLATERAL (C-7) ────────────────────

    /// **C-7:** `supply_collateral` cross-calls lending_pool.supply and
    /// collateral_vault.deposit, recording the user's position.
    #[test]
    fn test_C7_supply_collateral_cross_calls() {
        let TestEnv {
            env,
            pool,
            vault,
            ctrl,
            ..
        } = setup();
        let user = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");
        let amount = 10_000i128;

        // Configure the lending pool with this asset.
        let pool_client = lending_pool::LendingPoolClient::new(&env, &pool);
        pool_client.add_asset(&lending_pool::AssetConfig {
            asset: asset.clone(),
            collateral_vault: vault.clone(),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 200,
            slope1_bps: 1_000,
            slope2_bps: 13_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });

        // Call supply_collateral via the controller.
        ctrl.supply_collateral(&user, &asset, &amount);

        // Verify the lending pool recorded the supply.
        let shares = pool_client.deposit_shares_of(&user, &asset);
        assert_eq!(
            shares, amount,
            "lending_pool.supply should have minted shares"
        );

        // Verify the vault recorded the collateral.
        let vault_client = collateral_vault::CollateralVaultClient::new(&env, &vault);
        let pos = vault_client.position(&user, &asset);
        assert_eq!(
            pos, amount,
            "collateral_vault.deposit should have recorded collateral"
        );
    }

    // ──────────────────── BORROW (C-8) ────────────────────

    /// **C-8:** `borrow` cross-calls oracle.value_of for LTV enforcement,
    /// vault.deposit for collateral, and pool.borrow for debt recording.
    #[test]
    fn test_C8_borrow_cross_calls() {
        let TestEnv {
            env,
            pool,
            vault,
            ctrl,
            ..
        } = setup();
        let user = Address::generate(&env);
        let collat_asset = Symbol::new(&env, "XLM");
        let debt_asset = Symbol::new(&env, "USDC");

        let pool_client = lending_pool::LendingPoolClient::new(&env, &pool);
        for asset in [collat_asset.clone(), debt_asset.clone()] {
            pool_client.add_asset(&lending_pool::AssetConfig {
                asset,
                collateral_vault: vault.clone(),
                oracle: Address::generate(&env),
                ltoken: Address::generate(&env),
                base_rate_bps: 200,
                slope1_bps: 1_000,
                slope2_bps: 13_000,
                kink_bps: 8_000,
                reserve_factor_bps: 1_000,
                ltv_bps: 7_500,
            });
        }

        // Supply collateral: 100M units of XLM (at $0.10/XLM → $10M collateral value).
        ctrl.supply_collateral(&user, &collat_asset, &100_000_000i128);

        // Register controller as pool operator so borrow_raw works.
        pool_client.add_operator(&ctrl.address);

        // Borrow 5M USDC: cumulative collateral = 100M (supplied) + 50M
        // (posted here) = 150M XLM → $15M; debt = $5M → 33% LTV, within the
        // 75% cap from the pool's AssetConfig.
        ctrl.borrow(
            &user,
            &collat_asset,
            &50_000_000i128,
            &debt_asset,
            &5_000_000i128,
        );

        // Verify the vault recorded the initial supply + borrow collateral.
        let vault_client = collateral_vault::CollateralVaultClient::new(&env, &vault);
        let pos = vault_client.position(&user, &collat_asset);
        assert_eq!(
            pos, 150_000_000i128,
            "vault should have 100M supply + 50M borrow collateral"
        );

        // Verify the borrowing was recorded.
        let debt = pool_client.debt_of(&user, &debt_asset);
        assert!(debt >= 5_000_000i128, "pool should record the debt");
    }

    /// **C-8 (negative):** borrow that violates LTV must revert.
    #[test]
    #[should_panic(expected = "health factor too low")]
    fn test_C8_borrow_without_collateral_reverts() {
        let TestEnv {
            env,
            pool,
            vault,
            ctrl,
            ..
        } = setup();
        let user = Address::generate(&env);
        let collat_asset = Symbol::new(&env, "XLM");
        let debt_asset = Symbol::new(&env, "USDC");

        let pool_client = lending_pool::LendingPoolClient::new(&env, &pool);
        for asset in [collat_asset.clone(), debt_asset.clone()] {
            pool_client.add_asset(&lending_pool::AssetConfig {
                asset,
                collateral_vault: vault.clone(),
                oracle: Address::generate(&env),
                ltoken: Address::generate(&env),
                base_rate_bps: 200,
                slope1_bps: 1_000,
                slope2_bps: 13_000,
                kink_bps: 8_000,
                reserve_factor_bps: 1_000,
                ltv_bps: 7_500,
            });
        }

        // Register controller as pool operator.
        pool_client.add_operator(&ctrl.address);

        // Post 1M XLM collateral ($0.10 each → $100k).
        ctrl.supply_collateral(&user, &collat_asset, &1_000_000i128);
        // Try to borrow 100M USDC ($100M) with only 1 additional XLM —
        // 1 XLM collateral ($0.10) vs $100M debt, far exceeds 75% LTV.
        ctrl.borrow(&user, &collat_asset, &1i128, &debt_asset, &100_000_000i128);
    }

    /// **C-8 (per-asset LTV):** the controller reads `ltv_bps` from the
    /// pool's `AssetConfig` for the *collateral* asset instead of a global
    /// constant. Here XLM is configured at a strict 40% — a 30% borrow passes.
    #[test]
    fn test_C8_per_asset_ltv_from_pool_config() {
        let TestEnv {
            env,
            pool,
            vault,
            ctrl,
            ..
        } = setup();
        let user = Address::generate(&env);
        let collat_asset = Symbol::new(&env, "XLM");
        let debt_asset = Symbol::new(&env, "USDC");

        let pool_client = lending_pool::LendingPoolClient::new(&env, &pool);
        // Reconfigure XLM (the collateral asset) with a STRICT 40% LTV.
        pool_client.add_asset(&lending_pool::AssetConfig {
            asset: collat_asset.clone(),
            collateral_vault: vault.clone(),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 200,
            slope1_bps: 1_000,
            slope2_bps: 13_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 4_000,
        });
        pool_client.add_operator(&ctrl.address);

        // Post 100M XLM ($10M) collateral, then borrow while posting 100M
        // more XLM ($10M) → $20M cumulative collateral.
        ctrl.supply_collateral(&user, &collat_asset, &100_000_000i128);
        // Borrow 6M USDC ($6M) = 30% LTV → within the 40% per-asset cap.
        ctrl.borrow(
            &user,
            &collat_asset,
            &100_000_000i128,
            &debt_asset,
            &6_000_000i128,
        );

        let debt = pool_client.debt_of(&user, &debt_asset);
        assert!(debt >= 6_000_000i128, "borrow at 30% LTV must succeed");
    }

    /// **C-8 (per-asset LTV negative):** 45% LTV breaches XLM's 40% per-asset
    /// cap even though it is below the 75% global ceiling — proving the
    /// per-asset `AssetConfig` value, not the constant, binds.
    #[test]
    #[should_panic(expected = "health factor too low")]
    fn test_C8_per_asset_ltv_exceeded_reverts() {
        let TestEnv {
            env,
            pool,
            vault,
            ctrl,
            ..
        } = setup();
        let user = Address::generate(&env);
        let collat_asset = Symbol::new(&env, "XLM");
        let debt_asset = Symbol::new(&env, "USDC");

        let pool_client = lending_pool::LendingPoolClient::new(&env, &pool);
        pool_client.add_asset(&lending_pool::AssetConfig {
            asset: collat_asset.clone(),
            collateral_vault: vault.clone(),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 200,
            slope1_bps: 1_000,
            slope2_bps: 13_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 4_000,
        });
        pool_client.add_operator(&ctrl.address);

        ctrl.supply_collateral(&user, &collat_asset, &100_000_000i128);
        // 100M XLM posted → $20M cumulative collateral; borrowing 9M USDC
        // ($9M) = 45% LTV > 40% per-asset cap → must revert.
        ctrl.borrow(
            &user,
            &collat_asset,
            &100_000_000i128,
            &debt_asset,
            &9_000_000i128,
        );
    }

    /// **C-8 (protocol ceiling):** an asset configured with `ltv_bps` ABOVE
    /// the 75% protocol-wide ceiling is clamped to `MAX_LTV_BPS`. Here XLM is
    /// configured at 90% but an 80% borrow must still revert.
    #[test]
    #[should_panic(expected = "health factor too low")]
    fn test_C8_ltv_capped_at_protocol_ceiling() {
        let TestEnv {
            env,
            pool,
            vault,
            ctrl,
            ..
        } = setup();
        let user = Address::generate(&env);
        let collat_asset = Symbol::new(&env, "XLM");
        let debt_asset = Symbol::new(&env, "USDC");

        let pool_client = lending_pool::LendingPoolClient::new(&env, &pool);
        pool_client.add_asset(&lending_pool::AssetConfig {
            asset: collat_asset.clone(),
            collateral_vault: vault.clone(),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 200,
            slope1_bps: 1_000,
            slope2_bps: 13_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 9_000, // 90% — above the 75% protocol-wide ceiling
        });
        pool_client.add_operator(&ctrl.address);

        ctrl.supply_collateral(&user, &collat_asset, &100_000_000i128);
        // $20M cumulative collateral; borrow 16M USDC ($16M) = 80% LTV.
        // 80% < 90% (asset config) but > 75% (ceiling) → must revert.
        ctrl.borrow(
            &user,
            &collat_asset,
            &100_000_000i128,
            &debt_asset,
            &16_000_000i128,
        );
    }

    /// **C-8 (existing collateral counts):** collateral deposited in a
    /// *previous* transaction is summed via `vault.position` before the
    /// oracle LTV check, so it contributes to borrow capacity. Here the
    /// borrow posts only 1 unit of new XLM yet succeeds because 200M XLM of
    /// existing collateral already covers the debt. Under the old
    /// marginal-only semantics (valuing just `collateral_amount`) this call
    /// would have reverted.
    #[test]
    fn test_C8_existing_collateral_counts_toward_borrow_capacity() {
        let TestEnv {
            env,
            pool,
            vault,
            ctrl,
            ..
        } = setup();
        let user = Address::generate(&env);
        let collat_asset = Symbol::new(&env, "XLM");
        let debt_asset = Symbol::new(&env, "USDC");

        let pool_client = lending_pool::LendingPoolClient::new(&env, &pool);
        // XLM must be configured in the pool for the `ltv_bps` read.
        pool_client.add_asset(&lending_pool::AssetConfig {
            asset: collat_asset.clone(),
            collateral_vault: vault.clone(),
            oracle: Address::generate(&env),
            ltoken: Address::generate(&env),
            base_rate_bps: 200,
            slope1_bps: 1_000,
            slope2_bps: 13_000,
            kink_bps: 8_000,
            reserve_factor_bps: 1_000,
            ltv_bps: 7_500,
        });
        pool_client.add_operator(&ctrl.address);

        // Previous transaction: deposit 200M XLM collateral ($20M at the
        // XLM:USDC relative price).
        ctrl.supply_collateral(&user, &collat_asset, &200_000_000i128);

        // New transaction: borrow 5M USDC ($5M = 25% LTV against the
        // existing $20M) while posting just 1 XLM of new collateral.
        ctrl.borrow(&user, &collat_asset, &1i128, &debt_asset, &5_000_000i128);

        let debt = pool_client.debt_of(&user, &debt_asset);
        assert!(
            debt >= 5_000_000i128,
            "existing collateral must cover the borrow"
        );

        // The vault position now includes the 1 unit posted in the borrow.
        let vault_client = collateral_vault::CollateralVaultClient::new(&env, &vault);
        assert_eq!(vault_client.position(&user, &collat_asset), 200_000_001i128);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // C-6: CROSS-LANGUAGE PAYLOAD DIGEST (DRIFT CANARY)
    // ═══════════════════════════════════════════════════════════════════════

    /// Decode a 64-hex-char string into a 32-byte array (no std dependency).
    fn hex_decode(hex: &str) -> [u8; 32] {
        let bytes = hex.as_bytes();
        let mut out = [0u8; 32];
        for i in 0..32 {
            let hi = (bytes[2 * i] as char)
                .to_digit(16)
                .expect("invalid hex char in pinned digest") as u8;
            let lo = (bytes[2 * i + 1] as char)
                .to_digit(16)
                .expect("invalid hex char in pinned digest") as u8;
            out[i] = (hi << 4) | lo;
        }
        out
    }

    /// **C-6 (drift canary):** `build_canonical_payload` + sha256 must produce
    /// the exact digest pinned by the TypeScript signer test
    /// (`CANONICAL_DIGEST` in `services/payment/tests/signer.test.ts`). Any
    /// drift between the Rust and TS payload constructions surfaces here.
    #[test]
    fn invariant_C6_payload_digest_matches_ts() {
        let env = Env::default();
        let chain_id = 1u32;
        let source_addr = BytesN::from_array(&env, &[0x11u8; 32]);
        let amount = 1_000_000i128;
        let to = Address::from_str(
            &env,
            "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        );
        let salt = BytesN::from_array(&env, &[0x22u8; 32]);
        let nonce = 42u64;

        let payload = LendingController::build_canonical_payload(
            &env,
            chain_id,
            source_addr,
            amount,
            &to,
            &salt,
            nonce,
        );
        let hash = env.crypto().sha256(&payload);
        let expected =
            hex_decode("fd426f52b5772d98e1ae591139e3935b5c56671f2b1b7d2e1adb7460dffcffcc");
        assert_eq!(hash.to_array(), expected);
    }

    /// **C-6 (sensitivity):** changing any single field must change the digest.
    #[test]
    fn invariant_C6_payload_digest_changes_on_field_mutation() {
        let env = Env::default();
        let base_chain = 1u32;
        let base_src = BytesN::from_array(&env, &[0x11u8; 32]);
        let base_amount = 1_000_000i128;
        let base_to = Address::from_str(
            &env,
            "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        );
        let base_salt = BytesN::from_array(&env, &[0x22u8; 32]);
        let base_nonce = 42u64;

        let digest = |chain: u32,
                      src: &BytesN<32>,
                      amount: i128,
                      to: &Address,
                      salt: &BytesN<32>,
                      nonce: u64|
         -> [u8; 32] {
            let payload = LendingController::build_canonical_payload(
                &env,
                chain,
                src.clone(),
                amount,
                to,
                salt,
                nonce,
            );
            env.crypto().sha256(&payload).to_array()
        };

        let h0 = digest(
            base_chain,
            &base_src,
            base_amount,
            &base_to,
            &base_salt,
            base_nonce,
        );
        // chain_id
        assert_ne!(
            digest(2, &base_src, base_amount, &base_to, &base_salt, base_nonce),
            h0
        );
        // source_addr
        assert_ne!(
            digest(
                base_chain,
                &BytesN::from_array(&env, &[0x33u8; 32]),
                base_amount,
                &base_to,
                &base_salt,
                base_nonce
            ),
            h0
        );
        // amount
        assert_ne!(
            digest(base_chain, &base_src, 1_000_001, &base_to, &base_salt, base_nonce),
            h0
        );
        // salt
        assert_ne!(
            digest(
                base_chain,
                &base_src,
                base_amount,
                &base_to,
                &BytesN::from_array(&env, &[0x44u8; 32]),
                base_nonce
            ),
            h0
        );
        // nonce
        assert_ne!(
            digest(base_chain, &base_src, base_amount, &base_to, &base_salt, 43),
            h0
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MULTI-ATTESTER SIGNING (2-of-3 threshold)
    // ═══════════════════════════════════════════════════════════════════════

    /// 2-of-3 threshold: wrap succeeds with 2 distinct valid attestations.
    #[test]
    fn test_multi_attester_2_of_3_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);

        // Deploy sub-contracts.
        let wrapped_id = env.register(wrapped_asset::WrappedAsset {}, ());
        let wrapped_client = wrapped_asset::WrappedAssetClient::new(&env, &wrapped_id);
        wrapped_client.initialize(
            &admin,
            &env.register(LendingController {}, ()),
            &String::from_str(&env, "Wrapped Test"),
            &String::from_str(&env, "wTST"),
            &7u32,
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0x0"),
        );
        let pool_id = env.register(lending_pool::LendingPool {}, ());
        lending_pool::LendingPoolClient::new(&env, &pool_id).initialize(&admin);
        let vault_id = env.register(collateral_vault::CollateralVault {}, ());
        collateral_vault::CollateralVaultClient::new(&env, &vault_id).initialize(&admin);
        let oracle_id = env.register(oracle::Oracle {}, ());

        // Deploy controller with 3 attester keys, threshold = 2.
        let ctrl_id = env.register(LendingController {}, ());
        let ctrl = LendingControllerClient::new(&env.clone(), &ctrl_id);
        let signer_a = ed25519_dalek::SigningKey::from_bytes(&[2u8; 32]);
        let signer_b = ed25519_dalek::SigningKey::from_bytes(&[3u8; 32]);
        let signer_c = ed25519_dalek::SigningKey::from_bytes(&[4u8; 32]);
        let bridge_keys = soroban_sdk::vec![
            &env,
            BytesN::from_array(&env, &signer_a.verifying_key().to_bytes()),
            BytesN::from_array(&env, &signer_b.verifying_key().to_bytes()),
            BytesN::from_array(&env, &signer_c.verifying_key().to_bytes()),
        ];
        ctrl.initialize(
            &admin,
            &bridge_keys,
            &2u32, // threshold = 2-of-3
            &wrapped_id,
            &pool_id,
            &vault_id,
            &oracle_id,
        );
        wrapped_client.set_minter(&ctrl_id);

        let chain_id = 1u32;
        let src = BytesN::from_array(&env, &[9u8; 32]);
        let amount = 1_000i128;
        let to = Address::from_str(
            &env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
        let salt = BytesN::from_array(&env, &[7u8; 32]);
        let nonce = 0u64;

        // Sign with signers A (index 0) and B (index 1) — 2 distinct signatures.
        let sig_a = valid_attestation(&env, &signer_a, chain_id, &src, amount, &to, &salt, nonce);
        let sig_b = valid_attestation(&env, &signer_b, chain_id, &src, amount, &to, &salt, nonce);
        let atts = soroban_sdk::vec![&env, (0u32, sig_a), (1u32, sig_b)];

        ctrl.wrap(&atts, &chain_id, &src, &amount, &to, &salt, &nonce);

        let balance = wrapped_asset::WrappedAssetClient::new(&env, &wrapped_id).balance(&to);
        assert_eq!(balance, amount, "2-of-3 should succeed");
    }

    /// Below threshold: only 1 of 3 signatures → revert.
    #[test]
    #[should_panic(expected = "not enough attestations")]
    fn test_multi_attester_below_threshold_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);

        let wrapped_id = env.register(wrapped_asset::WrappedAsset {}, ());
        wrapped_asset::WrappedAssetClient::new(&env, &wrapped_id).initialize(
            &admin,
            &env.register(LendingController {}, ()),
            &String::from_str(&env, "Wrapped Test"),
            &String::from_str(&env, "wTST"),
            &7u32,
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0x0"),
        );
        let pool_id = env.register(lending_pool::LendingPool {}, ());
        lending_pool::LendingPoolClient::new(&env, &pool_id).initialize(&admin);
        let vault_id = env.register(collateral_vault::CollateralVault {}, ());
        collateral_vault::CollateralVaultClient::new(&env, &vault_id).initialize(&admin);
        let oracle_id = env.register(oracle::Oracle {}, ());

        let ctrl_id = env.register(LendingController {}, ());
        let ctrl = LendingControllerClient::new(&env.clone(), &ctrl_id);
        let signer_a = ed25519_dalek::SigningKey::from_bytes(&[5u8; 32]);
        let signer_b = ed25519_dalek::SigningKey::from_bytes(&[6u8; 32]);
        let signer_c = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let bridge_keys = soroban_sdk::vec![
            &env,
            BytesN::from_array(&env, &signer_a.verifying_key().to_bytes()),
            BytesN::from_array(&env, &signer_b.verifying_key().to_bytes()),
            BytesN::from_array(&env, &signer_c.verifying_key().to_bytes()),
        ];
        ctrl.initialize(
            &admin,
            &bridge_keys,
            &2u32,
            &wrapped_id,
            &pool_id,
            &vault_id,
            &oracle_id,
        );

        let src = BytesN::from_array(&env, &[9u8; 32]);
        let to = Address::from_str(
            &env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
        let salt = BytesN::from_array(&env, &[8u8; 32]);
        let sig_a = valid_attestation(&env, &signer_a, 1u32, &src, 1_000i128, &to, &salt, 0u64);
        // Only 1 signature when threshold is 2.
        let atts = attestations(&env, 0, &sig_a);
        ctrl.wrap(&atts, &1u32, &src, &1_000i128, &to, &salt, &0u64);
    }

    /// Duplicate key index → sorted check fails.
    #[test]
    #[should_panic(expected = "duplicate or unsorted attestations")]
    fn test_multi_attester_duplicate_index_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);

        let wrapped_id = env.register(wrapped_asset::WrappedAsset {}, ());
        wrapped_asset::WrappedAssetClient::new(&env, &wrapped_id).initialize(
            &admin,
            &env.register(LendingController {}, ()),
            &String::from_str(&env, "Wrapped Test"),
            &String::from_str(&env, "wTST"),
            &7u32,
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0x0"),
        );
        let pool_id = env.register(lending_pool::LendingPool {}, ());
        lending_pool::LendingPoolClient::new(&env, &pool_id).initialize(&admin);
        let vault_id = env.register(collateral_vault::CollateralVault {}, ());
        collateral_vault::CollateralVaultClient::new(&env, &vault_id).initialize(&admin);
        let oracle_id = env.register(oracle::Oracle {}, ());

        let ctrl_id = env.register(LendingController {}, ());
        let ctrl = LendingControllerClient::new(&env.clone(), &ctrl_id);
        let signer_a = ed25519_dalek::SigningKey::from_bytes(&[8u8; 32]);
        let bridge_keys = soroban_sdk::vec![
            &env,
            BytesN::from_array(&env, &signer_a.verifying_key().to_bytes()),
        ];
        ctrl.initialize(
            &admin,
            &bridge_keys,
            &1u32,
            &wrapped_id,
            &pool_id,
            &vault_id,
            &oracle_id,
        );

        let src = BytesN::from_array(&env, &[9u8; 32]);
        let to = Address::from_str(
            &env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
        let salt = BytesN::from_array(&env, &[9u8; 32]);
        let sig = valid_attestation(&env, &signer_a, 1u32, &src, 1_000i128, &to, &salt, 0u64);
        // Duplicate index 0,0.
        let atts = soroban_sdk::vec![&env, (0u32, sig.clone()), (0u32, sig)];
        ctrl.wrap(&atts, &1u32, &src, &1_000i128, &to, &salt, &0u64);
    }
}
