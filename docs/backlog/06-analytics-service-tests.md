# Add a test suite for the analytics service

**Labels:** `good first issue`, `testing`, `S` **Drips:** fundable — same shape
as the notification-service issue; pairs well with it for a first-time
contributor.

## Problem

`services/analytics` computes TVL-style aggregates
(`services/analytics/src/tvl.ts`) with a `test` script of `echo 'no tests yet'`.
Aggregation bugs are silent: the numbers look plausible and nothing fails.

## Scope

1. Add a `vitest` suite for `services/analytics/src/tvl.ts`.
2. Cover: empty state, a single deposit, a deposit plus a borrow, a withdrawal,
   and a rounding/boundary case.
3. If the module reads from the database, use the same mocking approach the
   indexer tests already use (or a pure in-memory fixture).

## Acceptance criteria

- [ ] `services/analytics/package.json` has a real `test` script and the
      matching dev dependencies.
- [ ] At least four tests covering the cases listed above.
- [ ] `pnpm --filter @stellar-payment-gateway/analytics test` passes.
- [ ] `docs/feature-evidence.md` § 3 changes the analytics row from
      "source-verified only" to "verified".

## Verification

```bash
pnpm --filter @stellar-payment-gateway/analytics exec tsc --noEmit
pnpm --filter @stellar-payment-gateway/analytics test
pnpm test
```

## Out of scope

- New analytics metrics or a dashboard for them.
- Performance optimisation of the aggregation query.

## References

- [`services/analytics/src/tvl.ts`](../../services/analytics/src/tvl.ts)
- [`services/indexer/tests/index.test.ts`](../../services/indexer/tests/index.test.ts)
