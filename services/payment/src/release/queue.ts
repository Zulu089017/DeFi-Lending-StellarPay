import type { UnwrapEvent } from "../types.js";
import { saveUnwrap } from "../store/db.js";
import { logger } from "../utils/logger.js";

/**
 * Enqueue a Stellar `unwrap` for the EVM release pipeline.
 *
 * Mirrors `StellarMinter.enqueue` in `services/payment/src/mint/stellarMinter.ts`:
 * the event is buffered here instead of being passed straight to the relayer,
 * so a fresh bridge tick can consume it inside the same poll interval and the
 * row is durable before the pipeline starts.
 *
 * `StellarUnwrapWatcher` is the only watcher that produces `UnwrapEvent`s
 * (the mint path uses `SourceEvent` for `Locked` / `Burned`), so this module
 * is intentionally small and explicit.
 */
export class UnwrapEnqueuer {
  constructor(
    private readonly saveRow: (ev: UnwrapEvent) => Promise<void> = saveUnwrap,
  ) {}

  async enqueue(ev: UnwrapEvent): Promise<void> {
    await this.saveRow(ev);
    logger.info({ txHash: ev.txHash, nonce: ev.nonce }, "unwrap enqueued for EVM release");
  }
}
