# Disaster Recovery Runbook

> How to recover StellarPay services from common failure scenarios.

## Severity classification

| Level             | Definition                                   | Example                         |
| ----------------- | -------------------------------------------- | ------------------------------- |
| **P1 — Critical** | Bridge halted; no mints/withdrawals possible | Mainnet bridge pod crash-looped |
| **P2 — Major**    | One chain affected; relay lagging > 10 min   | Polygon watcher stuck on reorg  |
| **P3 — Minor**    | Non-critical service degraded; API slow      | Indexer lag, stale dashboard    |

## Scenario 1: Bridge pod crashloop

**Symptoms**: `kubectl get pods -n spg` shows bridge pod restarting.

**Recovery**:

1. Check logs: `kubectl logs -n spg deploy/bridge --tail=100`
2. Common causes: RPC endpoint unreachable, invalid env var, DB connection
   refused.
3. If RPC is down: switch to backup RPC by updating the ConfigMap and rolling
   the deployment.
4. If DB is down: follow Postgres recovery (Scenario 4).
5. If the pod still won't start after fixing the root cause, scale down and back
   up: \
   `kubectl scale deploy/bridge -n spg --replicas=0 && sleep 5 && kubectl scale deploy/bridge -n spg --replicas=1`

## Scenario 2: Source-chain reorg

**Symptoms**: indexer shows gaps; API returns inconsistent data.

**Recovery**:

1. Pause the bridge: `bridge.setPaused(true)` via admin tx.
2. Identify the reorg depth from the RPC node: \
   `cast block <number> --rpc-url <RPC>`
3. Roll back the indexer cursor by N blocks: \
   `UPDATE cursors SET block = block - N WHERE chain = '<chain>';`
4. Restart the indexer pod. It replays the corrected blocks.
5. Unpause the bridge once the indexer has caught up.

## Scenario 3: Attester key compromise

**Symptoms**: unexpected mints, alerts from the rate-limit circuit breaker.

**Recovery** (within 15 min):

1. Immediately pause the bridge controller on Stellar: \
   `lending_controller.set_paused(true)` (requires admin multisig).
2. Rotate the compromised key: update the attester set on the EVM `Bridge`
   contract.
3. Update the attester secret — rotate `ATTESTER_KEYS_FILE` / `ATTESTER_KEYS` in
   the `payment-env` secret and restart the bridge deployment.
4. Audit all mints in the window between compromise and pause.
5. Unpause only after confirming no malicious mints occurred.

## Scenario 4: Postgres failure

**Symptoms**: all services return DB errors.

**Recovery**:

1. Verify DB is reachable: `psql $DATABASE_URL -c "SELECT 1"`
2. If the primary is down, promote the replica: \
   `patronictl switchover <cluster>` (if using Patroni).
3. If using managed Postgres (RDS, Cloud SQL), failover is automatic.
4. After recovery, restart all dependent pods: \
   `kubectl rollout restart deploy -n spg`

## Scenario 5: Oracle stale

**Symptoms**: `lending_pool` reverts with "price stale"; liquidations frozen.

**Recovery**:

1. Check oracle publishers are running: `kubectl logs deploy/oracle-publisher`
2. Manually push a price update via the admin key if the publisher is down:
   `oracle.set_price(asset, price)`.
3. Restart the oracle publisher pod.

## Scenario 6: Full protocol pause

Use when: security vulnerability, unprecedented market event, or coordinated
upgrade.

1. **Pause EVM bridges**: call `Bridge.setPaused(true)` on each chain
   (multisig).
2. **Pause Stellar controller**: call `lending_controller.set_paused(true)`
   (multisig).
3. **Pause API writes**: toggle the `API_READ_ONLY=true` env var.
4. Communicate via Twitter/Discord/status page.

## Emergency pause — trigger conditions & authority

Pause is the **first response** to any of the following (P1 by default):

| Trigger                 | Condition                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| Attester key compromise | Unexpected mints, rate-limit alerts, or confirmed key leak                                           |
| Oracle anomaly          | `get_price` stale (heartbeat exceeded), or publishers disagree such that the median can't be trusted |
| Active exploit / vuln   | Credible report of a P1 issue or an exploit in progress                                              |
| Market event            | Unprecedented move causing cascading liquidations faster than keepers can clear them                 |
| Deep source-chain reorg | Reorg deeper than the EVM watcher's `confirmations` requirement                                      |

**Who can trigger:**

| Surface | Call                                  | Authority                                                                     |
| ------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| Stellar | `lending_controller.set_paused(true)` | Admin multi-set (threshold), direct — no timelock by design for fast response |
| EVM     | `Bridge.setPaused(true)` (per chain)  | Multisig                                                                      |
| API     | `API_READ_ONLY=true`                  | Ops (k8s rollout)                                                             |

