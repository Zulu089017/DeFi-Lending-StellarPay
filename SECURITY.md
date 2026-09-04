# Security Policy

> **StellarPay is testnet-stage and unaudited. Do not deposit real assets.**

## Audit plan

Target: **Q1 2027** — **Trail of Bits** (primary) / **Halborn** (backup), funded
by the SCF Wave 8 grant ($140k of the $200k ask). Scope: 7 Soroban contracts
(~2,500 LOC Rust), `Bridge.sol` (~400 LOC Solidity), bridge middleware (~800 LOC
TS), relayer (~200 LOC TS). Outreach 2026-08-15; quote/LOI expected by
**2026-09-15** (replace with signed quote). Pre-audit checklist:
[`docs/audit-checklist.md`](docs/audit-checklist.md).

## Reporting a vulnerability

Do **not** file public issues. Email **security@spg.xyz** with: description and
impact; PoC or steps; affected subproject and version; name for credit
(optional). Acknowledged within **3 business days**; critical fix within **30
days**; **90-day coordinated disclosure** (extensions only by mutual agreement).

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
| Low      | Informational only                     | $[LOW — fill in]      | ## Known risks (from `docs/invariants.md`) |

All contract invariants (L, Q, C, O, V, W, B) have executing tests. **No
automated test yet:** X-1…X-3 (cross-chain backing/causality — unwrap →
`Bridge.release` not wired end-to-end) and X-4 (view consistency). Theseare
audit priorities.
