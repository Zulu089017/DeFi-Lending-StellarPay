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

  ATTESTER_KEYS: z.string().optional(),
  ATTESTER_KEYS_FILE: z.string().optional(),
  ATTESTER_THRESHOLD: z.coerce.number().int().positive(),

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
