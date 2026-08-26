import { Address as ScAddress } from "@stellar/stellar-sdk";

/**
 * Validation helpers for the bridge mint path.
 *
 * These guard the boundary between source-chain events and on-chain wrap
 * attestations. Failing fast here (instead of signing a payload that will
 * revert, or worse, hash differently on-chain) prevents mint requests from
 * stalling the queue forever.
 */

/**
 * Largest amount that can be bridged. The on-chain controller hashes the
 * amount as i64 (`amount as i64`, a *saturating* cast) while the TS signer
 * uses `BigInt.asIntN(64, …)` (a *wrapping* cast). For amounts above
 * i64::MAX the two sides hash different bytes, so the ed25519 attestation
 * can never verify on-chain and the wrap would revert. Reject anything
 * outside [1, i64::MAX] at enqueue time.
 */
export const MAX_MINTABLE_AMOUNT = 9_223_372_036_854_775_807n; // i64::MAX

export function isMintableAmount(amount: bigint): boolean {
  return amount > 0n && amount <= MAX_MINTABLE_AMOUNT;
}

/** 32-byte hex salt, with or without the 0x prefix. */
export function isValidSalt(salt: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(salt);
}

/** Valid Stellar destination (G… account or C… contract address). */
export function isValidStellarDest(dest: string): boolean {
  try {
    ScAddress.fromString(dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Source-chain address → 32 raw bytes. 64-char hex strings are used as-is;
 * anything else is ASCII-encoded and zero-padded to 32 bytes.
 *
 * MUST stay byte-identical to the on-chain `BytesN<32>` encoding in the
 * lending_controller and to the scval encoding in `mint/stellarMinter.ts`.
 * `signer.test.ts` pins the canonical payload digest, and the on-chain
 * C-6 canary pins the same digest on the Rust side — any drift here breaks
 * those tests.
 */
export function sourceAddrToBytes(sourceAddr: string): Buffer {
  const saHex = sourceAddr.startsWith("0x") ? sourceAddr.slice(2) : sourceAddr;
  if (/^[0-9a-fA-F]{64}$/.test(saHex)) {
    return Buffer.from(saHex, "hex");
  }
  const buf = Buffer.alloc(32);
  Buffer.from(sourceAddr, "ascii").subarray(0, 32).copy(buf);
  return buf;
}
