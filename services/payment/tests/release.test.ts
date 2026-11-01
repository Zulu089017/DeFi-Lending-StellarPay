import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";

// The pipeline touches Postgres only through these helpers; stub them so the
// release state machine is tested without a database.
const db = vi.hoisted(() => ({
  listPendingReleases: vi.fn(),
  countPendingReleases: vi.fn().mockResolvedValue(0),
  markUnwrapReleased: vi.fn(),
  markUnwrapReleaseAttempt: vi.fn(),
  markUnwrapReleaseFailed: vi.fn(),
}));
vi.mock("../src/store/db.js", () => db);

import {
  EvmReleaser,
  isAlreadyReleasedError,
  releaseTypedValue,
  type BridgeLike,
  type ReleaseContext,
  type ReleaseRow,
} from "../src/release/evmRelease.js";
import {
  signEvmRelease,
  RELEASE_EIP712_TYPES,
  STELLARPAY_EIP712_DOMAIN,
} from "../src/attest/signer.js";

const KEY1 = "0x" + "11".repeat(32);
const KEY2 = "0x" + "22".repeat(32);
const BRIDGE = "0x0000000000000000000000000000000000000002";
const TOKEN = "0x0000000000000000000000000000000000000003";
const RECIPIENT = "0x1234567890abcdef1234567890abcdef12345678";
const STELLAR_TX = "ab".repeat(32);

const ctx: ReleaseContext = {
  chain: "ethereum",
  chainId: 1,
  bridge: BRIDGE,
  token: TOKEN,
  provider: {} as ReleaseContext["provider"],
  signer: new ethers.Wallet(KEY1),
};

function row(over: Partial<ReleaseRow> = {}): ReleaseRow {
  return {
    id: "row-1",
    txHash: STELLAR_TX,
    chainId: 1,
    sourceChain: "ethereum",
    sourceAddr: "0x" + "00".repeat(12) + RECIPIENT.slice(2),
    amount: 1_000_000n,
    nonce: "0x" + "07".repeat(32),
    releaseAttempts: 0,
    ...over,
  };
}

function fakeBridge(
  over: Partial<{
    releasedNonces: (h: string) => Promise<boolean>;
    release: (...args: unknown[]) => Promise<unknown>;
  }> = {},
): BridgeLike {
  return {
    releasedNonces: over.releasedNonces ?? (async () => false),
    release:
      over.release ??
      (async () => ({
        hash: "0xreleasehash",
        wait: async () => ({ status: 1, hash: "0xreleasehash" }),
      })),
  } as BridgeLike;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.countPendingReleases.mockResolvedValue(0);
});

describe("releaseTypedValue", () => {
  it("builds the exact EIP-712 Release struct", () => {
    const v = releaseTypedValue(ctx, row());
    expect(v).toEqual({
      token: TOKEN,
      recipient: RECIPIENT,
      amount: 1_000_000n,
      stellarTxHash: "0x" + STELLAR_TX,
      nonce: BigInt("0x" + "07".repeat(32)),
    });
  });

  it("rejects a chain id that does not match the target context", () => {
    expect(() => releaseTypedValue(ctx, row({ chainId: 137 }))).toThrow(/not ethereum/);
  });
});

describe("EIP-712 attester signatures", () => {
  it("recovers the configured attester addresses", async () => {
    const value = releaseTypedValue(ctx, row());
    const sigs = await signEvmRelease([KEY1, KEY2], 1, BRIDGE, value);
    expect(sigs).toHaveLength(2);

    const domain = { ...STELLARPAY_EIP712_DOMAIN, chainId: 1, verifyingContract: BRIDGE };
    expect(ethers.verifyTypedData(domain, RELEASE_EIP712_TYPES, value, sigs[0])).toBe(
      new ethers.Wallet(KEY1).address,
    );
    expect(ethers.verifyTypedData(domain, RELEASE_EIP712_TYPES, value, sigs[1])).toBe(
      new ethers.Wallet(KEY2).address,
    );
  });
});

