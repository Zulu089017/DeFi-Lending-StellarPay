import "dotenv/config";
import { readFileSync } from "node:fs";
import { z } from "zod";

const Env = z.object({
  ETHEREUM_RPC: z.string().url(),
  POLYGON_RPC: z.string().url(),
  SOLANA_RPC: z.string().url(),

  ETHEREUM_BRIDGE: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  POLYGON_BRIDGE: z.string().regex(/^0x[a-fA-F0-9]{40}$/),

  STELLAR_RPC: z.string().url(),
  STELLAR_NETWORK_PASSPHRASE: z.string(),
  STELLAR_CONTROLLER: z.string(),
  RELAYER_SECRET: z.string(),

  // Soroban RPC endpoint used to read `unwrap` contract events. Horizon (the
  // STELLAR_RPC above) cannot serve contract events, so unwrap watching stays
  // disabled until this is set. Optional so the mint-only bridge still boots.
  STELLAR_SOROBAN_RPC: z.string().url().optional(),
  // First ledger the unwrap watcher scans when no cursor is persisted. When
  // unset, the watcher starts at the RPC's oldest retained ledger.
  STELLAR_SOROBAN_START_LEDGER: z.coerce.number().int().nonnegative().optional(),

  ATTESTER_KEYS: z.string().optional(),
  ATTESTER_KEYS_FILE: z.string().optional(),
  ATTESTER_THRESHOLD: z.coerce.number().int().positive(),

  // ── EVM release path (unwrap → Bridge.release) ────────────────────────
  // secp256k1 attester keys for EIP-712 `Release` signatures. Independent of
  // the ed25519 ATTESTER_KEYS which sign Stellar `wrap` payloads.
  EVM_ATTESTER_KEYS: z.string().optional(),
  EVM_ATTESTER_KEYS_FILE: z.string().optional(),
  EVM_ATTESTER_THRESHOLD: z.coerce.number().int().positive().default(2),
  // Canonical token address released on each source chain. A chain without a
  // token configured stays disabled (no unwraps are processed for it).
  ETHEREUM_RELEASE_TOKEN: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  POLYGON_RELEASE_TOKEN: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  // EVM tx submitter keys. Without one, the release path is read-only.
  ETHEREUM_RELAYER_PK: z.string().regex(/^(0x)?[a-fA-F0-9]{64}$/).optional(),
  POLYGON_RELAYER_PK: z.string().regex(/^(0x)?[a-fA-F0-9]{64}$/).optional(),
  // Block confirmations required before an unwrap is marked released.
  EVM_RELEASE_CONFIRMATIONS: z.coerce.number().int().positive().default(2),
  EVM_RELEASE_GAS_LIMIT: z.coerce.number().int().positive().default(300_000),
  MAX_RELEASE_ATTEMPTS: z.coerce.number().int().positive().default(10),

  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(4_000),
  PORT: z.coerce.number().int().positive().default(4100),
  HOST: z.string().default("0.0.0.0"),
});

export const config = Env.parse(process.env);

/**
 * Load attester ed25519 secret keys, preferring a mounted secret file
 * (`ATTESTER_KEYS_FILE`, injected by a secrets manager / Kubernetes Secret /
 * Vault agent / Doppler) over a plaintext `ATTESTER_KEYS` env var, so keys
 * never have to sit in plaintext env vars. Accepts comma- or newline-separated
 * keys, with or without a `0x` prefix.
 */
function loadAttesterKeys(): string[] {
  const raw = config.ATTESTER_KEYS_FILE
    ? readFileSync(config.ATTESTER_KEYS_FILE, "utf8")
    : (config.ATTESTER_KEYS ?? "");
  const keys = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    throw new Error(
      "no attester keys configured — set ATTESTER_KEYS or ATTESTER_KEYS_FILE",
    );
  }
  return keys;
}

export const attesters = loadAttesterKeys();

/** Load the optional EVM attester keys from a mounted file (preferred) or
 *  the plaintext env var. Returns [] when neither is set — the release path
 *  is then disabled rather than failing every unwrap. */
function loadEvmAttesterKeys(): string[] {
  const raw = config.EVM_ATTESTER_KEYS_FILE
    ? readFileSync(config.EVM_ATTESTER_KEYS_FILE, "utf8")
    : (config.EVM_ATTESTER_KEYS ?? "");
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const evmAttesters = loadEvmAttesterKeys();
