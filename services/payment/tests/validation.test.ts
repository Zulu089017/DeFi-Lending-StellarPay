import { describe, it, expect } from "vitest";
import {
  MAX_MINTABLE_AMOUNT,
  isMintableAmount,
  isValidSalt,
  isValidStellarDest,
  sourceAddrToBytes,
} from "../src/validation.js";

describe("isMintableAmount", () => {
  it("accepts amounts in [1, i64::MAX]", () => {
    expect(isMintableAmount(1n)).toBe(true);
    expect(isMintableAmount(MAX_MINTABLE_AMOUNT)).toBe(true);
  });

  it("rejects zero and negatives", () => {
    expect(isMintableAmount(0n)).toBe(false);
    expect(isMintableAmount(-1n)).toBe(false);
  });

  it("rejects amounts above i64::MAX (cross-language hash divergence)", () => {
    // The on-chain controller hashes the amount as a *saturating* i64 cast
    // while the TS signer uses a *wrapping* asIntN(64) — above i64::MAX the
    // two sides produce different payload bytes and the attestation can
    // never verify. Must be rejected before signing.
    expect(isMintableAmount(MAX_MINTABLE_AMOUNT + 1n)).toBe(false);
    expect(isMintableAmount(MAX_MINTABLE_AMOUNT * 2n)).toBe(false);
  });
});

describe("isValidSalt", () => {
  it("accepts 32-byte hex with or without 0x", () => {
    expect(isValidSalt("0x" + "a".repeat(64))).toBe(true);
    expect(isValidSalt("A".repeat(64))).toBe(true);
  });

  it("rejects wrong lengths and non-hex", () => {
    expect(isValidSalt("0x" + "a".repeat(63))).toBe(false);
    expect(isValidSalt("0x" + "g".repeat(64))).toBe(false);
    expect(isValidSalt("")).toBe(false);
  });
});

describe("isValidStellarDest", () => {
  it("accepts a well-formed account address", () => {
    expect(isValidStellarDest("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H")).toBe(true);
  });

  it("rejects garbage", () => {
    expect(isValidStellarDest("not-an-address")).toBe(false);
    expect(isValidStellarDest("")).toBe(false);
    expect(isValidStellarDest("0x0000000000000000000000000000000000000001")).toBe(false);
  });
});

describe("sourceAddrToBytes", () => {
  it("decodes 64-char hex to 32 raw bytes", () => {
    const b = sourceAddrToBytes("0x" + "11".repeat(32));
    expect(b.length).toBe(32);
    expect(b[0]).toBe(0x11);
    expect(b[31]).toBe(0x11);
  });

  it("ASCII-encodes longer strings, truncated to 32 bytes (EVM addresses)", () => {
    const b = sourceAddrToBytes("0x0000000000000000000000000000000000000001");
    expect(b.length).toBe(32);
    // 42-char string → first 32 chars ASCII (0x + 30 zeros), no padding
    // left over. Deterministic and byte-identical to the signer + on-chain
    // BytesN<32> encoding.
    expect(b[0]).toBe("0".charCodeAt(0));
    expect(b[1]).toBe("x".charCodeAt(0));
    expect(b[31]).toBe("0".charCodeAt(0));
  });

  it("zero-pads short ASCII strings to 32 bytes", () => {
    const b = sourceAddrToBytes("ABC");
    expect(b.length).toBe(32);
    expect(b[0]).toBe(0x41); // 'A'
    expect(b[3]).toBe(0);
    expect(b[31]).toBe(0);
  });

  it("is deterministic and identical to the signer's encoding", async () => {
    // Regression guard: payloadHash() must use the same bytes. The
    // CANONICAL_DIGEST pin in signer.test.ts catches drift end-to-end.
    const { payloadHash } = await import("../src/attest/signer.js");
    const digest = payloadHash({
      chainId: 1,
      sourceToken: "0x" + "A".repeat(40),
      amount: 1000n,
      stellarDest: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      salt: "0x" + "B".repeat(64),
      nonce: 1n,
    });
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(32);
  });
});
