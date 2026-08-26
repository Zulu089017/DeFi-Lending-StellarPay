import {
  Horizon,
  Keypair,
  TransactionBuilder,
  Operation,
  nativeToScVal,
  Address as ScAddress,
  xdr,
} from "@stellar/stellar-sdk";
import { ethers } from "ethers";
import { config } from "../config.js";
import { markMinted, prisma } from "../store/db.js";
import { collectSignatures, payloadHash } from "../attest/signer.js";
import type { StellarMintRequest, SourceChainId, SourceEvent } from "../types.js";
import { logger } from "../utils/logger.js";
import {
  isMintableAmount,
  isValidSalt,
  isValidStellarDest,
  sourceAddrToBytes,
} from "../validation.js";
import {
  bridgeEventsIngestedTotal,
  bridgeMintFailuresTotal,
  bridgeMintsTotal,
  bridgePendingMints,
  recordQuorumFailure,
} from "../utils/metrics.js";

const CHAIN_IDS: Record<SourceChainId, number> = {
  ethereum: 1,
  polygon: 137,
  solana: 0,
};

/** A pending mint request is dead-lettered after this many failed attempts
 *  so one permanently-failing request can't starve the rest of the queue. */
const MAX_MINT_ATTEMPTS = 10;

/** Returns a human-readable reason when `ev` can never mint on-chain, or
 *  null when it is safe to enqueue. */
function mintValidationError(ev: SourceEvent, stellarDest: string): string | null {
  if (!isMintableAmount(ev.amount)) {
    return `amount ${ev.amount} outside mintable range [1, i64::MAX]`;
  }
  if (!isValidSalt(ev.salt)) {
    return `salt is not 32 bytes hex: ${ev.salt}`;
  }
  if (!isValidStellarDest(stellarDest)) {
    return `invalid Stellar destination: ${stellarDest}`;
  }
  return null;
}

// NOTE: The on-chain `lending_controller.wrap` now accepts a Vec of
// (key_index, ed25519_signature) pairs and enforces a configurable threshold
// (2-of-3 by default). The off-chain signer collects >= threshold signatures
// and sends them all on-chain. See `attest/signer.ts`.

export class StellarMinter {
  private server: Horizon.Server;
  private keypair: Keypair;
  private controller: string;
  private network: string;

  constructor() {
    this.server = new Horizon.Server(config.STELLAR_RPC);
    this.keypair = Keypair.fromSecret(config.RELAYER_SECRET);
    this.controller = config.STELLAR_CONTROLLER;
    this.network = config.STELLAR_NETWORK_PASSPHRASE;
  }

  /** Queue a mint request from a SourceEvent. */
  async enqueue(ev: SourceEvent, stellarDest: string): Promise<void> {
    // Only source-chain `Locked`/`Burned` events mint. Stellar events are
    // unwraps and must never reach the mint queue (they have no chain id).
    if (ev.chain === "stellar") {
      logger.warn({ txHash: ev.txHash }, "skipping stellar event in mint queue");
      return;
    }

    // Validate BEFORE enqueueing. A request that can never mint on-chain
    // (amount outside the i64 range the payload hashes, malformed salt or
    // destination) would otherwise sit in the pending queue forever and
    // starve every event behind it. Record it as `failed` so it is visible
    // in the DB and metrics instead of silently dropped or retried.
    const validationError = mintValidationError(ev, stellarDest);
    if (validationError) {
      logger.error(
        { txHash: ev.txHash, reason: validationError },
        "rejecting source event: invalid for minting",
      );
      await prisma.mintRequest.upsert({
        where: { sourceTx_sourceLogIndex: { sourceTx: ev.txHash, sourceLogIndex: ev.logIndex } },
        create: {
          chain: ev.chain,
          sourceTx: ev.txHash,
          sourceLogIndex: ev.logIndex,
          sourceAddress: ev.token,
          amount: ev.amount,
          to: stellarDest,
          salt: ev.salt,
          status: "failed",
          attempts: 1,
          lastError: validationError,
        },
        update: {},
      });
      bridgeMintFailuresTotal.inc();
      return;
    }

    await prisma.mintRequest.upsert({
      where: { sourceTx_sourceLogIndex: { sourceTx: ev.txHash, sourceLogIndex: ev.logIndex } },
      create: {
        chain: ev.chain,
        sourceTx: ev.txHash,
        sourceLogIndex: ev.logIndex,
        sourceAddress: ev.token,
        amount: ev.amount,
        to: stellarDest,
        salt: ev.salt,
        status: "pending",
      },
      update: {},
    });
    bridgeEventsIngestedTotal.inc();
  }

