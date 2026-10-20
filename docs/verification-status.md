# Verification Status

> A record of **what was actually executed** for the current pass, in which
> environment, and what could not be executed and why. This exists so that a
> reviewer does not have to guess whether a green check was seen or merely
> assumed.

**Pass date:** 2026-10-20 **Environment:** Codespace container (Linux, x86_64)

| Component          | Version in this environment | Version pinned by the repo                         |
| ------------------ | --------------------------- | -------------------------------------------------- |
| Node.js            | v24.21.0                    | CI: 22 (`NODE_VERSION`)                            |
| pnpm               | 10.0.0                      | `packageManager: pnpm@10.0.0`                      |
| npm                | 11.19.0                     | used only by `contracts/`                          |
| Rust / cargo       | **not installed**           | CI: 1.91.0 + `wasm32v1-none`                       |
| Docker             | **not available**           | optional (Postgres / Redis for local services)     |
| `slither-analyzer` | **not installed**           | CI: `crytic/slither-action@v0.4.2`, slither 0.11.4 |

## Executed and passing

| Command (run from the repository root)                                                                     | Result                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                           | ✅ `Already up to date` — `pnpm-lock.yaml` is in sync with every workspace manifest          |
| `pnpm exec prettier --check "**/*.{json,md,yml,yaml}" "!**/node_modules/**" "!**/dist/**" "!**/target/**"` | ✅ no files reported                                                                         |
| `pnpm typecheck`                                                                                           | ✅ 12/12 turbo tasks                                                                         |
| `pnpm lint`                                                                                                | ✅ 2/2 turbo tasks (0 errors; 5 warnings from `bridge` and `dashboard`)                      |
| `pnpm test`                                                                                                | ✅ 35/35 turbo tasks — 56 tests: api 27, bridge 17, sdk 7, dashboard 3, indexer 1, relayer 1 |
| `pnpm --filter @stellar-payment-gateway/{bridge,relayer,indexer,api,sdk} exec prisma generate`             | ✅ 4 Prisma clients generated                                                                |
| `pnpm --filter @stellar-payment-gateway/{bridge,relayer,indexer,api,sdk} exec tsc --noEmit`                | ✅ clean                                                                                     |
| `pnpm --filter @stellar-payment-gateway/sdk build`                                                         | ✅ `dist/` emitted                                                                           |
| `pnpm --filter @stellar-payment-gateway/dashboard exec tsc --noEmit`                                       | ✅ clean                                                                                     |
| `pnpm --filter @stellar-payment-gateway/dashboard test`                                                    | ✅ 3 tests                                                                                   |
| `pnpm --filter @stellar-payment-gateway/dashboard exec next lint`                                          | ✅ clean (warnings only)                                                                     |
| `pnpm --filter @stellar-payment-gateway/dashboard build`                                                   | ✅ Next.js production build succeeded                                                        |
| `cd contracts && npm ci`                                                                                   | ✅ lockfile in sync with `contracts/package.json`                                            |
| `cd contracts && npx hardhat compile`                                                                      | ✅ compiled (Solidity 0.8.24, optimizer + `viaIR`)                                           |
| `cd contracts && npx hardhat test`                                                                         | ✅ **17 passing**                                                                            |
| `npm ci --dry-run` in the repository root, `packages/sdk`, `apps/api`                                      | ✅ all three npm lockfiles in sync with their manifests                                      |

## Not executable here — and exactly why

| Check                                                                   | Blocker                                                                                                     | How to run it                                                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `cargo fmt --all -- --check`                                            | No Rust toolchain in the container (`rustc: command not found`)                                             | `rustup toolchain install 1.91.0 --target wasm32v1-none` then `cd contracts && cargo fmt --all -- --check`    |
| `cargo check --workspace --locked --target wasm32v1-none --release`     | same                                                                                                        | same, with the target installed                                                                               |
| `cargo clippy --workspace --all-targets --locked -- -D warnings`        | same                                                                                                        | same                                                                                                          |
| `cargo test --workspace --locked`                                       | same — **113 `#[test]` functions** (42 named `invariant_*`) exist in the tree but were not executed here    | same                                                                                                          |
| Slither static analysis                                                 | `slither-analyzer` is not installed and the PyPI install requires network + Python ≥ 3.10 for ≥ 0.11.5      | `pipx install slither-analyzer==0.11.4` then `slither contracts/lending/evm --filter-paths "node_modules      | openzeppelin"` |
| Docker-backed integration flows (`infra/docker/docker-compose.dev.yml`) | No Docker daemon in the container                                                                           | `docker compose -f infra/docker/docker-compose.dev.yml up -d`                                                 |
| Live dashboard / API                                                    | `app.spg.xyz` and `api.spg.xyz` have **no DNS record**; `spg.xyz` resolves to an unrelated third-party site | Deploy `apps/web` and `apps/api` and configure the DNS — until then the repository does not claim a live demo |

## External facts re-checked during this pass

| Claim                                                                  | Method                                                                            | Outcome                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The 7 Soroban contracts were deployed to Stellar testnet               | Horizon testnet API: `GET /accounts/{admin}/operations?type=invoke_host_function` | ✅ The admin account `GA6ZXO…PJEZY` exists and shows **6 `UploadContractWasm` + 7 `CreateContract` + 7 `InvokeContract`** host-function operations on **2026-08-09**, all with `transaction_successful: true`                                                                                                                  |
| The contract IDs in `DEPLOYMENTS.md` are the ones deployed in that run | CAP-46 contract-id derivation from the recorded salts                             | ⚠️ **Not confirmed** — the derivation from the on-chain salts does not reproduce the seven IDs in `DEPLOYMENTS.md` / `packages/sdk/src/manifest.json`, and Horizon's `/contracts/{id}` returns 404 for all seven. The maintainer should re-verify with `stellar contract info` or the Soroban RPC before publishing them again |
| `app.spg.xyz` is a live demo                                           | DNS lookup                                                                        | ❌ **No DNS record** — the README no longer advertises a live demo                                                                                                                                                                                                                                                             |
| `api.spg.xyz` is a live API                                            | DNS lookup                                                                        | ❌ No DNS record                                                                                                                                                                                                                                                                                                               |
| `spg.xyz` is the project domain                                        | HTTPS fetch                                                                       | ⚠️ Resolves, but serves "Stephenson Property Group LLC                                                                                                                                                                                                                                                                         | rentals" — an unrelated third-party site. `stellar.toml` now points `ORG_URL` at this repository |

