import { Address as ScAddress } from "@stellar/stellar-sdk";
import type { SourceChainId } from "../types.js";

/** EVM chain ids the release pipeline can serve. Keep this in sync with
 *  `services/payment/src/mint/stellarMinter.ts` (wrap side) and with the
 *  Bridge deployments listed in DEPLOYMENTS.md. A chain that is missing here
 *  is NOT advertised as supported: its unwraps are rejected instead of being
 *  left in a queue that can never drain. */
export const EVM_CHAIN_IDS = { 1: "ethereum", 137: "polygon" } as const;

export type EvmChainId = keyof typeof EVM_CHAIN_IDS;

export function sourceChainForChainId(chainId: number): SourceChainId | null {
  return (EVM_CHAIN_IDS as Record<number, SourceChainId | undefined>)[chainId] ?? null;
}

export interface RawUnwrapMeta {
  txHash: string;
  ledger: number | bigint;
}

export interface DecodedUnwrap {
  chain: "stellar";
  txHash: string;
  ledger: bigint;
  user: string;
  amount: bigint;
  chainId: number;
  sourceChain: SourceChainId;
  sourceAddr: string;
  nonce: string;
  released?: boolean;
  destination?: string;
  releaseTxHash?: string | null;
}

/** Decode the native (JS) representation of a `#[contractevent] Unwrap`
 *  value into an `UnwrapEvent`.
 *
 *  `scValToNative` turns the event's `Vec` data into a JS array:
 *    [user, amount, chain_id, source_addr, nonce]
 *  where `user` is a Strkey string, `amount` is a bigint (i128), `chain_id`
 *  is a number (u32), and `source_addr` / `nonce` are 32-byte `Uint8Array`s.
 *
 *  Throws on any shape mismatch: a malformed event must never be signed into
 *  a `Release` (which would release real tokens to the wrong recipient or
 *  with the wrong amount).
 */
export function decodeUnwrapValue(value: unknown, meta: RawUnwrapMeta): DecodedUnwrap {
  if (!Array.isArray(value) || value.length !== 5) {
    throw new Error(
      `unwrap event must carry 5 fields, got ${Array.isArray(value) ? value.length : typeof value}`,
    );
  }
  const [user, amount, chainId, sourceAddr, nonce] = value;

  if (typeof user !== "string") {
    throw new Error(`unwrap user is not a string: ${typeof user}`);
  }
  try {
    ScAddress.fromString(user);
  } catch {
    throw new Error(`unwrap user is not a valid Stellar address: ${user}`);
  }

  const amountBig = typeof amount === "bigint" ? amount : BigInt(String(amount));
  if (amountBig <= 0n) {
    throw new Error(`unwrap amount must be positive, got ${amountBig}`);
  }

  const chainIdNum = Number(chainId);
  if (!Number.isSafeInteger(chainIdNum) || chainIdNum < 0) {
    throw new Error(`unwrap chain_id is not a valid u32: ${String(chainId)}`);
  }

  const sourceChain = sourceChainForChainId(chainIdNum);
  if (!sourceChain) {
    // Unsupported chain: reject loudly. The caller records the row as failed
    // so it is visible rather than silently stuck.
    throw new Error(`unsupported unwrap chain_id ${chainIdNum}`);
  }

  const sourceBytes = toBytes32(sourceAddr, "source_addr");
  const nonceBytes = toBytes32(nonce, "nonce");

  return {
    chain: "stellar",
    txHash: meta.txHash,
    ledger: BigInt(meta.ledger),
    user,
    amount: amountBig,
    chainId: chainIdNum,
    sourceChain,
    sourceAddr: "0x" + Buffer.from(sourceBytes).toString("hex"),
    nonce: "0x" + Buffer.from(nonceBytes).toString("hex"),
  };
}

function toBytes32(v: unknown, label: string): Uint8Array {
  const bytes =
    v instanceof Uint8Array
      ? v
      : typeof v === "string"
        ? Buffer.from(v.replace(/^0x/, ""), "hex")
        : null;
  if (!bytes || bytes.length !== 32) {
    throw new Error(`${label} must be 32 bytes, got ${bytes ? bytes.length : typeof v}`);
  }
  return bytes;
}

/** Derive the EVM recipient from the 32-byte `source_addr` field.
 *
 *  EVM addresses are encoded left-zero-padded to 32 bytes
 *  (`bytes32(uint256(uint160(addr)))`). We reject a non-zero high 12 bytes
 *  rather than silently truncating: a malformed destination must never
 *  release funds to an unintended address.
 */
export function evmRecipientFromSourceAddr(sourceAddr: string): string {
  const hex = sourceAddr.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`source_addr must be 32 bytes hex, got ${hex.length} chars`);
  }
  const high = hex.slice(0, 24); // 12 bytes
  if (!/^0{24}$/.test(high)) {
    throw new Error("source_addr has non-zero high 12 bytes; not an EVM address");
  }
  const addr = "0x" + hex.slice(24);
  if (addr === "0x" + "0".repeat(40)) {
    throw new Error("source_addr decodes to the zero address");
  }
  return addr;
}

/** u256 nonce for `Bridge.release` from the 32-byte Stellar nonce. */
export function evmNonceFromStellarNonce(nonce: string): bigint {
  const hex = nonce.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`nonce must be 32 bytes hex, got ${hex.length} chars`);
  }
  return BigInt("0x" + hex);
}

/** `Bridge.release` wants the Stellar tx hash as `bytes32`. */
export function stellarTxHashToBytes32(txHash: string): string {
  const hex = txHash.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`stellar tx hash must be 32 bytes hex, got ${hex.length} chars`);
  }
  return "0x" + hex.toLowerCase();
}
