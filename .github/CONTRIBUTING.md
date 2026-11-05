# Contributing to StellarPay

Thanks for your interest in contributing! 🎉

StellarPay is a **pre-audit, testnet-stage** protocol. Contributions that make
the protocol easier to reason about — tests, invariants, documentation,
reproducible tooling — are especially welcome.

## 1. Set up the project

The repository pins its own toolchain. Use these versions; other versions
usually work but are not what CI proves.

| Tool    | Version                                    | Install                                                      |
| ------- | ------------------------------------------ | ------------------------------------------------------------ |
| Node.js | ≥ 22.5 (CI uses 22)                        | `nvm install 22`                                             |
| pnpm    | **10.0.0** (pinned by `packageManager`)    | `corepack enable && corepack prepare pnpm@10.0.0 --activate` |
| Rust    | **1.91.0** with the `wasm32v1-none` target | `rustup toolchain install 1.91.0 --target wasm32v1-none`     |
| Docker  | ≥ 24                                       | optional — Postgres/Redis for the API, indexer and relayer   |
| npm     | bundled with Node                          | used **only** inside `contracts/`                            |

```bash
git clone https://github.com/Zulu089017/DeFi-Lending-StellarPay.git
cd DeFi-Lending-StellarPay
corepack enable && corepack prepare pnpm@10.0.0 --activate
pnpm install --frozen-lockfile     # CI uses exactly this command
```

> **Do not run `npm install` at the repository root.** The workspace is managed
> by pnpm; `contracts/` is the only npm project (it is deliberately excluded
> from `pnpm-workspace.yaml`).

### Environment files

```bash
cp apps/api/.env.example          apps/api/.env
cp apps/web/.env.example          apps/web/.env
cp services/payment/.env.example  services/payment/.env
cp services/indexer/.env.example  services/indexer/.env
cp services/cron/.env.example     services/cron/.env
```

