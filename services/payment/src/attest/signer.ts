import * as ed from "@noble/ed25519";
import { createHash } from "crypto";
import { ethers } from "ethers";
import { Address as ScAddress } from "@stellar/stellar-sdk";
import { attesters, config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Canonical payload format (must match `build_canonical_payload` in
 * stellar-contracts/contracts/lending_controller/src/lib.rs).
 *
 * Layout (dynamic, appended in order):
 *   1. "OWRP" (4 ASCII bytes)
 *   2. chain_id (u32 LE)
 *   3. source_addr (32 raw bytes)
 *   4. amount (i64 LE)
 *   5. to: full ScVal XDR of the Address (44 bytes for an ed25519
 *      account: 4-byte ScVal tag + 4-byte ScAddress tag + 4-byte
 *      AccountId tag + 32-byte raw pubkey)
 *   6. salt (32 raw bytes)
 *   7. nonce (u64 LE)
 *
 * The on-chain side uses `to.to_xdr(env)` to serialize the Address. The
 * off-chain side must use the exact same XDR — we get it via
 * `ScAddress.fromString(...).toScVal().toXDR()`. We then sha256(payload)
 * and ed25519-sign the 32-byte digest. Soroban has `env.crypto().sha256`
 * and `env.crypto().ed25519_verify` but NOT keccak256.
 */
export function payloadHash(args: {
  chainId: number;
  sourceToken: string;
  amount: bigint;
  stellarDest: string; // Strkey "G..."
  salt: string;       // 32-byte hex with or without 0x
  nonce: bigint;
}): Uint8Array {
  const bufs: Buffer[] = [];
  // 1. tag
  bufs.push(Buffer.from("OWRP", "ascii"));
  // 2. chain_id (u32 LE)
  const cid = Buffer.alloc(4);
  cid.writeUInt32LE(args.chainId >>> 0);
  bufs.push(cid);
  // 3. source_addr (32 raw bytes)
  const saHex = args.sourceToken.startsWith("0x")
    ? args.sourceToken.slice(2)
    : args.sourceToken;
  let sa: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(saHex)) {
    sa = Buffer.from(saHex, "hex");
  } else {
    sa = Buffer.alloc(32);
    Buffer.from(args.sourceToken, "ascii").subarray(0, 32).copy(sa);
  }
  bufs.push(sa);
  // 4. amount (i64 LE) — clamp to i64 range
  const amt = Buffer.alloc(8);
  amt.writeBigInt64LE(BigInt.asIntN(64, args.amount));
  bufs.push(amt);
  // 5. to: full ScVal XDR of the Address
  const toScVal = ScAddress.fromString(args.stellarDest).toScVal();
  const toXdr = Buffer.from(toScVal.toXDR());
  // Mirror the on-chain sanity check: an ed25519 Address serializes to
  // exactly 44 bytes (ScVal tag 4 + ScAddress tag 4 + AccountId tag 4 +
  // 32-byte pubkey). If this ever changes, the on-chain assertion in
  // `build_canonical_payload` will catch it — but failing fast at signing
  // time is much cheaper than reverting at mint time.
  if (toXdr.length !== 44) {
    throw new Error(`expected 44-byte Address XDR, got ${toXdr.length}`);
  }
  bufs.push(toXdr);
  // 6. salt (32 raw bytes)
  const saltHex = args.salt.replace(/^0x/, "");
  if (saltHex.length !== 64) {
    throw new Error(`salt must be 32 bytes (64 hex chars), got ${saltHex.length}`);
  }
  bufs.push(Buffer.from(saltHex, "hex"));
  // 7. nonce (u64 LE)
  const nonce = Buffer.alloc(8);
  nonce.writeBigUInt64LE(BigInt.asUintN(64, args.nonce));
  bufs.push(nonce);

  const payload = Buffer.concat(bufs);
  return new Uint8Array(createHash("sha256").update(payload).digest());
}

/** Sign the payload with each attester's ed25519 secret key, collecting
 *  up to `ATTESTER_THRESHOLD` signatures. Returns the signatures as
 *  hex strings (64 bytes each) along with their attester index (0-based),
 *  ready to be packed into sorted `(key_index, sig)` Vec<ScVal> pairs
 *  for the lending_controller's `wrap` entry point. */
