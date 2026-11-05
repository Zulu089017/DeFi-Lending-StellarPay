# Mount the attester keys as a Kubernetes Secret volume

**Labels:** `intermediate`, `infra`, `S` **Drips:** fundable — a small,
well-specified hardening task that removes a real "secret in an env var" risk.

## Problem

`services/payment` supports `ATTESTER_KEYS_FILE` (a path to a mounted secret
file) precisely so that the 2-of-3 attester **secret** keys are not stored in
plaintext environment variables. The code path exists and is documented in
`services/payment/.env.example`, but the Kubernetes manifest
(`infra/kubernetes/02-payment.yaml`) still provisions the whole secret through
`envFrom: [{ secretRef: { name: payment-env } }]` — i.e. the attester keys would
land in the pod's environment, readable by anything that can read the pod spec
or `/proc/<pid>/environ`.

## Scope

1. Split the secrets: keep `payment-env` for the non-sensitive configuration,
   and create a separate `attester-keys` Secret containing the key material.
2. Mount it in `infra/kubernetes/02-payment.yaml` as a volume (`secret` volume,
   `defaultMode: 0400`) and point `ATTESTER_KEYS_FILE` at the mounted path (e.g.
   `/run/secrets/attester_keys`).
3. Document the provisioning command (Sealed Secrets / External Secrets) in
   `docs/deployment.md` § 8 and in the manifest's header comment.
4. Make sure the mounted file is **not** logged: check that the middleware never
   prints the key file's contents.

## Acceptance criteria

- [ ] `infra/kubernetes/02-payment.yaml` mounts the attester keys as a volume
      and sets `ATTESTER_KEYS_FILE` to the mount path.
- [ ] The manifest header explains how to provision the Secret out-of-band and
      states that it must not contain the keys in plaintext.
- [ ] `docs/deployment.md` § 8 documents the rotation procedure with the new
      mount.
- [ ] The `ROADMAP.md` item "Attester keys out of plaintext env vars" can be
      marked done.
- [ ] The middleware logs contain no key material (demonstrate with a grep in
      the PR description).

## Verification

```bash
kubectl apply --dry-run=client -f infra/kubernetes/02-payment.yaml
grep -rn "ATTESTER_KEYS" infra/ services/payment/.env.example
```

## Out of scope

- Buying or configuring an HSM / KMS signer (a funded post-grant milestone).
- Changing the attestation threshold or the key set.

## References

- [`infra/kubernetes/02-payment.yaml`](../../infra/kubernetes/02-payment.yaml)
- [`services/payment/.env.example`](../../services/payment/.env.example)
- [`docs/disaster-recovery.md`](../disaster-recovery.md) § key rotation
