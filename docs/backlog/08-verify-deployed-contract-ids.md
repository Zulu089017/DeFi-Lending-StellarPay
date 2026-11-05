# Re-verify the deployed testnet contract IDs and add a verification script

**Labels:** `good first issue`, `infra`, `documentation`, `S` **Drips:**
fundable — needs only a Stellar CLI and a public RPC; no funded account and no
protocol knowledge.

## Problem

[`DEPLOYMENTS.md`](../../DEPLOYMENTS.md) publishes seven contract IDs for the
2026-08-09 testnet deployment. The verification pass of 2026-10-20 confirmed
that the admin account `GA6ZXO…PJEZY` really did create seven contracts on that
date, but it could **not** confirm that the seven IDs in the table are those
contracts: re-deriving the IDs from the recorded salts does not reproduce them,
and Horizon's `/contracts/{id}` returns 404 for all seven (see
[`docs/verification-status.md`](../verification-status.md) § "External facts
re-checked").

Until that is resolved, the published addresses — and the `lending_controller`
ID used by the SDK manifest, the `.env.example` files and the dashboard — should
be treated as unverified.

## Scope

1. Write a script (e.g. `contracts/scripts/verify-deployments.mjs`, or a shell
   script using the Stellar CLI) that, given the seven IDs, checks each one
   against the testnet and prints a table: contract name, ID, status, and the
   deploying transaction.
2. Use `stellar contract info <id> --network testnet`, the Soroban RPC
   `getLedgerEntries`, or Horizon's contract endpoint — whichever returns
   authoritative data.
3. If an ID turns out to be wrong, find the correct one (the admin account's
   operation history gives the created contract IDs) and update
   `DEPLOYMENTS.md`, `packages/sdk/src/manifest.json`, `stellar.toml`,
   `apps/web/public/.well-known/stellar.toml` and the `.env.example` files **in
   the same PR**.
4. Wire the script into CI as a non-blocking job (or a scheduled job) so the
   table does not silently rot again.

## Acceptance criteria

- [ ] A script exists that verifies every published contract ID and exits
      non-zero when one cannot be resolved.
- [ ] The script's output is pasted into the PR description.
- [ ] `DEPLOYMENTS.md` § "Verification status" no longer says the IDs are "not
      confirmed", or says exactly which ones are and are not.
- [ ] If any ID changed, every reference in the repository changed with it
      (`grep -r "<old-id>"` returns nothing).
- [ ] `docs/verification-status.md` is updated with the new result.

## Verification

```bash
node contracts/scripts/verify-deployments.mjs
stellar contract info CBNG3R6J2S4ZP7OEKIOS2JRVOJWG6YA56UR6N4Z4ZWIOH6LEX6R4NI2X --network testnet
```

## Out of scope

- Redeploying the contracts.
- Any change to contract code.

## References

- [`DEPLOYMENTS.md`](../../DEPLOYMENTS.md)
- [`docs/verification-status.md`](../verification-status.md)
- [`contracts/scripts/deploy-testnet.mjs`](../../contracts/scripts/deploy-testnet.mjs)
