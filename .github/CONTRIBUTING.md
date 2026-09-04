# Contributing to StellarPay

Thanks for your interest in contributing! 🎉

## How to start

1. Fork & clone the repo (or the relevant sub-repo if you've split per
   `docs/polyrepo.md`).
2. Pick an issue or open one to discuss the change you want to make. Issues are
   labeled by **difficulty**, **area**, and **size** — see
   [Issue labels](#issue-labels) below. If you're new, start with
   `good-first-issue` and [`docs/architecture.md`](../docs/architecture.md) +
   [`docs/invariants.md`](../docs/invariants.md) to get your bearings.
3. Comment on the issue to claim it ("I'll take this") so others don't pick up
   the same work. If it's been unclaimed for a while and you're blocked, ping a
   maintainer.
4. Branch from `main`: `git checkout -b feat/my-feature`.
5. Make your change. Add tests. Run lints.
6. Open a PR against `main` with the issue number in the title or description.

## Issue labels

Every issue carries three labels so contributors can filter quickly and
maintainers can size review load:

| Dimension  | Values                                                          | Meaning                                        |
| ---------- | --------------------------------------------------------------- | ---------------------------------------------- |
| Difficulty | `good-first-issue` · `intermediate` · `advanced`                | How much protocol/codebase context is required |
| Area       | `contracts` · `frontend` · `sdk` · `docs` · `infra` · `testing` | Which subproject the change touches            |
| Size       | `XS` · `S` · `M` · `L`                                          | Estimated review/implementation effort         |

- **Difficulty** reflects onboarding cost, not importance: a `good-first-issue`
  may still be security-relevant.
- **Area** maps to the subprojects in [`docs/polyrepo.md`](../docs/polyrepo.md)
  so a future split doesn't orphan the labels.
- **Size** is a rough estimate — `XS` (a doc fix), `S` (a focused change +
  tests), `M` (a new endpoint/feature), `L` (a multi-subproject or
  protocol-level change).
- If you open an issue, add all three labels yourself (or ask a maintainer to).

## Maintainer response SLA

We're a small team, but we commit to these response times so contributors aren't
left waiting:

- **Issue acknowledgement:** within **2 business days** (label/triage or a
  clarifying question).
- **First PR review:** within **5 business days** of the PR being opened (or of
  the last round of requested changes).
- **Security reports:** per [`SECURITY.md`](../SECURITY.md) — acknowledgement
  within 3 business days, critical fix within 30 days.

If you haven't heard back inside these windows, ping the PR/issue thread —
that's a signal we lost track, not an annoyance.

## Subproject conventions

## Subproject conventions

Each subproject is its own package with its own `package.json` / `Cargo.toml`.
Please follow the conventions within whichever subproject you're contributing
to.

### Soroban contracts (Rust)

- Run `cargo fmt && cargo clippy --all-targets --all-features -- -D warnings`
- Add unit tests inside the contract module
- Add integration tests under `tests/`

### EVM contracts (Solidity)

- Run `npx hardhat test`
- Add coverage for new branches
- Update the deploy script

### TypeScript services

- Use TypeScript strict mode (it's already enabled)
- Run `npx tsc --noEmit`
- Run `npm test`

### Frontend

- Use the existing UI primitives under `components/ui/`
- No new dependencies without discussion
- All interactive elements must be keyboard-accessible

## Security

If you discover a security vulnerability, please **do not** open a public issue.
Email `security@spg.xyz` with details. See
[`docs/security.md`](../docs/security.md) for the threat model.

## Code of conduct

This project follows the
[Contributor Covenant](https://www.contributor-covenant.org/).
