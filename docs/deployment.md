# Deployment Guide

This guide walks through deploying the StellarPay stack from a clean machine to
a public mainnet-like cluster.

## 0. Prerequisites

- A Stellar keypair (use `stellar keys generate deployer`)
- An EVM keypair with ETH/MATIC for gas
- A Postgres database (managed or self-hosted)
- A container registry (DockerHub, GHCR, ECR, etc.)
- A Kubernetes cluster (EKS, GKE, DO, k3s, etc.)
- DNS records for `spg.xyz` and `api.spg.xyz`

## 1. Deploy contracts

```bash
# Stellar
cd contracts
cargo build --workspace --target wasm32v1-none --release
bash scripts/deploy-testnet.sh   # deploy to testnet (mainnet: edit .env / script)

# EVM (Ethereum + Polygon)
cd ../contracts
npm install
npx hardhat run scripts/deploy.ts --network mainnet
npx hardhat run scripts/deploy.ts --network polygon
```

The Stellar deployer (`scripts/deploy-testnet.mjs`) handles friendbot funding,
wasm upload, contract creation, initialization in dependency order, an on-chain
read-back verification of every contract, and writes
`packages/packages/sdk/src/manifest.json`, `stellar.toml`, and the SEP-1 hosted
copy at `apps/web/public/.well-known/stellar.toml`. Contract IDs are
deterministic (salt = sha256(saltLabel)) so re-runs resume cleanly. Secrets live
in `contracts/.env` (gitignored) and are auto-generated + funded on first run.
Commit `packages/packages/sdk/src/manifest.json`, `stellar.toml`, and the
frontend copy.

> ⚠️ Redeploying after a **contract code change**: the salts do not depend on
> wasm bytes, so a re-run hits "contract already exists" and resumes with the
> OLD wasm. To ship new contract code, bump the saltLabel in
> `deploy-testnet.mjs` (or use a fresh admin keypair).

## 2. Build & push images

```bash
REGISTRY=ghcr.io/stellar-payment-gateway TAG=0.1.0 bash scripts/build-images.sh
```

## 3. Configure secrets

Replace the secrets in `infra/k8s/01-postgres.yaml`, `02-bridge.yaml`, etc. with
real values, ideally sealed with
[Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets) or an external
secret manager. The Stellar bridge signers must match the attester keys written
to `contracts/.env` by the deploy script (see `docs/security.md`).

## 4. Deploy the cluster

```bash
bash scripts/deploy-k8s.sh
```

## 5. Verify

```bash
kubectl -n spg get pods
kubectl -n spg port-forward svc/api 4000:80
curl localhost:4000/health
```

## 6. Set up TLS

Install [cert-manager](https://cert-manager.io/) and a ClusterIssuer for Let's
Encrypt. Apply `infra/k8s/07-ingress.yaml` once the issuer is ready.

## 7. Monitoring (optional but recommended)

- Prometheus + Grafana for metrics
- Loki or Datadog for logs
- Sentry for error tracking
- A pager for `bridge` and `relayer` uptime

## 8. Key storage & attester security

### Multi-attester signing (2-of-3)

The bridge middleware uses a 2-of-3 threshold signing scheme. Each attester key
must be stored with a different security posture to achieve the staggered key
release model described in `docs/security.md`:

| Key                   | Storage                                                                   | Location                | Compromise risk                                         |
| --------------------- | ------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| **Attester A** (hot)  | Environment variable or Kubernetes Secret                                 | Bridge pod / cloud VM   | Low — 2-of-3 threshold means this alone is insufficient |
| **Attester B** (warm) | AWS KMS / GCP Cloud KMS / Azure Key Vault                                 | Cloud HSM-backed key    | Medium — requires cloud provider credential compromise  |
| **Attester C** (cold) | Hardware security module (YubiHSM, Ledger, or offline air-gapped machine) | Physical safe / offline | High — requires physical access                         |

**Current implementation (testnet):** the bridge service loads attester keys
from a mounted secret file (`ATTESTER_KEYS_FILE`) injected by a secrets manager
(Kubernetes Secret / Docker secret / Vault agent / Doppler), falling back to the
`ATTESTER_KEYS` env var for local development — see
`services/payment/.env.example`. Keys are no longer required to sit in plaintext
env vars. Full **AWS KMS / GCP Cloud KMS / Azure Key Vault**-backed signing (and
hardware-backed cold storage) is a **funded post-grant milestone**; until then
this staggered posture is the target and the secrets-file path is the minimum
bar before mainnet.

**Key rotation procedure:**

1. Generate new attester keypair(s).
2. Propose bridge update via `propose_bridge(new_keys, threshold)`.
3. Wait 24h timelock (`TIMELOCK_LEDGERS = 17_280`).
4. Execute with `execute_bridge()`.
5. Securely decommission old keys.

**Compromise response:** See `docs/disaster-recovery.md` § Scenario 3.

## 9. Mainnet checklist

- [ ] All secrets stored in external secret manager
- [ ] Admin keys held in multisig (e.g. Gnosis Safe on each chain)
- [ ] Attester set is 2-of-3 with at least one off-cloud signer (see § 8 above)
- [ ] Oracle publishers are duplicated and rate-limited
- [ ] `Paused` is `false` on the controller
- [ ] Frontend env vars updated with mainnet addresses
- [ ] DNS + TLS live
- [ ] Health-factor circuit-breaker tested
- [ ] Security audit completed
