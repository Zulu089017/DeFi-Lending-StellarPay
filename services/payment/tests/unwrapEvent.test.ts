import { describe, it, expect } from "vitest";
import {
  decodeUnwrapValue,
  evmNonceFromStellarNonce,
  evmRecipientFromSourceAddr,
  sourceChainForChainId,
  stellarTxHashToBytes32,
} from "../src/events/unwrap.js";

const USER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const RECIPIENT = "0x1234567890abcdef1234567890abcdef12345678";
const paddedRecipient = Buffer.concat([Buffer.alloc(12), Buffer.from(RECIPIENT.slice(2), "hex")]);
const TX_HASH = "ab".repeat(32);
const NONCE = Buffer.alloc(32, 7);

function validValue() {
  return [USER, 1_000_000n, 1, new Uint8Array(paddedRecipient), new Uint8Array(NONCE)];
}

describe("decodeUnwrapValue", () => {
  it("decodes a well-formed Unwrap event", () => {
    const ev = decodeUnwrapValue(validValue(), { txHash: TX_HASH, ledger: 42 });
    expect(ev).toEqual({
      chain: "stellar",
      txHash: TX_HASH,
      ledger: 42n,
      user: USER,
      amount: 1_000_000n,
      chainId: 1,
      sourceChain: "ethereum",
      sourceAddr: "0x" + paddedRecipient.toString("hex"),
      nonce: "0x" + NONCE.toString("hex"),
    });
    expect(evmRecipientFromSourceAddr(ev.sourceAddr)).toBe(RECIPIENT);
  });

  it("maps chain ids and rejects unsupported chains", () => {
    expect(sourceChainForChainId(1)).toBe("ethereum");
    expect(sourceChainForChainId(137)).toBe("polygon");
    expect(sourceChainForChainId(56)).toBeNull();
  });

  it("rejects a wrong field count", () => {
    expect(() => decodeUnwrapValue([USER, 1n], { txHash: TX_HASH, ledger: 1 })).toThrow(/5 fields/);
    expect(() => decodeUnwrapValue({}, { txHash: TX_HASH, ledger: 1 })).toThrow(/5 fields/);
  });

  it("rejects non-positive amounts", () => {
    const v = validValue();
    v[1] = 0n;
    expect(() => decodeUnwrapValue(v, { txHash: TX_HASH, ledger: 1 })).toThrow(/positive/);
    const neg = validValue();
    neg[1] = -5n;
    expect(() => decodeUnwrapValue(neg, { txHash: TX_HASH, ledger: 1 })).toThrow(/positive/);
  });

  it("rejects an invalid Stellar user address", () => {
    const v = validValue();
    v[0] = "not-an-address";
    expect(() => decodeUnwrapValue(v, { txHash: TX_HASH, ledger: 1 })).toThrow(/Stellar address/);
  });

  it("rejects an unsupported destination chain", () => {
    const v = validValue();
    v[2] = 56; // BSC: no complete release flow → not supported
    expect(() => decodeUnwrapValue(v, { txHash: TX_HASH, ledger: 1 })).toThrow(
      /unsupported unwrap chain_id 56/,
    );
  });

  it("rejects malformed source_addr / nonce lengths", () => {
    const shortSrc = validValue();
    shortSrc[3] = new Uint8Array(20);
    expect(() => decodeUnwrapValue(shortSrc, { txHash: TX_HASH, ledger: 1 })).toThrow(
      /source_addr must be 32 bytes/,
    );

    const shortNonce = validValue();
    shortNonce[4] = new Uint8Array(8);
    expect(() => decodeUnwrapValue(shortNonce, { txHash: TX_HASH, ledger: 1 })).toThrow(
      /nonce must be 32 bytes/,
    );
  });
});

describe("release field derivation", () => {
  it("rejects a source_addr with non-zero high bytes (not an EVM address)", () => {
    const bad = "0x" + "11".repeat(12) + "22".repeat(20);
    expect(() => evmRecipientFromSourceAddr(bad)).toThrow(/high 12 bytes/);
  });

  it("rejects the zero address", () => {
    expect(() => evmRecipientFromSourceAddr("0x" + "00".repeat(32))).toThrow(/zero address/);
  });

  it("converts the Stellar nonce to a u256 deterministically", () => {
    expect(evmNonceFromStellarNonce("0x" + NONCE.toString("hex"))).toBe(
      BigInt("0x" + NONCE.toString("hex")),
    );
    expect(() => evmNonceFromStellarNonce("0x1234")).toThrow(/32 bytes/);
  });

  it("normalises and validates the Stellar tx hash", () => {
    expect(stellarTxHashToBytes32("0x" + "AB".repeat(32))).toBe("0x" + "ab".repeat(32));
    expect(() => stellarTxHashToBytes32("0xdeadbeef")).toThrow(/32 bytes/);
  });
});
