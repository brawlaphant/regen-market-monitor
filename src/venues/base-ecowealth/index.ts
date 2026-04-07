/**
 * Base EcoWealth Venue — Parent Wallet Adapter
 *
 * Consumes /api/parent/ledger from MVP API (http://localhost:3099).
 * Generates signals from parent wallet activity on Base chain.
 */

import type { BaseEcowealthConfig } from "./types.js";

// ─── Re-exports ─────────────────────────────────────────────────────────

export { scanParentLedger } from "./strategies.js";
export type { SdkLike } from "./strategies.js";
export { loadLedger, saveLedger, recordSignalGeneration } from "./ledger.js";
export type {
  BaseEcowealthSignal,
  BaseEcowealthLedger,
  BaseEcowealthConfig,
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
 * Build Base EcoWealth config from environment variables.
 *
 * Variables:
 *   PARENT_LEDGER_URL — parent ledger API URL (default: http://127.0.0.1:3099)
 *   PARENT_CONFIDENCE — confidence threshold (default: 0.3)
 *   PARENT_DRY_RUN — dry run mode (default: true)
 *   PARENT_SCAN_INTERVAL — scan interval in ms (default: 300000 / 5 min)
 */
export function buildConfig(): BaseEcowealthConfig {
  return {
    parentLedgerUrl: process.env.PARENT_LEDGER_URL || "http://127.0.0.1:3099",
    confidenceThreshold: safeFloat(process.env.PARENT_CONFIDENCE, 0.3),
    dryRun: (process.env.PARENT_DRY_RUN ?? "true").toLowerCase() !== "false",
    scanInterval: safeInt(process.env.PARENT_SCAN_INTERVAL, 300_000), // 5 min default
  };
}

/**
 * Log config (for debugging).
 */
export function logConfig(config: BaseEcowealthConfig): void {
  console.log("[base-ecowealth] config:", {
    parentLedgerUrl: config.parentLedgerUrl,
    confidenceThreshold: config.confidenceThreshold,
    dryRun: config.dryRun,
    scanInterval: `${config.scanInterval}ms`,
  });
}
