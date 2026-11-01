// Paginated Soroban event ingestion: RPC -> decode -> idempotent store.
//
// Design constraints:
//   • At-least-once delivery. The cursor is persisted only after a page has
//     been written, and every write is keyed by the RPC event id, so replaying
//     a page after a crash inserts nothing twice.
//   • No silent data loss. Malformed *known* events are counted and reported
//     (the caller logs them); unknown event names are ignored on purpose.
//   • Explicit gap reporting. Soroban RPC prunes events after ~7 days, so a
//     cold start may begin after events we can never fetch. We report the gap
//     instead of pretending the history is complete.

import {
  decodeSorobanEvent,
  EventDecodeError,
  isPersistable,
  type DecodedEvent,
  type RawSorobanEvent,
} from "./decode.js";

export interface EventPage {
  events: RawSorobanEvent[];
  cursor: string;
}

export interface GetEventsQuery {
  contractIds: string[];
  cursor?: string;
  startLedger?: number;
  limit: number;
}

export interface EventSource {
  getLatestLedger(): Promise<number>;
  getOldestLedger(): Promise<number>;
  getEvents(query: GetEventsQuery): Promise<EventPage>;
}

export interface StoredCursor {
  cursor: string;
  ledger: bigint;
}

export interface EventStore {
  getCursor(key: string): Promise<StoredCursor | null>;
  saveCursor(key: string, cursor: StoredCursor): Promise<void>;
  /** `true` when inserted, `false` when the event was already stored. */
  insertEvent(raw: RawSorobanEvent, decoded: DecodedEvent): Promise<boolean>;
}

export interface IngestOptions {
  cursorKey: string;
  contractIds: string[];
  pageSize?: number;
  maxPages?: number;
  /** Where to start on a cold run. Defaults to the oldest ledger RPC retains. */
  startLedger?: number;
}

export interface IngestError {
  eventId: string;
  message: string;
}

export interface IngestResult {
  pages: number;
  fetched: number;
  inserted: number;
  duplicates: number;
  ignored: number;
  decodeErrors: IngestError[];
  startLedger: number;
  latestLedger: number;
  /** Ledgers between the requested start and the oldest ledger still served. */
  unretrievableGap: number;
}

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 20;

export async function ingestEvents(
  source: EventSource,
  store: EventStore,
  opts: IngestOptions,
): Promise<IngestResult> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  const [latestLedger, oldestLedger] = await Promise.all([
    source.getLatestLedger(),
    source.getOldestLedger(),
  ]);

  const saved = await store.getCursor(opts.cursorKey);
  const requestedStart = opts.startLedger ?? oldestLedger;
  // RPC rejects startLedger outside [evicted, latest]; clamp instead of crash.
  const startLedger = Math.max(requestedStart, oldestLedger);

  const result: IngestResult = {
    pages: 0,
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    ignored: 0,
    decodeErrors: [],
    startLedger,
    latestLedger,
    unretrievableGap: Math.max(0, oldestLedger - requestedStart),
  };

  let cursor = saved?.cursor;

  for (let page = 0; page < maxPages; page++) {
    const response = await source.getEvents({
      contractIds: opts.contractIds,
      limit: pageSize,
      ...(cursor ? { cursor } : { startLedger }),
    });
    result.pages += 1;
    result.fetched += response.events.length;

    for (const raw of response.events) {
      let decoded: DecodedEvent | null;
      try {
        decoded = decodeSorobanEvent(raw);
      } catch (err) {
        if (err instanceof EventDecodeError) {
          result.decodeErrors.push({ eventId: err.eventId, message: err.message });
          continue;
        }
        throw err;
      }
      if (decoded === null || !isPersistable(decoded.kind)) {
        result.ignored += 1;
        continue;
      }
      const inserted = await store.insertEvent(raw, decoded);
      if (inserted) result.inserted += 1;
      else result.duplicates += 1;
    }

    if (response.cursor) {
      cursor = response.cursor;
      const lastLedger = response.events[response.events.length - 1]?.ledger ?? startLedger;
      await store.saveCursor(opts.cursorKey, { cursor, ledger: BigInt(lastLedger) });
    }

    if (response.events.length < pageSize) break;
  }

  return result;
}
