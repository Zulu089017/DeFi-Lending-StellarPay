import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  STELLAR_RPC: z.string().url(),
  STELLAR_NETWORK_PASSPHRASE: z.string(),
  STELLAR_RELAYER_SECRET: z.string(),

  ETHEREUM_RPC: z.string().url(),
  ETHEREUM_RELAYER_PK: z.string(),

  POLYGON_RPC: z.string().url(),
  POLYGON_RELAYER_PK: z.string(),

  DATABASE_URL: z.string().url(),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  MAX_RETRIES: z.coerce.number().int().positive().default(5),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // Health/metrics HTTP server (Prometheus scrape target). Default 4300:
  // the indexer owns 4200 in code and docker-compose.
  PORT: z.coerce.number().int().positive().default(4300),
  HOST: z.string().default("0.0.0.0"),
});

export const config = Env.parse(process.env);
