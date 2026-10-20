# Deploy the dashboard and the API to a domain the project controls

**Labels:** `intermediate`, `infra`, `M` **Drips:** fundable **once a domain is
available** — the work is real, but it is blocked on a decision the maintainer
has to make.

## Problem

There is no hosted deployment. `app.spg.xyz` and `api.spg.xyz` have **no DNS
record**, and the apex domain `spg.xyz` resolves to an unrelated third-party
site ("Stephenson Property Group LLC | rentals") that this project does not
control. The repository therefore claims no live demo, and the dashboard has to
be run locally.

The manifests exist (`infra/kubernetes/`, `apps/web/vercel.json`,
`infra/monitoring/`) but they point at hostnames nobody owns.

## Scope

1. **Decide on a domain.** Buy or confirm a domain the project controls
   (`stellarpay.xyz`, `stellarpay.finance`, …). This is a maintainer decision
   and a hard prerequisite — the issue stays open until it is made.
2. Point DNS at the deployment target and issue TLS (cert-manager
   `letsencrypt-prod` is already referenced in
   `infra/kubernetes/07-ingress.yaml`).
3. Deploy `apps/api` and `apps/web` with `NEXT_PUBLIC_API_URL` and
   `CORS_ORIGINS` set to the real origins — `CORS_ORIGINS` must **not** be `*`
   in production (the mechanism exists in `apps/api`).
4. Update `DEPLOYMENTS.md` (the "Web dashboard" table), `stellar.toml`
   (`ORG_URL`), `apps/web/public/.well-known/stellar.toml`, the `stellar.toml` /
   manifest defaults in `contracts/scripts/deploy-testnet.mjs`, and the README's
   "Known limitations" section.
5. Add a smoke check: a scheduled job that hits `/health` and the dashboard and
   fails loudly when the deployment is down.

## Acceptance criteria

- [ ] DNS records exist for the chosen domain and the TLS certificate is valid.
- [ ] `GET https://<api-host>/health` returns 200 and the dashboard loads real
      market data from that API.
- [ ] `CORS_ORIGINS` is an explicit allow-list, not `*`.
- [ ] Every `spg.xyz` reference in the repository is either updated or
      deliberately left with a comment explaining why.
- [ ] `DEPLOYMENTS.md` records the live URLs and the smoke-check result.
- [ ] The README's "no hosted demo" limitation is removed.

## Verification

```bash
curl -fsS https://<api-host>/health
dig +short <domain>
certbot certificates  # or: openssl s_client -connect <domain>:443 -servername <domain>
```

## Out of scope

- Mainnet contract deployment.
- Any change to the protocol itself.

## References

- [`DEPLOYMENTS.md`](../../DEPLOYMENTS.md) § "Web dashboard"
- [`infra/kubernetes/07-ingress.yaml`](../../infra/kubernetes/07-ingress.yaml)
- [`docs/deployment.md`](../deployment.md)
