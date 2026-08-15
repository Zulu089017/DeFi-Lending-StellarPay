# Demo Script — StellarPay Cross-Chain Lending Flow

> **Duration:** 3–5 minutes **Recording tool:** Loom (free), OBS (free), or
> QuickTime (macOS) **Target audience:** SCF Wave 8 grant reviewers

## Setup before recording

1. Open the live dashboard: https://app.spg.xyz
2. Open Stellar Expert testnet: https://stellar.expert/explorer/testnet
3. Have the contract addresses open from [DEPLOYMENTS.md](../DEPLOYMENTS.md)
4. Mute notifications and close unrelated tabs

## Scene-by-scene script

### Scene 1 — Intro (30s)

- **Show:** The README / dashboard landing page
- **Say:** "StellarPay is a cross-chain lending protocol built on Stellar's
  Soroban platform. Tokens from Ethereum are wrapped into Stellar-native assets,
  then supplied, borrowed, and liquidated — all with sub-cent fees and 5-second
  finality. Let me show you the full flow."

### Scene 2 — Dashboard overview (45s)

- **Show:** Navigate to the Dashboard page
- **Point out:** Markets table (wETH, wUSDC), utilization chart, stats overview
  (TVL, total supplied, total borrowed)
- **Show:** The `/bridge`, `/lend`, `/liquidations` navigation tabs
- **Say:** "This is the live dashboard connected to Stellar testnet. You can see
  real-time markets data, utilization rates, and the health of the protocol. The
  bridge page handles cross-chain wrapping, lend handles supply and borrow, and
  liquidations shows underwater positions."

### Scene 3 — Architecture (30s)

- **Show:** The architecture diagram in the README (scroll down)
- **Say:** "Here's the architecture. Users lock tokens on Ethereum via
  Bridge.sol. The off-chain bridge middleware watches for Locked events,
  attesters sign the payload with a 2-of-3 threshold, and the relayer submits
  the wrap transaction to the Soroban lending controller. The controller mints
  wrapped tokens, which users can then supply as collateral and borrow against."

### Scene 4 — Contracts on Stellar Expert (45s)

- **Show:** Stellar Expert for each contract (click through 2–3)
  - Lending controller:
    `CBNG3R6J2S4ZP7OEKIOS2JRVOJWG6YA56UR6N4Z4ZWIOH6LEX6R4NI2X`
  - Lending pool: `CAC5WYMZJIQKPFM6FRE6GHB37MQYGBBFKOVPJ7RMV46Z3II2VVBGS5FO`
  - Wrapped ETH: `CAII636MSZW643AQVYNVATNDQSSEXWDWNYKZA2J7CFYHKTCQ7IDPIGWL`
- **Say:** "All 7 Soroban contracts are deployed and verified on Stellar
  testnet. Here you can see the lending controller with its 6 storage keys —
  including the BridgeSet with 3 attester public keys and a 2-of-3 threshold,
  the admin multisig set, and the contract addresses for wrapped_asset,
  lending_pool, collateral_vault, and oracle."

### Scene 5 — Multi-attester security (45s)

- **Show:** The code for `require_bridge` in
  `contracts/lending/controller/src/lib.rs`
- **Point out:** The `BridgeSet` struct with Vec of keys and threshold
- **Point out:** The sorted-index verification loop
- **Say:** "The bridge uses multi-attester signing. Here's the on-chain
  verification — it accepts a sorted Vec of key-index and signature pairs,
  verifies each against its claimed pubkey, and requires at least the threshold
  of distinct valid attestations. The off-chain signer collects signatures from
  3 independent attesters with staggered key storage — one hot, one warm in KMS,
  one cold in HSM."

### Scene 6 — Invariant tests (30s)

- **Show:** Terminal running `cargo test --workspace` (or a screenshot of
  passing tests)
- **Say:** "The protocol has 103 passing tests, including 26 invariant tests
  covering lending pool solvency, liquidation bonus math, oracle median
  aggregation, and cross-contract integration. The CI pipeline runs clippy with
  deny-warnings, cargo fmt, and the full test suite on every push."

### Scene 7 — Close (30s)

- **Show:** Back to the dashboard
- **Say:** "StellarPay is testnet-deployed and ready for audit. We're requesting
  SCF Wave 8 funding primarily for a Trail of Bits audit and to complete the
  multi-attester signing with hardware-backed key storage. The code is open
  source, all docs are in the repo, and the live demo is at the link in the
  README. Thank you for your consideration."

## After recording

1. Upload to YouTube (unlisted) or Loom
2. Copy the embed URL
3. Update the README video placeholder with the actual URL
4. Commit the change

## Video embed code for README

```markdown
## 🎥 Demo

[![StellarPay Demo](https://img.youtube.com/vi/YOUR_VIDEO_ID/0.jpg)](https://www.youtube.com/watch?v=YOUR_VIDEO_ID)

_3-minute walkthrough: cross-chain wrap → supply → borrow → liquidation on
Stellar testnet_
```

Or for Loom:

```markdown
## 🎥 Demo

<a href="https://www.loom.com/share/YOUR_LOOM_ID">
  <img src="https://cdn.loom.com/sessions/thumbnails/YOUR_LOOM_ID.jpg" alt="StellarPay Demo" width="600">
</a>

_3-minute walkthrough: cross-chain wrap → supply → borrow → liquidation on
Stellar testnet_
```
