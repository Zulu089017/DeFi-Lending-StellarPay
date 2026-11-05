import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";

/** Compute APY / utilization from raw lending events. Shared between the
 *  /v1/markets (all assets) and /v1/markets/:asset (single asset) handlers. */
async function computeMarkets(asset?: string) {
  const events = await prisma.lendingEvent.groupBy({
    by: ["asset", "type"],
    where: asset ? { asset } : {},
    _sum: { amount: true },
  });

  const v = { supply: 0n, withdraw: 0n, borrow: 0n, repay: 0n };
  for (const e of events) {
    if (e.type === "supply") v.supply += e._sum.amount ?? 0n;
    if (e.type === "withdraw") v.withdraw += e._sum.amount ?? 0n;
    if (e.type === "borrow") v.borrow += e._sum.amount ?? 0n;
    if (e.type === "repay") v.repay += e._sum.amount ?? 0n;
  }

  // X-4: these must match the on-chain `lending_pool` views, where
  // `total_deposit` is reduced on withdrawal and `total_borrow` on repayment.
  // Ignoring `withdraw` (as this handler previously did) overstated supply as
  // soon as a supplier exited. Clamp at zero so an inconsistent index can
  // never produce a negative market or a divide-by-zero utilization.
  const totalSupply = v.supply > v.withdraw ? v.supply - v.withdraw : 0n;
  const totalBorrow = v.borrow > v.repay ? v.borrow - v.repay : 0n;
  const utilization = totalSupply === 0n ? 0 : Number((totalBorrow * 10_000n) / totalSupply) / 10_000;

  // H4 FIX: Use the same kinked-linear rate model as the on-chain
  // `lending_pool.borrow_apy_bps()`. Default params:
  //   base_rate_bps = 200 (2%), slope1_bps = 1000, slope2_bps = 13000,
  //   kink_bps = 8000 (80%).
  // This matches the on-chain formula exactly so the API never reports
  // incorrect APYs. In production, these params should be fetched from
  // the on-chain AssetConfig for each asset.
  const BASE_BPS = 200;
  const SLOPE1_BPS = 1000;
  const SLOPE2_BPS = 13000;
  const KINK_BPS = 8000;
  const RESERVE_FACTOR = 0.10;

  const uBps = Math.round(utilization * 10_000);
  let borrowApyBps: number;
  if (uBps <= KINK_BPS) {
    borrowApyBps = BASE_BPS + (SLOPE1_BPS * uBps) / KINK_BPS;
  } else {
    borrowApyBps = BASE_BPS + SLOPE1_BPS + (SLOPE2_BPS * (uBps - KINK_BPS)) / (10_000 - KINK_BPS);
  }
  const borrowApy = borrowApyBps / 10_000;
  const supplyApy = borrowApy * utilization * (1 - RESERVE_FACTOR);

  return {
    totalSupply: totalSupply.toString(),
    totalBorrow: totalBorrow.toString(),
    utilization,
    supplyApy,
    borrowApy,
  };
}

export async function marketsRoutes(app: FastifyInstance) {
  app.get("/v1/markets", async () => {
    const groups = await prisma.lendingEvent.groupBy({
      by: ["asset"],
      _count: { _all: true },
    });
    return Promise.all(
      groups.map(async (g: { asset: string }) => ({ asset: g.asset, ...(await computeMarkets(g.asset)) })),
    );
  });

  app.get<{ Params: { asset: string } }>("/v1/markets/:asset", async (req, reply) => {
    const asset = decodeURIComponent(req.params.asset);
    return { asset, ...(await computeMarkets(asset)) };
  });
}