  /** Process pending mint requests. */
  async processPending(): Promise<{ minted: number; failed: number; pending: number }> {
    const pending = await prisma.mintRequest.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      take: 25,
    });

    let minted = 0;
    let failed = 0;

    for (const req of pending) {
      const attempts = req.attempts + 1;
      // Dead-letter: a request that keeps failing (e.g. the source chain
      // reorged the event away) must not block the queue forever. After
      // MAX_MINT_ATTEMPTS it is marked failed so later events drain.
      if (attempts > MAX_MINT_ATTEMPTS) {
        await prisma.mintRequest.update({
          where: { sourceTx_sourceLogIndex: { sourceTx: req.sourceTx, sourceLogIndex: req.sourceLogIndex } },
          data: { status: "failed", attempts, lastError: "max mint attempts exceeded" },
        });
        logger.error({ req }, "mint request dead-lettered after max attempts");
        failed++;
        continue;
      }
      try {
        const req_typed: StellarMintRequest = {
          chain: req.chain as SourceChainId,
          sourceTx: req.sourceTx,
          sourceLogIndex: req.sourceLogIndex,
          sourceAddress: req.sourceAddress,
          amount: req.amount,
          to: req.to,
          salt: req.salt,
        };
        const ok = await this.mint(req_typed);
        if (ok) {
          minted++;
        } else {
          failed++;
          await prisma.mintRequest.update({
            where: { sourceTx_sourceLogIndex: { sourceTx: req.sourceTx, sourceLogIndex: req.sourceLogIndex } },
            data: { attempts, lastError: "mint attempt failed" },
          });
        }
      } catch (err) {
        failed++;
        await prisma.mintRequest.update({
          where: { sourceTx_sourceLogIndex: { sourceTx: req.sourceTx, sourceLogIndex: req.sourceLogIndex } },
          data: { attempts, lastError: String(err) },
        });
        logger.error({ err, req }, "mint failed");
      }
    }

    const remaining = await prisma.mintRequest.count({ where: { status: "pending" } });
    bridgePendingMints.set(remaining);
    return { minted, failed, pending: remaining };
  }

  /** Submit the `wrap` call to the Soroban controller. */
  async mint(req: StellarMintRequest): Promise<boolean> {
    const chainId = CHAIN_IDS[req.chain];
    // Per-event nonce: take the lower 64 bits of keccak256(sourceTx || logIndex)
    // so every source event produces a unique, deterministic nonce that fits
    // in a u64 and cannot be predicted by a same-source attacker.
    const nonceHash = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "uint256"], [req.sourceTx, req.sourceLogIndex]),
    );
    const nonce = BigInt(nonceHash) & 0xffffffffffffffffn;
    const payload = payloadHash({
      chainId,
      sourceToken: req.sourceAddress,
      amount: req.amount,
      stellarDest: req.to,
      salt: req.salt,
      nonce,
    });
    const sigs = await collectSignatures(payload);
    if (sigs.length === 0) {
      recordQuorumFailure();
      logger.error("no signatures collected");
      return false;
    }

    // Enforce the attester quorum off-chain as a safety net (the on-chain
    // contract also enforces threshold independently).
    if (sigs.length < config.ATTESTER_THRESHOLD) {
      recordQuorumFailure();
      logger.error(
        { got: sigs.length, need: config.ATTESTER_THRESHOLD },
        "insufficient attester signatures (quorum not met)",
      );
      return false;
    }

    // Build the sorted (key_index, BytesN<64>) attestation Vec for the
    // controller's `wrap` entry point. Signatures are already collected in
    // index order (attesters are iterated sequentially).
    const attestationScVals = sigs.map(({ sig, index }) => {
      const sigBytes = Buffer.from(sig.replace(/^0x/, ""), "hex");
      if (sigBytes.length !== 64) {
        throw new Error(`unexpected signature length: ${sigBytes.length}`);
      }
      return xdr.ScVal.scvVec([
        nativeToScVal(index, { type: "u32" }),
        xdr.ScVal.scvBytes(sigBytes),
      ]);
    });
    const attestationsScval = xdr.ScVal.scvVec(attestationScVals);

    const saltBytes = Buffer.from(req.salt.replace(/^0x/, ""), "hex");
    if (saltBytes.length !== 32) {
      logger.error({ len: saltBytes.length }, "salt must be 32 bytes");
      return false;
    }
    const saltScval = xdr.ScVal.scvBytes(saltBytes);
    const nonceU64 = nativeToScVal(nonce, { type: "u64" });    // sourceAddress is a 32-byte BytesN<32> on-chain. Shared encoding with
    // the signer's payloadHash (see src/validation.ts) — the C-6 canary
    // pins the digest on both sides.
    const sourceAddrBytes = sourceAddrToBytes(req.sourceAddress);
    const sourceAddrScval = xdr.ScVal.scvBytes(sourceAddrBytes);

    const source = await this.server.loadAccount(this.keypair.publicKey());
    const tx = new TransactionBuilder(source, {
      fee: "100000",
      networkPassphrase: this.network,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.controller,
          function: "wrap",
          args: [
            attestationsScval,
            nativeToScVal(chainId, { type: "u32" }),
            sourceAddrScval,
            nativeToScVal(req.amount, { type: "i128" }),
            ScAddress.fromString(req.to).toScVal(),
            saltScval,
            nonceU64,
          ],
        }) as any,
      )
      .setTimeout(60)
      .build();

    try {
      const result = await this.server.submitTransaction(tx);
      await markMinted(req.sourceTx, req.sourceLogIndex, result.hash);
      bridgeMintsTotal.inc();
      logger.info({ tx: result.hash, sourceTx: req.sourceTx }, "minted wTKN on Stellar");
      return true;
    } catch (err) {
      const detail =
        typeof err === "object" && err !== null ? JSON.stringify(err) : String(err);
      // Idempotency: if the previous attempt actually landed on-chain but
      // its response was lost (RPC timeout), the retry reverts with
      // "salt already used". Mark the request minted so it is not retried
      // forever — the wrap did happen.
      if (detail.includes("salt already used")) {
        await markMinted(req.sourceTx, req.sourceLogIndex, "replayed-salt");
        bridgeMintsTotal.inc();
        logger.warn({ sourceTx: req.sourceTx }, "salt replay — wrap already landed, marking minted");
        return true;
      }
      bridgeMintFailuresTotal.inc();
      logger.error({ err, sourceTx: req.sourceTx }, "submit failed");
      return false;
    }
  }
}
