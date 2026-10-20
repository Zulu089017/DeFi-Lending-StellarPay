# Add `cargo audit` (RustSec) to CI

**Labels:** `intermediate`, `infra`, `rust`, `S` **Drips:** fundable — small,
self-contained, and it closes a gap that is explicitly listed in
[`docs/security.md`](../security.md) and
[`docs/feature-evidence.md`](../feature-evidence.md).

## Problem

The repository's dependency posture is only checked for the TypeScript side (and
even there the audit step is advisory). The Rust workspace — which holds all the
value — has **no advisory scan at all**. `docs/security.md` lists "`cargo audit`
/ `npm audit` clean" as a remaining gap.

## Scope

1. Add a `cargo audit` step to the `stellar-contracts` job in
   `.github/workflows/ci.yml`, or as a separate lightweight job.
2. Pin `cargo-audit` (via `rustsec/audit-check@v2` or
   `taiki-e/install-action@cargo-audit`) so the action version is immutable.
3. Decide and document the policy for findings:
   - **deny** for advisories affecting the contract crates' direct dependencies,
     or
   - **advisory** (`continue-on-error`) with an issue opened automatically.
4. Fix or `ignore` any advisory that the scan reports, with a comment in
   `contracts/Cargo.lock` explaining why.
5. Document the policy in `docs/security.md` and in `.github/CONTRIBUTING.md`
   (so contributors know what a new dependency has to pass).

## Acceptance criteria

- [ ] The workflow has a named job/step that runs the Rust advisory scan.
- [ ] The action is pinned to a version/immutable ref.
- [ ] The job's behaviour on a finding is documented and matches the
      implementation (no silent `|| true` without a comment).
- [ ] `contracts/Cargo.lock` contains no un-ignored advisory, or each one has a
      written justification.
- [ ] `docs/security.md` moves the `cargo audit` item out of the "remaining"
      list.
- [ ] The workflow file still passes the repository's Prettier check.

## Verification

```bash
cargo install cargo-audit --locked
cargo audit
pnpm exec prettier --check ".github/workflows/*.yml"
```

## Out of scope

- Bumping the Soroban SDK.
- Adding `npm audit` to the TypeScript jobs (separate issue).

## References

- [`docs/security.md`](../security.md) § "Status of known gaps"
- [`docs/audit-checklist.md`](../audit-checklist.md) § "CI toolchain pins"
