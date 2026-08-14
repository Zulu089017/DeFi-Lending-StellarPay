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
- [ ] **Multi-attester signing** with staggered key release (HSM + cold
      storage + hot server)
- [ ] **Formal security audit** (Trail of Bits, $120k–$180k, Q1 2027)
- [ ] E2E testnet flow verified (Sepolia → Stellar Testnet)
- [ ] Testnet deployed + public demo URL
- [ ] Attester keys in HSM/KMS (not plaintext env vars)
- [ ] Bug bounty program (Immunefi)

**Grant ask:** ~60–70% of funds for the audit; remainder for multi-attester
signing implementation, testnet deployment, and developer documentation.

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
