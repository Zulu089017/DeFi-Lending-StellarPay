import { Horizon } from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { saveUnwrap, prisma } from "../store/db.js";
import type { UnwrapEvent } from "../types.js";
import { logger } from "../utils/logger.js";

const POLLER_NAME = "stellar";

/** Watches for `unwrap` events on the lending_controller. The controller emits
 *  topics that Horizon surfaces. The relayer consumes them and submits
 *  `release` transactions on the appropriate source chain. */
export class StellarWatcher {
  private server: Horizon.Server;
  private controller: string;
  private lastPagingToken: string | null = null;

  constructor() {
    this.server = new Horizon.Server(config.STELLAR_RPC);
    this.controller = config.STELLAR_CONTROLLER;
  }

  async pollOnce(): Promise<UnwrapEvent[]> {
    const builder = this.server
      .operations()
      .forAccount(this.controller)
      .order("asc")
      .limit(50);
    const page = this.lastPagingToken
      ? await builder.cursor(this.lastPagingToken).call()
      : await builder.call();

    const events: UnwrapEvent[] = [];
    for (const op of page.records) {
      // Only contract-call operations on the controller can be unwraps.
      // Record everything else (payments, manage data, …) would fabricate
      // unwrap rows and poison a future release pipeline.
      const type = (op.type ?? "").toLowerCase();
      if (!type.includes("invoke")) continue;
      // Decode the `unwrap` event from the operation memo or transaction
      // envelope. For the scaffold we accept that the off-chain indexer
      // populates this; here we just store the raw operation.
      const ev: UnwrapEvent = {
        chain: "stellar",
        txHash: op.transaction_hash,
        user: op.source_account,
        amount: 0n, // populated by indexer — the release pipeline is not wired yet
        sourceChain: "ethereum",
        sourceAddr: "",
        nonce: op.id,
      };
      await saveUnwrap(ev);
      events.push(ev);
    }
    this.lastPagingToken = page.records[page.records.length - 1]?.paging_token ?? null;
    if (this.lastPagingToken) {
      await prisma.cursor.upsert({
        where: { chain: POLLER_NAME },
        create: { chain: POLLER_NAME, block: BigInt(0), pagingToken: this.lastPagingToken },
        update: { pagingToken: this.lastPagingToken },
      });
    }
    return events;
  }

  async start() {
    const c = await prisma.cursor.findUnique({ where: { chain: POLLER_NAME } });
    if (c?.pagingToken) this.lastPagingToken = c.pagingToken;
    logger.info({ from: this.lastPagingToken }, "stellar watcher starting");
  }
}
