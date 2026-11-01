// Concrete implementations of the ingestion ports:
//   • RpcEventSource  — Soroban RPC getEvents, normalised to our raw shape
//   • PrismaEventStore — idempotent writes keyed by the RPC event id
//
// Both are thin on purpose; the interesting logic (decoding, pagination,
// dedupe accounting) lives in decode.ts / stream.ts and is unit-tested.

import { Prisma, PrismaClient } from "@prisma/client";
import { eventLogIndex, type DecodedEvent, type RawSorobanEvent } from "./decode.js";
import type { EventPage, EventSource, EventStore, GetEventsQuery } from "./stream.js";

/** JSON-RPC error returned by the Soroban endpoint (not an HTTP failure). */
export class SorobanRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method} failed (${code}): ${message}`);
    this.name = "SorobanRpcError";
  }
}

interface RawEventRpc {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId?: string;
  txHash: string;
  transactionIndex?: number;
  operationIndex?: number;
  topic: string[];
  value: string;
  inSuccessfulContractCall?: boolean;
}

/**
 * Soroban RPC event source over plain JSON-RPC.
 *
 * Deliberately not using the SDK's `rpc.Server` here: the SDK pinned by this
 * service predates cursor pagination on `getEvents` and omits `oldestLedger`
 * from `getHealth`, both of which the indexer needs to page events and to
 * report retention gaps. Raw JSON keeps the wire contract explicit.
 */
export class HttpEventSource implements EventSource {
  constructor(
    private readonly rpcUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };
    if (body.error) throw new SorobanRpcError(method, body.error.code, body.error.message);
    if (body.result === undefined) throw new Error(`${method}: empty result`);
    return body.result;
  }

  async getLatestLedger(): Promise<number> {
    const health = await this.call<{ latestLedger: number }>("getHealth", {});
    return health.latestLedger;
  }

  async getOldestLedger(): Promise<number> {
    const health = await this.call<{ oldestLedger: number }>("getHealth", {});
    return health.oldestLedger;
  }

  async getEvents(query: GetEventsQuery): Promise<EventPage> {
    const response = await this.call<{
      events: RawEventRpc[];
      cursor?: string;
      latestLedger: number;
    }>("getEvents", {
      filters: [{ type: "contract", contractIds: query.contractIds }],
      pagination: {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      },
      ...(query.cursor ? {} : { startLedger: query.startLedger }),
    });

    const events: RawSorobanEvent[] = response.events
      // A failed contract call can still emit diagnostic events; only events
      // from successful calls reflect protocol state.
      .filter((e) => e.inSuccessfulContractCall !== false)
      .map((e) => ({
        id: e.id,
        contractId: e.contractId ?? "",
        ledger: e.ledger,
        txHash: e.txHash,
        transactionIndex: e.transactionIndex ?? 0,
        operationIndex: e.operationIndex ?? 0,
        ledgerClosedAt: e.ledgerClosedAt,
        topic: e.topic,
        value: e.value,
      }));

    return { events, cursor: response.cursor ?? "" };
  }
}

export class PrismaEventStore implements EventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async getCursor(key: string) {
    const row = await this.prisma.cursor.findUnique({ where: { chain: key } });
    if (!row?.pagingToken) return null;
    return { cursor: row.pagingToken, ledger: row.block };
  }

  async saveCursor(key: string, cursor: { cursor: string; ledger: bigint }) {
    await this.prisma.cursor.upsert({
      where: { chain: key },
      create: { chain: key, pagingToken: cursor.cursor, block: cursor.ledger },
      update: { pagingToken: cursor.cursor, block: cursor.ledger },
    });
  }

  async insertEvent(raw: RawSorobanEvent, decoded: DecodedEvent): Promise<boolean> {
    const createdAt = raw.ledgerClosedAt ? new Date(raw.ledgerClosedAt) : new Date();
    const base = {
      id: raw.id,
      txHash: raw.txHash,
      ledger: BigInt(raw.ledger),
      createdAt,
    };

    try {
      switch (decoded.kind) {
        case "wrap":
          await this.prisma.wrapEvent.create({
            data: {
              ...base,
              chainId: decoded.chainId,
              sourceAddr: decoded.sourceAddr,
              to: decoded.to,
              amount: decoded.amount,
              salt: decoded.salt,
              nonce: decoded.nonce,
            },
          });
          return true;
        case "unwrap":
          await this.prisma.unwrapEvent.create({
            data: {
              ...base,
              user: decoded.user,
              amount: decoded.amount,
              chainId: decoded.chainId,
              sourceAddr: decoded.sourceAddr,
              nonce: decoded.nonce,
              released: false,
            },
          });
          return true;
        case "supply":
          await this.prisma.lendingEvent.create({
            data: {
              ...base,
              logIndex: eventLogIndex(raw.id),
              type: "supply",
              user: decoded.user,
              asset: decoded.asset,
              amount: decoded.amount,
            },
          });
          return true;
        case "collateral_deposit":
          await this.prisma.lendingEvent.create({
            data: {
              ...base,
              logIndex: eventLogIndex(raw.id),
              type: "collateral_deposit",
              user: decoded.user,
              asset: decoded.asset,
              amount: decoded.amount,
            },
          });
          return true;
        case "collateral_withdraw":
          await this.prisma.lendingEvent.create({
            data: {
              ...base,
              logIndex: eventLogIndex(raw.id),
              type: "collateral_withdraw",
              user: decoded.user,
              asset: decoded.asset,
              amount: decoded.amount,
            },
          });
          return true;
        case "borrow":
          await this.prisma.lendingEvent.create({
            data: {
              ...base,
              logIndex: eventLogIndex(raw.id),
              type: "borrow",
              user: decoded.user,
              // Market totals are per debt asset: that is what the borrower
              // owes and what `lending_pool.total_borrow` tracks.
              asset: decoded.debtAsset,
              amount: decoded.amount,
            },
          });
          return true;
        default:
          return false;
      }
    } catch (err) {
      // P2002 = unique constraint. Another worker (or a replayed page) already
      // wrote this event; that is the dedupe path, not an error.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return false;
      }
      throw err;
    }
  }
}
