// Reconciliation service: gather a snapshot of the system (on-chain views +
// indexed events), evaluate X-1 … X-4, persist an auditable run and alert on
// mismatch.
//
// Everything that touches the outside world is injected, so the orchestration
// is testable with fakes (see tests/reconcile.test.ts) while the production
// wiring lives in index.ts.

import type { PrismaClient } from "@prisma/client";
import {
  runChecks,
  type BridgeFlow,
  type LockRow,
  type MarketRow,
  type Mismatch,
  type ReconcileSnapshot,
  type ReleaseRow,
  type UnwrapRow,
  type WrapRow,
  type WrappedSupply,
} from "./rules.js";

export interface WrappedAssetRef {
  asset: string;
  contractId: string;
}

export interface ReconcileDeps {
  prisma: PrismaClient;
  /** Omitted when no on-chain reader is configured (X-1/X-4 are then skipped). */
  reader?: {
    wrappedSupply(contractId: string): Promise<bigint>;
    poolTotalDeposit(poolId: string, asset: string): Promise<bigint>;
    poolTotalBorrow(poolId: string, asset: string): Promise<bigint>;
  };
  poolContractId?: string;
  wrappedAssets: WrappedAssetRef[];
  apiUrl?: string;
  /** Unreleased unwraps older than this are reported by X-3. */
  staleAfterMs?: number;
  now?: () => Date;
  /** Rows per causality check; keeps the query bounded. */
  rowLimit?: number;
  alert?: (payload: { runId: string; mismatches: Mismatch[] }) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export interface ReconcileOutcome {
  runId: string;
  status: "ok" | "mismatch" | "error";
  checks: string[];
  skipped: string[];
  mismatchCount: number;
  mismatches: Mismatch[];
  markets: number;
  error?: string;
}

const DEFAULT_STALE_MS = 30 * 60 * 1000;
const DEFAULT_ROW_LIMIT = 500;

function toBigIntOrUndefined(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

export async function runReconciliation(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const rowLimit = deps.rowLimit ?? DEFAULT_ROW_LIMIT;
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_MS;
  const { prisma } = deps;

  const run = await prisma.reconciliationRun.create({ data: { status: "running" } });
  const checks: string[] = [];
  const skipped: string[] = [];

  try {
    // ── DB aggregates ──────────────────────────────────────────────────
    const [wrapRows, unwrapRows, lockRows, releaseRows, bridgeGroups, lendingGroups] =
      await Promise.all([
        prisma.wrapEvent.findMany({ orderBy: { ledger: "desc" }, take: rowLimit }),
        prisma.unwrapEvent.findMany({ orderBy: { ledger: "desc" }, take: rowLimit }),
        prisma.bridgeEvent.findMany({
          where: { type: { in: ["locked", "burned"] } },
          orderBy: { createdAt: "desc" },
          take: rowLimit,
        }),
        prisma.bridgeEvent.findMany({
          where: { type: "released" },
          orderBy: { createdAt: "desc" },
          take: rowLimit,
        }),
        prisma.bridgeEvent.groupBy({ by: ["chain", "type"], _sum: { amount: true } }),
        prisma.lendingEvent.groupBy({ by: ["asset", "type"], _sum: { amount: true } }),
      ]);

    const wraps: WrapRow[] = wrapRows.map((w) => ({
      txHash: w.txHash,
      ledger: w.ledger,
      chainId: w.chainId,
      salt: w.salt,
      amount: w.amount,
    }));
    const unwraps: UnwrapRow[] = unwrapRows.map((u) => ({
      txHash: u.txHash,
      ledger: u.ledger,
      chainId: u.chainId,
      nonce: u.nonce,
      amount: u.amount,
      createdAt: u.createdAt,
      released: u.released,
    }));
    const locks: LockRow[] = lockRows.map((l) => ({
      chain: l.chain,
      type: l.type,
      salt: l.salt,
      amount: l.amount,
    }));
    const releases: ReleaseRow[] = releaseRows.map((r) => ({
      chain: r.chain,
      txHash: r.txHash,
      stellarTxHash: r.stellarTxHash,
      nonce: r.nonce,
      amount: r.amount,
    }));

    const flows = new Map<string, BridgeFlow>();
    for (const group of bridgeGroups) {
      const flow = flows.get(group.chain) ?? {
        chain: group.chain,
        locked: 0n,
        burned: 0n,
        released: 0n,
      };
      const amount = group._sum.amount ?? 0n;
      if (group.type === "locked") flow.locked += amount;
      if (group.type === "burned") flow.burned += amount;
      if (group.type === "released") flow.released += amount;
      flows.set(group.chain, flow);
    }

    // ── On-chain views ─────────────────────────────────────────────────
    const wrappedSupply: WrappedSupply[] = [];
    const markets: MarketRow[] = [];
    const marketTotals = new Map<
      string,
      { supply: bigint; withdraw: bigint; borrow: bigint; repay: bigint }
    >();
    for (const group of lendingGroups) {
      const totals = marketTotals.get(group.asset) ?? {
        supply: 0n,
        withdraw: 0n,
        borrow: 0n,
        repay: 0n,
      };
      const amount = group._sum.amount ?? 0n;
      if (group.type === "supply") totals.supply += amount;
      if (group.type === "withdraw") totals.withdraw += amount;
      if (group.type === "borrow") totals.borrow += amount;
      if (group.type === "repay") totals.repay += amount;
      marketTotals.set(group.asset, totals);
    }

    if (deps.reader) {
      for (const asset of deps.wrappedAssets) {
        wrappedSupply.push({
          asset: asset.asset,
          contractId: asset.contractId,
          supply: await deps.reader.wrappedSupply(asset.contractId),
        });
      }
      checks.push("X-1");

      if (deps.poolContractId) {
        for (const [asset, totals] of marketTotals) {
          markets.push({
            asset,
            dbSupply: totals.supply,
            dbWithdraw: totals.withdraw,
            dbBorrow: totals.borrow,
            dbRepay: totals.repay,
            onChainSupply: await deps.reader.poolTotalDeposit(deps.poolContractId, asset),
            onChainBorrow: await deps.reader.poolTotalBorrow(deps.poolContractId, asset),
          });
        }
        checks.push("X-4");
      } else {
        skipped.push("X-4 (no lending pool contract configured)");
      }
    } else {
      skipped.push("X-1 (no on-chain reader configured)");
      skipped.push("X-4 (no on-chain reader configured)");
    }

    // ── API totals (optional) ──────────────────────────────────────────
    if (deps.apiUrl && markets.length > 0) {
      try {
        const fetchImpl = deps.fetchImpl ?? fetch;
        const res = await fetchImpl(`${deps.apiUrl.replace(/\/$/, "")}/v1/markets`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as Array<Record<string, unknown>>;
        for (const row of body) {
          const market = markets.find((m) => m.asset === row.asset);
          if (!market) continue;
          market.apiSupply = toBigIntOrUndefined(row.totalSupply);
          market.apiBorrow = toBigIntOrUndefined(row.totalBorrow);
        }
      } catch (err) {
        // A missing API must not fail the on-chain checks — but it must be
        // visible that the comparison used database totals instead.
        skipped.push(`API totals (${(err as Error).message})`);
      }
    }

    checks.push("X-2", "X-3");

    const snapshot: ReconcileSnapshot = {
      wrappedSupply,
      bridgeFlows: [...flows.values()],
      wraps,
      unwraps,
      locks,
      releases,
      markets,
      now,
      staleAfterMs,
    };
    const mismatches = runChecks(snapshot);

    const status = mismatches.length > 0 ? "mismatch" : "ok";
    await prisma.reconciliationRun.update({
      where: { id: run.id },
      data: {
        finishedAt: now,
        status,
        checksRun: checks.length,
        mismatchCount: mismatches.length,
        report: {
          checks,
          skipped,
          snapshot: {
            wrappedSupply: wrappedSupply.map((w) => ({ ...w, supply: w.supply.toString() })),
            bridgeFlows: [...flows.values()].map((f) => ({
              ...f,
              locked: f.locked.toString(),
              burned: f.burned.toString(),
              released: f.released.toString(),
            })),
            wraps: wraps.length,
            unwraps: unwraps.length,
            locks: locks.length,
            releases: releases.length,
            markets: markets.map((m) => ({
              asset: m.asset,
              dbSupply: m.dbSupply.toString(),
              dbWithdraw: m.dbWithdraw.toString(),
              dbBorrow: m.dbBorrow.toString(),
              dbRepay: m.dbRepay.toString(),
              apiSupply: m.apiSupply?.toString(),
              apiBorrow: m.apiBorrow?.toString(),
              onChainSupply: m.onChainSupply.toString(),
              onChainBorrow: m.onChainBorrow.toString(),
            })),
          },
        },
        mismatches: {
          create: mismatches.map((m) => ({
            invariant: m.invariant,
            subject: m.subject,
            expected: m.expected,
            actual: m.actual,
            delta: m.delta,
            message: m.message,
          })),
        },
      },
    });

    if (mismatches.length > 0 && deps.alert) {
      try {
        await deps.alert({ runId: run.id, mismatches });
      } catch {
        // Alerting is best-effort; the persisted run is the source of truth.
      }
    }

    return {
      runId: run.id,
      status,
      checks,
      skipped,
      mismatchCount: mismatches.length,
      mismatches,
      markets: markets.length,
    };
  } catch (err) {
    const message = (err as Error).message;
    await prisma.reconciliationRun
      .update({
        where: { id: run.id },
        data: { finishedAt: now, status: "error", checksRun: checks.length, errorMessage: message },
      })
      .catch(() => undefined);
    return {
      runId: run.id,
      status: "error",
      checks,
      skipped,
      mismatchCount: 0,
      mismatches: [],
      markets: 0,
      error: message,
    };
  }
}
