# Cover the SDK `wrap` / `unwrap` / `stream` paths and the dashboard UI

**Labels:** `good first issue`, `sdk`, `frontend`, `testing`, `M` **Drips:**
fundable — two independent sub-tasks; can be split into two PRs and funded
separately.

## Problem

The SDK's current test file (`packages/sdk/tests/client.test.ts`, 7 tests)
covers configuration, `supply` and the chain-id mapping. The three most
interesting paths are untested:

- `wrap()` — builds the source-chain `lock` call and the Stellar destination
  bytes.
- `unwrap()` — encodes `source_addr` into the `BytesN<32>` parameter the
  controller expects (there is a comment in `packages/sdk/src/client.ts` about
  the `scvBytes` / `scvBytesN` nuance).
- `stream()` — opens the WebSocket to the API and dispatches frames.

On the dashboard side, `apps/web/tests/button.test.tsx` (3 tests) is the only
test; the wrap/unwrap forms and the wallet-connect component are untested.

## Scope

### Part A — SDK (the smaller, better-scoped half)

1. Tests for `unwrap()` that assert the `scvBytes` payload is exactly 32 bytes
   for both a hex EVM address and an ASCII Stellar address.
2. Tests for `wrap()` that assert the `lock` call receives the right token,
   amount, destination bytes and a fresh salt.
3. A test for `stream()` that feeds a malformed frame and a valid frame and
   asserts the handler is only called for the valid one.

### Part B — dashboard

1. A test for the wrap/unwrap form validation (amount parsing, chain selection).
2. A test for the wallet-connect component's loading / error / connected states.

## Acceptance criteria

- [ ] `pnpm --filter @stellar-payment-gateway/sdk test` runs at least 12 tests,
      all passing.
- [ ] `pnpm --filter @stellar-payment-gateway/dashboard test` runs at least 5
      tests, all passing.
- [ ] The new tests fail if the corresponding production code is broken
      (demonstrated in the PR description).
- [ ] `docs/feature-evidence.md` § 4 and § 5 record the new counts.
- [ ] No new runtime dependency is added without discussion.

## Verification

```bash
pnpm --filter @stellar-payment-gateway/sdk exec tsc --noEmit
pnpm --filter @stellar-payment-gateway/sdk test
pnpm --filter @stellar-payment-gateway/dashboard exec tsc --noEmit
pnpm --filter @stellar-payment-gateway/dashboard test
```

## Out of scope

- Changing the SDK's public API.
- A live testnet integration test (see the "Sepolia -> Stellar end-to-end"
  issue).

## References

- [`packages/sdk/src/client.ts`](../../packages/sdk/src/client.ts)
- [`apps/web/components/wallet/wallet-connect.tsx`](../../apps/web/components/wallet/wallet-connect.tsx)
