import { describe, it, expect } from "vitest";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { DecodedEvent, RawSorobanEvent } from "../src/events/decode.js";
import {
  ingestEvents,
  type EventPage,
  type EventSource,
  type EventStore,
  type GetEventsQuery,
  type StoredCursor,
} from "../src/events/stream.js";

const USER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const CONTRACT = "CBNG3R6J2S4ZP7OEKIOS2JRVOJWG6YA56UR6N4Z4ZWIOH6LEX6R4NI2X";

let seq = 0;

function supplyEvent(ledger: number, name = "supply"): RawSorobanEvent {
  seq += 1;
  return {
    id: `00${ledger}-${String(seq).padStart(10, "0")}`,
    contractId: CONTRACT,
    ledger,
    txHash: `tx${seq}`,
    transactionIndex: 0,
    operationIndex: 0,
    ledgerClosedAt: "2026-11-01T14:02:10Z",
    topic: [xdr.ScVal.scvSymbol(name)],
    value: xdr.ScVal.scvVec([
      new Address(USER).toScVal(),
      xdr.ScVal.scvSymbol("XLM"),
      nativeToScVal(10n, { type: "i128" }),
    ]),
  };
}

class FakeSource implements EventSource {
  calls: GetEventsQuery[] = [];
  constructor(
    private readonly pages: EventPage[],
    private readonly latest = 1_000,
    private readonly oldest = 500,
  ) {}

  async getLatestLedger() {
    return this.latest;
  }
  async getOldestLedger() {
    return this.oldest;
  }
  async getEvents(query: GetEventsQuery): Promise<EventPage> {
    this.calls.push(query);
    return this.pages[this.calls.length - 1] ?? { events: [], cursor: "" };
  }
}

class FakeStore implements EventStore {
  ids = new Set<string>();
  cursors = new Map<string, StoredCursor>();
  stored: DecodedEvent[] = [];

  async getCursor(key: string) {
    return this.cursors.get(key) ?? null;
  }
  async saveCursor(key: string, cursor: StoredCursor) {
    this.cursors.set(key, cursor);
  }
  async insertEvent(raw: RawSorobanEvent, decoded: DecodedEvent) {
    if (this.ids.has(raw.id)) return false;
    this.ids.add(raw.id);
    this.stored.push(decoded);
    return true;
  }
}

const opts = { cursorKey: "soroban-events", contractIds: [CONTRACT] };

describe("ingestEvents", () => {
  it("starts at the oldest retained ledger on a cold start and persists the cursor", async () => {
    const events = [supplyEvent(501), supplyEvent(502)];
    const source = new FakeSource([{ events, cursor: "cur-1" }]);
    const store = new FakeStore();

    const result = await ingestEvents(source, store, opts);

    expect(source.calls[0].startLedger).toBe(500);
    expect(source.calls[0].cursor).toBeUndefined();
    expect(result.inserted).toBe(2);
    expect(result.startLedger).toBe(500);
    expect(result.unretrievableGap).toBe(0);
    expect(store.cursors.get("soroban-events")).toEqual({ cursor: "cur-1", ledger: 502n });
  });

  it("reports an unretrievable gap when the requested start predates retention", async () => {
    const source = new FakeSource([{ events: [], cursor: "cur" }], 1_000, 500);
    const store = new FakeStore();

    const result = await ingestEvents(source, store, { ...opts, startLedger: 100 });

    expect(result.startLedger).toBe(500);
    expect(result.unretrievableGap).toBe(400);
    expect(source.calls[0].startLedger).toBe(500);
  });

  it("resumes from the stored cursor instead of a ledger", async () => {
    const store = new FakeStore();
    await store.saveCursor("soroban-events", { cursor: "cur-42", ledger: 900n });
    const source = new FakeSource([{ events: [supplyEvent(901)], cursor: "cur-43" }]);

    await ingestEvents(source, store, opts);

    expect(source.calls[0].cursor).toBe("cur-42");
    expect(source.calls[0].startLedger).toBeUndefined();
    expect(store.cursors.get("soroban-events")?.cursor).toBe("cur-43");
  });

  it("is idempotent: replaying the same page inserts nothing new", async () => {
    const events = [supplyEvent(601), supplyEvent(602)];
    const store = new FakeStore();
    const pages = [{ events, cursor: "cur-a" }];

    const first = await ingestEvents(new FakeSource(pages), store, opts);
    const second = await ingestEvents(new FakeSource(pages), store, opts);

    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(2);
    expect(store.stored).toHaveLength(2);
  });

  it("records undecodable events without dropping the rest of the page", async () => {
    const broken = { ...supplyEvent(701), value: xdr.ScVal.scvVec([]) }; // supply needs 3 fields
    const good = supplyEvent(702);
    const store = new FakeStore();
    const source = new FakeSource([{ events: [broken, good], cursor: "cur" }]);

    const result = await ingestEvents(source, store, opts);

    expect(result.decodeErrors).toHaveLength(1);
    expect(result.decodeErrors[0].eventId).toBe(broken.id);
    expect(result.inserted).toBe(1);
    expect(store.stored).toHaveLength(1);
  });

  it("ignores unknown and non-persistable events", async () => {
    const fee = {
      ...supplyEvent(801, "fee"),
      value: xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 1n })),
    };
    const paused = supplyEvent(802, "pause_toggled");
    paused.value = xdr.ScVal.scvVec([xdr.ScVal.scvBool(true)]);
    const store = new FakeStore();

    const result = await ingestEvents(
      new FakeSource([{ events: [fee, paused], cursor: "cur" }]),
      store,
      opts,
    );

    expect(result.ignored).toBe(2);
    expect(result.inserted).toBe(0);
  });

  it("pages until a short page and respects maxPages", async () => {
    const page = (n: number): EventPage => ({
      events: [supplyEvent(900 + n)],
      cursor: `c${n}`,
    });
    const source = new FakeSource([page(1), page(2), page(3)]);
    const store = new FakeStore();

    const result = await ingestEvents(source, store, { ...opts, pageSize: 1, maxPages: 2 });

    expect(result.pages).toBe(2);
    expect(result.inserted).toBe(2);
    expect(store.cursors.get("soroban-events")?.cursor).toBe("c2");
  });
});
