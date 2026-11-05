# Frequently Asked Questions

## General

**What is StellarPay?** StellarPay is a cross-chain lending protocol built on
Stellar's Soroban smart contract platform. It wraps tokens from Ethereum,
Polygon, and Solana into Stellar-native assets, then enables lending, borrowing,
and automated liquidation with sub-cent fees and 5-second finality.

**Why Stellar instead of Ethereum L2s?** Stellar offers native sub-5-second
finality and ~$0.000005 transaction fees without requiring rollups or
sidechains. This makes it ideal for high-frequency DeFi operations like lending
and liquidation.

**Is StellarPay audited?** Not yet. A formal audit is targeted for **Q1 2027**
(Trail of Bits primary, Halborn backup); no engagement has been signed. Until
then, the protocol is in testnet-only mode. See [SECURITY.md](../SECURITY.md)
and [`docs/verification-status.md`](verification-status.md).

## Using the Protocol

**How do I bridge assets to Stellar?**

1. Connect your Freighter wallet
2. Go to the Bridge page
3. Select your source chain and token
4. Enter the amount and your Stellar destination address
5. Confirm the transaction on the source chain
6. Wait ~10-30 seconds for attestation and minting

**What assets are supported?**

- **Native**: XLM
- **Wrapped**: wETH, wUSDC (deployed on testnet — see
  [`DEPLOYMENTS.md`](../DEPLOYMENTS.md))
- More assets can be added through governance proposals

**What are the fees?**

- **Stellar network fee**: ~$0.000005 per transaction
- **Protocol fee**: 0.1% of borrow interest (configurable)
- **Liquidation bonus**: 5% for liquidators (configurable)

## Lending

**How is the interest rate determined?** StellarPay uses a kinked linear
interest rate model. Below 80% utilization, the rate increases slowly. Above
80%, it increases steeply to incentivize repayments and new deposits.

**What is the Health Factor?** Health Factor (HF) = Total Collateral Value /
Total Borrow Value. If HF < 1.0, your position can be liquidated. We recommend
maintaining HF > 1.5.

**How do liquidations work?** When a borrower's HF drops below 1.0, anyone can
liquidate up to 50% of their debt. The liquidator receives the collateral
value + a 5% bonus (minus a protocol fee). Liquidations are fully automated on
Soroban.

## Technical

**Which wallets are supported?**

- **Stellar**: Freighter (browser extension)
- **EVM**: MetaMask, WalletConnect-compatible wallets

**What chains are supported for bridging?** Ethereum mainnet, Polygon, and
Solana (coming Q4 2026).

**Can I run my own bridge/indexer?** Yes! The entire stack is open source and
designed as independent services. See the [Deployment Guide](deployment.md) and
the [Developer Guide](developer-guide.md). There is no hosted dashboard or API
today — run the stack locally.

## Security

**What happens if the bridge is compromised?** The bridge uses a multi-sig
attestation model. A threshold of attesters (default 2-of-N) must sign each
cross-chain operation. Compromising one attester is insufficient.

**Is there an emergency pause?** Yes. The protocol admin can pause all
state-changing operations (supply, borrow, withdraw, repay) in case of
emergency. View functions remain accessible.

**How do I report a security vulnerability?** Do not open a public issue. Use
GitHub's private vulnerability reporting
(<https://github.com/Zulu089017/DeFi-Lending-StellarPay/security/advisories/new>).
`security@spg.xyz` is listed as a fallback, but `spg.xyz` is not a domain this
project controls, so prefer the GitHub channel. See
[SECURITY.md](../SECURITY.md) for the disclosure policy.
