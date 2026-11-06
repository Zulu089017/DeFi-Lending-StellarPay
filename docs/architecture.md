# StellarPay Architecture

## System Overview

StellarPay is a cross-chain lending protocol built on Stellar's Soroban smart
contract platform. The system consists of **on-chain contracts** (Soroban +
EVM), **off-chain services** (bridge, relayer, indexer, API), an **SDK**, and a
**Next.js dashboard**.

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER INTERFACES                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Web App  │  │  SDK     │  │  API     │  │  CLI / Scripts │  │
│  │ (Next.js)│  │ (TS)     │  │ (Fastify)│  │               │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
└───────┼─────────────┼─────────────┼─────────────────┼──────────┘
        │             │             │                 │
┌───────┴─────────────┴─────────────┴─────────────────┴──────────┐
│                      OFF-CHAIN SERVICES                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Bridge   │  │ Relayer  │  │ Indexer  │  │ Notifications │  │
│  │ (payment)│  │ (cron)   │  │          │  │               │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
└───────┼─────────────┼─────────────┼─────────────────┼──────────┘
        │             │             │                 │
┌───────┴─────────────┴─────────────┴─────────────────┴──────────┐
│                       DATA LAYER                                │
│  ┌──────────────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │    Postgres      │  │  Redis   │  │  Horizon / EVM RPC   │  │
│  └──────────────────┘  └──────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
        │
┌───────┴─────────────────────────────────────────────────────────┐
│                    ON-CHAIN CONTRACTS                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │ Lending  │ │Collateral│ │ Oracle   │ │ Liquidation      │   │
│  │ Pool     │ │ Vault    │ │          │ │ Engine           │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │Governance│ │ Rewards  │ │ Treasury │ │EVM Bridge (EVM)  │   │
Note: the Solana watcher scaffold (`services/payment/src/chains/solana.ts`) is not a working bridge; Solana is planned.
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Cross-Chain Flow

### Wrap (EVM → Stellar)

```
1. User locks tokens on EVM chain (Bridge.sol)
2. Bridge.sol emits Locked(token, amount, stellarDest, salt)
3. Bridge middleware watches Locked events
4. Attesters sign the canonical payload (sha256 → ed25519)
5. Relayer submits mint tx to Soroban lending_controller
6. Controller verifies attestations → mints wrapped asset
7. Indexer picks up Horizon event → API pushes via WebSocket
```

### Unwrap (Stellar → EVM) — **not wired yet** (Issue #71)

The unwrap → release path is implemented in the code
(`lending_controller.unwrap`, `services/payment` unwrap watcher and EIP-712
release submitter) and unit-tested, but it has **not been wired end to end**
(Issue #71). The flow below is the intended design once wired:

```
1. User calls lending_controller.unwrap()
2. Controller burns wrapped asset, emits Unwrapped event
3. Bridge middleware watches Unwrapped events
4. Attesters sign EIP-712 Release typed data
5. Relayer submits Bridge.release() on EVM chain
6. EVM chain releases original tokens to user
```

Until wired, a Stellar unwrap burns the wrapped asset but does **not** release
on EVM. Solana is **not** a source chain today — the Solana watcher is a
scaffold, not a working bridge; wrapping is from Ethereum and Polygon only.

## Contract Architecture

### Lending Pool (contracts/lending/soroban)

- **supply(asset, amount)** → mints lToken shares
- **withdraw(asset, shares)** → burns shares, returns assets
- **borrow(asset, amount)** → draws against collateral (HF ≥ 1.0 enforced)
- **repay(asset, amount)** → reduces debt (capped at outstanding)
- **supply_collateral(asset, amount)** → locks collateral in vault
- **withdraw_collateral(asset, amount)** → releases collateral

Interest rate model: kinked linear curve

```
if utilization ≤ kink (80%):
  rate = base + slope1 × utilization / kink
else:
  rate = base + slope1 + slope2 × (utilization - kink) / (100% - kink)
```

### Liquidation Engine (contracts/liquidation/soroban)

```
liquidator repays borrower's debt → receives collateral + bonus - fee
bonus = 5% (configurable)
fee = 20% of bonus (configurable)
close_factor = 50% max per tx
```

## Service Architecture

### Bridge Middleware (services/payment)

Event-driven poller that is **lock-and-mint only today**:

1. Watches EVM Locked/Burned events (not Solana — the Solana watcher is a
   scaffold, not a working bridge; Solana is planned).
2. Collects Ed25519 attestation signatures
3. Submits mint transactions to Soroban for wraps; the unwrap `Bridge.release`
   pipeline exists and is unit-tested but is **not wired end to end** (Issue
   #71), so a Stellar unwrap does not yet release tokens on EVM.
4. Exposes `/health` endpoint for K8s probes

### Indexer (services/indexer)

Streams Horizon ledgers + EVM logs → Postgres:

1. Subscribes to Horizon `ledgers` stream
2. Parses Soroban contract events
3. Upserts into normalized Postgres tables
4. Serves queryable API for dashboard/SDK

### Relayer (services/cron)

Transaction relayer with retry + gas bumping:

1. Picks up signed transactions from queue
2. Submits to target chain (Stellar/EVM; Solana relaying is planned and not a
   working bridge today)
3. Retries with exponential backoff
4. Bumps gas on EVM transactions when needed

## Security Model

- **Multi-sig attestation**: n-of-m attesters required for bridge operations
- **Health factor enforcement**: borrow only when HF ≥ 1.0
- **Emergency pause**: admin can pause all state-changing operations
- **Timelock**: governance proposals have mandatory delay before execution
- **Close factor**: max 50% liquidation per tx prevents flash-loan attacks