describe("EvmReleaser state machine", () => {
  it("marks an unwrap released only after a confirmed receipt", async () => {
    db.listPendingReleases.mockResolvedValue([row()]);
    const bridge = fakeBridge();
    const r = new EvmReleaser({ ethereum: ctx }, [KEY1, KEY2], () => bridge);

    const out = await r.processPending();
    expect(out.released).toBe(1);
    expect(db.markUnwrapReleased).toHaveBeenCalledWith("row-1", "0xreleasehash");
    expect(db.markUnwrapReleased.mock.calls[0][1]).not.toBeNull();
  });

  it("does NOT mark released when the receipt is missing (unconfirmed)", async () => {
    db.listPendingReleases.mockResolvedValue([row()]);
    const bridge = fakeBridge({
      release: async () => ({
        hash: "0xpending",
        wait: async () => null,
      }),
    });
    const r = new EvmReleaser({ ethereum: ctx }, [KEY1, KEY2], () => bridge);

    const out = await r.processPending();
    expect(out.released).toBe(0);
    expect(db.markUnwrapReleased).not.toHaveBeenCalled();
    expect(db.markUnwrapReleaseAttempt).toHaveBeenCalled();
  });

  it("does NOT mark released when the tx reverted on-chain", async () => {
    db.listPendingReleases.mockResolvedValue([row()]);
    const bridge = fakeBridge({
      release: async () => ({
        hash: "0xreverted",
        wait: async () => ({ status: 0, hash: "0xreverted" }),
      }),
    });
    const r = new EvmReleaser({ ethereum: ctx }, [KEY1, KEY2], () => bridge);

    await r.processPending();
    expect(db.markUnwrapReleased).not.toHaveBeenCalled();
    expect(db.markUnwrapReleaseAttempt).toHaveBeenCalled();
  });

  it("skips submission when releasedNonces already records the unwrap", async () => {
    db.listPendingReleases.mockResolvedValue([row()]);
    const release = vi.fn();
    const bridge = fakeBridge({ releasedNonces: async () => true, release });
    const r = new EvmReleaser({ ethereum: ctx }, [KEY1, KEY2], () => bridge);

    const out = await r.processPending();
    expect(release).not.toHaveBeenCalled();
    expect(out.released).toBe(1);
    expect(db.markUnwrapReleased).toHaveBeenCalledWith("row-1", null);
  });

  it("treats a replay revert as already released, not as a failure", async () => {
    db.listPendingReleases.mockResolvedValue([row()]);
    const bridge = fakeBridge({
      release: async () => {
        throw new Error("execution reverted: custom error 'Bridge__ReleaseReplayed(...)'");
      },
    });
    const r = new EvmReleaser({ ethereum: ctx }, [KEY1, KEY2], () => bridge);

    const out = await r.processPending();
    expect(out.released).toBe(1);
    expect(out.failed).toBe(0);
    expect(db.markUnwrapReleased).toHaveBeenCalledWith("row-1", null);
  });

  it("dead-letters a row that exceeded MAX_RELEASE_ATTEMPTS without submitting", async () => {
    db.listPendingReleases.mockResolvedValue([row({ releaseAttempts: 10 })]);
    const release = vi.fn();
    const r = new EvmReleaser({ ethereum: ctx }, [KEY1, KEY2], () => fakeBridge({ release }));

    const out = await r.processPending();
    expect(release).not.toHaveBeenCalled();
    expect(out.failed).toBe(1);
    expect(db.markUnwrapReleaseFailed).toHaveBeenCalled();
  });

  it("leaves unwraps pending for a chain with no release context", async () => {
    db.listPendingReleases.mockResolvedValue([row({ sourceChain: "polygon", chainId: 137 })]);
    const r = new EvmReleaser({ ethereum: ctx }, [KEY1, KEY2], () => fakeBridge());

    const out = await r.processPending();
    expect(out.skipped).toBe(1);
    expect(db.markUnwrapReleased).not.toHaveBeenCalled();
    expect(db.markUnwrapReleaseAttempt).not.toHaveBeenCalled();
  });

  it("refuses to submit below the attester threshold", async () => {
    db.listPendingReleases.mockResolvedValue([row()]);
    const release = vi.fn();
    const r = new EvmReleaser({ ethereum: ctx }, [KEY1], () => fakeBridge({ release }));

    await r.processPending();
    expect(release).not.toHaveBeenCalled();
    expect(db.markUnwrapReleaseAttempt).toHaveBeenCalled();
  });
});

describe("isAlreadyReleasedError", () => {
  it("matches nested ethers-style errors", () => {
    expect(
      isAlreadyReleasedError({ shortMessage: "x", error: { message: "ReleaseReplayed" } }),
    ).toBe(true);
    expect(isAlreadyReleasedError(new Error("insufficient funds"))).toBe(false);
  });
});
