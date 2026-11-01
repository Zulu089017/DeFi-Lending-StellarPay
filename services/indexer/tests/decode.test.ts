import { describe, it, expect } from "vitest";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  EventDecodeError,
  decodeSorobanEvent,
  eventLogIndex,
  type RawSorobanEvent,
} from "../src/events/decode.js";

const USER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const OTHER = "GA6ZXOF7TP3VSUHTZEKBEWW5HYIQRJJ25TJ45YRVAQXLZEEVFY6PJEZY";
const BYTES32 = Buffer.alloc(32, 7);

function ev(
  name: string,
  fields: xdr.ScVal[],
  overrides: Partial<RawSorobanEvent> = {},
): RawSorobanEvent {
  return {
    id: "0023637859319676928-0000000000",
    contractId: "CBNG3R6J2S4ZP7OEKIOS2JRVOJWG6YA56UR6N4Z4ZWIOH6LEX6R4NI2X",
    ledger: 5_503_618,
    txHash: "d60161137cf493b0fc43caedb35df38281919c93ef11f95b592f0bb483cc2455",
    transactionIndex: 0,
    operationIndex: 0,
    ledgerClosedAt: "2026-11-01T14:02:10Z",
    topic: [xdr.ScVal.scvSymbol(name)],
    value: xdr.ScVal.scvVec(fields),
    ...overrides,
  };
}

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const addr = (a: string) => new Address(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const u64 = (n: bigint) => nativeToScVal(n, { type: "u64" });
const bytes = (b: Buffer) => xdr.ScVal.scvBytes(b);

describe("decodeSorobanEvent", () => {
  it("decodes the controller's wrap event in declaration order", () => {
    const decoded = decodeSorobanEvent(
      ev("wrap", [
        u32(1),
        bytes(BYTES32),
        addr(USER),
        i128(1_500_000n),
        bytes(Buffer.alloc(32, 9)),
        u64(42n),
      ]),
    );
    expect(decoded).toEqual({
      kind: "wrap",
      chainId: 1,
      sourceAddr: BYTES32.toString("hex"),
      to: USER,
      amount: 1_500_000n,
      salt: Buffer.alloc(32, 9).toString("hex"),
      nonce: 42n,
    });
  });

  it("decodes unwrap with its bytes32 nonce", () => {
    const decoded = decodeSorobanEvent(
      ev("unwrap", [addr(USER), i128(10n), u32(137), bytes(BYTES32), bytes(Buffer.alloc(32, 3))]),
    );
    expect(decoded).toMatchObject({
      kind: "unwrap",
      user: USER,
      amount: 10n,
      chainId: 137,
      sourceAddr: BYTES32.toString("hex"),
      nonce: Buffer.alloc(32, 3).toString("hex"),
    });
  });

  it("decodes supply and borrow", () => {
    expect(decodeSorobanEvent(ev("supply", [addr(USER), sym("XLM"), i128(100n)]))).toEqual({
      kind: "supply",
      user: USER,
      asset: "XLM",
      amount: 100n,
    });
    expect(
      decodeSorobanEvent(ev("borrow", [addr(OTHER), sym("XLM"), sym("USDC"), i128(55n)])),
    ).toEqual({
      kind: "borrow",
      user: OTHER,
      collateralAsset: "XLM",
      debtAsset: "USDC",
      amount: 55n,
    });
  });

  it("decodes the pool's collateral events", () => {
    expect(
      decodeSorobanEvent(ev("collateral_deposited", [addr(USER), sym("XLM"), i128(7n)])).kind,
    ).toBe("collateral_deposit");
    expect(
      decodeSorobanEvent(ev("collateral_withdrawn", [addr(USER), sym("XLM"), i128(7n)])).kind,
    ).toBe("collateral_withdraw");
  });

  it("returns null for events outside the indexed set", () => {
    expect(decodeSorobanEvent(ev("fee", [i128(1n)]))).toBeNull();
    expect(decodeSorobanEvent({ ...ev("wrap", []), topic: [i128(1n)] })).toBeNull();
    expect(decodeSorobanEvent({ ...ev("wrap", []), topic: [] })).toBeNull();
  });

  it("rejects a known event with the wrong arity", () => {
    expect(() => decodeSorobanEvent(ev("unwrap", [addr(USER), i128(1n)]))).toThrow(
      EventDecodeError,
    );
  });

  it("rejects non-positive amounts instead of indexing them", () => {
    expect(() => decodeSorobanEvent(ev("supply", [addr(USER), sym("XLM"), i128(0n)]))).toThrow(
      /non-positive amount/,
    );
  });

  it("rejects bytes that are not 32 bytes long", () => {
    expect(() =>
      decodeSorobanEvent(
        ev("unwrap", [addr(USER), i128(1n), u32(1), bytes(Buffer.alloc(20, 1)), bytes(BYTES32)]),
      ),
    ).toThrow(/expected 32 bytes/);
  });

  it("rejects field type confusion (amount as symbol)", () => {
    expect(() => decodeSorobanEvent(ev("supply", [addr(USER), sym("XLM"), sym("nope")]))).toThrow(
      /expected scvI128/,
    );
  });

  it("round-trips base64 payloads from raw JSON-RPC", () => {
    const raw = ev("supply", [addr(USER), sym("XLM"), i128(3n)]);
    const fromWire: RawSorobanEvent = {
      ...raw,
      topic: raw.topic.map((t) => (t as xdr.ScVal).toXDR("base64")),
      value: (raw.value as xdr.ScVal).toXDR("base64"),
    };
    expect(decodeSorobanEvent(fromWire)).toEqual({
      kind: "supply",
      user: USER,
      asset: "XLM",
      amount: 3n,
    });
  });
});

describe("eventLogIndex", () => {
  it("parses the ordinal suffix of the RPC event id", () => {
    expect(eventLogIndex("0023637859319676928-0000000003")).toBe(3);
  });

  it("falls back to 0 for unexpected ids rather than throwing", () => {
    expect(eventLogIndex("weird")).toBe(0);
    expect(eventLogIndex("a-notanumber")).toBe(0);
  });
});
