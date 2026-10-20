# Security Policy

> **StellarPay is testnet-stage and unaudited. Do not deposit real assets.**

## Audit plan

Target: **Q1 2027** — **Trail of Bits** (primary) / **Halborn** (backup), funded
by the SCF Wave 8 grant ($140k of the $200k ask). Scope (line counts measured
from the tree on 2026-10-20): **8 Soroban contracts** (~6,200 lines of Rust,
including the in-file `#[cfg(test)]` modules), `Bridge.sol` + `WrappedToken.sol`
(~415 lines of Solidity), bridge middleware (~1,600 lines of TypeScript),
relayer (~190 lines of TypeScript), API + indexer + SDK. Outreach 2026-08-15;
quote/LOI expected by **2026-09-15** (replace with signed quote). Pre-audit
checklist: [`docs/audit-checklist.md`](docs/audit-checklist.md).

> No audit engagement has been signed. Nothing in this repository should be read
> as an audit result.

## Reporting a vulnerability

Do **not** file public issues and **do not** open a pull request with exploit
details.

**Preferred channel — GitHub private vulnerability reporting:**

<https://github.com/Zulu089017/DeFi-Lending-StellarPay/security/advisories/new>

**Alternative — email `security@spg.xyz`.** Note that `spg.xyz` is _not_ a
domain this project currently controls (it resolves to an unrelated third-party
site), so a report sent there may not reach the maintainers. Use the GitHub
channel above whenever it is available, and treat the address as a fallback
only.

Include: description and impact; PoC or steps; affected subproject and version;
name for credit (optional). Acknowledged within **3 business days**; critical
fix within **30 days**; **90-day coordinated disclosure** (extensions only by
mutual agreement).

**Safe harbor:** good-faith research against testnet deployments is authorized —
no legal action. No mainnet exists; don't exfiltrate/destroy data or disrupt
users.

## Bug bounty (post-audit)

Launch within 60 days of the audit report. **In scope:** the 7 Soroban contracts
and `Bridge.sol` (EVM testnets). **Out of scope until mainnet:** off-chain
services, SDK, dashboards. Paid in wTKN.

| Severity | Example                                | Payout (USD)          |
| -------- | -------------------------------------- | --------------------- |
| Critical | Unauthorized mint / loss of user funds | $[CRITICAL — fill in] |
| High     | Insolvency, health-factor bypass       | $[HIGH — fill in]     |
| Medium   | Griefing / minor corruption            | $[MEDIUM — fill in]   |
| Low      | Informational only                     | $[LOW — fill in]      |

## Known risks (from `docs/invariants.md`)

All contract invariants (L, Q, C, O, V, W, B) have executing tests. **No
automated test yet:** X-1…X-3 (cross-chain backing/causality — unwrap →
`Bridge.release` not wired end-to-end) and X-4 (view consistency). These are
audit priorities.

The exact status of every check in this repository — including the checks that
could **not** be executed in the last verification pass — is recorded in
[`docs/verification-status.md`](docs/verification-status.md).
