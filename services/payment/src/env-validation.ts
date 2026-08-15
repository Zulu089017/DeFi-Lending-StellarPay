// Environment Validation
// Validates all required environment variables and runtime conditions on startup.

import { attesters, config } from "./config.js";
import { logger } from "./utils/logger.js";

export interface EnvValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate all environment variables and runtime conditions.
 * Call this at service startup before accepting traffic.
 */
export function validateEnvironment(): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required RPC URLs
  const requiredUrls: [string, string][] = [
    [config.ETHEREUM_RPC, "ETHEREUM_RPC"],
    [config.POLYGON_RPC, "POLYGON_RPC"],
    [config.SOLANA_RPC, "SOLANA_RPC"],
    [config.STELLAR_RPC, "STELLAR_RPC"],
    [config.DATABASE_URL, "DATABASE_URL"],
  ];

  for (const [url, name] of requiredUrls) {
    if (!url || url.length === 0) {
      errors.push(`${name} is not set`);
    } else {
      try {
        new URL(url);
      } catch {
        errors.push(`${name} is not a valid URL: ${url}`);
      }
    }
  }

  // Contract addresses
  if (!/^0x[a-fA-F0-9]{40}$/.test(config.ETHEREUM_BRIDGE)) {
    errors.push("ETHEREUM_BRIDGE must be a valid 0x-prefixed address");
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(config.POLYGON_BRIDGE)) {
    errors.push("POLYGON_BRIDGE must be a valid 0x-prefixed address");
  }

  // Stellar config
  if (!config.STELLAR_CONTROLLER || config.STELLAR_CONTROLLER.length !== 56) {
    errors.push("STELLAR_CONTROLLER must be a valid 56-character contract ID");
  }
  if (!config.RELAYER_SECRET || !/^S[A-Z2-7]{55}$/.test(config.RELAYER_SECRET)) {
    errors.push("RELAYER_SECRET must be a valid Stellar secret key (S...)");
  }

  // Attester config
  const keys = attesters;
  if (keys.length < config.ATTESTER_THRESHOLD) {
    errors.push(
      `ATTESTER_THRESHOLD (${config.ATTESTER_THRESHOLD}) exceeds number of attester keys (${keys.length})`,
    );
  }

  // Warnings
  if (config.STELLAR_NETWORK_PASSPHRASE.includes("Test")) {
    warnings.push("Running on Stellar testnet — do not use for production assets");
  }
  if (config.LOG_LEVEL === "debug" || config.LOG_LEVEL === "trace") {
    warnings.push("Verbose logging enabled — may expose sensitive data in logs");
  }

  logger.info(
    { errors: errors.length, warnings: warnings.length },
    "environment validation complete",
  );

  return { valid: errors.length === 0, errors, warnings };
}