> Pausing the controller halts all state-changing entry points (supply,
> withdraw, supply_collateral, withdraw_collateral, borrow, repay) — see
> `docs/security.md` Open TODOs and invariant C-4. Bridge updates (attester set)
> remain timelocked (`propose_bridge` → `execute_bridge`, 24h), so pause does
> not let an admin silently swap keys.

## Rollback procedure

For a bad config/image release, or an on-chain change that must be reverted:

1. **Identify** the last known-good image tag / ConfigMap / manifest.
2. **Roll back the workload:** `kubectl rollout undo deploy/<svc> -n spg` (or
   `git revert` the manifest change and re-apply).
3. **On-chain config:** bridge/attester set changes go through
   `propose_bridge` + `execute_bridge` (24h timelock). To revert, propose the
   previous key set and wait out the timelock — or remain paused until it lands.
4. **Verify** state consistency: indexer cursors, pending-mint queue, and that
   no half-processed `Locked`/`Unwrapped` events are stranded.
5. **Log** the rollback in the dry-run log below with timestamp + root cause.

## Dry-run / tabletop log

| Date       | Type     | Scenario exercised                                     | Result | Notes                                                                                                                                                          |
| ---------- | -------- | ------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-15 | Tabletop | Attester key compromise (Scenario 3) + emergency pause | ✅     | Verified `set_paused` wiring, `propose_bridge`/`execute_bridge` rotation, and the `ATTESTER_KEYS_FILE` rotation step. Live testnet dry-run pending admin keys. |
| 2026-08-15 | Tabletop | Oracle staleness (Scenario 5)                          | ✅     | Verified `Oracle::get_price` heartbeat (300s) + `min_publishers=2` panic path and admin `set_price` recovery.                                                  |

> **Status (2026-08-15):** tabletop only. A live on-testnet dry-run (with funded
> admin keys) is the next step — see the **Live dry-run checklist** section
> above. Record timestamp + what worked / what didn't here.

## Live dry-run checklist (pending funded admin keys)

Status: **tabletop only (2026-08-15)**. The scenarios below were exercised on
paper; a live on-testnet dry-run with funded admin keys is the remaining step to
close the ROADMAP checkbox. Each item references the concrete call / command to
run.

> ⚠️ All steps below target **Stellar Testnet / Sepolia only**. Never point
> these at a network with real value.

### Pre-flight

- [ ] Confirm monitoring is live first — every alert in
      `infra/monitoring/prometheus/alerts.yml` should fire/clear in Grafana
      (`http://localhost:3001` locally). The DR triggers below are the same
      conditions the alerts watch.
- [ ] Record baseline: `bridge_pending_queue_size`, `bridge_mints_total`,
      `relayer_submissions_total` in Prometheus.
- [ ] Confirm admin multisig keys can sign `set_paused` on the controller and
      `setPaused` on the EVM Bridge (testnet deployments).

### Scenario 3 live — attester key compromise (rotate in < 15 min)

1. `curl -s localhost:4100/metrics | grep bridge_mints_total` — note baseline.
2. Pause the Stellar controller (admin multisig):
   `lending_controller.set_paused(true)`.
3. Rotate the EVM attester set: `Bridge.setAttesters(newKeys, threshold)`
   (multisig).
4. Rotate the secret: replace the value in the `payment-env` secret and restart
   the bridge deployment (`kubectl rollout restart deploy/bridge`).
5. Verify no new mints: `bridge_mints_total` unchanged during the window.
6. Unpause (`set_paused(false)`) and confirm the next wrap succeeds.
7. Record timestamp + result in the tabletop log below (new row).

### Scenario 5 live — oracle staleness

1. Let the oracle heartbeat lapse (or remove a publisher) so `get_price` reverts
   as stale; confirm `lending_pool` borrow reverts.
2. Recover: restart the oracle publisher pod / push `oracle.set_price` via
   admin.
3. Confirm borrow works again; record in the log.

### Scenario 2 live — cursor rollback

1. `UPDATE cursors SET block = block - 12 WHERE chain = 'ethereum';`
2. Restart the indexer and confirm events replay (watch
   `indexer_events_ingested_total` increase).
3. Record in the log.

### Sign-off

- [ ] All scenarios recorded in the dry-run log below with timestamps, who ran
      them, and what broke.
- [ ] ROADMAP.md checkbox ticked and security.md pre-audit line updated.

## Emergency contacts

| Role                       | Name | Contact               |
| -------------------------- | ---- | --------------------- |
| On-call engineer (primary) | —    | @spg-oncall on Signal |
| Protocol lead              | —    | —                     |
| Security lead              | —    | —                     |

> This runbook should be printed and accessible even if GitHub is unreachable.
