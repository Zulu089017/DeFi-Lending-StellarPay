# StellarPay

<p align="center">
  <img src="public/logo.svg" alt="StellarPay logo" width="160" />
</p>

> A cross-chain lending protocol settled on Stellar: wrapped assets, an
> over-collateralised money market, and a permissionless liquidation engine —
> implemented in Soroban with an invariant-driven test suite and reproducible
> CI.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-testnet%20|%20pre--audit-yellow.svg)](docs/security.md)
[![Audit](https://img.shields.io/badge/Audit-planned_lightgrey.svg)](docs/security.md#audit)
[![Network](https://img.shields.io/badge/network-Stellar%20testnet-7D3FE4.svg)](DEPLOYMENTS.md)
[![Soroban](https://img.shields.io/badge/Soroban-27.0.6-blueviolet.svg)](contracts/Cargo.toml)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.24-363636.svg)](contracts/hardhat.config.ts)
[![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088FF.svg)](.github/workflows/ci.yml)
[![Code style: rustfmt](https://img.shields.io/badge/code%20style-rustfmt-orange.svg)](contracts/rustfmt.toml)
[![Turborepo](https://img.shields.io/badge/build-Turborepo-EF4444.svg)](turbo.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6.svg)](packages/sdk/package.json)
[![Rust](https://img.shields.io/badge/Rust-1.91-000000.svg)](contracts/Cargo.toml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](.github/CONTRIBUTING.md)

> ⚠️ **Project status: testnet, pre-audit, unaudited.** The Soroban contracts,
> the EVM bridge, and the off-chain services are functional and covered by
> automated tests, but **no external security audit has been performed**. There
> is no mainnet deployment and no live hosted dashboard. **Do not deposit real
> assets.** See
> [Security, risk and audit status](#security-risk-and-audit-status).

---

## 📖 Table of contents

- [What StellarPay is](#what-stellarpay-is)
- [Who it is for](#who-it-is-for)
- [Feature overview](#feature-overview)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Supported networks](#supported-networks)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Environment configuration](#environment-configuration)
- [Running contracts, services and the dashboard](#running-contracts-services-and-the-dashboard)
- [Reproducing a lending flow](#reproducing-a-lending-flow)
- [Tests and CI status](#tests-and-ci-status)
- [Security, risk and audit status](#security-risk-and-audit-status)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [Documentation index](#documentation-index)
- [License](#license)

---

## What StellarPay is

StellarPay is a **middleware + protocol** pair:

1. **Cross-chain bridge middleware** (`services/payment`, `Bridge.sol`) that
   locks or burns a canonical token on a source chain (Ethereum, Polygon) and
   mints a wrapped representation (`wETH`, `wUSDC`) on Stellar after a threshold
   of independent attester signatures.
2. **A lending protocol** written in Soroban (Rust) that lets those wrapped
   assets — and native assets such as XLM — be supplied, borrowed against
   collateral, repaid, and liquidated.

The point of settling the money market on Stellar is cost and latency: transfers
and liquidations cost fractions of a cent and settle in seconds, which is what
makes an always-on, permissionless liquidation engine practical.

## Who it is for

| Audience                          | Use case                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Lenders**                       | Supply assets to earn interest; interest is index-based, so it accrues without a keeper.                        |
| **Borrowers**                     | Borrow against over-collateralised positions (LTV and health-factor enforced on-chain).                         |
| **Liquidators**                   | Repay unhealthy debt and seize discounted collateral — permissionless, no allowlist.                            |
| **Bridge integrators**            | Use the attestation pipeline to issue wrapped assets on Stellar with a 2-of-3 signer quorum.                    |
| **Protocol engineers / auditors** | Read a Soroban workspace with explicit invariants (`docs/invariants.md`) and executable tests for each of them. |

## Feature overview

| Feature                                               | Where it lives                                     | Tests                                         | Status                                                            |
| ----------------------------------------------------- | -------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| Supply / withdraw (share-priced)                      | `contracts/lending/soroban`                        | `invariant_*` + unit tests                    | Implemented, tested                                               |
| Borrow / repay (index-based debt)                     | `contracts/lending/soroban`                        | `invariant_*` + unit tests                    | Implemented, tested                                               |
| Collateral accounting (vault positions)               | `contracts/collateral/soroban`                     | `invariant_*` + unit tests                    | Implemented, tested                                               |
| Health factor + LTV enforcement                       | `contracts/lending/soroban`                        | property test `prop_health_factor_monotonic`  | Implemented, tested                                               |
| Interest accrual (utilisation curve with kink)        | `contracts/lending/soroban`                        | unit + property tests                         | Implemented, tested                                               |
| Permissionless liquidation (close factor, bonus, fee) | `contracts/liquidation/soroban`                    | `invariant_Q*` + unit tests                   | Implemented, tested                                               |
| Oracle (multi-publisher, staleness heartbeat)         | `contracts/oracle/soroban`                         | `invariant_O*`                                | Implemented, tested                                               |
| Bridge attestation pipeline (ed25519, 2-of-3)         | `contracts/lending/controller`, `services/payment` | Rust + TS signer cross-language digest canary | Implemented, tested                                               |
| Replay protection (salt reuse → revert)               | `contracts/lending/controller`, `Bridge.sol`       | `invariant_C2`, `B-1`                         | Implemented, tested                                               |
| EIP-712 domain separation on EVM release              | `contracts/lending/evm/Bridge.sol`                 | `B-7` regression test                         | Implemented, tested                                               |
| Mint rate circuit breaker + pause surface             | `contracts/lending/controller`                     | `invariant_C3`, `C4`, `C5`, `B-6`             | Implemented, tested                                               |
| Off-chain relayer / watcher                           | `services/cron`                                    | vitest                                        | Implemented, tested                                               |
| Event indexer (Postgres)                              | `services/indexer`                                 | vitest                                        | Implemented, tested                                               |
| Public REST + WebSocket API                           | `apps/api`                                         | vitest (27 tests)                             | Implemented, tested                                               |
| Next.js dashboard                                     | `apps/web`                                         | vitest (3 tests) + `next lint`                | Implemented, tested                                               |
| TypeScript SDK                                        | `packages/sdk`                                     | vitest (7 tests)                              | Implemented, tested                                               |
| End-to-end unwrap → `Bridge.release`                  | —                                                  | **no test**                                   | **Not implemented** (see [Known limitations](#known-limitations)) |
| Cross-system backing/causality invariants X-1…X-4     | —                                                  | **no test**                                   | **Not implemented**                                               |
| Mainnet deployment, audit, bug bounty                 | —                                                  | —                                             | **Planned**                                                       |

A per-feature breakdown (implementation → tests → config → verification status)
is in [`docs/feature-evidence.md`](docs/feature-evidence.md).

## Architecture

```
 Source chains (EVM)                 Stellar testnet (Soroban)
┌────────────────────┐              ┌───────────────────────────────────────┐
│  Bridge.sol        │  Locked /    │  wrapped_asset  (wETH / wUSDC)        │
│  lock / release    │───Burned────▶│  collateral_vault (positions)         │
└────────────────────┘              │  oracle          (prices)             │
         │                           │  lending_pool    (supply/borrow)     │
         │ Locked/Burned events      │  liquidation     (seize/repay)      │
         ▼                           │  lending_controller (orchestration)   │
┌────────────────────┐              └───────────────────────────────────────┘
│ services/payment   │  ed25519 attestation (2-of-3 quorum)        ▲
│ bridge middleware  │─────────────────────────────────────────────┘
└─────────┬──────────┘
          │ wrap / unwrap events
          ▼
┌────────────────────┐   Postgres    ┌────────────────┐      WS      ┌──────────────────┐
│ services/indexer   │──────────────▶│ apps/api       │─────────────▶│ apps/web         │
│ event indexer      │               │ REST + WebSocket│              │ Next.js dashboard │
└────────────────────┘               └────────────────┘              └──────────────────┘
          ▲
          │ source-chain polling / tx submission
┌────────────────────┐
│ services/cron      │
│ relayer            │
└────────────────────┘
```

- **On Stellar (Soroban):** `wrapped_asset`, `lending_pool`, `collateral_vault`,
  `oracle`, `liquidation`, `lending_controller`, `governance`, `rewards` (7
  deployable contracts; 6 are deployed to testnet per
  [`DEPLOYMENTS.md`](DEPLOYMENTS.md) — see that file for the current address
  table and its verification status).
- **On source chains:** `Bridge.sol` (upgradeable, EIP-712 signed release,
  quorum-gated attester set).
- **Off-chain:** bridge middleware (attestation + event watching), relayer,
  indexer, API, dashboard, SDK.

## Repository layout

```
apps/
  web/          # Next.js dashboard (package: @stellar-payment-gateway/dashboard)
  api/          # Public REST + WebSocket API (@stellar-payment-gateway/api)
  dashboard/    # Standalone analytics app (@stellar-payment-gateway/dashboard-app)
  docs/  explorer/  treasury/
contracts/                        # Soroban workspace (Rust) + EVM (Hardhat)
  lending/soroban  lending/controller  lending/evm
  collateral/soroban  oracle/soroban  liquidation/soroban
  treasury/soroban  governance/soroban  rewards/soroban
  integration-tests/              # cross-contract + property-based tests
packages/           # sdk, ui, config, types, utils, eslint-config, tsconfig
services/           # payment (bridge), cron (relayer), indexer, notification, analytics
infra/              # docker, kubernetes, terraform
scripts/            # dev / build / deploy helpers
docs/               # protocol documentation
```

> The npm package scope is still `@stellar-payment-gateway/*` (inherited from
> the original skeleton). Package names are internal; the product, repository
> and docs use **StellarPay**.

## Supported networks

| Network                                                   | Status                           | Notes                                                                                   |
| --------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| **Stellar testnet** (`Test SDF Network ; September 2015`) | Active                           | Soroban contracts deployed 2026-08-09; addresses in [`DEPLOYMENTS.md`](DEPLOYMENTS.md). |
| **Ethereum Sepolia / Polygon Amoy**                       | Contract ready, **not deployed** | `Bridge` compiles and its test suite passes; deployment requires a funded deployer key. |
| Stellar mainnet                                           | Not planned yet                  | No mainnet deployment, no audit, no bug bounty.                                         |

## Prerequisites

| Tool     | Version                           | Why                                                                              | Install                                                      |
| -------- | --------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Node.js  | ≥ 22.5 (CI pins 22)               | `undici` 8 (via testcontainers) requires ≥ 22.5                                  | `nvm install 22`                                             |
| pnpm     | 10.x (pinned by `packageManager`) | Workspace package manager                                                        | `corepack enable && corepack prepare pnpm@10.0.0 --activate` |
| Rust     | 1.91.0 + `wasm32v1-none`          | Soroban SDK 27 MSRV; `wasm32-unknown-unknown` is rejected by SDK 27's `build.rs` | `rustup toolchain install 1.91.0 --target wasm32v1-none`     |
| Docker   | ≥ 24                              | Postgres / Redis for the API, indexer and relayer                                | see `infra/docker/`                                          |
| Node/npm | npm 11 only for `contracts/`      | The EVM subproject is outside the pnpm workspace and installs with npm           | bundled with Node                                            |

## Setup

```bash
# 1. Clone (canonical URL)
git clone https://github.com/Zulu089017/DeFi-Lending-StellarPay.git
cd DeFi-Lending-StellarPay

# 2. Install workspace dependencies (pnpm 10, frozen lockfile)
corepack enable && corepack prepare pnpm@10.0.0 --activate
pnpm install --frozen-lockfile

# 3. Infrastructure (Postgres 16 + Redis 7 on :5432 / :6379)
docker compose -f infra/docker/docker-compose.dev.yml up -d

# 4. Environment files
cp apps/api/.env.example        apps/api/.env
cp apps/web/.env.example        apps/web/.env
cp services/payment/.env.example services/payment/.env
cp services/indexer/.env.example services/indexer/.env
cp services/cron/.env.example    services/cron/.env

# 5. Generate Prisma clients + push the schema
pnpm --filter @stellar-payment-gateway/bridge  exec prisma generate
pnpm --filter @stellar-payment-gateway/relayer exec prisma generate
pnpm --filter @stellar-payment-gateway/indexer exec prisma generate
pnpm --filter @stellar-payment-gateway/api     exec prisma generate
pnpm --filter @stellar-payment-gateway/api     exec prisma db push
```

### Build and test the contracts

```bash
# Soroban (needs Rust 1.91.0 + wasm32v1-none)
cd contracts
cargo fmt --all -- --check
cargo check --workspace --locked --target wasm32v1-none --release
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked

# EVM (contracts/ is an npm project, not part of the pnpm workspace)
cd contracts
npm ci
npx hardhat compile
npx hardhat test
```

Deploying to Stellar testnet regenerates `packages/sdk/src/manifest.json`,
`stellar.toml` and `apps/web/public/.well-known/stellar.toml`:

```bash
cd contracts
bash scripts/deploy-testnet.sh      # needs contracts/.env with a funded secret key
```

## Environment configuration

Every service reads its configuration from a `.env` file in its own directory.
`.env` is git-ignored; only `.env.example` files are committed, and they contain
placeholders — never real keys.

| File                            | Key variables (safe placeholder values)                                                                                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/.env.example`         | `DATABASE_URL=postgresql://spg:spg@localhost:5432/spg`, `STELLAR_RPC=https://horizon-testnet.stellar.org`, `STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015`, `STELLAR_CONTROLLER=<lending_controller contract id>`, `PORT=4000`, `CORS_ORIGINS=*` |
| `apps/web/.env.example`         | `NEXT_PUBLIC_API_URL=http://localhost:4000`, `NEXT_PUBLIC_STELLAR_CONTROLLER=<contract id>`                                                                                                                                                                     |
| `services/payment/.env.example` | `ETHEREUM_RPC`, `POLYGON_RPC`, `SOLANA_RPC`, `RELAYER_SECRET` (**secret key — never commit**), `ATTESTER_KEYS` / `ATTESTER_KEYS_FILE`, `ATTESTER_THRESHOLD=2`                                                                                                   |
| `services/indexer/.env.example` | `DATABASE_URL`, `STELLAR_RPC`, `STELLAR_CONTROLLER`                                                                                                                                                                                                             |
| `services/cron/.env.example`    | `DATABASE_URL`, source-chain RPCs, `RELAYER_SECRET`                                                                                                                                                                                                             |

Contract IDs come from
[`packages/sdk/src/manifest.json`](packages/sdk/src/manifest.json), which the
deploy script regenerates. The `.env.example` files carry the
`lending_controller` id from the last deployment; if you redeploy, update them
(or point the service at the manifest).

**Secret handling:** `RELAYER_SECRET` and `ATTESTER_KEYS` are the two high-value
secrets. `ATTESTER_KEYS_FILE` is preferred over `ATTESTER_KEYS` because it can
be mounted from a secret manager. `.gitignore` excludes `.env`, `.env.*` (except
`.env.example`), `*.pem`, `*.key` and `secrets.json`.

## Running contracts, services and the dashboard

```bash
# Everything at once (Turborepo)
pnpm dev

# Or individually
pnpm --filter @stellar-payment-gateway/bridge  dev   # services/payment  :4100
pnpm --filter @stellar-payment-gateway/indexer dev   # services/indexer :4200
pnpm --filter @stellar-payment-gateway/relayer dev   # services/cron
pnpm --filter @stellar-payment-gateway/api     dev   # apps/api         :4000
pnpm --filter @stellar-payment-gateway/dashboard dev # apps/web         :3000
```

| Service                                | URL                   | Health check  |
| -------------------------------------- | --------------------- | ------------- |
| Dashboard (`apps/web`)                 | http://localhost:3000 | browser       |
| API (`apps/api`)                       | http://localhost:4000 | `GET /health` |
| Bridge middleware (`services/payment`) | http://localhost:4100 | `GET /health` |
| Indexer (`services/indexer`)           | http://localhost:4200 | `GET /health` |

## Reproducing a lending flow

The end-to-end path a user exercises (and how to run it locally):

1. **Wrap** — lock the canonical token on the source chain (`Bridge.lock`), wait
   for the off-chain watcher (`services/payment`) to collect `attester`
   signatures, then call `lending_controller.wrap` with the attestation. The
   controller mints the wrapped asset on Stellar.
2. **Supply collateral** — `lending_controller.supply_collateral` deposits into
   `collateral_vault` and supplies to `lending_pool`.
3. **Borrow** — `lending_controller.borrow` prices the collateral through
   `oracle`, checks LTV / health factor, and pulls `lending_pool.borrow_raw`.
4. **Repay or liquidate** — `lending_pool.repay` reduces the index-priced debt;
   if the health factor drops below 1, anyone can call `liquidation.liquidate`,
   which repays part of the debt (close factor) and seizes discounted
   collateral.
5. **Observe** — the indexer stores events in Postgres, the API exposes them
   over REST and WebSocket, the dashboard renders them.

From TypeScript, the SDK wraps steps 1–4:

```ts
import { StellarPay } from "@stellar-payment-gateway/sdk";

const spg = new StellarPay({
  stellar: {
    rpc: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    controllerContract: "<lending_controller contract id>",
    secretKey: process.env.STELLAR_SECRET!,
  },
  evm: {
    ethereum: {
      rpc: process.env.ETH_RPC!,
      bridgeAddress: process.env.ETH_BRIDGE!,
    },
    polygon: {
      rpc: process.env.POLY_RPC!,
      bridgeAddress: process.env.POLY_BRIDGE!,
    },
  },
  api: "http://localhost:4000",
});

await spg.supply("XLM", "1000000000"); // 100 XLM
await spg.borrow({
  collateralAsset: "XLM",
  collateralAmount: "1000000000",
  debtAsset: "USDC",
  borrowAmount: "50000000",
});

const unsub = spg.stream((evt) => {
  if (evt.type === "lending" && evt.data.type === "liquidate")
    console.log("liquidation", evt.data);
});
```

A scripted, manual walkthrough of the same flow on testnet lives in
[`docs/e2e-testnet-flow.md`](docs/e2e-testnet-flow.md).

> Note: the deployed EVM bridge is **not** live yet (`Bridge` addresses in
> `DEPLOYMENTS.md` are placeholders), so the _wrap_ leg of the flow requires a
> local `Bridge` deployment or the test fixtures. The lending legs (supply →
> borrow → repay → liquidate) run against the deployed Soroban contracts.

## Tests and CI status

CI (`.github/workflows/ci.yml`) has five jobs: `lint-configs`,
`soroban-contracts`, `evm-contracts`, `ts-services` (matrix of 5 packages) and
`frontend`.

**Results below were executed locally on 2026-10-20** (Node v24.21.0, pnpm
10.0.0, npm 11.19.0) with the repository's own commands:

| Check                     | Command                                                                 | Result                                                                            |
| ------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Install                   | `pnpm install --frozen-lockfile`                                        | ✅ pass                                                                           |
| Config formatting         | `pnpm exec prettier --check "**/*.{json,md,yml,yaml}" …`                | ✅ pass                                                                           |
| Type check (all packages) | `pnpm typecheck`                                                        | ✅ 12/12 turbo tasks                                                              |
| Lint                      | `pnpm lint`                                                             | ✅ 2/2 turbo tasks (warnings only, 0 errors)                                      |
| Unit tests (all packages) | `pnpm test`                                                             | ✅ 35/35 turbo tasks, **56 tests passed**                                         |
| API service               | `pnpm --filter @stellar-payment-gateway/api exec tsc --noEmit` / `test` | ✅ 27 tests                                                                       |
| Bridge service            | `…/bridge exec tsc --noEmit` / `test`                                   | ✅ 17 tests                                                                       |
| SDK                       | `…/sdk exec tsc --noEmit` / `test` / `build`                            | ✅ 7 tests                                                                        |
| Indexer / Relayer         | `…/indexer`, `…/relayer`                                                | ✅ 1 test each                                                                    |
| Dashboard (Next.js)       | `tsc --noEmit`, `test`, `next lint`, `build`                            | ✅ 3 tests, lint clean, build OK                                                  |
| EVM contracts             | `npx hardhat compile` / `npx hardhat test` (in `contracts/`)            | ✅ 17 tests passing                                                               |
| Soroban contracts         | `cargo fmt/check/clippy/test --locked`                                  | ⚠️ **not runnable in this environment** — no Rust toolchain installed (see below) |
| Slither static analysis   | `crytic/slither-action`                                                 | ⚠️ **not runnable in this environment** — `slither-analyzer` not installed        |

**Soroban test inventory (source-verified, not executed here):** the Rust
workspace contains **113 `#[test]` functions**, of which **42 are named
`invariant_*`** and map onto the invariant IDs in
[`docs/invariants.md`](docs/invariants.md) (18 lending pool, 6 liquidation, 6
controller, 4 oracle, 4 collateral vault, 4 wrapped asset). CI runs them on Rust
**1.91.0** with the `wasm32v1-none` target against the committed
`contracts/Cargo.lock` (`soroban-sdk 27.0.6`, `soroban-env-host 27.0.1`). No
coverage percentage is claimed anywhere in this repository.

### Reproducing the checks

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test
pnpm exec prettier --check "**/*.{json,md,yml,yaml}" "!**/node_modules/**" "!**/dist/**" "!**/target/**"
(cd contracts && npm ci && npx hardhat compile && npx hardhat test)
(cd contracts && cargo fmt --all -- --check && cargo clippy --workspace --all-targets --locked -- -D warnings && cargo test --workspace --locked)
```

## Security, risk and audit status

- **No audit has been performed.** The contracts are pre-audit and testnet only.
  See [`SECURITY.md`](SECURITY.md) and [`docs/security.md`](docs/security.md)
  for the threat model, disclosure policy and the planned scope.
- **Safe harbour** for good-faith research against the testnet deployments is
  granted; do not exfiltrate or destroy data.
- **Known unmitigated gaps** (all listed in
  [`docs/invariants.md`](docs/invariants.md) and
  [`docs/security.md`](docs/security.md)):
  - Cross-system invariants **X-1…X-3** (wrapped-asset backing and wrap/unwrap
    causality) have **no automated test**, because the unwrap → `Bridge.release`
    path is not wired end to end.
  - **X-4** (API/on-chain view consistency) is untested.
  - `pnpm audit` reports dev-dependency advisories in the `api` package
    (transitive `testcontainers`/`vitest` chain); the audit step in CI is
    advisory (`|| true`) until those majors can be bumped.
  - No formal smart-contract audit, no bug-bounty programme, no mainnet.
- **`cargo audit` / `npm audit` for the Rust workspace** are not part of CI yet
  — tracked in the backlog.

## Known limitations

- **No hosted demo.** `app.spg.xyz` and `api.spg.xyz` currently have **no DNS
  record**, and `spg.xyz` resolves to an unrelated third-party site, so no
  hosted dashboard or API is claimed as live. Run the stack locally instead (see
  [Setup](#setup)). The SEP-1 metadata in [`stellar.toml`](stellar.toml)
  therefore points `ORG_URL` at this repository rather than at an uncontrolled
  domain.
- **EVM bridge not deployed** on Sepolia/Amoy — `Bridge` is compiled and tested,
  but the addresses in `DEPLOYMENTS.md` are placeholders.
- **Partial coverage of the on-chain flow** — the wrap leg needs either a local
  `Bridge` deployment or the test fixtures.
- **Package scope** is still `@stellar-payment-gateway/*`.
- **`pnpm lint` covers 2 of 19 workspace packages** (only `bridge` and
  `dashboard` define a `lint` script); the remaining packages are covered by
  `tsc --noEmit` and the Prettier check in CI.

## Contributing

- Start here: [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) — setup,
  per-package test commands, commit conventions, review process.
- Issues: [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE) (bug, feature,
  documentation, testing, security, audit finding).
- Pull requests:
  [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md).
- Ready-to-pick-up work is tracked as GitHub issues labelled `good first issue`
  / `help wanted`; the full, verified backlog (with the issue drafts in this
  repository) is in [`docs/backlog/`](docs/backlog/README.md).
- Dependency updates are automated with [Dependabot](.github/dependabot.yml);
  code owners are listed in [`.github/CODEOWNERS`](.github/CODEOWNERS).

## Documentation index

| Document                                                     | Contents                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)               | Component-by-component design                                          |
| [`docs/invariants.md`](docs/invariants.md)                   | The invariant catalogue an audit checks, with test coverage            |
| [`docs/feature-evidence.md`](docs/feature-evidence.md)       | Feature → implementation → tests → verification status                 |
| [`docs/verification-status.md`](docs/verification-status.md) | What was executed in the last verification pass, and what could not be |
| [`docs/backlog/`](docs/backlog/README.md)                    | The contributor backlog (issue drafts, labels, sizes, funding order)   |
| [`docs/developer-guide.md`](docs/developer-guide.md)         | Day-to-day development workflow                                        |
| [`docs/api.md`](docs/api.md)                                 | REST + WebSocket API reference                                         |
| [`docs/sdk.md`](docs/sdk.md)                                 | SDK reference                                                          |
| [`docs/contracts.md`](docs/contracts.md)                     | Contract-by-contract interface summary                                 |
| [`docs/risk.md`](docs/risk.md)                               | Oracle bounds, bad debt, circuit breakers                              |
| [`docs/rate-model.md`](docs/rate-model.md)                   | Interest-rate curve                                                    |
| [`docs/security.md`](docs/security.md)                       | Threat model and open gaps                                             |
| [`docs/deployment.md`](docs/deployment.md)                   | Deployment runbook                                                     |
| [`docs/e2e-testnet-flow.md`](docs/e2e-testnet-flow.md)       | Manual testnet walkthrough                                             |
| [`docs/monitoring.md`](docs/monitoring.md)                   | Metrics and alerts                                                     |
| [`docs/disaster-recovery.md`](docs/disaster-recovery.md)     | Key compromise / recovery runbook                                      |
| [`docs/audit-checklist.md`](docs/audit-checklist.md)         | Pre-audit checklist                                                    |
| [`docs/polyrepo.md`](docs/polyrepo.md)                       | Planned per-subproject split                                           |
| [`DEPLOYMENTS.md`](DEPLOYMENTS.md)                           | Testnet addresses and their verification status                        |
| [`SECURITY.md`](SECURITY.md)                                 | Disclosure policy and audit plan                                       |
| [`CHANGELOG.md`](CHANGELOG.md)                               | Release history                                                        |

## License

Apache 2.0 — see [`LICENSE`](LICENSE).
