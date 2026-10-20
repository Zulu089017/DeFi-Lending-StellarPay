# Contributor Backlog (issue drafts)

> **Purpose.** These are ready-to-publish GitHub issue drafts for the work that
> is **verified to be missing** in this repository. Every item was derived from
> the verification pass of 2026-10-20 — see
> [`docs/verification-status.md`](../verification-status.md) (what was executed)
> and [`docs/feature-evidence.md`](../feature-evidence.md) (feature → tests →
> status) — not from a wish list.
>
> Each draft is written so that a contributor who has never seen the codebase
> can pick it up, run the verification commands, and know when they are done.
>
> **Status:** all twelve drafts were published as GitHub issues on 2026-10-20
> (#71 – #82). The files here are the source of truth for their bodies; edit the
> file and re-publish with `gh issue edit <n> --body-file <file>` if an issue
> needs changing.

## The backlog

| #   | Issue                                                                                                                                                                                    | Labels                                        | Size | Depends on          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---- | ------------------- |
| 01  | [#71](https://github.com/Zulu089017/DeFi-Lending-StellarPay/issues/71) — [Wire the unwrap → `Bridge.release` path end to end](01-unwrap-release-wiring.md)                               | `advanced` `contracts`                        | L    | —                   |
| 02  | [#72](https://github.com/Zulu089017/DeFi-Lending-StellarPay/issues/72) — [Add the cross-system backing and causality invariants (X-1…X-3)](02-cross-system-invariants.md)                | `advanced` `contracts` `testing`              | L    | 01 (soft)           |
| 03  | [#73](https://github.com/Zulu089017/DeFi-Lending-StellarPay/issues/73) — [Test that the API's views agree with the chain (X-4)](03-api-onchain-view-consistency.md)                      | `intermediate` `testing`                      | M    | —                   |
| 04  | [#74](https://github.com/Zulu089017/DeFi-Lending-StellarPay/issues/74) — [Add `cargo audit` (RustSec) to CI](04-cargo-audit-ci.md)                                                       | `intermediate` `infra` `rust`                 | S    | —                   |
| 05  | [#75](https://github.com/Zulu089017/DeFi-Lending-StellarPay/issues/75) — [Add a test suite for the notification service](05-notification-service-tests.md)                               | `good first issue` `testing`                  | S    | —                   |
| 06  | [#76](https://github.com/Zulu089017/DeFi-Lending-StellarPay/issues/76) — [Add a test suite for the analytics service](06-analytics-service-tests.md)                                     | `good first issue` `testing`                  | S    | —                   |
| 07  | [#77](https://github.com/Zulu089017/DeFi-Lending-StellarPay/issues/77) — [Extend `pnpm lint` to every workspace package](07-lint-coverage-all-packages.md)                               | `intermediate` `infra` `javascript`           | M    | —                   |
| 08  | [#78](https://github.com/Zulu089017/DeFi-Lending-StellarPay/issues/78) — [Re-verify the deployed testnet contract IDs and add a verification script](08-verify-deployed-contract-ids.md) | `good first issue` `infra` `documentation`    | S    | —                   |
| 09  | [#79](https://github.com/Zulu089017/DeFi-Lending-StellarPay/issues/79) — [Decide and enforce the npm-lockfile policy](09-lockfile-policy-ci.md)                                          | `intermediate` `infra` `dependencies`         | S    | —                   |
| 10  | [#80](https://github.com/Zulu089017/DeFi-Lending-StellarPay/issues/80) — [Mount the attester keys as a Kubernetes Secret volume](10-attester-keys-k8s-secret.md)                         | `intermediate` `infra`                        | S    | —                   |
| 11  | [#81](https://github.com/Zulu089017/DeFi-Lending-StellarPay/issues/81) — [Cover the SDK `wrap` / `unwrap` / `stream` paths and the dashboard UI](11-sdk-and-dashboard-tests.md)          | `good first issue` `sdk` `frontend` `testing` | M    | —                   |
| 12  | [#82](https://github.com/Zulu089017/DeFi-Lending-StellarPay/issues/82) — [Deploy the dashboard and the API to a domain the project controls](12-hosted-deployment.md)                    | `intermediate` `infra`                        | M    | maintainer decision |

**Suggested funding order** (Drips): 05 → 06 → 08 → 09 → 04 → 10 → 11 → 07 → 03
→ 01 → 02 → 12. The first five need no protocol context and no funded account,
so they are the fastest path to paid contributions; 01 and 02 are the
highest-impact but need `advanced` context.

## Publishing them

> The twelve issues below are **already published** (#71 – #82). The commands
> are kept so that the set can be re-published or extended, and so that a
> contributor can file a follow-up issue in the same shape.

Each draft file is the issue body verbatim. To publish one:

```bash
cd docs/backlog
gh issue create \
  --title "Wire the unwrap -> Bridge.release path end to end" \
  --body-file 01-unwrap-release-wiring.md \
  --label advanced --label contracts --label L
```

To publish all of them, the mapping is:

| File                                 | Title                                                                     | Labels                                            |
| ------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------- |
| `01-unwrap-release-wiring.md`        | Wire the unwrap -> `Bridge.release` path end to end                       | `advanced` `contracts` `L`                        |
| `02-cross-system-invariants.md`      | Add the cross-system backing and causality invariants (X-1…X-3)           | `advanced` `contracts` `testing` `L`              |
| `03-api-onchain-view-consistency.md` | Test that the API's views agree with the chain (X-4)                      | `intermediate` `testing` `M`                      |
| `04-cargo-audit-ci.md`               | Add `cargo audit` (RustSec) to CI                                         | `intermediate` `infra` `rust` `S`                 |
| `05-notification-service-tests.md`   | Add a test suite for the notification service                             | `good first issue` `testing` `S`                  |
| `06-analytics-service-tests.md`      | Add a test suite for the analytics service                                | `good first issue` `testing` `S`                  |
| `07-lint-coverage-all-packages.md`   | Extend `pnpm lint` to every workspace package                             | `intermediate` `infra` `javascript` `M`           |
| `08-verify-deployed-contract-ids.md` | Re-verify the deployed testnet contract IDs and add a verification script | `good first issue` `infra` `documentation` `S`    |
| `09-lockfile-policy-ci.md`           | Decide and enforce the npm-lockfile policy                                | `intermediate` `infra` `dependencies` `S`         |
| `10-attester-keys-k8s-secret.md`     | Mount the attester keys as a Kubernetes Secret volume                     | `intermediate` `infra` `S`                        |
| `11-sdk-and-dashboard-tests.md`      | Cover the SDK `wrap` / `unwrap` / `stream` paths and the dashboard UI     | `good first issue` `sdk` `frontend` `testing` `M` |
| `12-hosted-deployment.md`            | Deploy the dashboard and the API to a domain the project controls         | `intermediate` `infra` `M`                        |

The label set already exists in the repository (see
[`.github/CONTRIBUTING.md`](../../.github/CONTRIBUTING.md) § "Issue labels"), so
the commands above work as-is.

## Drips notes

- Each issue is written to be **fundable**: a bounded scope, explicit acceptance
  criteria, and a verification command a reviewer can run.
- Issues that need something the project does not have (a domain, funded testnet
  keys, an HSM) say so explicitly in the **Drips** line at the top — fund those
  only after the prerequisite is in place, or scope them to the part that is not
  blocked.
- Before opening an issue for payment, check that the work is not already done:
  the verification status of every feature is in
  [`docs/feature-evidence.md`](../feature-evidence.md).
