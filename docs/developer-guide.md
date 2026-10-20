# Developer Guide

> Day-to-day workflow for StellarPay. For the contribution process (labels, PR
> expectations, review), see
> [`.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md). For the status of
> every check, see [`docs/verification-status.md`](verification-status.md).

## Prerequisites

| Tool    | Version                  | Notes                                     |
| ------- | ------------------------ | ----------------------------------------- |
| Node.js | ≥ 22.5                   | CI pins 22                                |
| pnpm    | 10.0.0                   | `corepack prepare pnpm@10.0.0 --activate` |
| Rust    | 1.91.0 + `wasm32v1-none` | Soroban SDK 27 MSRV                       |
| Docker  | ≥ 24                     | optional (Postgres / Redis)               |
| npm     | bundled with Node        | used **only** in `contracts/`             |

## Repository structure

```
apps/
  web/          # Next.js dashboard — npm name: @stellar-payment-gateway/dashboard
  api/          # Fastify REST + WebSocket API — @stellar-payment-gateway/api
  dashboard/    # Standalone analytics app — @stellar-payment-gateway/dashboard-app
  docs/  explorer/  treasury/
contracts/      # Soroban workspace (Rust) + EVM (Hardhat, npm project)
  lending/soroban  lending/controller  lending/evm
  collateral/soroban  oracle/soroban  liquidation/soroban
  treasury/soroban  governance/soroban  rewards/soroban
  integration-tests/   # cross-contract + property-based tests
packages/       # sdk, ui, config, types, utils, eslint-config, tsconfig
services/
  payment/      # Bridge middleware — @stellar-payment-gateway/bridge
  cron/         # Relayer — @stellar-payment-gateway/relayer
  indexer/      # Event indexer — @stellar-payment-gateway/indexer
  notification/ # WebSocket notifications
  analytics/    # TVL analytics
infra/          # docker, kubernetes, terraform
scripts/        # dev / build / deploy helpers
docs/           # documentation
```

> The npm scope is still `@stellar-payment-gateway/*` (inherited from the
> original skeleton). Use the **npm name** when filtering pnpm commands
> (`--filter @stellar-payment-gateway/dashboard` refers to `apps/web`).

## Local development

### 1. Install dependencies

```bash
corepack enable && corepack prepare pnpm@10.0.0 --activate
pnpm install --frozen-lockfile
```

### 2. Start infrastructure

```bash
docker compose -f infra/docker/docker-compose.dev.yml up -d
# Postgres 16 on :5432, Redis 7 on :6379
```

### 3. Configure the environment

```bash
cp apps/api/.env.example          apps/api/.env
cp apps/web/.env.example          apps/web/.env
cp services/payment/.env.example  services/payment/.env
cp services/indexer/.env.example  services/indexer/.env
cp services/cron/.env.example     services/cron/.env
```

Contract ids come from `packages/sdk/src/manifest.json`; the `.env.example`
files carry the values from the last deployment.

### 4. Build the contracts

```bash
cd contracts
cargo build --workspace --locked --target wasm32v1-none --release   # Soroban WASM
npm ci && npx hardhat compile                                        # EVM
```

### 5. Generate Prisma clients and push the schema

```bash
pnpm --filter @stellar-payment-gateway/bridge  exec prisma generate
pnpm --filter @stellar-payment-gateway/relayer exec prisma generate
pnpm --filter @stellar-payment-gateway/indexer exec prisma generate
pnpm --filter @stellar-payment-gateway/api     exec prisma generate
pnpm --filter @stellar-payment-gateway/api     exec prisma db push
```

### 6. Run the services

```bash
pnpm dev            # everything at once (Turborepo)

# or individually
pnpm --filter @stellar-payment-gateway/bridge    dev   # services/payment :4100
pnpm --filter @stellar-payment-gateway/indexer   dev   # services/indexer :4200
pnpm --filter @stellar-payment-gateway/relayer   dev   # services/cron
pnpm --filter @stellar-payment-gateway/api       dev   # apps/api         :4000
pnpm --filter @stellar-payment-gateway/dashboard dev   # apps/web         :3000
```

## Testing

```bash
pnpm test                                          # whole workspace (turbo)
pnpm --filter @stellar-payment-gateway/sdk test   # single package

# Soroban
cd contracts && cargo test --workspace --locked

# EVM
cd contracts && npm ci && npx hardhat test
```

Test locations are listed in
[`.github/CONTRIBUTING.md` → Where the tests live](../.github/CONTRIBUTING.md#2-run-one-test-the-60-second-sanity-check).

## Type checking and linting

```bash
pnpm typecheck     # tsc --noEmit across the workspace (turbo)
pnpm lint          # eslint for the packages that define a lint script
pnpm format:check  # prettier --check over json/md/yml/yaml
```

CI runs the same commands — see
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Building for production

```bash
pnpm build
```

The dashboard build needs `NEXT_PUBLIC_API_URL` and
`NEXT_PUBLIC_STELLAR_CONTROLLER` (see `apps/web/.env.example`).

## Git workflow

[Conventional Commits](https://www.conventionalcommits.org/), enforced by
commitlint:

```
feat(scope): description
fix(scope): description
refactor(scope): description
test(scope): description
docs: description
security: description
perf(scope): description
```

### Hooks

- **pre-commit** — Husky runs `lint-staged` (Prettier + ESLint) and commitlint
  on staged files.
- **pre-push** — per-service type check and test scripts.

## Adding a new package

1. Create `packages/my-package/` with a `package.json` whose name is
   `@stellar-payment-gateway/my-package`.
2. Add a `tsconfig.json` extending
   `@stellar-payment-gateway/tsconfig/base.json`.
3. Add the directory to `pnpm-workspace.yaml`.
4. Run `pnpm install` and commit the updated `pnpm-lock.yaml`.

## Adding a new contract

1. Create `contracts/my-contract/soroban/` with a `Cargo.toml` that uses the
   workspace `soroban-sdk` version (`=27.0.6`).
2. Add the member to `contracts/Cargo.toml`.
3. Add unit tests in the contract module and, if it interacts with other
   contracts, an integration test under `contracts/integration-tests/`.
4. Run `cargo fmt`,
   `cargo clippy --workspace --all-targets --locked -- -D warnings` and
   `cargo test --workspace --locked`.
5. Update `docs/invariants.md` if the contract introduces or changes an
   invariant.

## API development

- Routes: `apps/api/src/routes/`
- Middleware: `apps/api/src/middleware/`
- Tests: `apps/api/src/tests/`
- Prisma schema: `apps/api/prisma/schema.prisma`
- Validate input with `zod` at the boundary; return structured errors.

## Deployment

See [`docs/deployment.md`](deployment.md) for the deployment runbook and
[`DEPLOYMENTS.md`](../DEPLOYMENTS.md) for the current addresses and their
verification status.
