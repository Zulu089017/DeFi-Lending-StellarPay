/**
 * Vitest setupFile. Runs in each worker process before the test file is
 * imported. Asserts that `globalSetup` successfully propagated the
 * test-database env vars; without this guard, a propagation failure
 * would surface deep inside `db.ts` as a confusing "DATABASE_URL is
 * not set" error from `config.ts`.
 *
 * The `config.ts` Zod schema requires the Stellar / controller fields;
 * `global-setup.ts` sets them via `process.env.X ??=` but that runs in
 * globalSetup which forks after module load. We set the dummy values here
 * so `config.ts` (imported by `buildApp` at module load) always parses.
 */
if (!process.env.DATABASE_URL) {
  throw new Error(
    "[api tests] DATABASE_URL is not set. This usually means the vitest " +
      "fork pool did not inherit env vars from globalSetup. Check that " +
      "`src/tests/helpers/global-setup.ts` ran before this file and that " +
      "you are not running `vitest` with `--no-env` or a custom env filter.",
  );
}
if (!process.env.STELLAR_RPC) process.env.STELLAR_RPC = "https://stellar.test";
if (!process.env.STELLAR_NETWORK_PASSPHRASE) process.env.STELLAR_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
if (!process.env.STELLAR_CONTROLLER) process.env.STELLAR_CONTROLLER = "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ";
