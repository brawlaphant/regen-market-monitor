/**
 * Hyperliquid Venue — perpetual futures funding capture + momentum.
 *
 * Scans funding rates and 24h momentum across all Hyperliquid perps.
 * Executes via EIP-712 signed orders through the Hyperliquid SDK.
 */

export { scanFunding, scanMomentum } from "./strategies.js";
export { loadLedger, saveLedger } from "./ledger.js";
export type { HyperliquidSignal, HyperliquidLedger, HyperliquidConfig } from "./types.js";

/** Build Hyperliquid config from environment variables */
export function buildHyperliquidConfig(): {
  privateKey?: string;
  dryRun: boolean;
  dailyCap: number;
  maxPosition: number;
  maxLeverage: number;
  fundingThreshold: number;
  momentumThreshold: number;
  minVolume24h: number;
} {
  return {
    privateKey: (process.env.HYPERLIQUID_PK || "").trim() || undefined,
    dryRun: (process.env.HYPERLIQUID_DRY_RUN || "true").toLowerCase() !== "false",
    dailyCap: parseFloat(process.env.HYPERLIQUID_DAILY_CAP || "50"),
    maxPosition: parseFloat(process.env.HYPERLIQUID_MAX_POSITION || "25"),
    maxLeverage: parseInt(process.env.HYPERLIQUID_MAX_LEVERAGE || "5", 10),
    fundingThreshold: parseFloat(process.env.HYPERLIQUID_FUNDING_THRESHOLD || "0.01"),
    momentumThreshold: parseFloat(process.env.HYPERLIQUID_MOMENTUM_THRESHOLD || "0.02"),
    minVolume24h: parseFloat(process.env.HYPERLIQUID_MIN_VOLUME || "1000000"),
  };
}
