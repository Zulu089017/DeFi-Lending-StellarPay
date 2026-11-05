import { describe, it, expect } from "vitest";
import { BridgeLogError, mapBridgeLog, uint256Hex } from "../src/events/evm.js";

const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SENDER = "0x1111111111111111111111111111111111111111";
const SALT = "0x" + "ab".repeat(32);
const DEST = "0x" + "cd".repeat(32);
const LOG = { txHash: "0x" + "EF".repeat(32), index: 3 };
const AT = new Date("2026-11-01T00:00:00Z");

describe("mapBridgeLog", () => {
  it("maps Locked with its salt and destination", () => {
    const row = mapBridgeLog(
      "ethereum",
      LOG,
      {
        name: "Locked",
        args: {
          sender: SENDER,
          token: TOKEN,
          amount: 1_000n,
          stellarDest: DEST,
          salt: SALT,
          nonce: 9n,
        } as any,
      },
      AT,
    );
    expect(row).toEqual({
      chain: "ethereum",
      txHash: LOG.txHash.toLowerCase(),
      logIndex: 3,
      type: "locked",
      sender: SENDER.toLowerCase(),
      token: TOKEN.toLowerCase(),
      amount: 1_000n,
      stellarDest: DEST,
      salt: SALT,
      stellarTxHash: null,
      nonce: uint256Hex(9n),
      createdAt: AT,
    });
  });

  it("maps Released to stellarTxHash + nonce (what X-3 compares)", () => {
    const row = mapBridgeLog(
      "ethereum",
      LOG,
      {
        name: "Released",
        args: {
          recipient: SENDER,
          token: TOKEN,
          amount: 5n,
          stellarTxHash: DEST,
          nonce: 12n,
        } as any,
      },
      AT,
    );
    expect(row.type).toBe("released");
    expect(row.sender).toBe(SENDER.toLowerCase());
    expect(row.stellarTxHash).toBe(DEST);
    expect(row.nonce).toBe(uint256Hex(12n));
    expect(row.salt).toBeNull();
  });

  it("maps Burned like Locked", () => {
    const row = mapBridgeLog("polygon", LOG, {
      name: "Burned",
      args: {
        sender: SENDER,
        token: TOKEN,
        amount: 5n,
        stellarDest: DEST,
        salt: SALT,
        nonce: 1n,
      } as any,
    });
    expect(row.type).toBe("burned");
  });

  it("rejects a non-bytes32 salt instead of storing a truncated value", () => {
    expect(() =>
      mapBridgeLog("ethereum", LOG, {
        name: "Locked",
        args: {
          sender: SENDER,
          token: TOKEN,
          amount: 1n,
          stellarDest: DEST,
          salt: "0x1234",
          nonce: 1n,
        } as any,
      }),
    ).toThrow(BridgeLogError);
  });

  it("rejects zero and non-integer amounts", () => {
    expect(() =>
      mapBridgeLog("ethereum", LOG, {
        name: "Locked",
        args: {
          sender: SENDER,
          token: TOKEN,
          amount: 0n,
          stellarDest: DEST,
          salt: SALT,
          nonce: 1n,
        } as any,
      }),
    ).toThrow(/positive bigint/);
    expect(() =>
      mapBridgeLog("ethereum", LOG, {
        name: "Locked",
        args: {
          sender: SENDER,
          token: TOKEN,
          amount: "1000",
          stellarDest: DEST,
          salt: SALT,
          nonce: 1n,
        } as any,
      }),
    ).toThrow(/positive bigint/);
  });

  it("rejects unknown event names", () => {
    expect(() => mapBridgeLog("ethereum", LOG, { name: "Paused", args: {} as any })).toThrow(
      /unexpected event/,
    );
  });
});

describe("uint256Hex", () => {
  it("left-pads to 32 bytes", () => {
    expect(uint256Hex(255n)).toBe("0x" + "f".repeat(2).padStart(64, "0"));
  });
});
