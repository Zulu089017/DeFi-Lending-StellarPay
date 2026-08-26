import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().url(),
  STELLAR_RPC: z.string().url(),
  STELLAR_NETWORK_PASSPHRASE: z.string(),
  STELLAR_CONTROLLER: z.string(),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  CORS_ORIGINS: z.string().default("*"),
  // When set, the rate limiter uses a shared Redis counter (across pod
  // replicas) instead of the in-process fallback.
  REDIS_URL: z.string().url().optional(),
});

export const config = Env.parse(process.env);
