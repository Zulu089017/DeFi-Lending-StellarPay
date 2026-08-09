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

const CHAIN_IDS: Record<SourceChainId, number> = {
  ethereum: 1,
  polygon: 137,
  solana: 0,
};

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
  }

  /** Process pending mint requests. */
  async processPending(): Promise<{ minted: number; failed: number }> {
    const pending = await prisma.mintRequest.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      take: 25,
    });

    let minted = 0;
    let failed = 0;

    for (const req of pending) {
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
        if (ok) minted++;
        else failed++;
      } catch (err) {
        logger.error({ err, req }, "mint failed");
        failed++;
      }
    }

    return { minted, failed };
  }

  /** Submit the `wrap` call to the Soroban controller. */
  async mint(req: StellarMintRequest): Promise<boolean> {
    const chainId = CHAIN_IDS[req.chain];
    // Per-event nonce: take the lower 64 bits of keccak256(sourceTx || logIndex)
    // so every source event produces a unique, deterministic nonce that fits
    // in a u64 and cannot be predicted by a same-source attacker.
    const nonceHash = ethers.keccak256(
      ethers.solidityPacked(
        ["bytes32", "uint256"],
        [req.sourceTx, req.sourceLogIndex],
      ),
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
      logger.error("no signatures collected");
      return false;
    }

    // Enforce the attester quorum off-chain as a safety net (the on-chain
    // contract also enforces threshold independently).
    if (sigs.length < config.ATTESTER_THRESHOLD) {
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
    const nonceU64 = nativeToScVal(nonce, { type: "u64" });

    // sourceAddress is now a 32-byte BytesN<32> on-chain. Accept either
    // a 32-byte hex string (with or without 0x) or an ASCII string padded
    // to 32 bytes.
    const saHex = req.sourceAddress.startsWith("0x")
      ? req.sourceAddress.slice(2)
      : req.sourceAddress;
    let sourceAddrBytes: Buffer;
    if (/^[0-9a-fA-F]{64}$/.test(saHex)) {
      sourceAddrBytes = Buffer.from(saHex, "hex");
    } else {
      sourceAddrBytes = Buffer.alloc(32);
      Buffer.from(req.sourceAddress, "ascii")
        .subarray(0, 32)
        .copy(sourceAddrBytes);
    }
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
      logger.info({ tx: result.hash, sourceTx: req.sourceTx }, "minted wTKN on Stellar");
      return true;
    } catch (err) {
      logger.error({ err, sourceTx: req.sourceTx }, "submit failed");
      return false;
    }
  }
}
