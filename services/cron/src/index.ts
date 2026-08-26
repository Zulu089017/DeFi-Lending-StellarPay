import { createServer } from "node:http";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { Relayer, prisma } from "./queue.js";
import { metricsBody, metricsContentType } from "./utils/metrics.js";

let running = true;
let intervalId: ReturnType<typeof setInterval> | null = null;

/** Minimal HTTP server for k8s probes (/health) and Prometheus scrapes
 *  (/metrics). The relayer itself is a poller; this is its only HTTP
 *  surface. Default port 4300 (the indexer owns 4200). */
function startHealthServer() {
  const server = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "spg-relayer", uptime: process.uptime() }));
      return;
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": metricsContentType() });
      res.end(await metricsBody());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(config.PORT, config.HOST, () => {
    logger.info({ port: config.PORT }, "relayer health/metrics server listening");
  });
  return server;
}

async function main() {
  logger.info("🚀 StellarPay relayer starting");
  const r = new Relayer();
  const tick = async () => {
    if (!running) return;
    try {
      await r.processOnce();
    } catch (err) {
      logger.error({ err }, "relayer tick failed");
    }
  };
  await tick();
  intervalId = setInterval(tick, config.POLL_INTERVAL_MS);
  startHealthServer();

  // H9 FIX: Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "relayer shutting down...");
    running = false;
    if (intervalId) clearInterval(intervalId);
    await new Promise((r) => setTimeout(r, 5_000));
    await prisma.$disconnect();
    logger.info("relayer shut down cleanly");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "fatal");
  process.exit(1);
});
