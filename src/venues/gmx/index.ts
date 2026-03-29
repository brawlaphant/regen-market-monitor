/**
 * GMX Venue — perpetual futures + GM pool yield on Arbitrum.
 *
 * Scans funding rates, 24h momentum, and GM pool APYs via @gmx-io/sdk.
 * Execution via EIP-712 signed orders with Gelato Relay (gasless, MEV-protected).
 */

export { scanFunding, scanMomentum, scanGmPools } from "./strategies.js";
export type { GmxSdkLike } from "./strategies.js";
export { loadLedger, saveLedger } from "./ledger.js";
export type { GmxSignal, GmxLedger, GmxConfig } from "./types.js";

const safeFloat = (v: string | undefined, fallback: number): number => {
  const n = parseFloat(v || String(fallback));
  return isNaN(n) ? fallback : n;
};
const safeInt = (v: string | undefined, fallback: number): number => {
  const n = parseInt(v || String(fallback), 10);
  return isNaN(n) ? fallback : n;
};

/** Build GMX config from environment variables */
export function buildGmxConfig(): GmxConfig {
  return {
    privateKey: (process.env.GMX_PK || "").trim() || undefined,
    dryRun: (process.env.GMX_DRY_RUN || "true").toLowerCase() !== "false",
    dailyCap: safeFloat(process.env.GMX_DAILY_CAP, 50),
    maxPosition: safeFloat(process.env.GMX_MAX_POSITION, 25),
    maxLeverage: safeInt(process.env.GMX_MAX_LEVERAGE, 10),
    fundingThreshold: safeFloat(process.env.GMX_FUNDING_THRESHOLD, 0.01),
    momentumThreshold: safeFloat(process.env.GMX_MOMENTUM_THRESHOLD, 0.02),
    minVolume24h: safeFloat(process.env.GMX_MIN_VOLUME, 1_000_000),
    chainId: safeInt(process.env.GMX_CHAIN_ID, 42161), // Arbitrum
    rpcUrl: (process.env.GMX_RPC_URL || "").trim() || "https://arb1.arbitrum.io/rpc",
    gmPoolEnabled: (process.env.GMX_GM_POOL_ENABLED || "false").toLowerCase() === "true",
    gmMinApy: safeFloat(process.env.GMX_GM_MIN_APY, 10),
  };
}

import type { GmxConfig } from "./types.js";
