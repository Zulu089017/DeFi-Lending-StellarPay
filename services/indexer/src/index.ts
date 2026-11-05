import "dotenv/config";
import express from "express";
import { ethers } from "ethers";
import { PrismaClient } from "@prisma/client";
import { Networks, rpc } from "@stellar/stellar-sdk";
import pino from "pino";
import {
  indexerErrorsTotal,
  indexerEventsIngested,
  indexerLagSeconds,
  metricsBody,
  metricsContentType,
  reconcileMismatchesTotal,
  reconcileRunsTotal,
} from "./utils/metrics.js";
import { HttpEventSource, PrismaEventStore } from "./events/store.js";
import { ingestEvents } from "./events/stream.js";
import { BRIDGE_EVENT_ABI, BridgeLogError, mapBridgeLog } from "./events/evm.js";
import { runReconciliation } from "./reconcile/service.js";
import { SorobanViewReader } from "./reconcile/stellarReader.js";

const logger = pino({ transport: { target: "pino-pretty", options: { colorize: true } } });
const prisma = new PrismaClient();

// Graceful shutdown flag — checked by every poll loop before each iteration.
let running = true;

const SOROBAN_RPC = process.env.SOROBAN_RPC ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
const CONTRACTS = (process.env.STELLAR_EVENT_CONTRACTS ?? process.env.STELLAR_CONTROLLER ?? "")
  .split(",")
  .map((c) => c.trim())
  .filter((c) => /^C[A-Z2-7]{55}$/.test(c));
const POOL_CONTRACT = process.env.STELLAR_POOL ?? "";
const RECONCILE_SOURCE = process.env.RECONCILE_SOURCE_ACCOUNT ?? "";
const RECONCILE_WRAPPED = (process.env.RECONCILE_WRAPPED_ASSETS ?? "")
  .split(",")
  .map((pair) => pair.trim())
  .filter(Boolean)
  .map((pair) => {
    const [asset, contractId] = pair.split("=");
    return { asset: asset?.trim() ?? "", contractId: contractId?.trim() ?? "" };
  })
  .filter((w) => w.asset && /^C[A-Z2-7]{55}$/.test(w.contractId));
const API_URL = process.env.API_URL ?? "";
const ALERT_WEBHOOK = process.env.RECONCILE_ALERT_WEBHOOK ?? "";

const ETHEREUM_RPC = process.env.ETHEREUM_RPC ?? "https://eth.llamarpc.com";
const ETHEREUM_BRIDGE = process.env.ETHEREUM_BRIDGE ?? "0x0";
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 4000);
const RECONCILE_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? 300_000);
const RECONCILE_STALE_MS = Number(process.env.RECONCILE_STALE_MS ?? 30 * 60 * 1000);
const PORT = Number(process.env.PORT ?? 4200);

const SOROBAN_CURSOR_KEY = "soroban-events";

const sorobanRpc = new rpc.Server(SOROBAN_RPC);
const eventSource = new HttpEventSource(SOROBAN_RPC);
const eventStore = new PrismaEventStore(prisma);

// ──────────────────────── Soroban event ingestion ────────────────────────
let ingesting = false;

async function pollSorobanEvents(): Promise<void> {
  if (!running || ingesting) return;
  if (CONTRACTS.length === 0) return;
  ingesting = true;
  try {
    const result = await ingestEvents(eventSource, eventStore, {
      cursorKey: SOROBAN_CURSOR_KEY,
      contractIds: CONTRACTS,
    });
    if (result.inserted > 0) {
      indexerEventsIngested.inc({ chain: "stellar" }, result.inserted);
      logger.info(
        { inserted: result.inserted, duplicates: result.duplicates, pages: result.pages },
        "soroban events ingested",
      );
    }
    for (const err of result.decodeErrors) {
      indexerErrorsTotal.inc({ chain: "stellar" });
      // Never silent: a known event we cannot decode means the index will
      // diverge from the chain until the decoder is updated.
      logger.error({ eventId: err.eventId, message: err.message }, "undecodable soroban event");
    }
    if (result.unretrievableGap > 0) {
      logger.warn(
        { gapLedgers: result.unretrievableGap },
        "soroban event history starts after the RPC retention window; earlier events are unavailable",
      );
    }
    indexerLagSeconds.set(
      { chain: "stellar" },
      Math.max(0, result.latestLedger - result.startLedger),
    );
  } catch (err) {
    indexerErrorsTotal.inc({ chain: "stellar" });
    logger.error({ err }, "soroban event poll failed");
  } finally {
    ingesting = false;
  }
}

