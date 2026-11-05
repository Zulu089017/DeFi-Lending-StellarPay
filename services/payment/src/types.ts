/** Chains whose `Locked`/`Burned` events can mint on Stellar. */
export type SourceChainId = "ethereum" | "polygon" | "solana";

/** Any chain the bridge watches, including Stellar (unwrap events only). */
export type ChainId = SourceChainId | "stellar";

export interface SourceEvent {
  chain: ChainId;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  sender: string;
  token: string;
  amount: bigint;
  stellarDest: string; // ed25519 pubkey
  salt: string; // 32-byte hex
  nonce: bigint;
  raw: unknown;
}

export interface StellarMintRequest {
  chain: SourceChainId;
  sourceTx: string;
  sourceLogIndex: number;
  sourceAddress: string;
  amount: bigint;
  to: string;
  salt: string;
}

/** A decoded `unwrap` contract event from the lending_controller.
 *
 *  On-chain shape (contracts/lending/controller/src/lib.rs):
 *    Unwrap { user: Address, amount: i128, chain_id: u32,
 *             source_addr: BytesN<32>, nonce: BytesN<32> }
 *
 *  `user` is the Stellar account whose wrapped tokens were burned;
 *  `source_addr` is the destination on the source chain (a 32-byte,
 *  left-zero-padded EVM address for EVM chains). */
export interface UnwrapEvent {
  chain: "stellar";
  txHash: string;
  ledger: bigint;
  user: string;
  amount: bigint;
  chainId: number;
  sourceChain: SourceChainId;
  sourceAddr: string; // 0x + 32 bytes hex
  nonce: string; // 0x + 32 bytes hex
}

/** A persisted unwrap awaiting (or past) its EVM release. */
export interface PendingRelease {
  id: string;
  txHash: string;
  chainId: number;
  sourceChain: SourceChainId;
  recipient: string;
  amount: bigint;
  nonce: string;
  attempts: number;
}

export type UnwrapStatus = "pending" | "released" | "failed";

export interface BridgeStatus {
  service: "bridge";
  uptimeSec: number;
  lastBlockEthereum: number | null;
  lastBlockPolygon: number | null;
  lastSlotSolana: number | null;
  processedEvents: number;
  pendingMints: number;
}
