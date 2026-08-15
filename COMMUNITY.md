# Community Announcements

Ready-to-post messages for sharing StellarPay in developer communities. Copy,
paste, and post!

---

## Stellar Developer Discord (#projects or #soroban)

```
🚀 StellarPay — Cross-Chain Lending on Soroban (SCF Wave 8)

Hi everyone! I've been building a cross-chain lending protocol on Soroban and
wanted to share it with the community.

🔗 Repo: https://github.com/Zulu089017/DeFi-Lending-Platform
🌐 Live Demo: https://app.spg.xyz

What it does:
• Wraps tokens from EVM chains into Stellar-native assets via a 2-of-3
  multi-attester bridge
• Supply, borrow, and auto-liquidate on Soroban with sub-cent fees
• 7 Soroban contracts deployed to testnet (verified on Stellar Expert)
• 103 tests passing (including 26 invariant tests)
• Next.js dashboard with real-time bridge, lend, and liquidation pages

Stack: Rust (Soroban SDK 27), Solidity (Bridge.sol), TypeScript (bridge
middleware, SDK, API), Next.js 14

The project is seeking SCF Wave 8 funding for a Trail of Bits audit and
multi-attester key storage (HSM + cold storage + hot server). All code is
open source (Apache 2.0), docs are solid, CI is green.

Would love feedback, code review, or just a ⭐ if you find it interesting!
```

---

## Stellar Community Forum / GalacticTalk

**Title:** [Project] StellarPay — Cross-chain lending + automated liquidation on
Soroban

```
StellarPay is a cross-chain lending protocol that wraps tokens from Ethereum
(and soon Polygon/Solana) into Stellar-native assets, then enables supply,
borrow, and automated liquidation — all with Stellar's 5-second finality and
sub-cent fees.

**Current state (August 2026):**
- 7 Soroban contracts deployed to testnet (verified)
- EVM Bridge.sol with EIP-712 typed signatures
- 2-of-3 multi-attester bridge signing (threshold enforced on-chain)
- 103 passing tests (clippy clean, CI green)
- Next.js dashboard live at app.spg.xyz
- TypeScript SDK published
- Full documentation: architecture, invariants, threat model, deployment guide

**Seeking SCF Wave 8 funding for:**
- Trail of Bits security audit (quote pending)
- Multi-attester key storage implementation (HSM, cold storage, hot server)

**Links:**
- GitHub: https://github.com/Zulu089017/DeFi-Lending-Platform
- Live demo: https://app.spg.xyz
- Contract addresses: DEPLOYMENTS.md in repo

Happy to answer questions or take code review feedback!
```

---

## Soroban Discord (#builders or #showcase)

```
Hey Soroban builders! 👋

I built a lending protocol on Soroban and deployed it to testnet. Would love
feedback from folks who know the SDK well.

🔗 https://github.com/Zulu089017/DeFi-Lending-Platform

Key Soroban-specific details:
• 6 Soroban contracts: lending_pool, collateral_vault, oracle (median of ≥2
  publishers), liquidation engine, wrapped_asset, lending_controller
• Cross-contract calls via env.invoke_contract for wrap → mint, borrow →
  oracle.value_of + vault.deposit + pool.borrow_raw
• Ed25519 bridge attestation verification with multi-attester threshold
  (BridgeSet with Vec<BytesN<32>> + sorted-index verification)
• 26 invariant tests for lending pool + liquidation (all pass on SDK 27.0.4)
• Deterministic contract IDs with resumable deploy (stellar-sdk v16, no CLI)

If you've built on Soroban or have opinions on the contract architecture,
I'd really value your input. Also looking for early testers to try the
testnet dashboard!
```

---

## Ethereum / DeFi Discord

```
Built something that bridges Ethereum and Stellar for lending:

🌉 Cross-chain lending protocol — lock tokens on Ethereum, get wrapped
   assets on Stellar, supply/borrow/liquidate with 5s finality
🔒 Bridge security: EIP-712 typed signatures on EVM side, ed25519
   attestations on Soroban side, 2-of-3 multi-attester threshold
🧪 Testnet deployed, 103 tests, CI green

Repo: https://github.com/Zulu089017/DeFi-Lending-Platform
Demo: https://app.spg.xyz

Stack: Solidity (OZ 5.x, UUPS proxy), Rust (Soroban), TypeScript (bridge
middleware, Next.js dashboard), Postgres (indexer)

Feedback welcome — especially on the bridge security model and the EIP-712
implementation!
```

---

## Twitter/X thread

```
🚀 Built a cross-chain lending protocol on @StellarOrg Soroban

🧵 Here's what it does:

1/ Wrap tokens from Ethereum → Stellar via a 2-of-3 multi-attester bridge
   (ed25519 attestations verified on-chain)

2/ Supply as collateral, borrow against it with per-asset LTV enforcement
   using oracle median pricing

3/ Fully automated liquidation engine — anyone can liquidate underwater
   positions, 5% bonus for liquidators

4/ All 7 Soroban contracts deployed to testnet. 103 tests passing.
   Dashboard live.

5/ Seeking @StellarOrg SCF Wave 8 funding for a Trail of Bits audit and
   production key storage (HSM + cold + hot)

🔗 GitHub: https://github.com/Zulu089017/DeFi-Lending-Platform
🌐 Demo: https://app.spg.xyz

RTs and ⭐ appreciated! 🙏
```

---

## GitHub Repo Settings (do this manually)

Since API access is restricted, update these manually at
https://github.com/Zulu089017/DeFi-Lending-Platform:

1. **Description:** "Cross-chain lending protocol on Stellar Soroban — wrap EVM
   tokens, supply, borrow, auto-liquidate. Testnet deployed. SCF Wave 8."

2. **Website:** https://app.spg.xyz

3. **Topics:** `stellar` `soroban` `defi` `lending` `bridge` `cross-chain`
   `rust` `nextjs` `typescript` `solidity` `smart-contracts` `soroban-sdk`

4. **Social preview:** The repo already has og-image.svg and twitter-card.svg in
   apps/web/public/ — these will show when sharing the repo link.
