// Pure mapping from decoded EVM `Bridge` logs to `BridgeEvent` rows.
//
// The three events have different field layouts; the previous implementation
// read them positionally with fallbacks (`args[0] ?? args.recipient`), which
// silently wrote the recipient into `sender` for `Released` and dropped the
// Stellar tx hash and nonce that X-3 reconciliation needs. Mapping by name
// keeps the stored columns meaningful.

export const BRIDGE_EVENT_ABI = [
  "event Locked(address indexed sender, address indexed token, uint256 amount, bytes32 indexed stellarDest, bytes32 salt, uint256 nonce)",
  "event Burned(address indexed sender, address indexed token, uint256 amount, bytes32 indexed stellarDest, bytes32 salt, uint256 nonce)",
  "event Released(address indexed recipient, address indexed token, uint256 amount, bytes32 indexed stellarTxHash, uint256 nonce)",
];

export interface BridgeEventRow {
  chain: string;
  txHash: string;
  logIndex: number;
  type: "locked" | "burned" | "released";
  sender: string;
  token: string;
  amount: bigint;
  stellarDest: string | null;
  salt: string | null;
  stellarTxHash: string | null;
  nonce: string | null;
  createdAt: Date;
}

export interface ParsedBridgeLog {
  name: string;
  args: Record<string, unknown> & Array<unknown>;
}

export class BridgeLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeLogError";
  }
}

function bytes32(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new BridgeLogError(`${field} is not a bytes32: ${String(value)}`);
  }
  return value.toLowerCase();
}

function address(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new BridgeLogError(`${field} is not an address: ${String(value)}`);
  }
  return value.toLowerCase();
}

function positiveAmount(value: unknown): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new BridgeLogError(`amount must be a positive bigint, got ${String(value)}`);
  }
  return value;
}

/** Left-pad a uint256 nonce to 32 bytes so hex comparisons are uniform. */
export function uint256Hex(value: unknown): string {
  const asBig = typeof value === "bigint" ? value : BigInt(String(value));
  return "0x" + asBig.toString(16).padStart(64, "0");
}

export function mapBridgeLog(
  chain: string,
  log: { txHash: string; index: number },
  parsed: ParsedBridgeLog,
  createdAt: Date = new Date(),
): BridgeEventRow {
  const base = {
    chain,
    txHash: log.txHash.toLowerCase(),
    logIndex: log.index,
    createdAt,
  };

  switch (parsed.name) {
    case "Locked":
    case "Burned":
      return {
        ...base,
        type: parsed.name === "Locked" ? "locked" : "burned",
        sender: address(parsed.args.sender, "sender"),
        token: address(parsed.args.token, "token"),
        amount: positiveAmount(parsed.args.amount),
        stellarDest: bytes32(parsed.args.stellarDest, "stellarDest"),
        salt: bytes32(parsed.args.salt, "salt"),
        stellarTxHash: null,
        nonce: uint256Hex(parsed.args.nonce),
      };
    case "Released":
      return {
        ...base,
        type: "released",
        // `recipient` is who receives value on the source chain; it is not a
        // sender, but the column is reused for display-only consistency.
        sender: address(parsed.args.recipient, "recipient"),
        token: address(parsed.args.token, "token"),
        amount: positiveAmount(parsed.args.amount),
        stellarDest: null,
        salt: null,
        stellarTxHash: bytes32(parsed.args.stellarTxHash, "stellarTxHash"),
        nonce: uint256Hex(parsed.args.nonce),
      };
    default:
      throw new BridgeLogError(`unexpected event ${parsed.name}`);
  }
}
