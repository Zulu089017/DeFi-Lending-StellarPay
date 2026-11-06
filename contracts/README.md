# StellarPay — Stellar (Soroban) Contracts

The on-chain core of the StellarPay protocol, written in Rust for
[Soroban](https://soroban.stellar.org/) — Stellar's smart-contract runtime.

## Contracts

| Contract             | Purpose                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrapped_asset`      | Canonical wrapped token (wTKN) — mint/burn driven by the bridge                                                                                                                                                                                         |
| `oracle`             | Price feed adapter (`Reflector`-style on-chain with publisher allow-list, median-of-≥2 aggregation and heartbeat staleness). **Not** a Chainlink feed integration and **not** a Stellar Reflect feed integration; Chainlink is planned, not integrated. |
| `collateral_vault`   | Per-asset collateral accounting                                                                                                                                                                                                                         |
| `lending_pool`       | Supply, borrow, repay, withdraw; interest-rate model                                                                                                                                                                                                    |
| `liquidation`        | Automated liquidation engine                                                                                                                                                                                                                            |
| `lending_controller` | Orchestrator + cross-chain entrypoint                                                                                                                                                                                                                   |

## Build

```bash
rustup target add wasm32v1-none
cargo build --workspace --target wasm32v1-none --release
```

## Test

```bash
cargo test
```

## Deploy to testnet

Build the WASMs (wasm32v1-none, release) and run the JS deployer:

```bash
bash scripts/deploy-testnet.sh
```

`scripts/deploy-testnet.mjs` (stellar-sdk v16, no stellar CLI required) funds
the admin via friendbot, uploads the six WASMs, creates the seven contracts
(deterministic IDs via
`sha256(HashIdPreimage::ContractId{network_id, preimage})`, so re-runs are
resumable), initializes them in dependency order, verifies each contract's
on-chain instance storage, and writes `packages/sdk/src/manifest.json`,
`stellar.toml`, and the SEP-1 hosted copy at
`apps/web/public/.well-known/stellar.toml`. Secrets are stored in
`contracts/.env` (gitignored). Validate the generated `stellar.toml` with:

```bash
python3 scripts/validate-sep1.py ../stellar.toml
```

## Architecture

See [`docs/architecture.md`](../docs/architecture.md) for the full protocol
design.

## Layout

```
contracts/
├── contracts/
│   ├── wrapped_asset/
│   ├── oracle/
│   ├── collateral_vault/
│   ├── lending_pool/
│   ├── liquidation/
│   └── lending_controller/
├── tests/                  # Cross-contract integration tests
├── scripts/                # deploy-testnet.{mjs,sh} + validate-sep1.py
└── Cargo.toml              # workspace
```
