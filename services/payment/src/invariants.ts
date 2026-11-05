/**
 * Cross-system bridge invariants X-1 … X-4.
 *
 * These tie the Stellar wrapped-asset ledger to the source-chain bridge
 * ledger. They are pure predicates so they can be asserted in unit tests and
 * reused by a reconciliation job against live data.
 *
 * Definitions (docs/invariants.md § 8):
 *   X-1 Backing:    wrapped supply on Stellar is fully backed by canonical
 *                   tokens locked/burned on source chains, net of releases.
 *   X-2 Causality:  every mint corresponds to exactly one source Locked/Burned
 *                   event.
 *   X-3 Causality:  every unwrap results in exactly one Released event.
 *   X-4 Consistency: API market totals equal on-chain pool totals.
 */

export interface BackingLedger {
  /** Current total supply of wrapped assets on Stellar. */
  wrappedSupply: bigint;
  /** Cumulative wrapped amount minted (= sum of wrap events). */
  totalWrapped: bigint;
  /** Cumulative wrapped amount burned by unwrap. */
  totalUnwrapped: bigint;
  /** Cumulative canonical tokens locked on source chains. */
  totalLocked: bigint;
  /** Cumulative canonical tokens burned on source chains. */
  totalBurned: bigint;
  /** Cumulative amount released back on source chains. */
  totalReleased: bigint;
}

export interface CausalityEntry {
  /** Source key: `chain:txHash:logIndex` for wrap, Stellar tx hash for unwrap. */
  key: string;
  amount: bigint;
}

export interface ReconciliationViolation {
  invariant: string;
  detail: string;
}

/**
 * X-1: `wrappedSupply + totalReleased == totalLocked + totalBurned`.
 *
 * Every wrapped token in existence was minted by a lock/burn; every token
 * destroyed by unwrap corresponds to a release. Tokens still in escrow are
 * `totalLocked + totalBurned - totalReleased`, which must equal supply.
 *
 * Also checks the internal supply identity
 * `wrappedSupply == totalWrapped - totalUnwrapped`, so an indexer that drops
 * a wrap/unwrap event cannot silently pass.
 */
export function checkX1Backing(ledger: BackingLedger): ReconciliationViolation[] {
  const violations: ReconciliationViolation[] = [];
  const backing = ledger.totalLocked + ledger.totalBurned - ledger.totalReleased;
  if (ledger.wrappedSupply !== backing) {
    violations.push({
      invariant: "X-1",
      detail: `wrapped supply ${ledger.wrappedSupply} != backed amount ${backing}`,
    });
  }
  const derivedSupply = ledger.totalWrapped - ledger.totalUnwrapped;
  if (ledger.wrappedSupply !== derivedSupply) {
    violations.push({
      invariant: "X-1",
      detail: `wrapped supply ${ledger.wrappedSupply} != wrapped-unwrapped ${derivedSupply}`,
    });
  }
  return violations;
}

/**
 * X-2: wraps and source-chain lock/burn events must be in bijection — same
 * cardinality, same keys, same amounts. A mint with no source event is
 * unbacked; a source event with no mint stranded value.
 */
export function checkX2Causality(
  wraps: CausalityEntry[],
  sourceEvents: CausalityEntry[],
): ReconciliationViolation[] {
  return compareLedgers(wraps, sourceEvents, "X-2", "wrap", "source event");
}

/**
 * X-3: unwraps and source-chain `Released` events must be in bijection.
 * Duplicate releases (same unwrap released twice) are also caught by the
 * duplicate-key check.
 */
export function checkX3Causality(
  unwraps: CausalityEntry[],
  releases: CausalityEntry[],
): ReconciliationViolation[] {
  return compareLedgers(unwraps, releases, "X-3", "unwrap", "release");
}

function compareLedgers(
  left: CausalityEntry[],
  right: CausalityEntry[],
  invariant: string,
  leftLabel: string,
  rightLabel: string,
): ReconciliationViolation[] {
  const violations: ReconciliationViolation[] = [];
  const leftMap = new Map<string, bigint>();
  const rightMap = new Map<string, bigint>();

  for (const [arr, map, label] of [
    [left, leftMap, leftLabel] as const,
    [right, rightMap, rightLabel] as const,
  ]) {
    for (const e of arr) {
      if (map.has(e.key)) {
        violations.push({
          invariant,
          detail: `duplicate ${label} key ${e.key}`,
        });
        continue;
      }
      map.set(e.key, e.amount);
    }
  }

  for (const [key, amount] of leftMap) {
    const other = rightMap.get(key);
    if (other === undefined) {
      violations.push({ invariant, detail: `${leftLabel} ${key} has no ${rightLabel}` });
    } else if (other !== amount) {
      violations.push({
        invariant,
        detail: `${leftLabel} ${key} amount ${amount} != ${rightLabel} amount ${other}`,
      });
    }
  }
  for (const key of rightMap.keys()) {
    if (!leftMap.has(key)) {
      violations.push({ invariant, detail: `${rightLabel} ${key} has no ${leftLabel}` });
    }
  }
  return violations;
}

export interface MarketTotals {
  [asset: string]: bigint;
}

/**
 * X-4: the API's `/v1/markets` `totalSupply` per asset must equal the
 * on-chain `lending_pool.total_deposit` for the same asset. Missing assets on
 * either side are a violation (an endpoint that omits a market is just as
 * wrong as one that overstates it).
 */
export function checkX4MarketTotals(
  apiMarkets: MarketTotals,
  onChain: MarketTotals,
): ReconciliationViolation[] {
  const violations: ReconciliationViolation[] = [];
  const assets = new Set([...Object.keys(apiMarkets), ...Object.keys(onChain)]);
  for (const asset of assets) {
    const api = apiMarkets[asset];
    const chain = onChain[asset];
    if (api === undefined) {
      violations.push({ invariant: "X-4", detail: `API missing market ${asset}` });
    } else if (chain === undefined) {
      violations.push({ invariant: "X-4", detail: `on-chain asset ${asset} missing from API` });
    } else if (api !== chain) {
      violations.push({
        invariant: "X-4",
        detail: `asset ${asset}: API totalSupply ${api} != on-chain ${chain}`,
      });
    }
  }
  return violations;
}

/** Run every cross-system check that can be evaluated from the supplied data. */
export function checkAll(input: {
  backing?: BackingLedger;
  wraps?: CausalityEntry[];
  sourceEvents?: CausalityEntry[];
  unwraps?: CausalityEntry[];
  releases?: CausalityEntry[];
  apiMarkets?: MarketTotals;
  onChainMarkets?: MarketTotals;
}): ReconciliationViolation[] {
  const out: ReconciliationViolation[] = [];
  if (input.backing) out.push(...checkX1Backing(input.backing));
  if (input.wraps && input.sourceEvents) {
    out.push(...checkX2Causality(input.wraps, input.sourceEvents));
  }
  if (input.unwraps && input.releases) {
    out.push(...checkX3Causality(input.unwraps, input.releases));
  }
  if (input.apiMarkets && input.onChainMarkets) {
    out.push(...checkX4MarketTotals(input.apiMarkets, input.onChainMarkets));
  }
  return out;
}
