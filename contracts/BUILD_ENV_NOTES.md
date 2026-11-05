# Build Environment Notes

> **Status (2026-07): RESOLVED.** The Soroban workspace now builds, lints, and
> tests cleanly on the **stable** Rust toolchain with **soroban-sdk 27.0.6**
> (pinned as `soroban-sdk = "=27.0.6"` in `contracts/Cargo.toml`). All CI
> commands pass: `cargo fmt --all -- --check`,
> `cargo check --workspace --locked --target wasm32v1-none --release`,
> `cargo clippy --workspace --all-targets --locked -- -D warnings`, and
> `cargo test --workspace --locked`.
>
> The committed `contracts/Cargo.lock` resolves **both** `ed25519-dalek 2.2.0`
> and `3.0.0` (and both `rand_core 0.6.4` and `0.10.1`) side by side — the old
> conflict is resolved by version isolation plus a pinned lockfile, not by
> forcing a single version. The exact graph is listed in
> [`docs/verification-status.md`](../docs/verification-status.md).

## History: what used to be broken

The workspace previously pinned `soroban-sdk = "21.0.0"`, which transitively
pulled in two `ed25519-dalek` majors with **incompatible** `rand_core`
requirements:

| Path                                | Crate                | Requires                                                                            |
| ----------------------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `soroban-env-host 21.2.1` testutils | `ed25519-dalek 1.x`  | `rand_core 0.5.x` or `0.6.0–0.6.3` (uses blanket `CryptoRng` impl removed in 0.6.4) |
| `soroban-sdk 21.x` direct           | `ed25519-dalek 2.x`  | `rand_core ^0.6.4`                                                                  |
| `soroban-env-host 21.2.1`           | `elliptic-curve` ... | `rand_core ^0.6.4`                                                                  |

`rand_core 0.6.4` (mid-2024) removed a blanket `CryptoRng` impl that
`ed25519-dalek 1.x` relied on, so the 21.x tree could not resolve a single
`rand_core` version. A secondary issue: a fresh `cargo check` against current
crates.io also pulled `cpufeatures 0.3.0` / `zeroize 1.9.0`, whose manifests use
the `edition2024` Cargo feature — unparseable by Rust 1.81.

## The fix (implemented)

1. **Bump to `soroban-sdk 27.x`** (the path-forward "Option A" documented
   below). 27.x bundles a modern `soroban-env-host` with no conflicting
   `ed25519-dalek 1.x` testutils path, resolving the `rand_core` split outright.
   `soroban-token-sdk` / `stellar-asset-sdk` were removed from the workspace
   deps — no contract uses them, and their transitive constraints were part of
   the original resolution failures.
2. **Use the `wasm32v1-none` target, not `wasm32-unknown-unknown`.** On Rust
   1.82+ the `wasm32-unknown-unknown` target enables `reference-types` /
   `multi-value` features that soroban-sdk 27's `build.rs` rejects; the
   Soroban-native target is `wasm32v1-none` (available with Rust 1.84+).
3. **Toolchain: pinned to `1.91.0`** (the soroban-sdk 27 MSRV; current stable
   also works). The CI job pins `dtolnay/rust-toolchain@1.91.0` with
   `targets: wasm32v1-none, components: rustfmt, clippy` — keep the `components`
   input as a single scalar (block style) so both components are installed.
4. **Contract API migrations for sdk 27:** `env.storage()` is now a method
   (`env.storage().instance()`), `env.events().publish(...)` is replaced by
   `#[contractevent]` types with a `.publish(&env)` method, test utils use
   `Address::generate` and `env.register(X, ())`, and `ledger().sequence()`
   returns `u32` (widened explicitly where `u64` is stored). See the git log for
   the per-contract diffs.
5. **Clippy config:** `clippy.toml` now contains only valid _settings_ (`msrv`,
   `too-many-arguments-threshold`). Lint _levels_ are not valid `clippy.toml`
   keys — the old `deny`/`warn`/`allow` top-level arrays caused clippy to abort
   on every run. Levels are enforced via `-D warnings` in CI plus
   `#![allow(...)]` crate attributes where a lint is not actionable for on-chain
   code (e.g. `non_snake_case` for invariant tests named after doc IDs).
6. **`Cargo.lock` is committed** with the resolved 27.x graph so a future
   crates.io drift cannot re-break resolution.

## What this repo does now

- **`.github/workflows/ci.yml`** runs, per commit/PR:
  - `cargo fmt --all -- --check`
  - `cargo check --workspace --target wasm32v1-none --release`
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo test --workspace`

## Notes for Soroban authors

- Contract entry points intentionally panic on invalid state (e.g. "already
  initialized"); the host surfaces these as transaction failures.
- Financial math uses `checked_*` explicitly; keep it that way.
- When adding a new contract, remember: `env.storage()` is a method call, events
  are `#[contractevent]` types, and wasm builds target `wasm32v1-none`.
