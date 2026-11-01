import { PrismaClient } from "@prisma/client";
import type { SourceChainId, SourceEvent, StellarMintRequest, UnwrapEvent } from "../types.js";

export const prisma = new PrismaClient();

/** Record a source-chain event. Idempotent on (chain, txHash, logIndex). */
export async function saveEvent(ev: SourceEvent): Promise<void> {
  await prisma.sourceEvent.upsert({
    where: {
      chain_txHash_logIndex: { chain: ev.chain, txHash: ev.txHash, logIndex: ev.logIndex },
    },
    create: {
      chain: ev.chain,
      txHash: ev.txHash,
      logIndex: ev.logIndex,
      blockNumber: BigInt(ev.blockNumber),
      sender: ev.sender,
      token: ev.token,
      amount: ev.amount,
      stellarDest: ev.stellarDest,
      salt: ev.salt,
      nonce: ev.nonce,
    },
    update: {},
  });
}

export async function listPendingMints(): Promise<StellarMintRequest[]> {
  const rows = await prisma.mintRequest.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  return rows.map((r: { chain: string; sourceTx: string; sourceLogIndex: number; sourceAddress: string; amount: bigint; to: string; salt: string }) => ({
    chain: r.chain as SourceChainId,
    sourceTx: r.sourceTx,
    sourceLogIndex: r.sourceLogIndex,
    sourceAddress: r.sourceAddress,
    amount: r.amount,
    to: r.to,
    salt: r.salt,
  }));
}

export async function markMinted(
  sourceTx: string,
  sourceLogIndex: number,
  stellarTxHash: string,
): Promise<void> {
  await prisma.mintRequest.update({
    where: { sourceTx_sourceLogIndex: { sourceTx, sourceLogIndex } },
    data: { status: "minted", stellarTxHash },
  });
}

export async function saveUnwrap(ev: UnwrapEvent): Promise<void> {
  await prisma.unwrapEvent.upsert({
    where: { txHash_nonce: { txHash: ev.txHash, nonce: ev.nonce } },
    create: {
      chain: ev.chain,
      txHash: ev.txHash,
      ledger: ev.ledger,
      user: ev.user,
      amount: ev.amount,
      chainId: ev.chainId,
      sourceChain: ev.sourceChain,
      sourceAddr: ev.sourceAddr,
      nonce: ev.nonce,
      status: "pending",
    },
    // An unwrap is immutable once observed. Never overwrite a row that a
    // concurrent release attempt may already have advanced.
    update: {},
  });
}

/** Record an unwrap event that could never be released (unsupported chain,
 *  malformed payload, …). Persisted as `failed` so it is visible in the API
 *  and metrics instead of silently skipped. */
export async function markUnwrapFailed(txHash: string, reason: string): Promise<void> {
  // A malformed event has no trustworthy nonce, so use a sentinel that still
  // lets multiple failed events in one transaction coexist.
  const nonce = "invalid";
  await prisma.unwrapEvent.upsert({
    where: { txHash_nonce: { txHash, nonce } },
    create: {
      chain: "stellar",
      txHash,
      user: "unknown",
      amount: 0n,
      sourceChain: "unknown",
      sourceAddr: "",
      nonce,
      status: "failed",
      lastError: reason.slice(0, 500),
    },
    update: { status: "failed", lastError: reason.slice(0, 500) },
  });
}

/** Unwraps awaiting an EVM release, oldest first. */
export async function listPendingReleases(limit = 25) {
  return prisma.unwrapEvent.findMany({
    where: { status: "pending", released: false },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/** Mark an unwrap released only after its release is confirmed on-chain.
 *  `releaseTxHash` is null when the release was already executed on-chain by
 *  another party (replay detected); the row is still terminal. */
export async function markUnwrapReleased(
  id: string,
  releaseTxHash: string | null,
): Promise<void> {
  await prisma.unwrapEvent.update({
    where: { id },
    data: {
      status: "released",
      released: true,
      releaseTxHash,
      lastError: releaseTxHash ? null : "already released on-chain",
    },
  });
}

export async function markUnwrapReleaseAttempt(
  id: string,
  attempts: number,
  error: string | null,
): Promise<void> {
  await prisma.unwrapEvent.update({
    where: { id },
    data: { releaseAttempts: attempts, lastError: error ? error.slice(0, 500) : null },
  });
}

export async function markUnwrapReleaseFailed(id: string, error: string): Promise<void> {
  await prisma.unwrapEvent.update({
    where: { id },
    data: { status: "failed", lastError: error.slice(0, 500) },
  });
}

export async function countPendingReleases(): Promise<number> {
  return prisma.unwrapEvent.count({ where: { status: "pending", released: false } });
}
