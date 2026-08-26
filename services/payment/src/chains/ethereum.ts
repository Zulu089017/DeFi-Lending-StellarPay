import { ethers } from "ethers";
import { config } from "../config.js";
import { saveEvent, prisma } from "../store/db.js";
import type { SourceEvent } from "../types.js";
import { logger } from "../utils/logger.js";

const BRIDGE_ABI = [
  "event Locked(address indexed sender, address indexed token, uint256 amount, bytes32 indexed stellarDest, bytes32 salt, uint256 nonce)",
  "event Burned(address indexed sender, address indexed token, uint256 amount, bytes32 indexed stellarDest, bytes32 salt, uint256 nonce)",
];

// Both `Locked` and `Burned` mint on Stellar (canonical tokens can be
// locked via transfer, or burned outright via `Bridge.burn`). Watch both
// topics with an OR filter — previously only `Locked` was polled, so
// burned source tokens were never wrapped. (Invariant X-2 expects
// "Locked **or Burned**".)

const POLLER_NAME = "ethereum";

/** Minimum block confirmations before processing an event.
 *  Ethereum PoS: 2 epochs (~12.8 min) safety margin, but we use 12 blocks
 *  (~2 min) as a practical lower bound for testnet. Mainnet should use 15+. */
const REQUIRED_CONFIRMATIONS = 12;

export class EthereumWatcher {
  private provider: ethers.JsonRpcProvider;
  private iface = new ethers.Interface(BRIDGE_ABI);
  private bridge: string;
  private lastProcessed: number | null = null;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.ETHEREUM_RPC);
    this.bridge = config.ETHEREUM_BRIDGE;
  }

  /** Polls the latest blocks for new `Locked` events. */
  async pollOnce(): Promise<SourceEvent[]> {
    const head = await this.provider.getBlockNumber();
    const from = (this.lastProcessed ?? head - 50) + 1;
    if (from > head) return [];
    // C7 FIX: Only process blocks that have sufficient confirmations.
    // Events in blocks above (head - REQUIRED_CONFIRMATIONS) are deferred
    // to the next poll cycle.
    const safeHead = head - REQUIRED_CONFIRMATIONS;
    const to = Math.min(from + 50, Math.max(from, safeHead));
    if (from > to) return [];

    const logs = await this.provider.getLogs({
      address: this.bridge,
      fromBlock: from,
      toBlock: to,
      topics: [
        [
          this.iface.getEvent("Locked")!.topicHash,
          this.iface.getEvent("Burned")!.topicHash,
        ],
      ],
    });

    const events: SourceEvent[] = [];
    for (const log of logs) {
      try {
        const parsed = this.iface.parseLog(log);
        if (!parsed) continue;
        const [sender, token, amount, stellarDest, salt, nonce] = parsed.args;
        const ev: SourceEvent = {
          chain: "ethereum",
          txHash: log.transactionHash,
          logIndex: log.index,
          blockNumber: log.blockNumber,
          sender,
          token,
          amount: BigInt(amount),
          stellarDest,
          salt,
          nonce: BigInt(nonce),
          raw: log,
        };
        await saveEvent(ev);
        events.push(ev);
      } catch (err) {
        logger.error({ err, log }, "failed to parse eth log");
      }
    }

    this.lastProcessed = to;
    await prisma.cursor.upsert({
      where: { chain: POLLER_NAME },
      create: { chain: POLLER_NAME, block: BigInt(to) },
      update: { block: BigInt(to) },
    });
    return events;
  }

  async getLastProcessedFromDb(): Promise<number | null> {
    const c = await prisma.cursor.findUnique({ where: { chain: POLLER_NAME } });
    return c ? Number(c.block) : null;
  }

  async start() {
    this.lastProcessed = await this.getLastProcessedFromDb();
    logger.info({ from: this.lastProcessed }, "ethereum watcher starting");
  }
}
