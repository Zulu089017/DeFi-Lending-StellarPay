import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../index.js";
import { prisma } from "../db.js";
import { resetDb } from "./helpers/db.js";

describe("GET /v1/release-status", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lists unwraps that have not yet been released, with the release outcome", async () => {
    await prisma.unwrapEvent.createMany({
      data: [
        {
          id: "unwrap-1",
          txHash: "0x" + "11".repeat(32),
          ledger: 123n,
          user: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
          amount: 1_000_000n,
          chainId: 1,
          sourceAddr: "0x" + "22".repeat(32),
          nonce: "0x" + "33".repeat(32),
          released: false,
          releaseTxHash: null,
          createdAt: new Date(),
        },
        {
          id: "unwrap-2",
          txHash: "0x" + "44".repeat(32),
          ledger: 456n,
          user: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
          amount: 2_000_000n,
          chainId: 1,
          sourceAddr: "0x" + "55".repeat(32),
          nonce: "0x" + "66".repeat(32),
          released: true,
          releaseTxHash: "0x" + "77".repeat(32),
          createdAt: new Date(),
        },
      ],
    });

    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/release-status" });
      expect(res.statusCode).toBe(200);

      const rows = res.json() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].txHash).toBe("0x" + "11".repeat(32));
      expect(rows[0].released).toBe(false);
      expect(rows[0].releaseTxHash).toBeNull();
      expect(rows[0].releaseAttempts).toBe(0);
      expect(rows[0].chainId).toBe(1);
      // The terminal unlock event is not advertised: only not-yet-released
      // rows are surfaced so indexer reconciliation can see the pending
      // frontier.
    } finally {
      await app.close();
    }
  });

  it("returns an empty array when every unwrap has been released", async () => {
    await prisma.unwrapEvent.create({
      data: {
        id: "unwrap-1",
        txHash: "0x" + "11".repeat(32),
        ledger: 123n,
        user: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        amount: 1_000_000n,
        chainId: 1,
        sourceAddr: "0x" + "22".repeat(32),
        nonce: "0x" + "33".repeat(32),
        released: true,
        releaseTxHash: "0x" + "44".repeat(32),
        createdAt: new Date(),
      },
    });

    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/release-status" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("GET /v1/unwrap-events", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("exposes the back-side release fields on each persisted unwrap", async () => {
    await prisma.unwrapEvent.create({
      data: {
        id: "unwrap-1",
        txHash: "0x" + "11".repeat(32),
        ledger: 123n,
        user: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        amount: 1_000_000n,
        chainId: 1,
        sourceAddr: "0x" + "22".repeat(32),
        nonce: "0x" + "33".repeat(32),
        destination: "0x" + "44".repeat(32),
        released: true,
        releaseTxHash: "0x" + "55".repeat(32),
        releaseAttempts: 1,
        status: "released",
        createdAt: new Date(),
      },
    });

    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/unwrap-events" });
      expect(res.statusCode).toBe(200);

      const rows = res.json() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.released).toBe(true);
      expect(row.releaseTxHash).toBe("0x" + "55".repeat(32));
      expect(row.destination).toBe("0x" + "44".repeat(32));
      expect(row.releaseAttempts).toBe(1);
      expect(row.status).toBe("released");
      expect(row.txHash).toBe("0x" + "11".repeat(32));
      // The unwraps payload is a faithful mirror of the DB row: back-side
      // release fields (destination, releaseTxHash, releaseAttempts, status)
    } finally {
      await app.close();
    }
  });
});
