# Deployments

> Testnet contract addresses for the StellarPay protocol. Updated after each
> testnet deployment via `contracts/scripts/deploy-testnet.sh`.
>
> **Last deployed:** 2026-08-09

## Stellar Testnet

| Contract               | Address                                                    | Explorer                                                                                                                    |
| ---------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `wrapped_asset` (wETH) | `CAII636MSZW643AQVYNVATNDQSSEXWDWNYKZA2J7CFYHKTCQ7IDPIGWL` | [Stellar Expert](https://stellar.expert/explorer/testnet/contract/CAII636MSZW643AQVYNVATNDQSSEXWDWNYKZA2J7CFYHKTCQ7IDPIGWL) |
| `wrapped_usdc` (wUSDC) | `CCVDMRJYATZE6Y4C74PA4UZREV3TWASUL34XKYJ2RJB226ZZOJYAK67M` | [Stellar Expert](https://stellar.expert/explorer/testnet/contract/CCVDMRJYATZE6Y4C74PA4UZREV3TWASUL34XKYJ2RJB226ZZOJYAK67M) |
| `oracle`               | `CDHO2OMTEDKURE4EWNP3QTDCGO7SGBT46BYAPJDZPR26YQPUN2D6IK7K` | [Stellar Expert](https://stellar.expert/explorer/testnet/contract/CDHO2OMTEDKURE4EWNP3QTDCGO7SGBT46BYAPJDZPR26YQPUN2D6IK7K) |
| `collateral_vault`     | `CDZW33FW2PZKZGUNHOMR4U5DCSRUBI6VREZFHVMW6AULABVKSGFB7YFL` | [Stellar Expert](https://stellar.expert/explorer/testnet/contract/CDZW33FW2PZKZGUNHOMR4U5DCSRUBI6VREZFHVMW6AULABVKSGFB7YFL) |
| `lending_pool`         | `CAC5WYMZJIQKPFM6FRE6GHB37MQYGBBFKOVPJ7RMV46Z3II2VVBGS5FO` | [Stellar Expert](https://stellar.expert/explorer/testnet/contract/CAC5WYMZJIQKPFM6FRE6GHB37MQYGBBFKOVPJ7RMV46Z3II2VVBGS5FO) |
| `liquidation`          | `CD5SQP6NAG6RDPYV5FFX2A4JKSTN5D2HQH5XOVCG5X63CEWSQTIUZ4WY` | [Stellar Expert](https://stellar.expert/explorer/testnet/contract/CD5SQP6NAG6RDPYV5FFX2A4JKSTN5D2HQH5XOVCG5X63CEWSQTIUZ4WY) |
| `lending_controller`   | `CBNG3R6J2S4ZP7OEKIOS2JRVOJWG6YA56UR6N4Z4ZWIOH6LEX6R4NI2X` | [Stellar Expert](https://stellar.expert/explorer/testnet/contract/CBNG3R6J2S4ZP7OEKIOS2JRVOJWG6YA56UR6N4Z4ZWIOH6LEX6R4NI2X) |

**Admin key:** `GA6ZXOF7TP3VSUHTZEKBEWW5HYIQRJJ25TJ45YRVAQXLZEEVFY6PJEZY`

**Bridge attesters (2-of-3 threshold):**

| Index | Role | Public Key                                                 |
| ----- | ---- | ---------------------------------------------------------- |
| 0     | Hot  | `GDYEJQJQDCIWZGMVPXCSXUVW3TGUH2JERXWORBRXKLDF4ZUIAQCE5DXO` |
| 1     | Warm | `GBLZVFSHNMAJW5IJLLEKSCVJVJBVUEGZ5DXUARG4CPDOKHQ7B3EFYG4W` |
| 2     | Cold | `GCPQMX62ANCNTO3VEOSGVRCQLXNWABMG6XDTDZICNBSLUSEWMUZD46PE` |

## EVM Testnet (Sepolia)

| Contract | Address                                                         | Explorer |
| -------- | --------------------------------------------------------------- | -------- |
| `Bridge` | `0x0000000000000000000000000000000000000000` (not yet deployed) | —        |

## EVM Testnet (Polygon Amoy)

| Contract | Address                                                         | Explorer |
| -------- | --------------------------------------------------------------- | -------- |
| `Bridge` | `0x0000000000000000000000000000000000000000` (not yet deployed) | —        |

---

## Web Dashboard

| App           | URL                                        |
| ------------- | ------------------------------------------ |
| **Dashboard** | [https://app.spg.xyz](https://app.spg.xyz) |

### Custom domain (Vercel)

The dashboard is served from a **stable production domain** (`app.spg.xyz`), not
a per-PR Vercel preview alias, so the URL survives redeploys. Setup steps
(require Vercel project + DNS provider access — done out-of-band, not via this
repo):

1. In the Vercel project **Settings → Domains**, add `app.spg.xyz` and assign it
   to the `production` branch (not the per-PR preview alias).
2. Add the DNS record Vercel shows for `app.spg.xyz` at the `spg.xyz` DNS
   provider (typically a `CNAME` → `cname.vercel-dns.com`, or an `A` record to
   `76.76.21.21` for the apex).
3. Verify TLS issues automatically via Let's Encrypt; confirm the dashboard
   resolves and survives a redeploy.
4. Keep `apps/web/vercel.json` unchanged — the domain is configured in the
   Vercel dashboard, not in the repo.

> **Status (2026-08-15):** all repo references have been moved to `app.spg.xyz`;
> the Vercel project + DNS changes are pending on the owner's Vercel/DNS
> credentials.

---

**Deployer script:** `contracts/scripts/deploy-testnet.mjs` **Network:** Stellar
Testnet (`Test SDF Network ; September 2015`) **RPC:**
`https://soroban-testnet.stellar.org`
