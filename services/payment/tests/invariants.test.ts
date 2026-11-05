import { describe, it, expect } from "vitest";
import {
  checkAll,
  checkX1Backing,
  checkX2Causality,
  checkX3Causality,
  checkX4MarketTotals,
  type BackingLedger,
  type CausalityEntry,
} from "../src/invariants.js";

function ledger(over: Partial<BackingLedger> = {}): BackingLedger {
  return {
    wrappedSupply: 700n,
    totalWrapped: 1_000n,
    totalUnwrapped: 300n,
    totalLocked: 900n,
    totalBurned: 100n,
    totalReleased: 300n,
    ...over,
  };
}

describe("X-1 backing", () => {
  it("holds when supply equals locked + burned − released", () => {
    expect(checkX1Backing(ledger())).toEqual([]);
  });

  it("flags unbacked supply", () => {
    const v = checkX1Backing(ledger({ wrappedSupply: 701n }));
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((x) => x.invariant === "X-1")).toBe(true);
  });

  it("flags a dropped unwrap event (supply identity)", () => {
    const v = checkX1Backing(ledger({ totalUnwrapped: 299n }));
    expect(v.some((x) => /wrapped-unwrapped/.test(x.detail))).toBe(true);
  });
});

describe("X-2 / X-3 causality", () => {
  const wraps: CausalityEntry[] = [
    { key: "ethereum:0xaa:0", amount: 600n },
    { key: "polygon:0xbb:1", amount: 400n },
  ];
  const sources: CausalityEntry[] = [
    { key: "ethereum:0xaa:0", amount: 600n },
    { key: "polygon:0xbb:1", amount: 400n },
  ];

  it("holds for a bijection", () => {
    expect(checkX2Causality(wraps, sources)).toEqual([]);
  });

  it("flags a mint with no source event", () => {
    const v = checkX2Causality([...wraps, { key: "stellar:0xcc", amount: 1n }], sources);
    expect(v).toHaveLength(1);
    expect(v[0].detail).toMatch(/no source event/);
  });

  it("flags a source event that was never minted", () => {
    const v = checkX2Causality(wraps, [...sources, { key: "ethereum:0xdd:2", amount: 5n }]);
    expect(v).toHaveLength(1);
    expect(v[0].detail).toMatch(/has no wrap/);
  });

  it("flags amount mismatch and duplicate release keys (X-3)", () => {
    const unwraps: CausalityEntry[] = [{ key: "stellar:tx1", amount: 300n }];
    const releases: CausalityEntry[] = [
      { key: "stellar:tx1", amount: 300n },
      { key: "stellar:tx1", amount: 300n },
    ];
    const v = checkX3Causality(unwraps, releases);
    expect(v.some((x) => /duplicate release key/.test(x.detail))).toBe(true);

    const mismatch = checkX3Causality(unwraps, [{ key: "stellar:tx1", amount: 299n }]);
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].detail).toMatch(/amount/);
  });

  it("flags a released unwrap with no matching unwrap", () => {
    const v = checkX3Causality([], [{ key: "stellar:ghost", amount: 1n }]);
    expect(v[0].detail).toMatch(/has no unwrap/);
  });
});

describe("X-4 API/on-chain market totals", () => {
  it("holds when totals match per asset", () => {
    expect(checkX4MarketTotals({ XLM: 10n, USDC: 5n }, { XLM: 10n, USDC: 5n })).toEqual([]);
  });

  it("flags a mismatch, a missing API market, and an extra API market", () => {
    const v = checkX4MarketTotals({ XLM: 11n, USDC: 5n }, { XLM: 10n, wETH: 2n });
    expect(v).toHaveLength(3);
    expect(v.every((x) => x.invariant === "X-4")).toBe(true);
  });
});

describe("X-1 property test over random wrap/unwrap/release flows", () => {
  // Deterministic PRNG so failures are reproducible.
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("never violates X-1 across 2,000 random operations", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = mulberry32(seed);
      let l = ledger({
        wrappedSupply: 0n,
        totalWrapped: 0n,
        totalUnwrapped: 0n,
        totalLocked: 0n,
        totalBurned: 0n,
        totalReleased: 0n,
      });
      let escrow = 0n; // canonical tokens held by the bridge

      for (let i = 0; i < 100; i++) {
        const op = rand();
        const amount = BigInt(1 + Math.floor(rand() * 1_000));
        if (op < 0.5) {
          // lock on source chain → mint on Stellar
          l.totalLocked += amount;
          escrow += amount;
          l.totalWrapped += amount;
          l.wrappedSupply += amount;
        } else if (op < 0.85 && l.wrappedSupply >= amount) {
          // unwrap on Stellar → release on source chain
          l.totalUnwrapped += amount;
          l.wrappedSupply -= amount;
          l.totalReleased += amount;
          escrow -= amount;
        }
        expect(checkX1Backing(l)).toEqual([]);
        // Independent escrow cross-check: the bridge must hold exactly the
        // amount that backs outstanding supply.
        expect(escrow).toBe(l.totalLocked + l.totalBurned - l.totalReleased);
        expect(escrow).toBe(l.wrappedSupply);
      }
    }
  });
});

describe("checkAll", () => {
  it("aggregates violations from every supplied check", () => {
    const v = checkAll({
      backing: ledger({ wrappedSupply: 999n }),
      wraps: [{ key: "a", amount: 1n }],
      sourceEvents: [],
      unwraps: [{ key: "u", amount: 1n }],
      releases: [],
      apiMarkets: { XLM: 1n },
      onChainMarkets: { XLM: 2n },
    });
    expect(new Set(v.map((x) => x.invariant))).toEqual(new Set(["X-1", "X-2", "X-3", "X-4"]));
  });
});
