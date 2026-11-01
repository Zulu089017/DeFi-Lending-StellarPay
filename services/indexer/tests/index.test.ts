import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Express to test indexer HTTP routes in-process.
vi.mock("express", () => {
  const express = vi.fn(() => ({
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    listen: vi.fn((_port, cb: () => void) => {
      cb();
      return { close: vi.fn() };
    }),
  }));
  (express as any).json = vi.fn(() => vi.fn());
  return { default: express };
});

vi.mock("@stellar/stellar-sdk", () => ({
  Horizon: { Server: vi.fn(() => ({ operations: vi.fn() })) },
  rpc: { Server: vi.fn(() => ({ getHealth: vi.fn() })) },
  Networks: { TESTNET: "Test SDF Network ; September 2015" },
}));

vi.mock("ethers", () => ({
  ethers: {
    JsonRpcProvider: vi.fn(),
    Interface: vi.fn(() => ({ parseLog: vi.fn() })),
    isAddress: vi.fn(() => false),
    ZeroAddress: "0x0000000000000000000000000000000000000000",
  },
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(() => ({
    cursor: { findUnique: vi.fn() },
    wrapEvent: { findMany: vi.fn(() => []), upsert: vi.fn() },
    unwrapEvent: { findMany: vi.fn(() => []) },
    lendingEvent: { findMany: vi.fn(() => []) },
    bridgeEvent: { findMany: vi.fn(() => []), upsert: vi.fn() },
    reconciliationRun: { findFirst: vi.fn(() => null) },
  })),
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

vi.mock("pino", () => ({
  default: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

describe("Indexer module loads without crashing", () => {
  beforeEach(() => {
    vi.stubEnv("STELLAR_RPC", "https://horizon-testnet.stellar.org");
    vi.stubEnv("ETHEREUM_RPC", "https://eth.llamarpc.com");
    vi.stubEnv("ETHEREUM_BRIDGE", "0x0");
    vi.stubEnv("STELLAR_CONTROLLER", "CABC");
  });

  it("exports a basic health endpoint concept", async () => {
    // The indexer module registers HTTP routes on import. We just verify the
    // module shape doesn't throw (the event/reconcile loops are off when no
    // contracts or reconcile account are configured).
    await expect(import("../src/index.js")).resolves.toBeDefined();
  });
});
