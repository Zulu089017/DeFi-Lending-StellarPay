import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../index.js";
import { resetDb } from "./helpers/db.js";
import { seedLendingEvent } from "./helpers/seed.js";

describe("GET /v1/markets", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns an empty array when there are no lending events", async () => {
    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/markets" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("returns per-asset stats with the kinked-rate model (util <= 0.8)", async () => {
    // On-chain model (lending_pool.borrow_apy_bps): base 200bps, slope1 1000,
    // slope2 13000, kink 80%, reserve factor 10%.
    // XLM: util = 0.4 → borrowApy = (200 + 1000*0.4/0.8)/10000 = 0.07,
    //      supplyApy = 0.07 * 0.4 * 0.9 = 0.0252
    // USDC: 2000 supply, 0 borrow → util = 0 → borrowApy = 200/10000 = 0.02
    await seedLendingEvent({ type: "supply", user: "alice", asset: "XLM", amount: 1000n });
    await seedLendingEvent({ type: "borrow", user: "alice", asset: "XLM", amount: 400n });
    await seedLendingEvent({ type: "supply", user: "bob", asset: "USDC", amount: 2000n });

    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/markets" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ asset: string } & Record<string, unknown>>;
      const xlm = body.find((m) => m.asset === "XLM")!;
      const usdc = body.find((m) => m.asset === "USDC")!;

      expect(xlm.totalSupply).toBe("1000");
      expect(xlm.totalBorrow).toBe("400");
      expect(xlm.utilization).toBeCloseTo(0.4);
      expect(xlm.borrowApy).toBeCloseTo(0.07);
      expect(xlm.supplyApy).toBeCloseTo(0.0252);

      expect(usdc.totalSupply).toBe("2000");
      expect(usdc.totalBorrow).toBe("0");
      expect(usdc.utilization).toBe(0);
      expect(usdc.borrowApy).toBeCloseTo(0.02);
      expect(usdc.supplyApy).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("applies the post-kink slope when util > 0.8", async () => {
    // XLM: util = 0.9 → borrowApy = (200 + 1000 + 13000*(0.9-0.8)/0.2)/10000 = 0.77
    await seedLendingEvent({ type: "supply", user: "alice", asset: "XLM", amount: 1000n });
    await seedLendingEvent({ type: "borrow", user: "alice", asset: "XLM", amount: 900n });

    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/markets" });
      const xlm = (res.json() as Array<Record<string, unknown>>).find(
        (m) => m.asset === "XLM",
      )!;
      expect(xlm.utilization).toBeCloseTo(0.9);
      expect(xlm.borrowApy).toBeCloseTo(0.77);
    } finally {
      await app.close();
    }
  });

  it("subtracts withdraw from totalSupply (X-4)", async () => {
    // On-chain `total_deposit` falls on withdrawal; the API must match it.
    await seedLendingEvent({ type: "supply", user: "alice", asset: "XLM", amount: 1000n });
    await seedLendingEvent({ type: "withdraw", user: "alice", asset: "XLM", amount: 400n });

    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/markets" });
      const xlm = (res.json() as Array<Record<string, unknown>>).find(
        (m) => m.asset === "XLM",
      )!;
      expect(xlm.totalSupply).toBe("600"); // 1000 - 400
    } finally {
      await app.close();
    }
  });

  it("subtracts repay from totalBorrow", async () => {
    await seedLendingEvent({ type: "supply", user: "alice", asset: "XLM", amount: 1000n });
    await seedLendingEvent({ type: "borrow", user: "alice", asset: "XLM", amount: 500n });
    await seedLendingEvent({ type: "repay", user: "alice", asset: "XLM", amount: 200n });

    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/markets" });
      const xlm = (res.json() as Array<Record<string, unknown>>).find(
        (m) => m.asset === "XLM",
      )!;
      expect(xlm.totalSupply).toBe("1000");
      expect(xlm.totalBorrow).toBe("300"); // 500 - 200
    } finally {
      await app.close();
    }
  });
});

describe("GET /v1/markets/:asset", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns stats for a single asset", async () => {
    await seedLendingEvent({ type: "supply", user: "alice", asset: "XLM", amount: 1000n });
    await seedLendingEvent({ type: "borrow", user: "alice", asset: "XLM", amount: 400n });
    await seedLendingEvent({ type: "supply", user: "bob", asset: "USDC", amount: 2000n });

    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/markets/XLM" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.asset).toBe("XLM");
      expect(body.totalSupply).toBe("1000");
      expect(body.totalBorrow).toBe("400");
      expect(body.utilization).toBeCloseTo(0.4);
    } finally {
      await app.close();
    }
  });

  it("returns zeroed stats for an asset with no events", async () => {
    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/markets/XLM" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.asset).toBe("XLM");
      expect(body.totalSupply).toBe("0");
      expect(body.totalBorrow).toBe("0");
      expect(body.utilization).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("decodes URI-encoded asset symbols", async () => {
    await seedLendingEvent({ type: "supply", user: "alice", asset: "USDC", amount: 500n });
    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/markets/USDC" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.asset).toBe("USDC");
      expect(body.totalSupply).toBe("500");
    } finally {
      await app.close();
    }
  });
});
