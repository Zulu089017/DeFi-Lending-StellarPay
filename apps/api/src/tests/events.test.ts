import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../index.js";
import { prisma } from "../db.js";
import { resetDb } from "./helpers/db.js";

const BIG = 9_007_199_254_740_993n; // > Number.MAX_SAFE_INTEGER

describe("GET /v1/wrap-events and /v1/unwrap-events", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("serialises 64/128-bit amounts as strings instead of throwing on BigInt", async () => {
    await prisma.wrapEvent.create({
      data: {
        id: "wrap_1",
        txHash: "0x" + "11".repeat(32),
        ledger: 123456n,
        chainId: 1,
        sourceAddr: "0xabc",
        to: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        amount: BIG,
        salt: "0x" + "22".repeat(32),
        createdAt: new Date(),
      },
    });
    await prisma.unwrapEvent.create({
      data: {
        id: "unwrap_1",
        txHash: "0x" + "33".repeat(32),
        ledger: 654321n,
        user: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        amount: BIG,
        chainId: 137,
        sourceAddr: "0x" + "44".repeat(32),
        nonce: "0x" + "55".repeat(32),
        released: false,
        createdAt: new Date(),
      },
    });

    const app = await buildApp({ logger: false });
    try {
      const wrapRes = await app.inject({ method: "GET", url: "/v1/wrap-events" });
      expect(wrapRes.statusCode).toBe(200);
      const wraps = wrapRes.json() as Array<Record<string, unknown>>;
      expect(wraps).toHaveLength(1);
      expect(wraps[0].amount).toBe(BIG.toString());
      expect(wraps[0].ledger).toBe("123456");

      const unwrapRes = await app.inject({ method: "GET", url: "/v1/unwrap-events" });
      expect(unwrapRes.statusCode).toBe(200);
      const unwraps = unwrapRes.json() as Array<Record<string, unknown>>;
      expect(unwraps).toHaveLength(1);
      expect(unwraps[0].amount).toBe(BIG.toString());
      expect(unwraps[0].released).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns an empty array when there are no events", async () => {
    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/lending-events" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
