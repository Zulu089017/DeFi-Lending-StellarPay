import { describe, it, expect } from "vitest";
import {
  checkX1,
  checkX2,
  checkX3,
  checkX4,
  normalizeHex,
  runChecks,
  type ReconcileSnapshot,
} from "../src/reconcile/rules.js";
import { runReconciliation } from "../src/reconcile/service.js";

const NOW = new Date("2026-11-01T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function snapshot(overrides: Partial<ReconcileSnapshot> = {}): ReconcileSnapshot {
  return {
    wrappedSupply: [],
    bridgeFlows: [],
    wraps: [],
    unwraps: [],
    locks: [],
    releases: [],
    markets: [],
    now: NOW,
    staleAfterMs: HOUR,
    ...overrides,
  };
}

const salt = "0x" + "ab".repeat(32);
/** Must match the `unwrap.txHash` used by the X-3 fixtures below. */
const stellarTxHash = "0x" + "ee".repeat(32);

describe("X-1 backing conservation", () => {
  it("nets releases out of the backing (wrapped + released == locked + burned)", () => {
    const mismatches = checkX1(
      snapshot({
        wrappedSupply: [{ asset: "wETH", contractId: "C1", supply: 90n }],
        bridgeFlows: [{ chain: "ethereum", locked: 100n, burned: 0n, released: 10n }],
      }),
    );
    expect(mismatches).toEqual([]);
  });

  it("flags an under-collateralised wrapped supply", () => {
    const [mismatch] = checkX1(
      snapshot({
        wrappedSupply: [{ asset: "wETH", contractId: "C1", supply: 120n }],
        bridgeFlows: [{ chain: "ethereum", locked: 100n, burned: 0n, released: 10n }],
      }),
    );
    expect(mismatch.invariant).toBe("X-1");
    expect(mismatch.expected).toBe("100");
    expect(mismatch.actual).toBe("130");
    expect(mismatch.delta).toBe("30");
  });

  it("counts burned mints on source chains as backing", () => {
    expect(
      checkX1(
        snapshot({
          wrappedSupply: [{ asset: "wETH", contractId: "C1", supply: 50n }],
          bridgeFlows: [{ chain: "ethereum", locked: 0n, burned: 50n, released: 0n }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("X-2 wrap causality", () => {
  it("accepts a wrap whose salt matches a lock, ignoring 0x prefixes", () => {
    const mismatches = checkX2(
      snapshot({
        wraps: [{ txHash: "aa", ledger: 1n, chainId: 1, salt: salt.slice(2), amount: 5n }],
        locks: [{ chain: "ethereum", type: "locked", salt, amount: 5n }],
      }),
    );
    expect(mismatches).toEqual([]);
  });

  it("flags a wrap with no source-chain event", () => {
    const [mismatch] = checkX2(
      snapshot({
        wraps: [{ txHash: "aa", ledger: 1n, chainId: 1, salt: salt.slice(2), amount: 5n }],
      }),
    );
    expect(mismatch.invariant).toBe("X-2");
    expect(mismatch.actual).toBe("0");
  });

  it("flags an amount that does not match the lock", () => {
    const [mismatch] = checkX2(
      snapshot({
        wraps: [{ txHash: "aa", ledger: 1n, chainId: 1, salt: salt.slice(2), amount: 6n }],
        locks: [{ chain: "ethereum", type: "locked", salt, amount: 5n }],
      }),
    );
    expect(mismatch.delta).toBe("1");
    expect(mismatch.message).toMatch(/does not match/);
  });

  it("flags two source events sharing a salt", () => {
    const [mismatch] = checkX2(
      snapshot({
        wraps: [{ txHash: "aa", ledger: 1n, chainId: 1, salt: salt.slice(2), amount: 5n }],
        locks: [
          { chain: "ethereum", type: "locked", salt, amount: 5n },
          { chain: "ethereum", type: "burned", salt, amount: 5n },
        ],
      }),
    );
    expect(mismatch.actual).toBe("2");
  });

  it("ignores chains it cannot map to a label", () => {
    expect(
      checkX2(
        snapshot({
          wraps: [{ txHash: "aa", ledger: 1n, chainId: 999, salt: salt.slice(2), amount: 5n }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("X-3 unwrap causality", () => {
  const unwrap = {
    txHash: "ee".repeat(32),
    ledger: 10n,
    chainId: 1,
    nonce: "11".repeat(32),
    amount: 7n,
    createdAt: new Date(NOW.getTime() - 60_000),
    released: false,
  };

  it("accepts a matching single release", () => {
    expect(
      checkX3(
        snapshot({
          unwraps: [unwrap],
          releases: [
            {
              chain: "ethereum",
              txHash: "0x1",
              stellarTxHash,
              nonce: "0x" + "11".repeat(32),
              amount: 7n,
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("treats a fresh unreleased unwrap as pending, not broken", () => {
    expect(checkX3(snapshot({ unwraps: [unwrap] }))).toEqual([]);
  });

  it("flags an unwrap still unreleased past the SLA", () => {
    const [mismatch] = checkX3(
      snapshot({ unwraps: [{ ...unwrap, createdAt: new Date(NOW.getTime() - 2 * HOUR) }] }),
    );
    expect(mismatch.invariant).toBe("X-3");
    expect(mismatch.actual).toBe("0");
    expect(mismatch.message).toMatch(/unreleased/);
  });

  it("flags a duplicate release for the same unwrap", () => {
    const release = {
      chain: "ethereum",
      txHash: "0x1",
      stellarTxHash,
      nonce: "0x" + "11".repeat(32),
      amount: 7n,
    };
    const [mismatch] = checkX3(snapshot({ unwraps: [unwrap], releases: [release, release] }));
    expect(mismatch.message).toMatch(/more than once/);
  });

  it("flags a released amount that does not match the unwrap", () => {
    const [mismatch] = checkX3(
      snapshot({
        unwraps: [unwrap],
        releases: [
          {
            chain: "ethereum",
            txHash: "0x1",
            stellarTxHash,
            nonce: "0x" + "11".repeat(32),
            amount: 8n,
          },
        ],
      }),
    );
    expect(mismatch.delta).toBe("1");
  });
});

describe("X-4 view consistency", () => {
  const base = {
    asset: "XLM",
    dbSupply: 100n,
    dbWithdraw: 40n,
    dbBorrow: 30n,
    dbRepay: 10n,
    onChainSupply: 60n,
    onChainBorrow: 20n,
  };

  it("compares net DB totals with the on-chain views", () => {
    expect(checkX4(snapshot({ markets: [base] }))).toEqual([]);
  });

  it("prefers API totals when the API answered", () => {
    const mismatches = checkX4(
      snapshot({ markets: [{ ...base, apiSupply: 55n, apiBorrow: 20n }] }),
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].subject).toBe("XLM:total_deposit");
    expect(mismatches[0].message).toMatch(/^API/);
  });

  it("never reports a negative total when withdrawals exceed indexed supply", () => {
    const mismatches = checkX4(
      snapshot({ markets: [{ ...base, dbSupply: 10n, dbWithdraw: 40n, onChainSupply: 0n }] }),
    );
    expect(mismatches).toEqual([]);
  });
});

describe("runChecks", () => {
  it("returns every violation across invariants", () => {
    const mismatches = runChecks(
      snapshot({
        wrappedSupply: [{ asset: "wETH", contractId: "C1", supply: 999n }],
        bridgeFlows: [{ chain: "ethereum", locked: 1n, burned: 0n, released: 0n }],
        wraps: [{ txHash: "aa", ledger: 1n, chainId: 1, salt: salt.slice(2), amount: 1n }],
        markets: [
          {
            asset: "XLM",
            dbSupply: 5n,
            dbWithdraw: 0n,
            dbBorrow: 0n,
            dbRepay: 0n,
            onChainSupply: 0n,
            onChainBorrow: 0n,
          },
        ],
      }),
    );
    expect(mismatches.map((m) => m.invariant).sort()).toEqual(["X-1", "X-2", "X-4"]);
  });
});

describe("normalizeHex", () => {
  it("lowercases, strips 0x and left-pads to bytes32", () => {
    expect(normalizeHex("0xAB")).toBe("ab".padStart(64, "0"));
  });
});

// ────────────────────────── service orchestration ──────────────────────────

interface FakeRows {
  wraps?: unknown[];
  unwraps?: unknown[];
  bridge?: unknown[];
  lending?: unknown[];
}

function fakePrisma(rows: FakeRows = {}) {
  const created: any[] = [];
  const updated: any[] = [];
  const prisma = {
    reconciliationRun: {
      create: async (args: any) => {
        const run = { id: "run_1", ...args.data };
        created.push(run);
        return run;
      },
      update: async (args: any) => {
        updated.push(args);
        return { id: args.where.id, ...args.data };
      },
    },
    wrapEvent: { findMany: async () => rows.wraps ?? [] },
    unwrapEvent: { findMany: async () => rows.unwraps ?? [] },
    bridgeEvent: {
      findMany: async ({ where }: any) => {
        const bridge = (rows.bridge ?? []) as any[];
        if (where?.type) {
          const types = where.type.in ?? [where.type];
          return bridge.filter((b) => types.includes(b.type));
        }
        return bridge;
      },
      groupBy: async () => {
        const totals = new Map<string, bigint>();
        for (const event of (rows.bridge ?? []) as any[]) {
          const key = `${event.chain}:${event.type}`;
          totals.set(key, (totals.get(key) ?? 0n) + event.amount);
        }
        return [...totals.entries()].map(([key, amount]) => {
          const [chain, type] = key.split(":");
          return { chain, type, _sum: { amount } };
        });
      },
    },
    lendingEvent: {
      groupBy: async () => {
        const totals = new Map<string, bigint>();
        for (const event of (rows.lending ?? []) as any[]) {
          const key = `${event.asset}:${event.type}`;
          totals.set(key, (totals.get(key) ?? 0n) + event.amount);
        }
        return [...totals.entries()].map(([key, amount]) => {
          const [asset, type] = key.split(":");
          return { asset, type, _sum: { amount } };
        });
      },
    },
  };
  return { prisma: prisma as any, created, updated };
}

const reader = {
  wrappedSupply: async () => 90n,
  poolTotalDeposit: async () => 100n,
  poolTotalBorrow: async () => 0n,
};

describe("runReconciliation", () => {
  it("persists a mismatch run with one row per violation", async () => {
    const { prisma, updated } = fakePrisma({
      lending: [{ asset: "XLM", type: "supply", amount: 40n }],
    });
    const outcome = await runReconciliation({
      prisma,
      reader,
      poolContractId: "CPOOL",
      wrappedAssets: [{ asset: "wETH", contractId: "CWRAP" }],
      now: () => NOW,
    });

    expect(outcome.status).toBe("mismatch");
    expect(outcome.checks).toEqual(["X-1", "X-4", "X-2", "X-3"]);
    expect(outcome.mismatchCount).toBe(2); // X-1 backing vs 90/0, X-4 supply 40 vs 100
    const data = updated[0].data;
    expect(data.status).toBe("mismatch");
    expect(data.mismatches.create).toHaveLength(2);
    expect(data.report.snapshot.markets[0]).toMatchObject({
      asset: "XLM",
      dbSupply: "40",
      onChainSupply: "100",
    });
  });

  it("reports ok when every check passes", async () => {
    const { prisma, updated } = fakePrisma({
      bridge: [{ chain: "ethereum", type: "locked", salt: "0x" + "ab".repeat(32), amount: 90n }],
      wraps: [
        {
          txHash: "aa",
          ledger: 1n,
          chainId: 1,
          salt: "ab".repeat(32),
          amount: 90n,
        },
      ],
    });
    const outcome = await runReconciliation({
      prisma,
      reader: {
        wrappedSupply: async () => 90n,
        poolTotalDeposit: async () => 0n,
        poolTotalBorrow: async () => 0n,
      },
      poolContractId: "CPOOL",
      wrappedAssets: [{ asset: "wETH", contractId: "CWRAP" }],
      now: () => NOW,
    });

    expect(outcome.status).toBe("ok");
    expect(updated[0].data.mismatches.create).toEqual([]);
  });

  it("skips on-chain checks (and says so) when no reader is configured", async () => {
    const { prisma } = fakePrisma();
    const outcome = await runReconciliation({ prisma, wrappedAssets: [], now: () => NOW });

    expect(outcome.checks).toEqual(["X-2", "X-3"]);
    expect(outcome.skipped).toEqual([
      "X-1 (no on-chain reader configured)",
      "X-4 (no on-chain reader configured)",
    ]);
  });

  it("marks the run as error when a source fails, without throwing", async () => {
    const { prisma, updated } = fakePrisma();
    const outcome = await runReconciliation({
      prisma,
      reader: {
        wrappedSupply: async () => {
          throw new Error("rpc unavailable");
        },
        poolTotalDeposit: async () => 0n,
        poolTotalBorrow: async () => 0n,
      },
      wrappedAssets: [{ asset: "wETH", contractId: "CWRAP" }],
      now: () => NOW,
    });

    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/rpc unavailable/);
    expect(updated[0].data.status).toBe("error");
  });

  it("uses API totals when the API is reachable", async () => {
    const { prisma } = fakePrisma({
      lending: [{ asset: "XLM", type: "supply", amount: 100n }],
    });
    const fetchImpl = (async () =>
      new Response(JSON.stringify([{ asset: "XLM", totalSupply: "99", totalBorrow: "0" }]), {
        status: 200,
      })) as unknown as typeof fetch;

    const outcome = await runReconciliation({
      prisma,
      reader,
      poolContractId: "CPOOL",
      wrappedAssets: [],
      apiUrl: "http://api",
      fetchImpl,
      now: () => NOW,
    });

    expect(outcome.mismatches.some((m) => m.subject === "XLM:total_deposit")).toBe(true);
  });

  it("alerts exactly once with the mismatches", async () => {
    const { prisma } = fakePrisma({
      lending: [{ asset: "XLM", type: "supply", amount: 40n }],
    });
    const alerts: unknown[] = [];
    await runReconciliation({
      prisma,
      reader,
      poolContractId: "CPOOL",
      wrappedAssets: [{ asset: "wETH", contractId: "CWRAP" }],
      now: () => NOW,
      alert: async (payload) => {
        alerts.push(payload);
      },
    });

    expect(alerts).toHaveLength(1);
    expect((alerts[0] as any).mismatches.length).toBeGreaterThan(0);
  });
});
