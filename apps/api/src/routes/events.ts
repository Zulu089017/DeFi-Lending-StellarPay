import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";

/** Prisma returns `BigInt` for 64/128-bit columns; `JSON.stringify` (and thus
 *  Fastify's default serializer) throws on them. Convert to decimal strings —
 *  the same convention `/v1/markets` uses — rather than losing precision. */
function serializeEvent(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "bigint" ? v.toString() : v;
  }
  return out;
}

export async function eventsRoutes(app: FastifyInstance) {
  app.get("/v1/wrap-events", async () => {
    const rows = await prisma.wrapEvent.findMany({
      take: 50,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(serializeEvent);
  });

  /**
   * <<#71 split-release>> `GET /v1/unwrap-events` now records (and re-exposes)
   * the release outcome of a Stellar `unwrap`. The indexer's X-3
   * reconciliation compares `UnwrapEvent.released` + `UnwrapEvent.releaseTxHash`
   * against indexed EVM `Released` logs, so the API can expose (1) whether the
   * unwrap already produced a signed `Bridge.release` and (2) that release's
   * on-chain tx hash. Rows are immutable once created:
   * `txHash` + `nonce` is a unique index, so a re-processed event never
   * overwrites a previously recorded release state.
   */
  app.get("/v1/unwrap-events", async () => {
    const rows = await prisma.unwrapEvent.findMany({
      take: 50,
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => ({
      id: row.id,
      txHash: row.txHash,
      ledger: row.ledger,
      user: row.user,
      amount: row.amount,
      chainId: row.chainId,
      sourceAddr: row.sourceAddr,
      nonce: row.nonce,
      // <<#71 split-release>> back-side release fields.
      destination: row.destination,
      released: row.released,
      releaseTxHash: row.releaseTxHash,
      releaseAttempts: row.releaseAttempts,
      status: row.status,
      createdAt: row.createdAt,
    }));
  });

  /**
   * <<#71 split-release>> `GET /v1/release-status` exposes the release outcome of
   * the unwrap events the EVM release pipeline observed, so the indexer's X-3
   * reconciliation can compare its persisted rows against indexed EVM `Released`
   * logs without re-deriving the causality from raw chain data.
   */
  app.get("/v1/release-status", async () => {
    const rows = await prisma.unwrapEvent.findMany({
      where: { released: false },
      take: 50,
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => ({
      txHash: row.txHash,
      nonce: row.nonce,
      chainId: row.chainId,
      sourceAddr: row.sourceAddr,
      amount: row.amount,
      released: row.released,
      releaseTxHash: row.releaseTxHash,
      releaseAttempts: row.releaseAttempts,
      lastError: row.lastError,
      createdAt: row.createdAt,
    }));
  });

  app.get("/v1/lending-events", async (req) => {
    const q = req.query as { user?: string; asset?: string };
    const rows = await prisma.lendingEvent.findMany({
      where: { ...(q.user ? { user: q.user } : {}), ...(q.asset ? { asset: q.asset } : {}) },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(serializeEvent);
  });
}