`.env` files are git-ignored. Never commit a secret key, an attester key or a
database URL with real credentials — see [Security](#security).

## 2. Run one test (the 60-second sanity check)

```bash
pnpm --filter @stellar-payment-gateway/sdk test
```

Expected: `Test Files 1 passed (1) / Tests 7 passed (7)`.

Then the whole workspace (35 turbo tasks, ~90 s):

```bash
pnpm test
```

## 3. Per-package commands

| Package (directory)     | npm name                             | Type check                                                                          | Test                                                    | Build                                                                               |
| ----------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/api`              | `@stellar-payment-gateway/api`       | `pnpm --filter @stellar-payment-gateway/api exec tsc --noEmit`                      | `pnpm --filter @stellar-payment-gateway/api test`       | `pnpm --filter @stellar-payment-gateway/api build`                                  |
| `apps/web`              | `@stellar-payment-gateway/dashboard` | `pnpm --filter @stellar-payment-gateway/dashboard exec tsc --noEmit`                | `pnpm --filter @stellar-payment-gateway/dashboard test` | `pnpm --filter @stellar-payment-gateway/dashboard build`                            |
| `services/payment`      | `@stellar-payment-gateway/bridge`    | `…/bridge exec tsc --noEmit`                                                        | `…/bridge test`                                         | `…/bridge build`                                                                    |
| `services/cron`         | `@stellar-payment-gateway/relayer`   | `…/relayer exec tsc --noEmit`                                                       | `…/relayer test`                                        | `…/relayer build`                                                                   |
| `services/indexer`      | `@stellar-payment-gateway/indexer`   | `…/indexer exec tsc --noEmit`                                                       | `…/indexer test`                                        | `…/indexer build`                                                                   |
| `packages/sdk`          | `@stellar-payment-gateway/sdk`       | `…/sdk exec tsc --noEmit`                                                           | `…/sdk test`                                            | `…/sdk build`                                                                       |
| `contracts/` (Rust)     | —                                    | `cd contracts && cargo check --workspace --locked --target wasm32v1-none --release` | `cd contracts && cargo test --workspace --locked`       | `cd contracts && cargo build --workspace --locked --target wasm32v1-none --release` |
| `contracts/` (Solidity) | —                                    | —                                                                                   | `cd contracts && npm ci && npx hardhat test`            | `cd contracts && npx hardhat compile`                                               |

Workspace-wide shortcuts: `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm build`, `pnpm format:check`.

### Where the tests live

| Area                            | Path                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| Soroban unit tests              | next to the contract, e.g. `contracts/lending/soroban/src/lib.rs` (`#[cfg(test)] mod tests`) |
| Cross-contract + property tests | `contracts/integration-tests/src/{cross_contract,property,fuzz,governance,rewards}.rs`       |
| EVM tests                       | `contracts/lending/evm/test/Bridge.test.ts` (Hardhat + OZ upgrades plugin)                   |
| Bridge middleware               | `services/payment/tests/`                                                                    |
| Relayer / indexer               | `services/cron/tests/`, `services/indexer/tests/`                                            |
| API                             | `apps/api/src/tests/`                                                                        |
| Dashboard                       | `apps/web/tests/`                                                                            |
| SDK                             | `packages/sdk/tests/`                                                                        |

## 4. Conventions per subproject

Each subproject is its own package with its own `package.json` / `Cargo.toml`.
Follow the conventions of whichever one you touch.

### Soroban contracts (Rust)

- `cd contracts && cargo fmt --all -- --check`
- `cd contracts && cargo clippy --workspace --all-targets --locked -- -D warnings`
- Add unit tests inside the contract module; add cross-contract tests under
  `contracts/integration-tests/`.
- Keep financial arithmetic on `checked_*` operations; the CI profile enables
  `overflow-checks`.
- Follow the invariants in [`docs/invariants.md`](../docs/invariants.md): if you
  change a rule, update the document **and** its test in the same PR.
- Build for `wasm32v1-none` (not `wasm32-unknown-unknown`) — Soroban SDK 27
  rejects the latter; see
  [`contracts/BUILD_ENV_NOTES.md`](../contracts/BUILD_ENV_NOTES.md).

### EVM contracts (Solidity)

- `cd contracts && npx hardhat compile && npx hardhat test`
- Cover new branches with tests; keep EIP-712 domain separation intact
  (invariant `B-7`).
- Update the deploy script and `DEPLOYMENTS.md` if addresses change.

### TypeScript services

- TypeScript strict mode is already on — keep it on.
- `pnpm --filter <package> exec tsc --noEmit`
- `pnpm --filter <package> test` (vitest)
- Prefer `zod` for input validation at the boundary and return structured errors
  (see `apps/api/src/routes/`).

### Frontend (`apps/web`)

- Reuse the primitives in `components/ui/`; no new dependencies without
  discussion in the PR.
- All interactive elements must be keyboard-accessible and have an error / empty
  state.
- `pnpm --filter @stellar-payment-gateway/dashboard exec next lint` and
  `... build` must pass.

### Dependencies and lockfiles

| Lockfile                                                                            | When it changes                                                                                           |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm-lock.yaml`                                                                    | any workspace `package.json` change → run `pnpm install` and commit it                                    |
| `contracts/package-lock.json`                                                       | any `contracts/package.json` change → run `cd contracts && npm install --package-lock-only` and commit it |
| `package-lock.json`, `packages/sdk/package-lock.json`, `apps/api/package-lock.json` | npm mirrors of the corresponding manifest → keep them in sync with `npm install --package-lock-only`      |

CI installs with `--frozen-lockfile` / `npm ci`, so an out-of-date lockfile
fails the build.

## 5. Branching, commits and PRs

- Branch from `main`: `git checkout -b feat/my-feature` (or `fix/…`, `docs/…`,
  `test/…`).
- We use [Conventional Commits](https://www.conventionalcommits.org/), enforced
  by commitlint:

  ```
  feat(scope): description
  fix(scope): description
  refactor(scope): description
  test(scope): description
  docs: description
  security: description
  perf(scope): description
  ```

- Husky runs `lint-staged` (Prettier + ESLint) and commitlint on commit.
- Open the PR against `main` and fill in
  [`.github/PULL_REQUEST_TEMPLATE.md`](PULL_REQUEST_TEMPLATE.md). Reference the
  issue number (`Closes #123`).

### What maintainers check on review

1. **Tests.** New behaviour comes with a test that fails without the change. "I
   ran the tests" is not the same as "a test covers this".
2. **Command parity.** The commands in the PR description are the commands in
   `README.md` / `docs/developer-guide.md`.
3. **Invariant impact.** Changes to contract logic state which invariant IDs
   they touch and how the invariant document was updated.
4. **No scope creep.** One concern per PR; refactors and behaviour changes are
   separate PRs.
5. **No secrets, no unrelated lockfile churn.**

## 6. Issue labels

Issues carry up to three dimensions so contributors can filter and maintainers
can size review load:

| Dimension  | Values                                                                   | Meaning                                        |
| ---------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| Difficulty | `good first issue` · `intermediate` · `advanced`                         | How much protocol/codebase context is required |
| Area       | `contracts` · `frontend` · `sdk` · `documentation` · `infra` · `testing` | Which subproject the change touches            |
| Size       | `XS` · `S` · `M` · `L`                                                   | Estimated review/implementation effort         |

- **Difficulty** reflects onboarding cost, not importance: a `good first issue`
  may still be security-relevant.
- **Area** maps to the subprojects in [`docs/polyrepo.md`](../docs/polyrepo.md)
  so a future split doesn't orphan the labels.
- **Size** is a rough estimate — `XS` (a doc fix), `S` (a focused change +
  tests), `M` (a new endpoint/feature), `L` (a multi-subproject or
  protocol-level change).
- If you open an issue, add the labels yourself (or ask a maintainer to).

Ready-to-pick-up work is listed in the repository's GitHub issues; look for
`good first issue` and `help wanted`. The full, verified backlog — with the
issue drafts kept in the repository — is in
[`docs/backlog/`](../docs/backlog/README.md); every item there is derived from
[`docs/verification-status.md`](../docs/verification-status.md) and
[`docs/feature-evidence.md`](../docs/feature-evidence.md), not from guesswork.

## 7. Maintainer response SLA

We're a small team, but we commit to these response times so contributors aren't
left waiting:

- **Issue acknowledgement:** within **2 business days** (label/triage or a
  clarifying question).
- **First PR review:** within **5 business days** of the PR being opened (or of
  the last round of requested changes).
- **Security reports:** per [`SECURITY.md`](../SECURITY.md) — acknowledgement
  within 3 business days, critical fix within 30 days.

If you haven't heard back inside these windows, ping the PR/issue thread —
that's a signal we lost track, not an annoyance.

## 8. Security

If you discover a security vulnerability, please **do not** open a public issue
and **do not** put exploit details in a PR. Follow the disclosure process in
[`SECURITY.md`](../SECURITY.md); the threat model is in
[`docs/security.md`](../docs/security.md).

Good-faith research against the testnet deployments is authorised (safe harbour)
— see `SECURITY.md` for the exact terms.

## 9. Code of conduct

This project follows the
[Contributor Covenant](https://www.contributor-covenant.org/) — see
[`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md).
