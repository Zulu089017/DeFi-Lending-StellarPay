// Pure reconciliation predicates for the cross-system invariants X-1 … X-4
// (see docs/invariants.md § 8). Everything here is a deterministic function of
// a snapshot, so the rules can be tested without a chain, a database or a clock.
//
// The service layer (reconcile/service.ts) is responsible for gathering the
// snapshot from Stellar RPC + Postgres and persisting the result.

export type Invariant = "X-1" | "X-2" | "X-3" | "X-4";

export interface Mismatch {
  invariant: Invariant;
  subject: string;
  expected: string;
  actual: string;
  delta?: string;
  message: string;
}

export interface WrappedSupply {
  asset: string;
  contractId: string;
  supply: bigint;
}

export interface BridgeFlow {
  chain: string;
  locked: bigint;
  burned: bigint;
  released: bigint;
}

export interface WrapRow {
  txHash: string;
  ledger: bigint;
  chainId: number;
  salt: string;
  amount: bigint;
}

export interface UnwrapRow {
  txHash: string;
  ledger: bigint;
  chainId: number;
  nonce: string;
  amount: bigint;
  createdAt: Date;
  released: boolean;
}

export interface LockRow {
  chain: string;
  /** `locked` or `burned` — both represent value entering the bridge. */
  type: string;
  salt: string | null;
  amount: bigint;
}

export interface ReleaseRow {
  chain: string;
  txHash: string;
  /** Stellar tx hash carried in the `Released` event (bytes32). */
  stellarTxHash: string | null;
  nonce: string | null;
  amount: bigint;
}

export interface MarketRow {
  asset: string;
  dbSupply: bigint;
  dbWithdraw: bigint;
  dbBorrow: bigint;
  dbRepay: bigint;
  /** Totals reported by the API, when one is reachable. */
  apiSupply?: bigint;
  apiBorrow?: bigint;
  /** On-chain `lending_pool.total_deposit` / `total_borrow`. */
  onChainSupply: bigint;
  onChainBorrow: bigint;
}

export interface ReconcileSnapshot {
  wrappedSupply: WrappedSupply[];
  bridgeFlows: BridgeFlow[];
  wraps: WrapRow[];
  unwraps: UnwrapRow[];
  locks: LockRow[];
  releases: ReleaseRow[];
  markets: MarketRow[];
  now: Date;
  /** How long an unwrap may stay unreleased before it is reported. */
  staleAfterMs: number;
}

/** EVM chain id → the chain label used by the bridge indexer. */
export const CHAIN_ID_LABEL: Record<number, string> = {
  1: "ethereum",
  137: "polygon",
};

/** Normalise a bytes32/hex salt or tx hash for comparison (lowercase, no 0x). */
export function normalizeHex(value: string): string {
  return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

const ZERO = 0n;

function sum(values: bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, ZERO);
}

function clampZero(v: bigint): bigint {
  return v > ZERO ? v : ZERO;
}

/**
 * X-1 — backing conservation:
 *   Σ wrapped supply on Stellar + Σ released  ==  Σ locked + Σ burned
 * A release returns canonical value to a source chain, so it must be netted
 * out of the backing on the EVM side; counting locked+burned alone would
 * report a phantom surplus after every unwrap.
 */
export function checkX1(snapshot: ReconcileSnapshot): Mismatch[] {
  const wrapped = sum(snapshot.wrappedSupply.map((w) => w.supply));
  const released = sum(snapshot.bridgeFlows.map((f) => f.released));
  const locked = sum(snapshot.bridgeFlows.map((f) => f.locked));
  const burned = sum(snapshot.bridgeFlows.map((f) => f.burned));

  const expected = locked + burned;
  const actual = wrapped + released;
  if (expected === actual) return [];

  const delta = actual - expected;
  return [
    {
      invariant: "X-1",
      subject: "aggregate",
      expected: expected.toString(),
      actual: actual.toString(),
      delta: delta.toString(),
      message:
        `wrapped supply (${wrapped}) + released (${released}) = ${actual}, ` +
        `backed by locked (${locked}) + burned (${burned}) = ${expected}`,
    },
  ];
}

/**
 * X-2 — every wrap on Stellar is caused by exactly one source-chain lock/burn.
 * A wrap can only be minted after attestation of a source event, so a missing
 * counterpart is always an inconsistency (unlike the reverse direction, where
 * a lock may simply not have been minted yet).
 */
