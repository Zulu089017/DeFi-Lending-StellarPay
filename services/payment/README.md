# StellarPay — Bridge Middleware

Off-chain TypeScript service that runs both directions of the bridge:

1. **Wrap** — watches `Locked` / `Burned` on source chains (Ethereum, Polygon)
   and submits `lending_controller.wrap` to mint wrapped tokens on Stellar after
   collecting a threshold of ed25519 attestations.
2. **Unwrap → release** — reads `unwrap` contract events from Soroban RPC,
   collects threshold EIP-712 (`Release`) signatures, and submits
   `Bridge.release` on the destination chain, marking the unwrap released only
   after the receipt is confirmed.

## How it works

```
┌──────────────────┐  Locked/Burned  ┌──────────────────┐   wrap()    ┌──────────────┐
│  EVM chain       │ ──────────────▶ │  Bridge          │ ──────────▶ │  Soroban     │
│  Bridge.sol      │                 │  middleware      │             │  Controller  │
│                  │ ◀────────────── │  (this service)  │ ◀────────── │              │
└──────────────────┘  release()      └──────────────────┘   unwrap    └──────────────┘
                           ▲                 │
                           │                 ▼
                    ┌──────────────────┐  ┌──────────────────┐
                    │  EVM attesters   │  │  Postgres        │
                    │  (EIP-712, 2-of-3)│  │  event/state store│
                    └──────────────────┘  └──────────────────┘
```

## Key features

- Pluggable chain handlers (`src/chains/`)
- Idempotent: source events are keyed by `(txHash, logIndex)`, unwraps by
  `(txHash, nonce)` — a Stellar tx may contain several unwraps
- Multi-attester quorum signing: ed25519 for `wrap`, EIP-712 secp256k1 for
  `release`
- On-chain replay pre-check (`Bridge.releasedNonces`) before every submission
- Releases are marked done **only after** the configured confirmations
- Dead-lettering after `MAX_RELEASE_ATTEMPTS`, so one stuck unwrap cannot starve
  the queue
- Cross-system invariant predicates X-1…X-4 (`src/invariants.ts`) with tests
- Graceful shutdown, `/health`, `/metrics`

## Configuration

See [`.env.example`](./.env.example). The dual-direction pipeline needs:

| Variable                                                | Purpose                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `STELLAR_RPC`                                           | Horizon endpoint (submits `wrap` transactions)              |
| `STELLAR_SOROBAN_RPC`                                   | Soroban RPC endpoint (**required** to read `unwrap` events) |
| `STELLAR_CONTROLLER`                                    | `lending_controller` contract id                            |
| `RELAYER_SECRET`                                        | Stellar relayer key (submits `wrap`)                        |
| `ATTESTER_KEYS` / `_FILE`, `ATTESTER_THRESHOLD`         | ed25519 keys signing `wrap` payloads                        |
| `EVM_ATTESTER_KEYS` / `_FILE`, `EVM_ATTESTER_THRESHOLD` | secp256k1 keys signing EIP-712 `Release`                    |
| `ETHEREUM_RELEASE_TOKEN`, `POLYGON_RELEASE_TOKEN`       | Canonical token released per chain                          |
| `ETHEREUM_RELAYER_PK`, `POLYGON_RELAYER_PK`             | EVM tx submitter (pays gas)                                 |

A chain without a token + submitter key is **skipped**, never advertised as
supported: its unwraps stay `pending` until the deployment is configured.

> **Status:** both directions are implemented and unit-tested. Neither has been
> run against a deployed EVM `Bridge` (none exists yet — see
> [`DEPLOYMENTS.md`](../../DEPLOYMENTS.md)). Treat the release path as untested
> in production until that run happens.

## Run

```bash
pnpm install
cp .env.example .env   # fill in
pnpm --filter @stellar-payment-gateway/bridge exec prisma generate
pnpm --filter @stellar-payment-gateway/bridge exec prisma db push
pnpm --filter @stellar-payment-gateway/bridge dev
```

## Layout

```
bridge/
├── src/
│   ├── index.ts                 # entrypoint
│   ├── config.ts
│   ├── chains/
│   │   ├── ethereum.ts
│   │   ├── polygon.ts
│   │   ├── solana.ts
│   │   └── stellar.ts           # Soroban `unwrap` watcher
│   ├── events/unwrap.ts         # pure decode / validation
│   ├── attest/signer.ts         # ed25519 (wrap) + EIP-712 (release)
│   ├── mint/stellarMinter.ts
│   ├── release/evmRelease.ts    # unwrap → Bridge.release state machine
│   ├── invariants.ts            # X-1…X-4 predicates
│   ├── store/db.ts              # Prisma
│   ├── utils/
│   └── types.ts
├── prisma/schema.prisma
├── tests/
├── package.json
├── tsconfig.json
└── Dockerfile
```
