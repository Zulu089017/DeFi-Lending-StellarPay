---
name: Testing
about: Request a test, a regression test or a test-tooling improvement
title: "[test] "
labels: testing
assignees: ""
---

**What is not covered**

<!-- The behaviour, branch or invariant that currently has no test. -->

**Where should the test live**

<!-- e.g. contracts/lending/soroban/src/lib.rs (unit),
     contracts/integration-tests/src/property.rs (property),
     contracts/lending/evm/test/Bridge.test.ts (EVM),
     services/payment/tests/, apps/api/src/tests/ -->

**Which invariant / spec does it relate to**

<!-- e.g. L-6 in docs/invariants.md, or "no invariant — regression guard". -->

**How to reproduce the behaviour**

<!-- For a bug: the exact steps. For a missing feature: the API call or
     contract invocation that should be exercised. -->

**What a passing test should assert**

<!-- The property that must hold after the call. Be specific: "repay never
     exceeds outstanding debt", not "it works". -->

**Acceptance criteria**

- [ ] The test fails against the current code (or is a new capability test)
- [ ] The test passes with the intended behaviour
- [ ] The test is deterministic (no wall-clock or network dependency)
- [ ] `cargo test --workspace --locked` / `pnpm --filter <package> test` stays
      green
