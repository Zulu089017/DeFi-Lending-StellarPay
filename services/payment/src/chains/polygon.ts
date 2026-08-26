import { ethers } from "ethers";
import { config } from "../config.js";
import { saveEvent, prisma } from "../store/db.js";
import type { SourceEvent } from "../types.js";
import { logger } from "../utils/logger.js";

const BRIDGE_ABI = [
  "event Locked(address indexed sender, address indexed token, uint256 amount, bytes32 indexed stellarDest, bytes32 salt, uint256 nonce)",
  "event Burned(address indexed sender, address indexed token, uint256 amount, bytes32 indexed stellarDest, bytes32 salt, uint256 nonce)",
];

// Both `Locked` and `Burned` mint on Stellar — see chains/ethereum.ts.

const POLLER_NAME = "polygon";

/** Polygon produces blocks every ~2s and has probabilistic finality via
 *  Bor + Heimdall checkpoints. We require 256 blocks (~8 min) for safety. */
const REQUIRED_CONFIRMATIONS = 256;

export class PolygonWatcher {
  private provider: ethers.JsonRpcProvider;
  private iface = new ethers.Interface(BRIDGE_ABI);
  private lastProcessed: number | null = null;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.POLYGON_RPC);
  }

  async pollOnce(): Promise<SourceEvent[]> {
    const head = await this.provider.getBlockNumber();
    const from = (this.lastProcessed ?? head - 100) + 1;
    if (from > head) return [];
    // C7 FIX: Only process blocks with sufficient confirmations.
    const safeHead = head - REQUIRED_CONFIRMATIONS;
    const to = Math.min(from + 200, Math.max(from, safeHead));
    if (from > to) return [];

    const logs = await this.provider.getLogs({
      address: config.POLYGON_BRIDGE,
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
      const parsed = this.iface.parseLog(log);
      if (!parsed) continue;
      const [sender, token, amount, stellarDest, salt, nonce] = parsed.args;
      const ev: SourceEvent = {
        chain: "polygon",
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
    }
    this.lastProcessed = to;
    await prisma.cursor.upsert({
      where: { chain: POLLER_NAME },
      create: { chain: POLLER_NAME, block: BigInt(to) },
      update: { block: BigInt(to) },
    });
    return events;
  }

  async start() {
    this.lastProcessed = await this.getLastProcessedFromDb();
    logger.info({ from: this.lastProcessed }, "polygon watcher starting");
  }

  async getLastProcessedFromDb(): Promise<number | null> {
    const c = await prisma.cursor.findUnique({ where: { chain: POLLER_NAME } });
    return c ? Number(c.block) : null;
  }
}
