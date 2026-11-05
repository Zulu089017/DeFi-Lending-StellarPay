## What does this PR do?

<!-- One or two sentences. Link the issue: "Closes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Contract / protocol change
- [ ] Refactor (no behaviour change)
- [ ] Tests only
- [ ] Documentation / CI / tooling

## How is it tested?

<!-- Paste the commands you ran and their result (pass/fail counts).
     Use the repository's own commands:

       pnpm --filter @stellar-payment-gateway/<pkg> exec tsc --noEmit
       pnpm --filter @stellar-payment-gateway/<pkg> test
       (cd contracts && cargo test --workspace --locked)
       (cd contracts && npx hardhat test)
-->

**Commands run and results:**

```

```

**New tests added** (file + what they assert):

**Not tested / known limitations:**

## Invariant and protocol impact

<!-- If this touches contract logic: which invariant IDs (L-*, Q-*, C-*, O-*,
     V-*, W-*, B-*) are affected, and was docs/invariants.md updated?
     If not applicable, say so. -->

- Affected invariant IDs:
- `docs/invariants.md` updated: [ ] yes [ ] not needed

## Checklist

- [ ] I've read [CONTRIBUTING.md](../blob/main/.github/CONTRIBUTING.md)
- [ ] I've added/updated tests where appropriate
- [ ] I've added/updated documentation where appropriate
- [ ] New/changed public interfaces are documented
- [ ] Lockfiles are in sync (`pnpm-lock.yaml`, `contracts/package-lock.json`)
- [ ] No secrets, keys, seed phrases or real credentials are included
- [ ] The commands above match the ones documented in the README / docs
