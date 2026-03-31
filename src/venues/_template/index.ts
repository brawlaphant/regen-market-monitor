/**
 * %%VENUE_NAME%% Venue — [one-line description of what this venue is].
 *
 * TODO: Replace this docblock with a real description. Examples from other venues:
 *   "GMX Venue — perpetual futures + GM pool yield on Arbitrum."
 *   "Hyperliquid Venue — perpetual futures funding capture + momentum."
 *   "Polymarket Venue — prediction market signals + execution."
 *
 * Replace every "%%VENUE_NAME%%" with your venue name (e.g. "Kujira").
 * Replace every "%%VENUE_KEY%%" with the UPPER_SNAKE env prefix (e.g. "KUJIRA").
 * Replace every "%%venue_key%%" with a lowercase slug (e.g. "kujira").
 */

import type { %%VENUE_NAME%%Config } from "./types.js";

// ─── Re-exports ─────────────────────────────────────────────────────────
// Export your strategy scan functions so the orchestrator can call them.
// Export the ledger functions so the orchestrator can track daily spend.
// Export your types so consumers don't need to reach into this directory.

export { scanExample } from "./strategies.js";
export type { SdkLike } from "./strategies.js";
export { loadLedger, saveLedger } from "./ledger.js";
export type {
  %%VENUE_NAME%%Signal,
  %%VENUE_NAME%%Ledger,
  %%VENUE_NAME%%Config,
} from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────

const safeFloat = (v: string | undefined, fallback: number): number => {
  const n = parseFloat(v || String(fallback));
  return isNaN(n) ? fallback : n;
};
const safeInt = (v: string | undefined, fallback: number): number => {
  const n = parseInt(v || String(fallback), 10);
  return isNaN(n) ? fallback : n;
};

// ─── Config Builder ─────────────────────────────────────────────────────

/**
 * Build %%VENUE_NAME%% config from environment variables.
 *
 * Every venue follows this pattern:
 *   - All config comes from env vars with a venue-specific prefix
 *   - Sane defaults for everything (so the venue runs signal-only with zero config)
 *   - privateKey is optional (undefined = paper trade / signal-only)
 *   - dryRun defaults to true (safe by default)
 *
 * TODO: Add your venue-specific env vars below. Follow the naming convention:
 *   %%VENUE_KEY%%_DAILY_CAP, %%VENUE_KEY%%_MAX_POSITION, etc.
 */
export function build%%VENUE_NAME%%Config(): %%VENUE_NAME%%Config {
  return {
    privateKey: (process.env.%%VENUE_KEY%%_PK || "").trim() || undefined,
    dryRun: (process.env.%%VENUE_KEY%%_DRY_RUN || "true").toLowerCase() !== "false",
    dailyCap: safeFloat(process.env.%%VENUE_KEY%%_DAILY_CAP, 50),
    maxPosition: safeFloat(process.env.%%VENUE_KEY%%_MAX_POSITION, 25),
    maxLeverage: safeInt(process.env.%%VENUE_KEY%%_MAX_LEVERAGE, 1),
    // TODO: Add your venue-specific config fields here.
    // Examples:
    //   rpcUrl: (process.env.%%VENUE_KEY%%_RPC_URL || "").trim() || "https://rpc.kujira.app",
    //   chainId: safeInt(process.env.%%VENUE_KEY%%_CHAIN_ID, 1),
    //   minLiquidity: safeFloat(process.env.%%VENUE_KEY%%_MIN_LIQUIDITY, 10_000),
    //   apiBaseUrl: (process.env.%%VENUE_KEY%%_API_URL || "").trim() || "https://api.example.com",
  };
}
