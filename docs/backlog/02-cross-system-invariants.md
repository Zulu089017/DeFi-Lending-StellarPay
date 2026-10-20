# Add the cross-system backing and causality invariants (X-1…X-3)

**Labels:** `advanced`, `contracts`, `testing`, `L` **Drips:** fundable — the
audit checklist explicitly names these as the top priority; a reviewer will look
for them first.

## Problem

Every on-chain invariant (L, Q, C, O, V, W, B) has an executing test, but the
**cross-system** invariants — the ones that state the protocol is actually
backed — have none. They are documented as open in
[`docs/invariants.md`](../invariants.md) § 8 and listed as a remaining gap in
[`docs/security.md`](../security.md).

This issue is about the **tests**. The implementation work it depends on is
tracked in the sibling issue "Wire the unwrap -> `Bridge.release` path end to
end"; if that issue lands first, this one is unblocked. If it does not, the
tests can still be written against the documented behaviour and marked
`#[ignore]` with a reason, exactly as the earlier gaps were.

## Scope

Add the missing invariant tests:

- **X-1 — wrapped-asset backing.** For every `wrap`, the amount of the wrapped
  asset minted on Stellar equals the amount locked/burned on the source chain,
  and the total wrapped supply never exceeds the total locked amount (allowing
  for the explicit fee parameters).
- **X-2 — wrap/unwrap causality.** A wrapped token cannot be unwrapped (burned
  on Stellar, released on the source chain) more times than it was wrapped, and
  the amounts are conserved.
- **X-3 — release ordering.** `Bridge.release` is only reachable after the
  corresponding Stellar unwrap has been recorded (no release-first path).

## Acceptance criteria

- [ ] Each of X-1, X-2 and X-3 has a named `invariant_X*` test in the
      repository's existing naming style.
- [ ] The tests live next to the other integration tests, in
      `contracts/integration-tests/src/`, and are executed by
      `cargo test --workspace --locked`.
- [ ] Each test states the invariant it enforces in a doc comment, and the ID
      matches the row in `docs/invariants.md` § 8.
- [ ] `docs/invariants.md` § 8 is updated to point at the new tests.
- [ ] A failing scenario is demonstrated: the test must fail when the invariant
      is broken (e.g. by temporarily minting one extra unit).

## Verification

```bash
cd contracts
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

> Requires Rust **1.91.0** with the `wasm32v1-none` target
> (`rustup toolchain install 1.91.0 --target wasm32v1-none`). The Soroban suite
> is **not** executed in every environment — see
> [`docs/verification-status.md`](../verification-status.md).

## Out of scope

- Changing the protocol's economics (fees, close factor, LTV).
- Performance or fuzzing beyond what the existing property-test harness already
  provides.

## References

- [`docs/invariants.md`](../invariants.md) § 8
- [`contracts/integration-tests/src/cross_contract.rs`](../../contracts/integration-tests/src/cross_contract.rs)
- [`docs/audit-checklist.md`](../audit-checklist.md)
