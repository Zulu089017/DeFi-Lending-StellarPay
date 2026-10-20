---
name: "Security hardening / audit-scope item"
about:
  "Report a non-sensitive security improvement, an untested invariant, or an
  audit-scope item"
title: "[security] "
labels: ["security", "triage"]
assignees: ""
---

<!--
  ⚠️ DO NOT USE THIS TEMPLATE FOR A LIVE VULNERABILITY.
  A GitHub issue is public. If you have found an exploitable bug — anything
  that could move funds, mint tokens, or bypass a pause — report it privately:
  https://github.com/Zulu089017/DeFi-Lending-StellarPay/security/advisories/new
  See SECURITY.md for the disclosure policy and the safe-harbour terms.
-->

This template is for **non-sensitive** security work only: a missing invariant
test, an unsafe default, a dependency with an advisory, a missing pause guard,
an area an auditor should look at.

**Type of item**

- [ ] Missing invariant test
- [ ] Missing / incomplete hardening (e.g. a pause path, a rate limit)
- [ ] Dependency or supply-chain concern (no exploit details)
- [ ] Audit-scope suggestion
- [ ] Other (describe below)

**Component**

- [ ] contracts/lending
- [ ] contracts/controller
- [ ] contracts/collateral
- [ ] contracts/oracle
- [ ] contracts/liquidation
- [ ] contracts/treasury
- [ ] contracts/evm (`Bridge.sol`)
- [ ] bridge (`services/payment`)
- [ ] relayer (`services/cron`)
- [ ] indexer (`services/indexer`)
- [ ] api (`apps/api`)
- [ ] sdk (`packages/sdk`)
- [ ] frontend (`apps/web`)
- [ ] infra / deployment

**What should be true** (the invariant or property that ought to hold):

**What is true today** (the current behaviour, without exploit details):

**Which invariant does this relate to?** (e.g. `C-3`, `B-6`, `X-1` — see
[`docs/invariants.md`](../../docs/invariants.md))

**Suggested remediation** (if you have one):

**Security impact if unaddressed** (e.g. "a compromised attester could mint
unbacked wrapped tokens" — a description, not a proof of concept)