## Lockfile policy

| Lockfile                                                                            | Owner                                                                    | Used by                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `pnpm-lock.yaml`                                                                    | pnpm workspace (root + 19 workspace packages)                            | CI `pnpm install --frozen-lockfile`; `packageManager: pnpm@10.0.0`                 |
| `contracts/package-lock.json`                                                       | npm project (`contracts/` is deliberately **not** in the pnpm workspace) | CI `npm ci` for the EVM job (`cache-dependency-path: contracts/package-lock.json`) |
| `package-lock.json`, `packages/sdk/package-lock.json`, `apps/api/package-lock.json` | npm mirrors kept in sync for tooling that shells out to npm              | `npm ci --dry-run` verified in sync                                                |

When you change a `package.json`, regenerate the matching lockfile
(`pnpm install` for the workspace, `npm install --package-lock-only` for the npm
projects) and commit both.

## Lockfile drift found and fixed (2026-10-20)

The three npm lockfiles that mirror the pnpm workspace were **out of sync with
their manifests** in `main` (at `20f4523`). `npm ci` therefore failed with
`EUSAGE` in every one of them, while `pnpm install --frozen-lockfile` was
unaffected (it reads `pnpm-lock.yaml`).

| Lockfile                         | Drift in `main`                                                                                                                                                                              | `npm ci` error (verbatim)                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package-lock.json` (root)       | `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` were declared in `package.json` but absent from the lockfile                                                              | `npm ci can only install packages when your package.json and package-lock.json … are in sync`                                                    |
| `packages/sdk/package-lock.json` | resolved `@stellar/stellar-sdk@12.3.0` against the required `^16.3.1`; `@stellar/js-xdr`, `bignumber.js`, `eventsource`, `commander`, `@noble/ed25519`, `@noble/hashes` all stale or missing | `Invalid: lock file's @stellar/stellar-sdk@12.3.0 does not satisfy @stellar/stellar-sdk@16.3.1` · `Missing: @noble/ed25519@3.2.0 from lock file` |
| `apps/api/package-lock.json`     | `ioredis` and `prom-client` (and the whole `redis` dependency chain) were missing                                                                                                            | `Missing: ioredis@5.11.1 from lock file` · `Missing: prom-client@15.1.3 from lock file`                                                          |

**Fix:** each lockfile was regenerated with `npm install --package-lock-only`
(no dependency versions were changed by hand) and re-verified with
`npm ci --dry-run` in all four npm projects (`.`, `packages/sdk`, `apps/api`,
`contracts`) — all four now exit 0.

**Remaining policy question (not a defect):** the root, `packages/sdk` and
`apps/api` npm lockfiles duplicate `pnpm-lock.yaml` for a subset of the
workspace. Nothing in CI installs them (CI uses `pnpm install --frozen-lockfile`
for the workspace and `npm ci` only inside `contracts/`). They are kept in sync
because some tooling shells out to npm. If that duplication is unwanted, the
cleanest change is to delete the three mirrors and add a CI step that fails when
a `package.json` changes without its mirror being regenerated. Contributors: see
the lockfile table in [`.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md).

## Rust dependency resolution (the `ed25519-dalek` / `ChaCha20Rng` history)

The historical failure was a `rand_core` split between `ed25519-dalek 1.x`
(pulled by the old `soroban-env-host` test utilities) and `ed25519-dalek 2.x`
(pulled by `soroban-sdk`). The current, committed resolution in
`contracts/Cargo.lock` is:

| Crate              | Version                                      | Pulled in by                                                                     |
| ------------------ | -------------------------------------------- | -------------------------------------------------------------------------------- |
| `soroban-sdk`      | 27.0.6 (`=27.0.6` in `contracts/Cargo.toml`) | workspace contracts                                                              |
| `soroban-env-host` | 27.0.1                                       | `soroban-sdk` (test utilities)                                                   |
| `ed25519-dalek`    | 2.2.0                                        | `soroban-env-host` → `elliptic-curve` / `ecdsa`                                  |
| `ed25519-dalek`    | 3.0.0                                        | `soroban-sdk` (direct)                                                           |
| `rand_core`        | 0.6.4                                        | `rand 0.8.7` → `rand_chacha 0.3.1` (`ChaCha20Rng`) — the `soroban-env-host` path |
| `rand_core`        | 0.10.1                                       | the `ed25519-dalek 3.x` / `signature 3.x` path                                   |

Both `ed25519-dalek` majors and both `rand_core` majors coexist in one committed
lockfile, so the old "no single `rand_core` version" conflict is resolved by
**version isolation**, not by forcing a single version. The solution is
reproducible because `contracts/Cargo.lock` is committed and CI builds with
`--locked`. `soroban-token-sdk` / `stellar-asset-sdk` were removed from the
workspace dependencies because no contract uses them and their transitive
constraints were part of the original failure — see
[`contracts/BUILD_ENV_NOTES.md`](../contracts/BUILD_ENV_NOTES.md).
