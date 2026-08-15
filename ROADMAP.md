# StellarPay Roadmap

> **SCF Wave 8 Grant Scope** (MVP — what this grant funds): Bridge + Lending
> Pool + Collateral Vault + Oracle + Liquidation Engine (single source chain:
> Ethereum → Stellar). Multi-attester signing, formal audit, testnet-to-mainnet
> path.

---

## 🎯 SCF Wave 8 Grant Scope (MVP — Q3 2026 – Q1 2027)

This is the tightly scoped deliverable for the initial grant:

- [x] Soroban lending pool, collateral vault, oracle, liquidation engine
- [x] EVM Bridge.sol (Ethereum)
- [x] Cross-chain bridge middleware with Ed25519 attestation
- [x] Off-chain indexer (Horizon + EVM → Postgres)
- [x] Public REST + WebSocket API
- [x] TypeScript SDK
- [x] Next.js dashboard
- [x] Freighter wallet integration
- [x] **Multi-attester signing** — 2-of-3 on-chain `BridgeSet` + off-chain
      threshold collection shipped (2026-08); staggered hardware key release
      (HSM/cold/hot) is a funded post-grant milestone
- [ ] **Formal security audit** (Trail of Bits, quote pending — outreach
      initiated 2026-08-15, Q1 2027)
- [x] E2E testnet flow verified (Sepolia → Stellar Testnet) — documented manual
      run + tabletop review in `docs/e2e-testnet-flow.md` (2026-08-15)
- [x] Testnet deployed + public demo URL — `app.spg.xyz` (2026-08-15)
- [x] Attester keys out of plaintext env vars — `ATTESTER_KEYS_FILE` mounted
      secret (2026-08-15); full HSM/KMS signing is a funded post-grant milestone
- [ ] Bug bounty program (Immunefi)

**Grant ask:** **$200,000 USD** — 70% audit, 20% pre-audit checklist, 10%
ops/infra; see
[`docs/security.md` § Grant Fund Allocation](docs/security.md#grant-fund-allocation).

---

## Q4 2026 — Production Readiness (post-grant)

- [ ] Mainnet deployment (Stellar, Ethereum)
- [ ] Chainlink oracle integration
- [ ] Rate limiting on API
- [ ] Prometheus + Grafana monitoring dashboards
- [ ] Disaster recovery runbook tested

## Q1 2027 — Ecosystem Growth (future grant)

- [ ] Polygon bridge integration
- [ ] Solana bridge integration
- [ ] Mobile wallet support (Freighter mobile, Lobstr)
- [ ] Governance token launch + airdrop
- [ ] Liquidity mining / yield farming program
- [ ] Institutional-grade API tier
- [ ] Cross-chain flash loans
- [ ] SDK v2 with improved DX
- [ ] Integration partners (wallets, aggregators)

## Q2 2027 — Advanced Features (future grant)

- [ ] Isolated margin pools
- [ ] Fixed-rate lending terms
- [ ] Credit delegation (undercollateralized loans for whitelisted borrowers)
- [ ] Cross-chain liquid staking derivatives
- [ ] DAO-governed risk parameters
- [ ] MEV-resistant liquidation auctions

## Community & Governance

- [ ] Discord server
- [ ] Monthly community calls
- [ ] Governance forum (Discourse)
- [ ] Grant program for ecosystem builders
- [ ] University research partnerships
