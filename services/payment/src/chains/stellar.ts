import { rpc, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { saveUnwrap, markUnwrapFailed, prisma } from "../store/db.js";
import type { UnwrapEvent } from "../types.js";
import { decodeUnwrapValue } from "../events/unwrap.js";
import { logger } from "../utils/logger.js";
import { bridgeUnwrapsIngestedTotal } from "../utils/metrics.js";

const POLLER_NAME = "stellar-unwrap";

/** Topic symbol emitted by the controller's `Unwrap` contract event. */
const UNWRAP_TOPIC = nativeToScVal("unwrap", { type: "symbol" }).toXDR("base64");

/** How far back to start when no cursor is persisted and no explicit start
 *  ledger is configured. Soroban RPC retains events for a limited window
 *  (currently ~7 days), so falling back to the oldest retained ledger is
 *  correct for a cold start. */
const COLD_START_LOOKBACK_LEDGERS = 17_280; // ~24h at 5s ledgers

/** Watches the lending_controller for `unwrap` contract events using Soroban
 *  RPC `getEvents` (Horizon does not expose contract events), persists each
 *  one, and leaves it `pending` for the EVM release pipeline.
 *
 *  Each event is stored exactly once (`UnwrapEvent.txHash` is unique), so a
 *  re-poll cannot double-release. Cursor pagination is persisted in the
 *  `Cursor` table so restarts resume where they left off.
 */
export class StellarUnwrapWatcher {
  private server: rpc.Server | null;
  private controller: string;
  private cursor: string | null = null;
  private enabled: boolean;

  constructor() {
    this.controller = config.STELLAR_CONTROLLER;
    if (!config.STELLAR_SOROBAN_RPC) {
      this.server = null;
      this.enabled = false;
      logger.warn(
        "STELLAR_SOROBAN_RPC is not set — unwrap event watching is disabled " +
          "(the unwrap → Bridge.release pipeline will not run)",
      );
      return;
    }
    this.server = new rpc.Server(config.STELLAR_SOROBAN_RPC, {
      allowHttp: config.STELLAR_SOROBAN_RPC.startsWith("http://"),
    });
    this.enabled = true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async start(): Promise<void> {
    if (!this.server) return;
    const c = await prisma.cursor.findUnique({ where: { chain: POLLER_NAME } });
    if (c?.pagingToken) {
      this.cursor = c.pagingToken;
      logger.info({ cursor: this.cursor }, "unwrap watcher resuming from cursor");
      return;
    }
    logger.info(
      {
        startLedger: config.STELLAR_SOROBAN_START_LEDGER ?? "oldest retained",
      },
      "unwrap watcher cold start",
    );
  }

  /** Poll once and return newly persisted unwraps. */
  async pollOnce(): Promise<UnwrapEvent[]> {
    if (!this.server) return [];

    const request: rpc.Api.GetEventsRequest = this.cursor
      ? {
          filters: [
            {
              type: "contract",
              contractIds: [this.controller],
              topics: [[UNWRAP_TOPIC]],
            },
          ],
          cursor: this.cursor,
          limit: 100,
        }
      : {
          filters: [
            {
              type: "contract",
              contractIds: [this.controller],
              topics: [[UNWRAP_TOPIC]],
            },
          ],
          startLedger: config.STELLAR_SOROBAN_START_LEDGER ?? (await this.coldStartLedger()),
          limit: 100,
        };

    const page = await this.server.getEvents(request);
    const events: UnwrapEvent[] = [];

    for (const raw of page.events) {
      // Ignore events from failed contract calls: the burn did not happen.
      if (!raw.inSuccessfulContractCall) continue;
      try {
        const decoded = decodeUnwrapValue(scValToNative(raw.value), {
          txHash: raw.txHash,
          ledger: raw.ledger,
        });
        await saveUnwrap(decoded);
        events.push(decoded);
        bridgeUnwrapsIngestedTotal.inc();
      } catch (err) {
        // Persist the failure so operators can see it (and so a malformed
        // event does not disappear). No release will ever be signed for it.
        logger.error({ err, txHash: raw.txHash, ledger: raw.ledger }, "invalid unwrap event");
        await markUnwrapFailed(raw.txHash, String(err)).catch((dbErr) =>
          logger.error({ err: dbErr, txHash: raw.txHash }, "failed to record invalid unwrap"),
        );
      }
    }

    if (page.cursor && page.cursor !== this.cursor) {
      this.cursor = page.cursor;
      await prisma.cursor.upsert({
        where: { chain: POLLER_NAME },
        create: { chain: POLLER_NAME, block: BigInt(page.latestLedger), pagingToken: page.cursor },
        update: { block: BigInt(page.latestLedger), pagingToken: page.cursor },
      });
    }

    return events;
  }

  private async coldStartLedger(): Promise<number> {
    if (!this.server) return 1;
    const latest = await this.server.getLatestLedger();
    return Math.max(1, latest.sequence - COLD_START_LOOKBACK_LEDGERS);
  }
}
