import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // The `config.ts` Zod schema requires the Stellar / controller fields
    // at module load (`import { config } from "./config.js"` in `index.ts`).
    // Do NOT set `DATABASE_URL` here: it would override the container URL
    // that `global-setup.ts` supplies via the fork-pool env, so workers
    // would point Prisma at the dead `localhost:5432` instead of the
    // testcontainers Postgres. The Stellar fields are set as harmless
    // dummies so the schema parses at module load; `global-setup.ts`
    // supplies the real values for everything the test routes read.
    env: {
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
