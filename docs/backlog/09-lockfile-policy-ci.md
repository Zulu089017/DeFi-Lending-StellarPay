# Decide and enforce the npm-lockfile policy

**Labels:** `intermediate`, `infra`, `dependencies`, `S` **Drips:** fundable —
removes an ambiguity that has already broken `npm ci` twice in this repository's
history.

## Problem

The repository carries **four** npm lockfiles (`package-lock.json`,
`packages/sdk/package-lock.json`, `apps/api/package-lock.json`,
`contracts/package-lock.json`) in addition to `pnpm-lock.yaml`. The first three
mirror the pnpm workspace, but nothing in CI installs them — CI uses
`pnpm install --frozen-lockfile` for the workspace and `npm ci` only inside
`contracts/`.

Because nothing checks them, all three drifted out of sync with their manifests
and `npm ci` failed in each of them (the exact npm errors are recorded in
[`docs/verification-status.md`](../verification-status.md) § "Lockfile drift
found and fixed"). They have been regenerated, but the recurrence risk remains.

## Scope

Pick one of two policies and implement it:

- **Option A — keep the mirrors and enforce them.** Add a CI job that runs
  `npm ci --dry-run` (or `npm install --package-lock-only` +
  `git diff --exit-code`) in the three mirrored directories, so drift fails the
  build.
- **Option B — delete the mirrors.** Remove the three lockfiles and document
  that npm users must not run `npm install` at the root; keep only
  `pnpm-lock.yaml` and `contracts/package-lock.json`.

Whichever option is chosen, document it in:

- [`.github/CONTRIBUTING.md`](../../.github/CONTRIBUTING.md) § "Dependencies and
  lockfiles"
- [`docs/developer-guide.md`](../developer-guide.md)
- [`docs/verification-status.md`](../verification-status.md) § "Lockfile policy"

## Acceptance criteria

- [ ] The chosen policy is stated in one place and referenced from the three
      documents above.
- [ ] A CI job (option A) or the removal itself (option B) is in the workflow.
- [ ] Deliberately breaking the sync (option A) makes the new job fail —
      demonstrated in the PR description.
- [ ] `CONTRIBUTING.md` no longer tells contributors to keep four lockfiles in
      sync if option B was chosen.

## Verification

```bash
npm ci --dry-run          # root
(cd packages/sdk && npm ci --dry-run)
(cd apps/api && npm ci --dry-run)
(cd contracts && npm ci --dry-run)
pnpm install --frozen-lockfile
```

## Out of scope

- Migrating the workspace off pnpm.
- Upgrading dependencies (this issue is about lockfile hygiene only).

## References

- [`docs/verification-status.md`](../verification-status.md) § "Lockfile policy"
- [`.github/CONTRIBUTING.md`](../../.github/CONTRIBUTING.md)
