# Security Model

> **Status: testnet-stage — not yet audited.** Intended security model and the
> plan to close remaining gaps before mainnet.

## Threat model

| Adversary           | Capability                    | Mitigation                                         |
| ------------------- | ----------------------------- | -------------------------------------------------- |
| Attester key leak   | Sign malicious wrap/release   | 2-of-3 `BridgeSet` (ed25519, sorted-index)         |
| Source-chain reorg  | Replay a `Locked` event       | Salts + `confirmations` on EVM watcher             |
| Stale oracle        | Borrow at bad prices          | Heartbeat + median of ≥2 publishers                |
| Underwater position | No liquidator                 | Permissionless `liquidate()`                       |
| Rate-limit bypass   | Mint $1B/hour                 | Per-hour mint circuit breaker                      |
| Admin compromise    | Upgrade/drain                 | Multi-admin threshold + 24h timelock; direct pause |
| Cross-chain replay  | Reuse an attestation          | `chain_id` in payload; EIP-712 on EVM              |
| ECDSA malleability  | Second valid sig for a digest | OZ `ECDSA` (s bound to half-order)                 |

> Economic risk design: [`docs/risk.md`](risk.md).

## Status of known gaps

All previously open contract TODOs are **closed and tested** — see
[`docs/invariants.md`](invariants.md) (L-1…L-16, Q-1…Q-9, C-1…C-8, O-1…O-5,
V-1…V-5, W-3…W-6, B-1…B-7).

**Remaining:**

- [ ] X-1…X-3 cross-system backing/causality tests (unwrap → `Bridge.release`
      not wired end-to-end; top priority)
- [ ] Live on-testnet DR dry-run (pending funded admin keys)
- [ ] Load test (1,000 users); chaos tests
- [ ] `cargo audit` / `npm audit` clean (dev/test findings only)

## Audit

Target **Q1 2027** — **Trail of Bits** (primary) / **Halborn** (backup),
confirmed in budget under the SCF Wave 8 grant; **quote pending** (expected
**2026-09-15**). Scope and full plan: [`SECURITY.md`](../SECURITY.md).

## Grant Fund Allocation

SCF Wave 8 ask: **$200,000 USD** — audit 70% ($140,000), pre-audit checklist 20%
($40,000), ops/infra 10% ($20,000).

## Bug bounty & disclosure

Bounty scope, tiers, payouts (post-audit, within 60 days; amounts are
placeholders) and the disclosure policy (90-day coordinated window, safe
harbor): [`SECURITY.md`](../SECURITY.md).
