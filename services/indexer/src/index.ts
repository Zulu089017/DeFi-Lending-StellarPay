import "dotenv/config";
import express from "express";
import { Horizon } from "@stellar/stellar-sdk";
import { ethers } from "ethers";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import {
  indexerErrorsTotal,
  indexerEventsIngested,
  indexerLagSeconds,
  metricsBody,
  metricsContentType,
} from "./utils/metrics.js";

const logger = pino({ transport: { target: "pino-pretty", options: { colorize: true } } });
const prisma = new PrismaClient();

// H9 FIX: Graceful shutdown flag — checked by poll loops before each iteration.
let running = true;

const STELLAR_RPC = process.env.STELLAR_RPC ?? "https://horizon-testnet.stellar.org";
const ETHEREUM_RPC = process.env.ETHEREUM_RPC ?? "https://eth.llamarpc.com";
const ETHEREUM_BRIDGE = process.env.ETHEREUM_BRIDGE ?? "0x0";
const CONTROLLER = process.env.STELLAR_CONTROLLER ?? "C...";
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 4000);
const PORT = Number(process.env.PORT ?? 4200);

// ──────────────────────── Horizon streamer ────────────────────────
const server = new Horizon.Server(STELLAR_RPC);

async function streamHorizon() {
  let cursor: string | null = null;
  const c = await prisma.cursor.findUnique({ where: { chain: "stellar" } });
  cursor = c?.pagingToken ?? null;

  setInterval(async () => {
    if (!running) return;
    try {
      const builder = server.operations().forAccount(CONTROLLER).order("asc").limit(50);
      const page = cursor ? await builder.cursor(cursor).call() : await builder.call();
      for (const op of page.records) {
        await indexStellarOp(op);
      }
      cursor = page.records[page.records.length - 1]?.paging_token ?? cursor;
      if (cursor) {
        await prisma.cursor.upsert({
          where: { chain: "stellar" },
          create: { chain: "stellar", pagingToken: cursor },
          update: { pagingToken: cursor },
        });
      }
    } catch (err) {
      indexerErrorsTotal.inc({ chain: "stellar" });
      logger.error({ err }, "horizon poll failed");
    }
  }, POLL_MS);
}

async function indexStellarOp(op: any) {
  // The lending_controller emits `wrap` and `unwrap` events which appear as
  // `invokeHostFunction` operations. We tag them by topic string. The
  // production indexer would decode the returned ScVal; for the scaffold we
  // persist a placeholder row that the API hydrates from the contract
  // instance when needed.
  const type = (op.type ?? "").toLowerCase();
  if (type.includes("invoke")) {
    await prisma.wrapEvent.upsert({
      where: { txHash: op.transaction_hash },
      create: {
        txHash: op.transaction_hash,
        ledger: BigInt(op.ledger_attr ?? 0),
        chainId: 0,
        sourceAddr: "",
        to: op.source_account,
        amount: 0n,
        salt: "",
      },
      update: {},
    });
    indexerEventsIngested.inc({ chain: "stellar" });
  }
}

// ──────────────────────── EVM streamer ────────────────────────
const BRIDGE_ABI = [
  "event Locked(address indexed sender, address indexed token, uint256 amount, bytes32 indexed stellarDest, bytes32 salt, uint256 nonce)",
  "event Burned(address indexed sender, address indexed token, uint256 amount, bytes32 indexed stellarDest, bytes32 salt, uint256 nonce)",
  "event Released(address indexed recipient, address indexed token, uint256 amount, bytes32 indexed stellarTxHash, uint256 nonce)",
];
const iface = new ethers.Interface(BRIDGE_ABI);

async function streamEvm() {
  const provider = new ethers.JsonRpcProvider(ETHEREUM_RPC);
  let fromBlock = Number(
    (await prisma.cursor.findUnique({ where: { chain: "ethereum" } }))?.block ?? 0,
  );

  setInterval(async () => {
    if (!running) return;
    try {
      const head = await provider.getBlockNumber();
      if (head < fromBlock) fromBlock = head - 1;
      const logs = await provider.getLogs({
        address: ETHEREUM_BRIDGE,
        fromBlock: fromBlock + 1,
        toBlock: head,
      });
      indexerLagSeconds.set({ chain: "ethereum" }, Math.max(0, head - fromBlock));
      for (const log of logs) {
        const parsed = iface.parseLog(log);
        if (!parsed) {
          indexerErrorsTotal.inc({ chain: "ethereum" });
          continue;
        }
        const eventName = parsed.name as "Locked" | "Burned" | "Released";
        const args = parsed.args;
        await prisma.bridgeEvent.upsert({
          where: {
            chain_txHash_logIndex: {
              chain: "ethereum",
              txHash: log.transactionHash,
              logIndex: log.index,
            },
          },
          create: {
            chain: "ethereum",
            txHash: log.transactionHash,
            logIndex: log.index,
            type: eventName.toLowerCase(),
            sender: args[0] ?? args.recipient,
            token: args[1] ?? args.token,
            amount: BigInt(args[2] ?? args.amount),
            stellarDest: args[3] ?? null,
            salt: args[4] ?? null,
          },
          update: {},
        });
        indexerEventsIngested.inc({ chain: "ethereum" });
      }
      fromBlock = head;
      await prisma.cursor.upsert({
        where: { chain: "ethereum" },
        create: { chain: "ethereum", block: BigInt(head) },
        update: { block: BigInt(head) },
      });
    } catch (err) {
      indexerErrorsTotal.inc({ chain: "ethereum" });
      logger.error({ err }, "evm poll failed");
    }
  }, POLL_MS);
}

// ──────────────────────── HTTP API ────────────────────────
const app = express();
app.use(express.json());

app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/metrics", async (_req, res) => {
  res.setHeader("content-type", metricsContentType());
  res.send(await metricsBody());
});

app.get("/events/wrap", async (_, res) => {
  const events = await prisma.wrapEvent.findMany({ take: 50, orderBy: { createdAt: "desc" } });
  res.json(events);
});

app.get("/events/unwrap", async (_, res) => {
  const events = await prisma.unwrapEvent.findMany({ take: 50, orderBy: { createdAt: "desc" } });
  res.json(events);
});

app.get("/events/lending", async (_, res) => {
  const events = await prisma.lendingEvent.findMany({ take: 50, orderBy: { createdAt: "desc" } });
  res.json(events);
});

app.get("/events/bridge/:chain", async (req, res) => {
  const events = await prisma.bridgeEvent.findMany({
    where: { chain: req.params.chain },
    take: 50,
    orderBy: { createdAt: "desc" },
  });
  res.json(events);
});

app.get("/stats", async (_, res) => {
  const [wraps, unwraps, bridge] = await Promise.all([
    prisma.wrapEvent.count(),
    prisma.unwrapEvent.count(),
    prisma.bridgeEvent.count(),
  ]);
  res.json({ wraps, unwraps, bridgeEvents: bridge });
});

app.listen(PORT, () => {
  logger.info(`📡 indexer API listening on :${PORT}`);
  streamHorizon();
  streamEvm();
});

// H9 FIX: Graceful shutdown on SIGTERM/SIGINT.
// Sets `running = false` first so no new poll iterations start, then
// gives in-flight ops 5s to finish before disconnecting DB and exiting.
const shutdown = async (signal: string) => {
  logger.info({ signal }, "indexer shutting down...");
  running = false;
  await new Promise((r) => setTimeout(r, 5_000));
  await prisma.$disconnect();
  logger.info("indexer shut down cleanly");
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
