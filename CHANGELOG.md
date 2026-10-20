# Changelog

All notable changes to StellarPay are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- **Fixed `lending_pool` interest accrual never running.** `add_asset` did not
  seed the `LastAccrual` clock and `accrue_interest` treats a missing key as
  "now", so the first accrual always no-opped and the borrow index never grew.
  `add_asset` now stores the current ledger sequence; the new
  `invariant_L8_accrue_does_not_change_total_borrow` regression test proves
  the index grows while `total_borrow` stays constant.
- **Bridge mint queue hardening** (`services/payment`): `Locked` *and* `Burned`
  source events are now watched (previously burned canonical tokens were never
  wrapped); amounts outside `[1, i64::MAX]` are rejected at enqueue (the TS
  signer wraps while the on-chain controller saturates, so larger amounts can
  never verify); requests are dead-lettered after 10 failed attempts instead of
  blocking the queue forever; a `salt already used` submit error is treated as
  already-minted (submit-timeout idempotency); Stellar watcher only records
  contract-call ops as unwraps.
- **Configurable mint rate limit** (`lending_controller.set_mint_rate_limit`,
  admin-only) with the previous default preserved; C-3 now has a dedicated
  test (`invariant_C3_mint_rate_limit_enforced`).
- **Closed invariant C-1** (ed25519 attestation verification for
  `lending_controller.wrap`): `wrap` now rejects any attestation that is not a
  valid ed25519 signature over `sha256(build_canonical_payload)` from the
  registered bridge pubkey. `require_bridge` wires `env.crypto().ed25519_verify`
  (previously a documented accept-all stub). Added `test_C1_bridge_attestation_verified`
  and `test_C1_wrong_attester_rejected` (real keypairs via `ed25519-dalek`
  dev-dep), and re-enabled `invariant_C2_salt_replay_reverts` now that a valid
  signature can reach the replay branch.
- **Closed invariant B-7** (EIP-712 for `Bridge.release`): the on-chain
  digest is now a proper EIP-712 typed-data hash
  (`keccak256("\x19\x01" || domainSeparator || structHash)`) using
  `OpenZeppelin`'s `EIP712Upgradeable` and a pinned
  `RELEASE_TYPEHASH = keccak256("Release(address token,address recipient,uint256 amount,bytes32 stellarTxHash,uint256 nonce)")`.
  This prevents cross-chain and cross-contract replay attacks. Off-chain
  counterpart: `services/payment/src/attest/signer.ts` → `signEvmRelease()`. A
  regression test (`release rejects signatures signed for a different
  domain (B-7)`) in `contracts/test/Bridge.test.ts` proves the
  domain binding works.

### Added
- **Prometheus + Grafana monitoring**: every TS service (bridge, relayer,
  indexer, api) exposes `/metrics` with real counters; scrape + alerting
  configs, a provisioned Grafana dashboard, docker-compose services, and k8s
  manifests live in `infra/monitoring/` and
  `infra/kubernetes/08-monitoring.yaml` (see `docs/monitoring.md`).
- **Redis-backed API rate limiting** (`apps/api`): shared fixed-window limiter
  via `REDIS_URL` with in-memory fallback, per-route 60/min cap on quote
  endpoints, WebSocket per-IP/message caps, rate-limit headers, and unit tests
  (`src/tests/rate-limiter.test.ts`).
- Invariant tests L-7 (`deposit shares never negative`), L-8 (accrual leaves
  `total_borrow` unchanged), C-5 (`set_paused` admin-only, selective-auth
  mock), W-3…W-6 (unauthorized burn, minter-only mint, one-shot init, positive
  amounts), and B-6 pause coverage for `release`/`burn` in `Bridge.test.ts`.
- `services/payment/src/validation.ts` with shared source-address encoding and
  mint-path validation helpers (+ unit tests).
- Root eslint config now parses TypeScript (`@typescript-eslint` parser +
  plugin) — `pnpm lint` no longer crashes on `.ts` files.
- `SECURITY.md` and `CHANGELOG.md` at the repository root.
- `.github/CODEOWNERS` for default reviewers.
- `.github/dependabot.yml` for npm, cargo, and GitHub Actions ecosystems.
- `contracts/rustfmt.toml` and `clippy.toml` for consistent Rust style.
- `contracts/rust-toolchain.toml` pinning the Soroban workspace
  to Rust 1.81.0 (avoids the `zeroize 1.9.0` `edition2024` requirement
  that forces Rust >= 1.85). **Removed in the sdk-27 migration** — the
  toolchain is now pinned by CI (`dtolnay/rust-toolchain@1.91.0`, the
  soroban-sdk 27 MSRV); `rust-toolchain.toml` no longer exists in the
  repo. See `contracts/BUILD_ENV_NOTES.md`.
- `docs/invariants.md` documenting protocol invariants for auditors.
- `contracts/BUILD_ENV_NOTES.md` documenting the known
  `cargo test --workspace` dep-resolution blocker and the two real
  paths forward (bump `soroban-sdk` to 22+, or use Docker with a
  pre-baked `Cargo.lock`).
- 17 `invariant_*` tests in `contracts/contracts/*/src/lib.rs`
  (V-1/V-2/V-3/V-5, C-2/C-4, L-1..L-6/L-9, O-1/O-2/O-3, Q-3/Q-4) and
  `test_TODO_*` stubs (C-1, L-10, Q-1/Q-2) for the documented security
  gaps. The suite executes and passes on the migrated toolchain (Rust
  1.91.0, soroban-sdk 27.0.6, `wasm32v1-none`): 30 passed, 0 failed,
  with only the `test_TODO_*` stubs for the still-open gaps — L-10 and
  Q-1/Q-2 — `#[ignore]`d (C-1 and C-2 are now implemented and tested); see
  `contracts/BUILD_ENV_NOTES.md`.
