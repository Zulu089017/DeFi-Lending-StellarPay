# Wire the unwrap -> `Bridge.release` path end to end

**Labels:** `advanced`, `contracts`, `L` **Drips:** fundable — this is the last
un-implemented leg of the bridge and it unblocks the cross-system invariants
(X-1…X-3) and the Sepolia -> Stellar end-to-end test.

## Problem

`lending_controller.unwrap` exists on Stellar and `Bridge.release` exists on
EVM, but **nothing connects them**. Today an unwrap on Stellar only records an
event; the canonical token is never released on the source chain, so the backed
amount on Stellar is never returned to the user. This is the single largest
functional gap in the repository and is called out as such in
[`docs/invariants.md`](../invariants.md) (X-2, X-3) and
[`docs/feature-evidence.md`](../feature-evidence.md).

Relevant code today:

| Piece                     | Location                                                   |
| ------------------------- | ---------------------------------------------------------- |
| Soroban unwrap            | `contracts/lending/controller/src/lib.rs` (`unwrap`)       |
| Off-chain release signing | `services/payment/src/attest/signer.ts` (`signEvmRelease`) |
| EVM release               | `contracts/lending/evm/Bridge.sol` (`release`, EIP-712)    |
| Watcher                   | `services/payment/src/stellarPayment.ts`                   |

## Scope

1. Extend the Stellar watcher in `services/payment` to detect a successful
   `unwrap` invocation on `lending_controller` and enqueue a release request
   (the same queue/shape as the existing wrap path).
2. Collect the 2-of-3 attester EIP-712 signatures for the release payload and
   submit `Bridge.release` on the correct source chain (Ethereum / Polygon).
3. Make the operation **idempotent**: a retried release must not fail with
   `Bridge__AlreadyReleased` and must not be double-counted by the indexer.
4. Record the release back on the indexer so the API can expose it
   (`GET /v1/unwrap-events` already exists — extend its payload if needed).

## Acceptance criteria

- [ ] `lending_controller.unwrap` produces a release request on the source
      chain, observable in the bridge middleware logs and in the indexer.
- [ ] The release is signed by the 2-of-3 attester quorum using the existing
      EIP-712 domain (`STELLARPAY_EIP712_DOMAIN` in
      `services/payment/src/attest/signer.ts`).
- [ ] Replaying the same unwrap is a no-op (no revert, no second transfer).
- [ ] A test proves the canonical token is released **only after** the Stellar
      unwrap succeeded (ordering guarantee, cross-system causality).
- [ ] `docs/invariants.md` § 8 is updated: X-2 and X-3 move from "not
      implemented" to "implemented and tested", with the new test names.
- [ ] `docs/feature-evidence.md` and `CHANGELOG.md` are updated.

## Verification

```bash
pnpm --filter @stellar-payment-gateway/bridge exec tsc --noEmit
pnpm --filter @stellar-payment-gateway/bridge test
(cd contracts && npm ci && npx hardhat compile && npx hardhat test)
```

## Out of scope

- Solana support.
- Mainnet deployment.
- Changing the EIP-712 domain or the attester key set.

## References

- [`docs/invariants.md`](../invariants.md) § 6 and § 8
- [`docs/feature-evidence.md`](../feature-evidence.md) § 6
- [`docs/architecture.md`](../architecture.md)
