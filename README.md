# StellarPay

<p align="center">
  <img src="public/logo.svg" alt="StellarPay logo" width="160" />
</p>

> A decentralized cross-chain lending protocol with automated liquidation, built
> on Stellar's ultra-fast, low-fee network.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-pre--audit_|_testnet_only-yellow.svg)](docs/security.md)
[![Audit](https://img.shields.io/badge/Audit-Planned_Q1_2027-lightgrey.svg)](docs/security.md#audit)
[![Demo](https://img.shields.io/badge/Demo-Live_↗-success.svg)](https://web-h21ixnvop-zulu0890s-projects.vercel.app)
[![Soroban](https://img.shields.io/badge/Soroban-27-blueviolet.svg)](contracts/Cargo.toml)
[![Solidity](https://img.shields.io/badge/Solidity-%5E0.8.24-363636.svg)](contracts/hardhat.config.ts)
[![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088FF.svg)](.github/workflows/ci.yml)
[![Code style: rustfmt](https://img.shields.io/badge/code%20style-rustfmt-orange.svg)](contracts/rustfmt.toml)
[![Turborepo](https://img.shields.io/badge/build-Turborepo-EF4444.svg)](turbo.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6.svg)](packages/sdk/package.json)
[![Rust](https://img.shields.io/badge/Rust-1.91-000000.svg)](contracts/Cargo.toml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](.github/CONTRIBUTING.md)

**StellarPay** is a middleware that allows developers on other chains (Ethereum,
Solana, Polygon) to instantly spin up wrapped versions of their tokens on
Stellar. These wrapped assets can then be used in a fully on-chain lending
protocol featuring automated liquidation, powered by Stellar's near-instant
settlement.

> 🔗 **Live Demo:**
> [web-h21ixnvop-zulu0890s-projects.vercel.app](https://web-h21ixnvop-zulu0890s-projects.vercel.app)
> — Explore the lending dashboard, bridge tokens, and monitor liquidations on
> Stellar testnet. All 7 Soroban contracts deployed and verified. See
> [DEPLOYMENTS.md](DEPLOYMENTS.md) for contract addresses.

## 🎥 Demo

> 📹 **Video walkthrough coming soon.** See [DEMO.md](DEMO.md) for the
> scene-by-scene recording script covering the full cross-chain flow: wrap →
> supply → borrow → liquidation on Stellar testnet.
>
> _After recording: replace this section with a YouTube/Loom embed._

---

## 🌍 Why StellarPay?

| Pain Point                       | StellarPay Solution                                |
| -------------------------------- | -------------------------------------------------- |
| High gas fees on Ethereum/Solana | Mint wrapped assets on Stellar for ~$0.000005 / tx |
| Slow cross-chain bridging        | Near-instant settlement via Stellar's consensus    |
| Liquidity fragmentation          | Single canonical wrapped-asset hub on Stellar      |
| Manual liquidations              | Fully automated liquidation engine on Soroban      |
| Opaque bridge state              | Real-time Horizon stream → live dashboard          |

---

## 🏗️ Polyrepo Layout

StellarPay is composed of **independent, loosely-coupled subprojects**. Each one
is a self-contained unit with its own build, test, and deploy pipeline. Together
they form the protocol.

```
StellarPay/
│
├── apps/
│   ├── web/              # Next.js dashboard — real-time cross-chain & lending UI
│   ├── api/              # Public REST + WebSocket API
│   ├── dashboard/        # Standalone analytics dashboard
│   ├── docs/             # Documentation site
│   └── explorer/         # Block/transaction explorer
│
├── contracts/
│   ├── lending/          # Lending pool + controller (Soroban + EVM)
│   ├── collateral/       # Collateral vault (Soroban)
│   ├── oracle/           # Price oracle (Soroban)
│   ├── liquidation/      # Liquidation engine (Soroban)
│   ├── treasury/         # Wrapped assets (Soroban + EVM)
│   ├── governance/       # Governance contracts (Soroban)
│   └── rewards/          # Rewards distribution (Soroban)
│
├── packages/
│   ├── packages/sdk/              # TypeScript SDK
│   ├── ui/               # Shared UI components
│   ├── config/           # Shared configuration
│   ├── types/            # Shared TypeScript types
│   ├── utils/            # Shared utilities
│   ├── eslint-config/    # Shared ESLint config
│   └── tsconfig/         # Shared TypeScript config
│
├── services/
│   ├── payment/          # Cross-chain bridge middleware
│   ├── cron/             # Transaction relayer service
│   ├── indexer/           # Off-chain indexer
│   ├── notification/     # Notification service
│   └── analytics/        # Analytics service
│
├── infra/
│   ├── docker/           # Docker Compose files
│   ├── kubernetes/       # K8s manifests
│   └── terraform/        # Infrastructure as code
│
├── scripts/              # Build & deploy scripts
├── docs/                 # Protocol documentation
└── .github/              # CI workflows, issue & PR templates
```

> **Note**: Each top-level directory is designed to live in its own git
> repository. The monorepo layout here is for local development and
> orchestration. See `docs/polyrepo.md` for the recommended split.

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 22.5 (required by testcontainers/undici 8)
- **pnpm** ≥ 10 (install:
  `corepack enable && corepack prepare pnpm@10 --activate`)
- **Rust** ≥ 1.91 (Soroban SDK 27 MSRV, with `wasm32v1-none` target)
- **Docker** ≥ 24 (for Postgres, Redis, and integration tests)
- **Foundry** or **Hardhat** (for EVM contract compilation)

### 1. Clone & Install

```bash
git clone https://github.com/Zulu089017/DeFi-Lending-Platform
cd DeFi-Lending-Platform
pnpm install
```

### 2. Start Infrastructure

```bash
cd infra/docker
docker compose up -d
# Starts Postgres 16, Redis 7 on localhost:5432, :6379
```

### 3. Set Up Environment Variables

```bash
cp apps/api/.env.example apps/api/.env
cp services/payment/.env.example services/payment/.env
cp services/indexer/.env.example services/indexer/.env
cp services/cron/.env.example services/cron/.env
# Edit each .env file with your RPC URLs and keys
```

### 4. Build & Deploy Smart Contracts

```bash
# Soroban contracts (build + test)
cd contracts
cargo test --workspace
bash scripts/deploy-testnet.sh

# EVM contracts (compile + test)
npm install
npx hardhat compile
npx hardhat test
```

### 5. Generate Prisma Clients & Run Migrations

```bash
cd services/payment && pnpm prisma generate && pnpm prisma db push
cd services/indexer && pnpm prisma generate && pnpm prisma db push
cd services/cron && pnpm prisma generate && pnpm prisma db push
cd apps/api && pnpm prisma generate && pnpm prisma db push
```

### 6. Start Services

```bash
# Terminal 1: Bridge middleware
cd services/payment && pnpm dev

# Terminal 2: Indexer
cd services/indexer && pnpm dev

# Terminal 3: Relayer
cd services/cron && pnpm dev

# Terminal 4: API server
cd apps/api && pnpm dev

# Terminal 5: Web dashboard
cd apps/web && pnpm dev
```

### 7. Verify

| Service   | URL                   | Health Check  |
| --------- | --------------------- | ------------- |
| Dashboard | http://localhost:3000 | Browser       |
| API       | http://localhost:4000 | `GET /health` |
| Bridge    | http://localhost:4100 | `GET /health` |
| Indexer   | http://localhost:4200 | `GET /health` |

### Using Turborepo

```bash
pnpm build        # Build all packages
pnpm test         # Run all tests
pnpm lint         # Lint all packages
pnpm typecheck    # Type-check all packages
pnpm dev          # Start all dev servers
```

---

## 🧱 Architecture at a Glance

```
┌──────────────┐    lock/burn     ┌────────────────┐
│   Ethereum   │ ───────────────▶ │                │
│   Polygon    │                  │  Bridge        │   attest
│   Solana     │                  │  Middleware    │ ───────▶ ┌────────────┐
└──────────────┘                  │  (off-chain)   │           │  Stellar   │
                                  └────────────────┘           │  (Soroban) │
                                          │                    │  Mint wTKN │
                                          │ events             └────────────┘
                                          ▼                          │
                                  ┌────────────────┐                 │ events
                                  │   Indexer      │ ◀───────────────┘ (Horizon)
                                  │   (Postgres)   │
                                  └────────────────┘
                                          │
                                          ▼
                                  ┌────────────────┐    WS    ┌────────────┐
                                  │   API          │ ───────▶ │ Frontend   │
                                  │   (REST+WS)    │          │ (Next.js)  │
                                  └────────────────┘          └────────────┘
```

**On Stellar (Soroban):**

- `wrapped_asset` — canonical wrapped token contract
- `lending_pool` — supply/borrow/withdraw/repay
- `collateral_vault` — locked collateral accounting
- `oracle` — price feeds (Chainlink/Stellar reflect oracle)
- `liquidation` — automated liquidation engine
- `lending_controller` — orchestrates the above

**On source chains (EVM/Solana):**

- `Bridge.sol` / `bridge.ts` — locks or burns the canonical token
- Emits `Locked` / `Burned` events that the off-chain bridge watches

---

## 📚 Documentation

- [Architecture Deep Dive](docs/architecture.md)
- [Protocol Invariants](docs/invariants.md) — what an audit will check
- [Security Model & Threat Model](docs/security.md) — known TODOs and disclosure
  policy
- [Deployments](DEPLOYMENTS.md) — testnet contract addresses & live demo URL
- [Deployment Guide](docs/deployment.md)
- [Polyrepo Guide](docs/polyrepo.md)
- [API Reference](docs/api.md)
- [SDK Reference](docs/sdk.md)
- [Changelog](CHANGELOG.md) · [Security Policy](SECURITY.md)

---

## 🤝 Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md). PRs welcome. Code owners per
subproject are listed in [CODEOWNERS](.github/CODEOWNERS). Dependency updates
are automated via [Dependabot](.github/dependabot.yml).

## 📄 License

Apache 2.0 — see [LICENSE](LICENSE).

## ⚠️ Status

This repository is a **testnet-stage protocol**. The smart contracts have not
been audited. All 7 Soroban contracts are deployed to Stellar testnet (see
[DEPLOYMENTS.md](DEPLOYMENTS.md)) and the Next.js dashboard is live at the demo
link above. Health factor checks, collateral validation, and liquidation
invariants are implemented and tested (103 tests pass, 26 invariant tests). **Do
not deposit real assets.** A formal audit, bug-bounty program, and coordinated
disclosure policy are tracked in [`SECURITY.md`](SECURITY.md) and
[`docs/security.md`](docs/security.md).
