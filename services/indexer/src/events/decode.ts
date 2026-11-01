// Strict decoders for the Soroban contract events emitted by the StellarPay
// contracts (`#[contractevent(data_format = "vec")]`, soroban-sdk >= 22).
//
// Shapes are taken from the contract sources, not guessed:
//   contracts/lending/controller/src/lib.rs  → Wrap, Unwrap, Supply, Borrow
//   contracts/lending/soroban/src/lib.rs     → CollateralDeposited,
//                                              CollateralWithdrawn, PauseToggled
//
// The event name is the snake_case of the struct name and is always topic[0];
// the fields follow in declaration order inside a SCVec payload.
//
// Everything here is pure: no RPC, no database. That keeps the decode rules
// testable without a network and lets the stream/ingest layer stay thin.

import { Address, xdr } from "@stellar/stellar-sdk";

export type ScValLike = xdr.ScVal | string;

export interface RawSorobanEvent {
  /** RPC event id, e.g. `0023637859319676928-0000000000`. Stable and unique. */
  id: string;
  contractId: string;
  ledger: number;
  txHash: string;
  transactionIndex: number;
  operationIndex: number;
  ledgerClosedAt?: string;
  topic: ScValLike[];
  value: ScValLike;
}

export class EventDecodeError extends Error {
  constructor(
    message: string,
    readonly eventId: string,
  ) {
    super(`event ${eventId}: ${message}`);
    this.name = "EventDecodeError";
  }
}

export interface WrapPayload {
  chainId: number;
  sourceAddr: string;
  to: string;
  amount: bigint;
  salt: string;
  nonce: bigint;
}

export interface UnwrapPayload {
  user: string;
  amount: bigint;
  chainId: number;
  sourceAddr: string;
  nonce: string;
}

export interface LendingPayload {
  user: string;
  asset: string;
  amount: bigint;
}

export interface BorrowPayload {
  user: string;
  collateralAsset: string;
  debtAsset: string;
  amount: bigint;
}

export type DecodedEvent =
  | ({ kind: "wrap" } & WrapPayload)
  | ({ kind: "unwrap" } & UnwrapPayload)
  | ({ kind: "supply" } & LendingPayload)
  | ({ kind: "collateral_deposit" } & LendingPayload)
  | ({ kind: "collateral_withdraw" } & LendingPayload)
  | ({ kind: "borrow" } & BorrowPayload)
  | { kind: "pause_toggled"; paused: boolean };

// ──────────────────────── ScVal helpers ────────────────────────

function asScVal(v: ScValLike): xdr.ScVal {
  return typeof v === "string" ? xdr.ScVal.fromXDR(v, "base64") : v;
}

function fail(eventId: string, msg: string): never {
  throw new EventDecodeError(msg, eventId);
}

function expectType(v: xdr.ScVal, name: string, eventId: string): void {
  const actual = v.switch().name;
  if (actual !== name) fail(eventId, `expected ${name}, got ${actual}`);
}

function symbol(v: xdr.ScVal, eventId: string): string {
  expectType(v, "scvSymbol", eventId);
  return v.sym().toString();
}

function address(v: xdr.ScVal, eventId: string): string {
  expectType(v, "scvAddress", eventId);
  try {
    return Address.fromScVal(v).toString();
  } catch {
    return fail(eventId, "malformed address");
  }
}

function i128(v: xdr.ScVal, eventId: string): bigint {
  expectType(v, "scvI128", eventId);
  const parts = v.i128();
  // hi is a signed 64-bit high word, lo an unsigned 64-bit low word.
  return BigInt(parts.hi().toString()) * (1n << 64n) + BigInt(parts.lo().toString());
}

function u32(v: xdr.ScVal, eventId: string): number {
  expectType(v, "scvU32", eventId);
  return v.u32();
}

function u64(v: xdr.ScVal, eventId: string): bigint {
  expectType(v, "scvU64", eventId);
  return BigInt(v.u64().toString());
}

/** `BytesN<32>` and `Bytes` both serialise as SCV_BYTES on the wire. */
function bytes32(v: xdr.ScVal, eventId: string): string {
  expectType(v, "scvBytes", eventId);
  const buf = Buffer.from(v.bytes());
  if (buf.length !== 32) fail(eventId, `expected 32 bytes, got ${buf.length}`);
  return buf.toString("hex");
}

function vec(v: xdr.ScVal, eventId: string, arity: number): xdr.ScVal[] {
  expectType(v, "scvVec", eventId);
  const items = v.vec();
  if (!items) fail(eventId, "empty vec payload");
  if (items.length !== arity) fail(eventId, `expected ${arity} fields, got ${items.length}`);
  return items;
}

