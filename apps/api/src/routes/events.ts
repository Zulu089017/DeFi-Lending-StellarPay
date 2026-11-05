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

  app.get("/v1/unwrap-events", async () => {
    const rows = await prisma.unwrapEvent.findMany({
      take: 50,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(serializeEvent);
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
