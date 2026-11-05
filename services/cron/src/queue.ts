import { PrismaClient } from "@prisma/client";
import { ethers } from "ethers";
import { Horizon, Transaction } from "@stellar/stellar-sdk";
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

export class Relayer {
  private ethProvider = new ethers.JsonRpcProvider(config.ETHEREUM_RPC);
  private polyProvider = new ethers.JsonRpcProvider(config.POLYGON_RPC);

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
          await this.submitEvm(job, "ethereum", this.ethProvider);
        } else if (job.chain === "polygon") {
          await this.submitEvm(job, "polygon", this.polyProvider);
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

  private async submitStellar(job: { id: string; signedTxXdr?: string | null }) {
    if (!job.signedTxXdr) throw new Error(`Stellar job ${job.id} missing signedTxXdr`);
    const server = new Horizon.Server(config.STELLAR_RPC);
    const tx = new Transaction(job.signedTxXdr, config.STELLAR_NETWORK_PASSPHRASE);
    const result = await server.submitTransaction(tx);
    relayerSubmissionsTotal.inc({ chain: "stellar" });
    await prisma.relayerJob.update({
      where: { id: job.id },
      data: { status: "submitted", submittedHash: result.hash, submittedAt: new Date() },
    });
    logger.info({ hash: result.hash, jobId: job.id }, "stellar tx submitted");
  }

  /**
   * Broadcast a pre-signed EVM transaction.
   *
   * `rawTx` is the hex-encoded **signed RLP envelope**, not calldata. The
   * previous implementation passed it to `wallet.sendTransaction({ data })`,
   * which produced an unrelated contract-creation transaction with no `to`
   * and no signature — the release never happened. Broadcasting the envelope
   * with the provider is the correct (and only) way to submit it.
   */
  private async submitEvm(
    job: { id: string; rawTx?: string | null },
    chain: "ethereum" | "polygon",
    provider: ethers.Provider,
  ) {
    const raw = job.rawTx;
    if (!raw) throw new Error(`EVM job ${job.id} missing rawTx`);
    if (!/^0x[0-9a-fA-F]+$/.test(raw) || raw.length < 10) {
      throw new Error(`EVM job ${job.id} rawTx is not a hex-encoded signed transaction`);
    }
    const tx = await provider.broadcastTransaction(raw);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`EVM tx ${tx.hash} did not confirm successfully`);
    }
    relayerSubmissionsTotal.inc({ chain });
    await prisma.relayerJob.update({
      where: { id: job.id },
      data: { status: "submitted", submittedHash: receipt.hash, submittedAt: new Date() },
    });
    logger.info({ hash: receipt.hash, chain, jobId: job.id }, "evm tx submitted");
  }
}
