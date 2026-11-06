import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // The `config.ts` Zod schema requires the Stellar / controller fields
    // at module load (`import { config } from "./config.js"` in `index.ts`).
    // These are set here (applied to each worker before the module graph is
    // evaluated) so `buildApp` / `PrismaClient` boot successfully even when
    // `global-setup.ts` (globalSetup) is what normally provides them.
    env: {
      DATABASE_URL: "postgresql://spg:spg@localhost:5432/spg",
      STELLAR_RPC: "https://horizon-testnet.stellar.org",
      STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      STELLAR_CONTROLLER: "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    },
    // testcontainers startup is 5-15s on first run; allow generous timeouts
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // `forks` avoids the Prisma WASM-loader issue with `threads`; singleFork
    // serialises tests so the one globalSetup container isn't raced.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    globalSetup: ["./src/tests/helpers/global-setup.ts"],
    setupFiles: ["./src/tests/helpers/setup-env.ts"],
    include: ["src/tests/**/*.test.ts"],
  },
});
