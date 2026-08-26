import type { FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import { prisma } from "./db.js";
import { wsConnections, wsConnectionsRejectedTotal } from "./metrics.js";

/** Max concurrent WebSocket connections per client IP. */
const MAX_CONNECTIONS_PER_IP = 10;

/** Max inbound messages per connection per 10s window (defensive: the
 *  stream currently only broadcasts, but cap client chatter regardless). */
const MAX_MESSAGES_PER_WINDOW = 30;
const MESSAGE_WINDOW_MS = 10_000;

function clientIp(req: any): string {
  return req.socket?.remoteAddress ?? req.headers?.["x-forwarded-for"] ?? "unknown";
}

/** WebSocket: pushes new indexer rows to any connected client as soon as
 *  the indexer commits them. We use Postgres LISTEN/NOTIFY for low-latency
 *  delivery; the scaffold polls every 1s and pushes the diff. */
export function attachWebsocket(app: FastifyInstance) {
  const wss = new WebSocketServer({ server: app.server, path: "/v1/stream" });

  // Per-IP connection cap: track live sockets, close the newest when a
  // client exceeds the cap (prevents one client from exhausting the
  // connection pool and hogging the broadcast fan-out).
  const connsPerIp = new Map<string, Set<WebSocket>>();
  const messageCounts = new WeakMap<WebSocket, { count: number; windowStart: number }>();

  wss.on("connection", (ws, req) => {
    const ip = String(clientIp(req));
    let conns = connsPerIp.get(ip);
    if (!conns) {
      conns = new Set();
      connsPerIp.set(ip, conns);
    }
    if (conns.size >= MAX_CONNECTIONS_PER_IP) {
      wsConnectionsRejectedTotal.inc();
      ws.close(1013, "too many connections from this IP"); // 1013 = try again later
      return;
    }
    conns.add(ws);
    wsConnections.set(countLive(wss));

    ws.on("close", () => {
      conns.delete(ws);
      wsConnections.set(countLive(wss));
    });

    // Defensive inbound message cap.
    ws.on("message", () => {
      const now = Date.now();
      const state = messageCounts.get(ws) ?? { count: 0, windowStart: now };
      if (now - state.windowStart > MESSAGE_WINDOW_MS) {
        state.count = 0;
        state.windowStart = now;
      }
      state.count++;
      messageCounts.set(ws, state);
      if (state.count > MAX_MESSAGES_PER_WINDOW) {
        ws.close(1008, "message rate limit exceeded"); // 1008 = policy violation
      }
    });

    ws.send(JSON.stringify({ type: "hello", message: "spg-stream" }));
  });

  const countLive = (server: WebSocketServer): number => {
    let n = 0;
    server.clients.forEach((c) => {
      if (c.readyState === 1) n++;
    });
    return n;
  };

  const seen = {
    wrap: new Set<string>(),
    unwrap: new Set<string>(),
    lending: new Set<string>(),
  };

  setInterval(async () => {
    const [wraps, unwraps, lending] = await Promise.all([
      prisma.wrapEvent.findMany({ take: 20, orderBy: { createdAt: "desc" } }),
      prisma.unwrapEvent.findMany({ take: 20, orderBy: { createdAt: "desc" } }),
      prisma.lendingEvent.findMany({ take: 20, orderBy: { createdAt: "desc" } }),
    ]);

    const broadcast = (event: any) => {
      // Prisma returns BigInt for numeric columns (ledger, amount, ...).
      // `JSON.stringify` throws on BigInt, so serialize with a BigInt-aware
      // replacer to avoid unhandled rejections when broadcasting rows.
      const payload = JSON.stringify(event, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
      wss.clients.forEach((c) => c.readyState === 1 && c.send(payload));
    };

    for (const w of wraps) {
      if (!seen.wrap.has(w.id)) {
        seen.wrap.add(w.id);
        broadcast({ type: "wrap", data: w });
      }
    }
    for (const u of unwraps) {
      if (!seen.unwrap.has(u.id)) {
        seen.unwrap.add(u.id);
        broadcast({ type: "unwrap", data: u });
      }
    }
    for (const l of lending) {
      if (!seen.lending.has(l.id)) {
        seen.lending.add(l.id);
        broadcast({ type: "lending", data: l });
      }
    }

    // GC
    if (seen.wrap.size > 5_000) seen.wrap = new Set(Array.from(seen.wrap).slice(-1_000));
    if (seen.unwrap.size > 5_000) seen.unwrap = new Set(Array.from(seen.unwrap).slice(-1_000));
    if (seen.lending.size > 5_000) seen.lending = new Set(Array.from(seen.lending).slice(-1_000));
  }, 1_000);
}