export function checkX2(snapshot: ReconcileSnapshot): Mismatch[] {
  const out: Mismatch[] = [];
  for (const wrap of snapshot.wraps) {
    const chain = CHAIN_ID_LABEL[wrap.chainId];
    if (!chain) continue; // chain not modelled by the indexer — reported separately
    const salt = normalizeHex(wrap.salt);
    const matches = snapshot.locks.filter(
      (l) =>
        l.chain === chain &&
        (l.type === "locked" || l.type === "burned") &&
        l.salt !== null &&
        normalizeHex(l.salt) === salt,
    );

    const subject = `${chain}:${wrap.txHash}`;
    if (matches.length === 0) {
      out.push({
        invariant: "X-2",
        subject,
        expected: `1 lock/burn for salt ${salt.slice(0, 18)}…`,
        actual: "0",
        message: `wrap on Stellar has no source-chain lock/burn event (salt ${salt})`,
      });
      continue;
    }
    if (matches.length > 1) {
      out.push({
        invariant: "X-2",
        subject,
        expected: "1",
        actual: String(matches.length),
        message: "multiple source-chain events share this salt",
      });
      continue;
    }
    const lock = matches[0];
    if (lock.amount !== wrap.amount) {
      out.push({
        invariant: "X-2",
        subject,
        expected: lock.amount.toString(),
        actual: wrap.amount.toString(),
        delta: (wrap.amount - lock.amount).toString(),
        message: "wrapped amount does not match the locking event",
      });
    }
  }
  return out;
}

/**
 * X-3 — every unwrap is released exactly once, or is explicitly still pending
 * inside the SLA window. More than one matching release is a double-spend of
 * backing; none at all after `staleAfterMs` means the return leg stalled.
 */
export function checkX3(snapshot: ReconcileSnapshot): Mismatch[] {
  const out: Mismatch[] = [];
  for (const unwrap of snapshot.unwraps) {
    const subject = `${CHAIN_ID_LABEL[unwrap.chainId] ?? unwrap.chainId}:${unwrap.txHash}:${unwrap.nonce.slice(0, 12)}…`;
    const txId = normalizeHex(unwrap.txHash);
    const nonce = normalizeHex(unwrap.nonce);
    const matches = snapshot.releases.filter(
      (r) =>
        r.stellarTxHash !== null &&
        normalizeHex(r.stellarTxHash) === txId &&
        r.nonce !== null &&
        normalizeHex(r.nonce) === nonce,
    );

    if (matches.length > 1) {
      out.push({
        invariant: "X-3",
        subject,
        expected: "1",
        actual: String(matches.length),
        message: "unwrap was released more than once (duplicate release)",
      });
      continue;
    }
    if (matches.length === 1) {
      const release = matches[0];
      if (release.amount !== unwrap.amount) {
        out.push({
          invariant: "X-3",
          subject,
          expected: unwrap.amount.toString(),
          actual: release.amount.toString(),
          delta: (release.amount - unwrap.amount).toString(),
          message: "released amount does not match the unwrap",
        });
      }
      continue;
    }

    const age = snapshot.now.getTime() - unwrap.createdAt.getTime();
    if (age > snapshot.staleAfterMs) {
      out.push({
        invariant: "X-3",
        subject,
        expected: "1 release",
        actual: "0",
        message: `unwrap still unreleased after ${Math.round(age / 60_000)} min`,
      });
    }
  }
  return out;
}

/**
 * X-4 — the totals the API serves equal the on-chain views. The API number is
 * compared when the API was reachable; otherwise the database-derived total is
 * compared, which is what the API would return.
 */
export function checkX4(snapshot: ReconcileSnapshot): Mismatch[] {
  const out: Mismatch[] = [];
  for (const market of snapshot.markets) {
    const dbSupply = clampZero(market.dbSupply - market.dbWithdraw);
    const dbBorrow = clampZero(market.dbBorrow - market.dbRepay);

    const supplyExpected = market.apiSupply ?? dbSupply;
    if (supplyExpected !== market.onChainSupply) {
      out.push({
        invariant: "X-4",
        subject: `${market.asset}:total_deposit`,
        expected: market.onChainSupply.toString(),
        actual: supplyExpected.toString(),
        delta: (supplyExpected - market.onChainSupply).toString(),
        message: `${market.apiSupply !== undefined ? "API" : "database"} supply total disagrees with lending_pool.total_deposit`,
      });
    }

    const borrowExpected = market.apiBorrow ?? dbBorrow;
    if (borrowExpected !== market.onChainBorrow) {
      out.push({
        invariant: "X-4",
        subject: `${market.asset}:total_borrow`,
        expected: market.onChainBorrow.toString(),
        actual: borrowExpected.toString(),
        delta: (borrowExpected - market.onChainBorrow).toString(),
        message: `${market.apiBorrow !== undefined ? "API" : "database"} borrow total disagrees with lending_pool.total_borrow`,
      });
    }
  }
  return out;
}

export function runChecks(snapshot: ReconcileSnapshot): Mismatch[] {
  return [...checkX1(snapshot), ...checkX2(snapshot), ...checkX3(snapshot), ...checkX4(snapshot)];
}
