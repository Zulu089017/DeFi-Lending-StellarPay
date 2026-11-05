# Community Announcements

Ready-to-post messages for sharing StellarPay in developer communities. Copy,
paste, and post!

> **Accuracy note (2026-10-20).** There is **no hosted demo** — `app.spg.xyz`
> and `api.spg.xyz` have no DNS record — so the messages below point at the
> repository and a local run instead. The test counts are the ones actually
> observed (56 TypeScript tests executed locally, 17 EVM tests executed locally,
> 113 Rust `#[test]` functions in the Soroban workspace of which 42 are
> `invariant_*` tests; the Rust suite itself is executed by CI). Before posting,
> re-check [`docs/verification-status.md`](docs/verification-status.md) and
> [`DEPLOYMENTS.md`](DEPLOYMENTS.md).

---

## Stellar Developer Discord (#projects or #soroban)

```
🚀 StellarPay — Cross-Chain Lending on Soroban (SCF Wave 8)

Hi everyone! I've been building a cross-chain lending protocol on Soroban and
wanted to share it with the community.

🔗 Repo: https://github.com/Zulu089017/DeFi-Lending-StellarPay
▶️ Run it locally: pnpm install --frozen-lockfile && pnpm dev

What it does:
• Wraps tokens from EVM chains into Stellar-native assets via a 2-of-3
  multi-attester bridge
• Supply, borrow, and auto-liquidate on Soroban with sub-cent fees
• 7 Soroban contracts deployed to Stellar testnet (2026-08-09; addresses and
  their verification status in DEPLOYMENTS.md)
• 113 Rust tests in the Soroban workspace (42 of them invariant tests) +
  56 TypeScript tests + 17 EVM tests
• Next.js dashboard (Next.js 14) you can run locally against the services

Stack: Rust (Soroban SDK 27.0.6), Solidity (Bridge.sol), TypeScript (bridge
middleware, SDK, API), Next.js 14

Honest status: testnet only, not audited, no mainnet, no hosted demo yet.
The project is seeking SCF Wave 8 funding for a Trail of Bits audit and
multi-attester key storage (HSM + cold storage + hot server). All code is
open source (Apache 2.0), docs are solid, and CI runs lint, typecheck,
tests and both contract toolchains on every PR.

Would love feedback, code review, or just a ⭐ if you find it interesting!
```

---

## Stellar Community Forum / GalacticTalk

**Title:** [Project] StellarPay — cross-chain lending + automated liquidation on
Soroban

```
StellarPay is a cross-chain lending protocol that wraps tokens from Ethereum
(and soon Polygon/Solana) into Stellar-native assets, then enables supply,
borrow, and automated liquidation — all with Stellar's 5-second finality and
sub-cent fees.

**Current state (October 2026):**
- 7 Soroban contracts deployed to Stellar testnet on 2026-08-09
- EVM Bridge.sol with EIP-712 typed signatures (compiled and tested; not
  deployed to Sepolia/Amoy yet)
- 2-of-3 multi-attester bridge signing (threshold enforced on-chain)
- 113 Rust tests in the Soroban workspace, 42 of them invariant tests, plus
  56 TypeScript and 17 EVM tests
- Next.js dashboard + REST/WebSocket API + TypeScript SDK, all runnable
  locally with one `pnpm install`
- Full documentation: architecture, invariants, threat model, deployment guide

**Not yet:** a formal audit, a mainnet deployment, a hosted demo, and a bug
bounty. The dashboard and API are meant to be run locally for now.

**Seeking SCF Wave 8 funding for:**
- Trail of Bits security audit (quote pending)
- Multi-attester key storage implementation (HSM, cold storage, hot server)

**Links:**
- GitHub: https://github.com/Zulu089017/DeFi-Lending-StellarPay
- Contract addresses: DEPLOYMENTS.md in the repo
- Verification status: docs/verification-status.md in the repo

Happy to answer questions or take code review feedback!
```

---

## Soroban Discord (#builders or #showcase)

```
Hey Soroban builders! 👋

I built a lending protocol on Soroban and deployed it to testnet. Would love
feedback from folks who know the SDK well.

🔗 https://github.com/Zulu089017/DeFi-Lending-StellarPay

Key Soroban-specific details:
• 8 Soroban contracts in the workspace (6 core: lending_pool,
  collateral_vault, oracle with median-of-≥2-publishers pricing, liquidation
  engine, wrapped_asset, lending_controller — plus governance and rewards)
• Cross-contract calls via env.invoke_contract for wrap → mint, borrow →
  oracle.value_of + vault.deposit + pool.borrow_raw
• Ed25519 bridge attestation verification with multi-attester threshold
  (BridgeSet with Vec<BytesN<32>> + sorted-index verification)
• 42 invariant_* tests mapped to the invariant IDs in docs/invariants.md
• Deterministic contract IDs with resumable deploy (stellar-sdk v16, no CLI)
• Rust 1.91 + wasm32v1-none (soroban-sdk 27 rejects wasm32-unknown-unknown)

If you've built on Soroban or have opinions on the contract architecture,
I'd really value your input. Also looking for early testers to run the
stack locally and try the testnet contracts!
```

---

## Ethereum / DeFi Discord

```
Built something that bridges Ethereum and Stellar for lending:

🌉 Cross-chain lending protocol — lock tokens on Ethereum, get wrapped
   assets on Stellar, supply/borrow/liquidate with 5s finality
🔒 Bridge security: EIP-712 typed signatures on the EVM side, ed25519
   attestations on the Soroban side, 2-of-3 multi-attester threshold
🧪 Testnet deployed (Soroban side), 113 Rust + 56 TypeScript + 17 EVM tests

Repo: https://github.com/Zulu089017/DeFi-Lending-StellarPay
Note: the EVM bridge is not deployed yet — Bridge.sol is compiled and tested

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
   positions, with a liquidator bonus

4/ 7 Soroban contracts deployed to Stellar testnet. 113 Rust tests
   (42 invariant tests) + 56 TypeScript + 17 EVM tests.

5/ Still testnet-only and unaudited — no mainnet, no hosted demo yet. Full
   docs and a local one-command setup in the repo.

6/ Seeking @StellarOrg SCF Wave 8 funding for a Trail of Bits audit and
   production key storage (HSM + cold + hot)

🔗 GitHub: https://github.com/Zulu089017/DeFi-Lending-StellarPay

RTs and ⭐ appreciated! 🙏
```

---

## GitHub Repo Settings (do this manually)

Update these at https://github.com/Zulu089017/DeFi-Lending-StellarPay:

1. **Description:** "Cross-chain lending protocol on Stellar Soroban — wrap EVM
   tokens, supply, borrow, auto-liquidate. Testnet only, pre-audit. SCF Wave 8."

2. **Website:** leave empty until a project-controlled domain is live —
   `app.spg.xyz` has no DNS record today.

3. **Topics:** `stellar` `soroban` `defi` `lending` `bridge` `cross-chain`
   `rust` `nextjs` `typescript` `solidity` `smart-contracts` `soroban-sdk`

4. **Social preview:** the repo already has og-image.svg and twitter-card.svg in
   `apps/web/public/` — these will show when sharing the repo link.