function requirePositive(amount: bigint, eventId: string): void {
  if (amount <= 0n) fail(eventId, `non-positive amount ${amount}`);
}

// ──────────────────────── Decoder ────────────────────────

/** Event name (`topic[0]`), or `null` when the event is not one we index. */
export function eventName(raw: RawSorobanEvent): string | null {
  if (raw.topic.length === 0) return null;
  const first = asScVal(raw.topic[0]);
  if (first.switch().name !== "scvSymbol") return null;
  return first.sym().toString();
}

/**
 * Decode a known event. Returns `null` for event names outside the indexed
 * set (other contracts share the ledger), and throws `EventDecodeError` when a
 * *known* event has a malformed payload — silently dropping those would make
 * the indexer disagree with the chain without anyone noticing.
 */
export function decodeSorobanEvent(raw: RawSorobanEvent): DecodedEvent | null {
  const name = eventName(raw);
  if (name === null) return null;
  const payload = asScVal(raw.value);
  const id = raw.id;

  switch (name) {
    case "wrap": {
      const [chainId, sourceAddr, to, amount, salt, nonce] = vec(payload, id, 6);
      const decoded: DecodedEvent = {
        kind: "wrap",
        chainId: u32(chainId, id),
        sourceAddr: bytes32(sourceAddr, id),
        to: address(to, id),
        amount: i128(amount, id),
        salt: bytes32(salt, id),
        nonce: u64(nonce, id),
      };
      requirePositive(decoded.amount, id);
      return decoded;
    }
    case "unwrap": {
      const [user, amount, chainId, sourceAddr, nonce] = vec(payload, id, 5);
      const decoded: DecodedEvent = {
        kind: "unwrap",
        user: address(user, id),
        amount: i128(amount, id),
        chainId: u32(chainId, id),
        sourceAddr: bytes32(sourceAddr, id),
        nonce: bytes32(nonce, id),
      };
      requirePositive(decoded.amount, id);
      return decoded;
    }
    case "supply":
    case "collateral_deposited":
    case "collateral_withdrawn": {
      const [user, asset, amount] = vec(payload, id, 3);
      const value = i128(amount, id);
      requirePositive(value, id);
      return {
        kind:
          name === "supply"
            ? "supply"
            : name === "collateral_deposited"
              ? "collateral_deposit"
              : "collateral_withdraw",
        user: address(user, id),
        asset: symbol(asset, id),
        amount: value,
      };
    }
    case "borrow": {
      const [user, collateralAsset, debtAsset, amount] = vec(payload, id, 4);
      const decoded: DecodedEvent = {
        kind: "borrow",
        user: address(user, id),
        collateralAsset: symbol(collateralAsset, id),
        debtAsset: symbol(debtAsset, id),
        amount: i128(amount, id),
      };
      requirePositive(decoded.amount, id);
      return decoded;
    }
    case "pause_toggled": {
      const [paused] = vec(payload, id, 1);
      expectType(paused, "scvBool", id);
      return { kind: "pause_toggled", paused: paused.b() };
    }
    default:
      return null;
  }
}

/** Event kinds that have a table; others are decoded but not persisted. */
export function isPersistable(kind: DecodedEvent["kind"]): boolean {
  return kind !== "pause_toggled";
}

/**
 * Event ordinal inside its transaction. The RPC id is
 * `<toid>-<eventOrder>`, where `toid = ledger << 32 | txIndex`; the suffix is
 * what `(txHash, logIndex)` uniqueness needs.
 */
export function eventLogIndex(id: string): number {
  const suffix = id.split("-")[1];
  const parsed = suffix ? Number.parseInt(suffix, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Lending-market event types, matching `GET /v1/markets` aggregation.
 *
 * Only the controller's `supply`/`borrow` events move the market totals: its
 * `supply_collateral` bumps `lending_pool.total_deposit` (via `pool.supply`).
 * The pool's own `collateral_deposited`/`collateral_withdrawn` events track the
 * vault position and must NOT be folded into supply/withdraw, or market totals
 * would drift from the on-chain views X-4 compares against.
 */
export type LendingEventType = "supply" | "withdraw" | "borrow" | "repay";

export function lendingEventType(kind: DecodedEvent["kind"]): LendingEventType | null {
  switch (kind) {
    case "supply":
      return "supply";
    case "borrow":
      return "borrow";
    default:
      return null;
  }
}