export async function collectSignatures(
  payload: Uint8Array,
): Promise<{ sig: string; index: number }[]> {
  const sigs: { sig: string; index: number }[] = [];
  let idx = 0;
  for (const pk of attesters) {
    try {
      const secretKey = Buffer.from(pk.replace(/^0x/, ""), "hex");
      if (secretKey.length !== 32) throw new Error("ed25519 secret must be 32 bytes");
      const sig = await ed.sign(payload, secretKey);
      sigs.push({ sig: "0x" + Buffer.from(sig).toString("hex"), index: idx });
      if (sigs.length >= config.ATTESTER_THRESHOLD) break;
    } catch (err) {
      logger.error({ err }, "attester failed to sign");
    }
    idx += 1;
  }
  return sigs;
}

// ─────────────────────────── EIP-712 (EVM release) ───────────────────────
//
// EIP-712 typed data for the `Bridge.release` function on the EVM side.
// The on-chain digest is:
//
//   digest = keccak256("\x19\x01" || domainSeparator || structHash)
//
// where:
//
//   domainSeparator = keccak256(abi.encode(
//       keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
//       keccak256("StellarPay Bridge"),
//       keccak256("1"),
//       block.chainid,
//       address(this)
//   ))
//
//   structHash = keccak256(abi.encode(
//       RELEASE_TYPEHASH,
//       token, recipient, amount, stellarTxHash, nonce
//   ))
//
//   RELEASE_TYPEHASH = keccak256("Release(address token,address recipient,uint256 amount,bytes32 stellarTxHash,uint256 nonce)")
//
// The on-chain side uses OpenZeppelin's `EIP712Upgradeable` to compute
// the domain separator and `_hashTypedDataV4` for the final digest
// (see evm-contracts/contracts/Bridge.sol). This function produces the
// matching 65-byte secp256k1 signatures.

/** EIP-712 domain for the StellarPay Bridge. Must match the values passed
 *  to `__EIP712_init(name, version)` in `Bridge.initialize`. */
export const STELLARPAY_EIP712_DOMAIN = Object.freeze({
  name: "StellarPay Bridge",
  version: "1",
});

/** EIP-712 type definitions for the `Release` struct. The field order
 *  MUST match the Solidity `RELEASE_TYPEHASH` exactly. */
export const RELEASE_EIP712_TYPES = Object.freeze({
  Release: [
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "stellarTxHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
});

/** Shape of the `Release` typed-data value. */
export interface ReleaseTypedValue {
  token: string;        // ERC-20 contract address
  recipient: string;    // EOA or contract receiving the released tokens
  amount: bigint;       // amount of `token` to release
  stellarTxHash: string; // 32-byte hash of the Stellar Unwrap event
  nonce: number | bigint; // replay-protection nonce (u256)
}

/** Sign a `Release` typed-data payload with each attester's secp256k1
 *  private key, returning 65-byte hex-encoded signatures.
 *
 *  @param attesterKeys   secp256k1 private keys (hex, with or without `0x`).
 *  @param chainId        EVM chain id of the target Bridge deployment.
 *  @param bridgeAddress  Address of the deployed `Bridge` contract.
 *  @param value          The `Release` struct fields.
 *  @returns              Array of `0x`-prefixed 65-byte signatures.
 *
 *  The caller is responsible for ordering the signatures to match the
 *  Bridge contract's attester threshold; the on-chain side does NOT
 *  require ascending order, so any subset of length >= threshold is
 *  accepted. */
export async function signEvmRelease(
  attesterKeys: string[],
  chainId: number,
  bridgeAddress: string,
  value: ReleaseTypedValue,
): Promise<string[]> {
  const domain = {
    ...STELLARPAY_EIP712_DOMAIN,
    chainId,
    verifyingContract: bridgeAddress,
  };
  const sigs: string[] = [];
  for (const pk of attesterKeys) {
    try {
      const wallet = new ethers.Wallet(pk);
      // ethers v6: `signTypedData` returns a 0x-prefixed 65-byte hex string.
      const sig = await wallet.signTypedData(domain, RELEASE_EIP712_TYPES, value);
      sigs.push(sig);
    } catch (err) {
      logger.error({ err }, "EVM attester failed to sign Release");
    }
  }
  return sigs;
}