// ──────────────────────── EVM bridge events ────────────────────────
const iface = new ethers.Interface(BRIDGE_EVENT_ABI);
let bridgeConfigured = false;

async function pollEvmBridge(): Promise<void> {
  if (!running) return;
  if (!bridgeConfigured) return;
  try {
    const provider = new ethers.JsonRpcProvider(ETHEREUM_RPC);
    const saved = await prisma.cursor.findUnique({ where: { chain: "ethereum" } });
    let fromBlock = Number(saved?.block ?? 0);
    const head = await provider.getBlockNumber();
    if (head < fromBlock) fromBlock = Math.max(0, head - 1);

    const logs = await provider.getLogs({
      address: ETHEREUM_BRIDGE,
      fromBlock: fromBlock + 1,
      toBlock: head,
    });
    indexerLagSeconds.set({ chain: "ethereum" }, Math.max(0, head - fromBlock));

    for (const log of logs) {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) {
        indexerErrorsTotal.inc({ chain: "ethereum" });
        continue;
      }
      try {
        const row = mapBridgeLog(
          "ethereum",
          { txHash: log.transactionHash, index: log.index },
          parsed as unknown as { name: string; args: Record<string, unknown> & Array<unknown> },
        );
        await prisma.bridgeEvent.upsert({
          where: {
            chain_txHash_logIndex: { chain: row.chain, txHash: row.txHash, logIndex: row.logIndex },
          },
          create: row,
          update: {},
        });
        indexerEventsIngested.inc({ chain: "ethereum" });
      } catch (err) {
        indexerErrorsTotal.inc({ chain: "ethereum" });
        if (err instanceof BridgeLogError) {
          logger.error({ err, txHash: log.transactionHash }, "malformed bridge log");
        } else {
          throw err;
        }
      }
    }

    await prisma.cursor.upsert({
      where: { chain: "ethereum" },
      create: { chain: "ethereum", block: BigInt(head) },
      update: { block: BigInt(head) },
    });
  } catch (err) {
    indexerErrorsTotal.inc({ chain: "ethereum" });
    logger.error({ err }, "evm bridge poll failed");
  }
}

// ──────────────────────── Reconciliation ────────────────────────
const reader =
  RECONCILE_SOURCE.length > 0
    ? new SorobanViewReader(sorobanRpc, RECONCILE_SOURCE, NETWORK_PASSPHRASE)
    : undefined;

let reconciling = false;

async function reconcileOnce(trigger: string) {
  if (reconciling) return null;
  reconciling = true;
  try {
    const outcome = await runReconciliation({
      prisma,
      reader,
      poolContractId: POOL_CONTRACT || undefined,
      wrappedAssets: RECONCILE_WRAPPED,
      apiUrl: API_URL || undefined,
      staleAfterMs: RECONCILE_STALE_MS,
      alert: ALERT_WEBHOOK
        ? async ({ runId, mismatches }) => {
            await fetch(ALERT_WEBHOOK, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ source: "stellarpay-reconciler", runId, mismatches }),
              signal: AbortSignal.timeout(5_000),
            });
          }
        : undefined,
    });

    reconcileRunsTotal.inc({ status: outcome.status });
    for (const mismatch of outcome.mismatches) {
      reconcileMismatchesTotal.inc({ invariant: mismatch.invariant, subject: mismatch.subject });
    }
    if (outcome.mismatchCount > 0) {
      logger.error(
        { trigger, runId: outcome.runId, mismatches: outcome.mismatches },
        "cross-system invariant mismatch detected",
      );
    } else if (outcome.status === "ok") {
      logger.info({ trigger, runId: outcome.runId, checks: outcome.checks }, "reconciliation ok");
    } else {
      logger.error(
        { trigger, runId: outcome.runId, error: outcome.error },
        "reconciliation failed",
      );
    }
    return outcome;
  } finally {
    reconciling = false;
  }
}

