# Extend `pnpm lint` to every workspace package

**Labels:** `intermediate`, `infra`, `javascript`, `M` **Drips:** fundable —
mechanical but valuable; it turns "lint passes" from a two-package claim into a
repository-wide one.

## Problem

`pnpm lint` currently runs **2 of 19** workspace packages: only `bridge` and
`dashboard` define a `lint` script. Everything else is only covered by
`tsc --noEmit` and the Prettier check, so style and rule violations in the API,
the SDK, the indexer, the relayer and the other apps are invisible. The README
already flags this as a known limitation.

## Scope

1. Add a `lint` script to every workspace package that has TypeScript sources,
   using the repository's shared ESLint configuration
   (`packages/eslint-config`).
2. Make the root `turbo.json` `lint` task depend on `^lint` so dependencies are
   linted in order.
3. Fix the violations that surface (or narrow the rule set deliberately, with a
   written justification per rule).
4. Make CI run the new `lint` task and **fail on errors** (warnings may stay
   warnings for now, but that must be stated in the CI job).

## Acceptance criteria

- [ ] `pnpm lint` reports a task for every workspace package that owns
      TypeScript sources (target: >= 15 of 19).
- [ ] The run exits 0 with **0 errors**.
- [ ] CI's TypeScript job runs the same command and fails on an error.
- [ ] `README.md` § "Known limitations" no longer lists the 2-of-19 coverage
      gap, and `docs/verification-status.md` records the new task count.
- [ ] `packages/eslint-config` remains the single source of the rule set.

## Verification

```bash
pnpm lint
pnpm exec prettier --check "**/*.{json,md,yml,yaml}" "!**/node_modules/**" "!**/dist/**" "!**/target/**"
```

## Out of scope

- Turning warnings into errors (a separate, follow-up decision).
- Restyling the Rust or Solidity code.

## References

- [`packages/eslint-config/`](../../packages/eslint-config)
- [`turbo.json`](../../turbo.json)
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