- Expanded EVM `Bridge.test.ts` with release, threshold, and pause tests.
- Expanded `sdk` tests with config, supply, and chain-id coverage.
- **API integration test suite** (`api/`): vitest + testcontainers
  Postgres 16-alpine. 23 tests across 3 files cover `/v1/markets` and
  `/v1/markets/:asset` (6 tests — empty, kinked-rate pre/post 0.8,
  repay subtraction, single-asset, no-events, URL-decoded asset),
  `/v1/positions/:user` and `/v1/health-factor/:user` (8 tests — empty,
  multi-asset, repay/withdraw subtraction, cross-user isolation, all
  3 hf bands + underflow guard), and `/v1/quote/wrap` and
  `/v1/quote/unwrap` (6 tests — valid, all enum chains, missing fields,
  invalid chain). One testcontainer per suite (~10s startup) with
  `prisma db push` to materialise the schema. `Docker` is required.
  See `api/README.md` → “Testing”.

### Changed
- `apps/web`: bump `next` 14.2.4 → 14.2.25 (patches the middleware auth
  bypass CVE-2025-29927; the app ships no middleware so it was not
  exploitable).
- `turbo.json`: the `test` task now depends on `prisma:generate`, so
  `pnpm test` works on a fresh checkout (apps/api tests previously failed
  with "@prisma/client did not initialize yet").
- `services/payment` Prisma schema: `MintRequest` gains `attempts` and
  `lastError` for dead-letter accounting.
- `.github/workflows/ci.yml` pins `dtolnay/rust-toolchain@1.91.0` in
  the `stellar-contracts` job (was `@stable`, which would also fail
  on 1.97+; the earlier `@1.81.0` pin was superseded as part of the
  soroban-sdk 27 migration).
- `contracts/contracts/Bridge.sol` now uses `OpenZeppelin`'s `ECDSA` and
  `MessageHashUtils` libraries instead of a custom signature-recovery
  implementation.
- `packages/sdk/src/client.ts` adds the missing `supplyCollateral` method so it
  matches the documented API and `packages/sdk/README.md`.
- `services/payment/src/attest/signer.ts` adds `STELLARPAY_EIP712_DOMAIN`,
  `RELEASE_EIP712_TYPES`, and `signEvmRelease()` (uses
  `ethers.Wallet.signTypedData`) to produce the matching secp256k1
  signatures consumed by `Bridge.release`.
- `@openzeppelin/hardhat-upgrades@^3.9.0` dev dep + `evmVersion: "cancun"`
  in `hardhat.config.ts` (OZ 5.x's `Bytes.sol` uses the `mcopy` opcode,
  EIP-5656 in the Cancun upgrade).
- `contracts/contracts/Bridge.sol` now inherits OZ 5.x's
  `ReentrancyGuard` (ERC-7201 namespaced storage) in place of the
  removed `ReentrancyGuardUpgradeable`. The new guard is
  `@custom:stateless` and does not shift the contract's linear storage
  layout, so this change is storage-layout-safe for new deployments.
- `contracts/scripts/deploy.ts` now uses `upgrades.deployProxy`
  (previously called `initialize()` directly on the implementation,
  which fails with `InvalidInitialization()` in OZ 5.x). New env vars
  `PROXY_ADMIN_ADDRESS` and `OWNER_ADDRESS` let production deploys
  point the ERC-1967 admin and the `Ownable` owner at a multisig; the
  script transfers both ownerships post-deploy and prints a warning if
  either is left as the deployer EOA on a non-hardhat network.
- `contracts/test/Bridge.test.ts` `deploy()` helper now uses
  `upgrades.deployProxy` for the same reason; added a B-7 cross-domain
  replay test that forges sigs against a fake bridge address and
  confirms the on-chain EIP-712 wrapping reverts with
  `Bridge__NotAttester`.
- `api/src/index.ts` now exports a `buildApp({ corsOrigin?, logger? })`
  factory that returns the configured Fastify instance without calling
  `.listen()`, so the integration test suite can import it in-process
  and use `app.inject()` instead of a real port. The production
  `main()` is now guarded with `if (import.meta.main)` so it only runs
  when the file is the process entrypoint (an earlier
  `fileURLToPath(...).href` pattern was a bug — it was always
  `undefined` and `main()` was dead code).
- `api/package.json` swaps the phantom `fastify-cors@^9.0.1` (which
  does not exist on the registry) for the official scoped
  `@fastify/cors@^9.0.1`. Also pins `testcontainers` and
  `@testcontainers/postgresql` to `^10.13.0` to avoid a 10/12
  major-version mismatch, adds the `prisma@^5.16.1` CLI to match
  `@prisma/client`, and removes the now-dead `@types/cors`.

## [0.1.0] — 2026-01-15

### Added
- Initial scaffold of StellarPay.
- Soroban contracts: `wrapped_asset`, `oracle`, `collateral_vault`,
  `lending_pool`, `liquidation`, `lending_controller`.
- EVM contracts: `Bridge.sol` (upgradeable, 2-of-N attester multisig),
  `WrappedToken.sol`, `MockERC20.sol`.
- Off-chain services: `bridge`, `relayer`, `indexer`, `api`.
- TypeScript SDK: `sdk` (`@stellar-payment-gateway/sdk`).
- Next.js 14 dashboard: landing, dashboard, bridge, lend, liquidations.
- K8s manifests and Docker Compose for local development.
- Documentation: architecture, security, deployment, polyrepo, API, SDK.