// ──────────────────────── HTTP API ────────────────────────
const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  const cursor = await prisma.cursor.findUnique({ where: { chain: SOROBAN_CURSOR_KEY } });
  const lastRun = await prisma.reconciliationRun.findFirst({ orderBy: { startedAt: "desc" } });
  res.json({
    ok: true,
    stellar: {
      configuredContracts: CONTRACTS.length,
      cursorLedger: cursor?.block?.toString() ?? null,
    },
    reconciliation: lastRun
      ? { id: lastRun.id, status: lastRun.status, mismatchCount: lastRun.mismatchCount }
      : null,
  });
});

app.get("/metrics", async (_req, res) => {
  res.setHeader("content-type", metricsContentType());
  res.send(await metricsBody());
});

app.get("/events/wrap", async (_req, res) => {
  const events = await prisma.wrapEvent.findMany({ take: 50, orderBy: { createdAt: "desc" } });
  res.json(
    events.map((e) => ({
      ...e,
      amount: e.amount.toString(),
      ledger: e.ledger.toString(),
      nonce: e.nonce.toString(),
    })),
  );
});

app.get("/events/unwrap", async (_req, res) => {
  const events = await prisma.unwrapEvent.findMany({ take: 50, orderBy: { createdAt: "desc" } });
  res.json(events.map((e) => ({ ...e, amount: e.amount.toString(), ledger: e.ledger.toString() })));
});

app.get("/events/lending", async (_req, res) => {
  const events = await prisma.lendingEvent.findMany({ take: 50, orderBy: { createdAt: "desc" } });
  res.json(events.map((e) => ({ ...e, amount: e.amount.toString() })));
});

app.get("/events/bridge/:chain", async (req, res) => {
  const events = await prisma.bridgeEvent.findMany({
    where: { chain: req.params.chain },
    take: 50,
    orderBy: { createdAt: "desc" },
  });
  res.json(events.map((e) => ({ ...e, amount: e.amount.toString() })));
});

app.get("/stats", async (_req, res) => {
  const [wraps, unwraps, bridge] = await Promise.all([
    prisma.wrapEvent.count(),
    prisma.unwrapEvent.count(),
    prisma.bridgeEvent.count(),
  ]);
  res.json({ wraps, unwraps, bridgeEvents: bridge });
});

app.get("/reconcile/latest", async (_req, res) => {
  const run = await prisma.reconciliationRun.findFirst({
    orderBy: { startedAt: "desc" },
    include: { mismatches: true },
  });
  if (!run) return res.status(404).json({ error: "no reconciliation runs yet" });
  res.json(run);
});

app.get("/reconcile/runs", async (_req, res) => {
  const runs = await prisma.reconciliationRun.findMany({
    take: 20,
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      startedAt: true,
      finishedAt: true,
      status: true,
      checksRun: true,
      mismatchCount: true,
      errorMessage: true,
    },
  });
  res.json(runs);
});

app.post("/reconcile/run", async (_req, res) => {
  const outcome = await reconcileOnce("http");
  if (!outcome) return res.status(409).json({ error: "reconciliation already running" });
  res.status(outcome.status === "error" ? 500 : 200).json(outcome);
});

app.listen(PORT, () => {
  logger.info(`📡 indexer API listening on :${PORT}`);
  if (CONTRACTS.length === 0) {
    logger.warn("STELLAR_EVENT_CONTRACTS is empty — Stellar contract events are not indexed");
  } else {
    void pollSorobanEvents();
    setInterval(() => void pollSorobanEvents(), POLL_MS);
  }

  bridgeConfigured = ethers.isAddress(ETHEREUM_BRIDGE) && ETHEREUM_BRIDGE !== ethers.ZeroAddress;
  if (bridgeConfigured) {
    setInterval(() => void pollEvmBridge(), POLL_MS);
  } else {
    logger.warn("ETHEREUM_BRIDGE is unset — EVM bridge events are not indexed");
  }

  if (reader) {
    void reconcileOnce("startup");
    setInterval(() => void reconcileOnce("schedule"), RECONCILE_MS);
  } else {
    logger.warn(
      "RECONCILE_SOURCE_ACCOUNT is unset — on-chain reconciliation (X-1/X-4) is disabled",
    );
  }
});

// Graceful shutdown on SIGTERM/SIGINT: stop new iterations, give in-flight
// work 5s to finish, then disconnect the database.
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
