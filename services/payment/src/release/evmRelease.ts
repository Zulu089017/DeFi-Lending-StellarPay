import { ethers } from "ethers";
import { config, evmAttesters } from "../config.js";
import { signEvmRelease, type ReleaseTypedValue } from "../attest/signer.js";
import {
  evmNonceFromStellarNonce,
  evmRecipientFromSourceAddr,
  sourceChainForChainId,
  stellarTxHashToBytes32,
} from "../events/unwrap.js";
import {
  countPendingReleases,
  listPendingReleases,
  markUnwrapReleaseAttempt,
  markUnwrapReleaseFailed,
  markUnwrapReleased,
} from "../store/db.js";
import type { SourceChainId } from "../types.js";
import { logger } from "../utils/logger.js";
import {
  bridgePendingReleases,
  bridgeReleaseFailuresTotal,
  bridgeReleasesTotal,
  recordQuorumFailure,
} from "../utils/metrics.js";

/** Minimal ABI for the parts of `Bridge.sol` the release path needs. */
export const BRIDGE_RELEASE_ABI = [
  "function release(address token, address recipient, uint256 amount, bytes32 stellarTxHash, uint256 nonce, bytes[] signatures) external",
  "function releasedNonces(bytes32) view returns (bool)",
  "function isAttester(address) view returns (bool)",
  "event Released(address indexed recipient, address indexed token, uint256 amount, bytes32 indexed stellarTxHash, uint256 nonce)",
] as const;

/** Everything needed to submit a release for one source chain. */
export interface ReleaseContext {
  chain: SourceChainId;
  chainId: number;
  bridge: string;
  token: string;
  provider: ethers.Provider;
  signer: ethers.Wallet;
}

/** The DB row shape the pipeline consumes (subset of `UnwrapEvent`). */
export interface ReleaseRow {
  id: string;
  txHash: string;
  chainId: number;
  sourceChain: string;
  sourceAddr: string;
  amount: bigint;
  nonce: string;
  releaseAttempts: number;
}

/**
 * Build the chain contexts from configuration. Chains with a missing token,
 * RPC or submitter key are simply omitted: unwraps for them stay `pending`
 * instead of failing, and can be drained once the deployment is configured.
 * This is also what keeps the service from advertising a chain it cannot
 * actually complete a transfer on.
 */
export function buildReleaseContexts(
  cfg = config,
  attesterKeyCount = evmAttesters.length,
): Partial<Record<SourceChainId, ReleaseContext>> {
  const contexts: Partial<Record<SourceChainId, ReleaseContext>> = {};
  const candidates: Array<{
    chain: SourceChainId;
    chainId: number;
    rpc: string | undefined;
    bridge: string | undefined;
    token: string | undefined;
    pk: string | undefined;
  }> = [
    {
      chain: "ethereum",
      chainId: 1,
      rpc: cfg.ETHEREUM_RPC,
      bridge: cfg.ETHEREUM_BRIDGE,
      token: cfg.ETHEREUM_RELEASE_TOKEN,
      pk: cfg.ETHEREUM_RELAYER_PK,
    },
    {
      chain: "polygon",
      chainId: 137,
      rpc: cfg.POLYGON_RPC,
      bridge: cfg.POLYGON_BRIDGE,
      token: cfg.POLYGON_RELEASE_TOKEN,
      pk: cfg.POLYGON_RELAYER_PK,
    },
  ];

  for (const c of candidates) {
    if (!c.rpc || !c.bridge || !c.token || !c.pk) continue;
    if (attesterKeyCount < cfg.EVM_ATTESTER_THRESHOLD) continue;
    try {
      const provider = new ethers.JsonRpcProvider(c.rpc);
      const signer = new ethers.Wallet(c.pk, provider);
      contexts[c.chain] = {
        chain: c.chain,
        chainId: c.chainId,
        bridge: ethers.getAddress(c.bridge),
        token: ethers.getAddress(c.token),
        provider,
        signer,
      };
    } catch (err) {
      logger.error({ err, chain: c.chain }, "release context misconfigured; chain disabled");
    }
  }
  return contexts;
}

/** Build the EIP-712 `Release` struct for an unwrap row. Pure, so tests can
 *  pin the exact typed-data that gets signed. */
export function releaseTypedValue(ctx: ReleaseContext, row: ReleaseRow): ReleaseTypedValue {
  // The amount is passed through 1:1 in the token's smallest unit. The wrap
  // side (`lending_controller.wrap`) also mints the raw source amount, so both
  // directions use the same integer and no decimal scaling is implied.
  const chainId = row.chainId || ctx.chainId;
  const expected = sourceChainForChainId(chainId);
  if (expected !== ctx.chain) {
    throw new Error(
      `unwrap chain_id ${chainId} maps to ${expected ?? "nothing"}, not ${ctx.chain}`,
    );
  }
  return {
    token: ctx.token,
    recipient: evmRecipientFromSourceAddr(row.sourceAddr),
    amount: row.amount,
    stellarTxHash: stellarTxHashToBytes32(row.txHash),
    nonce: evmNonceFromStellarNonce(row.nonce),
  };
}

/** True when an ethers error is the contract's replay guard firing, which
 *  means the release already happened (possibly from a previous attempt whose
 *  response was lost). That is success, not a retryable failure. */
export function isAlreadyReleasedError(err: unknown): boolean {
  const text = collectErrorText(err);
  return (
    text.includes("ReleaseReplayed") ||
    text.includes("already released") ||
    text.includes("releasedNonces")
  );
}

