import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ethers } from "ethers";
import { Horizon, Keypair, TransactionBuilder, Operation, Networks } from "@stellar/stellar-sdk";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import {
  relayerAttemptsTotal,
  relayerFailuresTotal,
  relayerPendingQueueSize,
  relayerSubmissionsTotal,
} from "./utils/metrics.js";

export const prisma = new PrismaClient();

/** A job in the relayer queue. The payload is pre-signed and chain-specific. */
export type RelayerJob = {
  id: string;
  chain: "stellar" | "ethereum" | "polygon";
  signedTxXdr?: string; // base64 XDR for Stellar
  rawTx?: string; // hex RLP for EVM
  attempts: number;
  status: "pending" | "submitted" | "failed";
};

const EVM_BRIDGE_ABI = [
  "function release(address token, address recipient, uint256 amount, bytes32 stellarTxHash, uint256 nonce, bytes[] calldata signatures) external",
];

export class Relayer {
  private stellarKeypair = Keypair.fromSecret(config.STELLAR_RELAYER_SECRET);
  private ethProvider = new ethers.JsonRpcProvider(config.ETHEREUM_RPC);
  private polyProvider = new ethers.JsonRpcProvider(config.POLYGON_RPC);
  private ethWallet = new ethers.Wallet(config.ETHEREUM_RELAYER_PK, this.ethProvider);
  private polyWallet = new ethers.Wallet(config.POLYGON_RELAYER_PK, this.polyProvider);

  async processOnce() {
    const jobs = await prisma.relayerJob.findMany({
      where: { status: "pending" },
      take: 25,
      orderBy: { createdAt: "asc" },
    });
    relayerPendingQueueSize.set(jobs.length);
    for (const job of jobs) {
      relayerAttemptsTotal.inc({ chain: job.chain });
      try {
        if (job.chain === "stellar") {
          await this.submitStellar(job);
        } else if (job.chain === "ethereum") {
          await this.submitEvm(job, this.ethWallet, "ethereum");
        } else if (job.chain === "polygon") {
          await this.submitEvm(job, this.polyWallet, "polygon");
        }
      } catch (err) {
        relayerFailuresTotal.inc({ chain: job.chain });
        logger.error({ err, jobId: job.id }, "relayer submission failed");
        await prisma.relayerJob.update({
          where: { id: job.id },
          data: {
            attempts: { increment: 1 },
            status: job.attempts + 1 >= config.MAX_RETRIES ? "failed" : "pending",
            lastError: String(err),
          },
        });
      }
    }
  }

  private async submitStellar(job: any) {
    const server = new Horizon.Server(config.STELLAR_RPC);
    const envelope = job.signedTxXdr;
    const tx = new (await import("@stellar/stellar-sdk")).Transaction(
      envelope,
      config.STELLAR_NETWORK_PASSPHRASE,
    );
    const result = await server.submitTransaction(tx);
    relayerSubmissionsTotal.inc({ chain: "stellar" });
    await prisma.relayerJob.update({
      where: { id: job.id },
      data: { status: "submitted", submittedHash: result.hash, submittedAt: new Date() },
    });
    logger.info({ hash: result.hash, jobId: job.id }, "stellar tx submitted");
  }

  private async submitEvm(job: any, wallet: ethers.Wallet, chain: "ethereum" | "polygon") {
    const raw = job.rawTx as string;
    if (!raw) throw new Error(`EVM job ${job.id} missing rawTx`);
    const tx = await wallet.sendTransaction({ data: raw });
    const receipt = await tx.wait();
    relayerSubmissionsTotal.inc({ chain });
    await prisma.relayerJob.update({
      where: { id: job.id },
      data: { status: "submitted", submittedHash: tx.hash, submittedAt: new Date() },
    });
    logger.info({ hash: tx.hash, chain, jobId: job.id }, "evm tx submitted");
  }
}
