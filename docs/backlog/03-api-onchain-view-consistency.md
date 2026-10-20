# Test that the API's views agree with the chain (X-4)

**Labels:** `intermediate`, `testing`, `M` **Drips:** fundable — bounded,
well-specified, and a good first "protocol context" contribution.

## Problem

`apps/api` serves `GET /v1/markets`, `GET /v1/positions/:user` and
`GET /v1/health-factor/:user`. Those responses are produced from the indexer's
Postgres tables — **not** from the chain. Nothing verifies that the two agree,
so a broken indexer, a missed event or a rounding difference would silently
produce a dashboard that disagrees with the protocol
([`docs/invariants.md`](../invariants.md) § 8, X-4).

## Scope

1. Add a test that, for a known on-chain state, compares the API's numbers with
   the values read directly from `lending_pool` / `collateral_vault` (via the
   Soroban RPC or the SDK).
2. Cover at least: total supplied, total borrowed, borrow index, a user's
   collateral and debt, and the health factor.
3. The test must fail loudly when the indexer is behind (missing event) or when
   the API applies a different rounding rule than the contract.

## Acceptance criteria

- [ ] A new test file (e.g. `apps/api/src/tests/consistency.test.ts` or
      `contracts/integration-tests/src/view_consistency.rs` — whichever fits the
      existing structure better) covers the six values listed above.
- [ ] The test is deterministic and does not require a live testnet: use the
      existing test fixtures / mocked RPC.
- [ ] A deliberate 1-unit divergence in the mock makes the test fail
      (demonstrate this in the PR description).
- [ ] `docs/invariants.md` § 8 marks X-4 as covered, with the test name.
- [ ] `docs/feature-evidence.md` is updated.

## Verification

```bash
pnpm --filter @stellar-payment-gateway/api exec tsc --noEmit
pnpm --filter @stellar-payment-gateway/api test
```

## Out of scope

- Rewriting the API's read model.
- Indexer performance work.

## References

- [`apps/api/src/routes/markets.ts`](../../apps/api/src/routes/markets.ts)
- [`apps/api/src/routes/positions.ts`](../../apps/api/src/routes/positions.ts)
- [`services/indexer/src/`](../../services/indexer/src)