function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    if (typeof cur === "object") {
      const o = cur as Record<string, unknown>;
      for (const k of ["shortMessage", "reason", "message", "data", "error"]) {
        if (typeof o[k] === "string") parts.push(o[k] as string);
      }
      cur = o.error ?? o.info ?? o.cause;
    } else break;
  }
  return parts.join(" ");
}

/**
 * Drives `unwrap` → `Bridge.release`: for every persisted unwrap it
 * re-checks on-chain replay state, collects threshold EIP-712 attester
 * signatures, submits the release, waits for confirmations, and only then
 * marks the row released.
 *
 * Safety properties:
 * - Never reports an unconfirmed transaction as released.
 * - Re-running after a crash is safe (`releasedNonces` + the salt-based
 *   replay guard in `Bridge.release`).
 * - A permanently failing unwrap is dead-lettered so it cannot starve the
 *   queue.
 */
export type BridgeLike = {
  releasedNonces(stellarTxHash: string): Promise<boolean>;
  release(
    token: string,
    recipient: string,
    amount: bigint,
    stellarTxHash: string,
    nonce: bigint,
    signatures: string[],
    overrides?: { gasLimit?: number },
  ): Promise<{
    hash: string;
    wait(confirmations?: number): Promise<{ status: number; hash: string } | null>;
  }>;
};

export class EvmReleaser {
  constructor(
    private contexts: Partial<Record<SourceChainId, ReleaseContext>>,
    private attesterKeys: string[] = evmAttesters,
    private bridgeFactory: (ctx: ReleaseContext) => BridgeLike = (ctx) =>
      new ethers.Contract(ctx.bridge, BRIDGE_RELEASE_ABI, ctx.signer) as unknown as BridgeLike,
  ) {}

  isEnabled(): boolean {
    return Object.keys(this.contexts).length > 0 && this.attesterKeys.length > 0;
  }

  async processPending(): Promise<{
    released: number;
    failed: number;
    pending: number;
    skipped: number;
  }> {
    if (!this.isEnabled()) {
      bridgePendingReleases.set(await countPendingReleases());
      return { released: 0, failed: 0, pending: 0, skipped: 0 };
    }

    const rows = (await listPendingReleases(25)) as ReleaseRow[];
    let released = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of rows) {
      const ctx = this.contexts[row.sourceChain as SourceChainId];
      if (!ctx) {
        // Chain disabled by configuration — leave the row pending so it can
        // be processed after the operator finishes the deployment.
        skipped++;
        continue;
      }
      const attempts = row.releaseAttempts + 1;
      if (attempts > config.MAX_RELEASE_ATTEMPTS) {
        await markUnwrapReleaseFailed(row.id, "max release attempts exceeded");
        bridgeReleaseFailuresTotal.inc({ chain: row.sourceChain });
        failed++;
        continue;
      }
      try {
        await this.release(ctx, row);
        released++;
      } catch (err) {
        if (isAlreadyReleasedError(err)) {
          await markUnwrapReleased(row.id, null);
          logger.warn(
            { txHash: row.txHash, chain: ctx.chain },
            "release already present on-chain; marking released",
          );
          released++;
          continue;
        }
        const reason = String(
          (err as { shortMessage?: string })?.shortMessage ?? (err as Error)?.message ?? err,
        );
        bridgeReleaseFailuresTotal.inc({ chain: ctx.chain });
        logger.error({ err: reason, txHash: row.txHash }, "release failed");
        if (attempts >= config.MAX_RELEASE_ATTEMPTS) {
          await markUnwrapReleaseFailed(row.id, reason);
          failed++;
        } else {
          await markUnwrapReleaseAttempt(row.id, attempts, reason);
        }
      }
    }

    const pending = await countPendingReleases();
    bridgePendingReleases.set(pending);
    return { released, failed, pending, skipped };
  }

  private async release(ctx: ReleaseContext, row: ReleaseRow): Promise<string> {
    const value = releaseTypedValue(ctx, row);
    const bridge = this.bridgeFactory(ctx);

    // Replay pre-check: if the release already landed, do not submit again.
    const already: boolean = await bridge.releasedNonces(value.stellarTxHash);
    if (already) {
      await markUnwrapReleased(row.id, null);
      return "";
    }

    const signatures = await signEvmRelease(
      this.attesterKeys.slice(0, 20), // Bridge caps signatures at 20
      ctx.chainId,
      ctx.bridge,
      value,
    );
    if (signatures.length < config.EVM_ATTESTER_THRESHOLD) {
      recordQuorumFailure();
      throw new Error(
        `not enough EVM attester signatures: got ${signatures.length}, need ${config.EVM_ATTESTER_THRESHOLD}`,
      );
    }

    logger.info(
      {
        chain: ctx.chain,
        txHash: row.txHash,
        amount: value.amount.toString(),
        recipient: value.recipient,
      },
      "submitting Bridge.release",
    );

    const tx = await bridge.release(
      value.token,
      value.recipient,
      value.amount,
      value.stellarTxHash,
      value.nonce,
      signatures,
      { gasLimit: config.EVM_RELEASE_GAS_LIMIT },
    );
    const receipt = await tx.wait(config.EVM_RELEASE_CONFIRMATIONS);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`release tx ${tx.hash} did not confirm successfully`);
    }

    // Mark released only AFTER confirmation — an unconfirmed tx is never
    // reported as successful.
    await markUnwrapReleased(row.id, receipt.hash);
    bridgeReleasesTotal.inc({ chain: ctx.chain });
    logger.info(
      { chain: ctx.chain, releaseTx: receipt.hash, stellarTx: row.txHash },
      "unwrap released",
    );
    return receipt.hash;
  }
}
