/**
 * %%VENUE_NAME%% venue types.
 *
 * Replace every instance of "%%VENUE_NAME%%" with your venue name (e.g. "Kujira").
 * Replace every "%%venue_key%%" with a lowercase slug (e.g. "kujira").
 *
 * Three types are required:
 *   1. Signal  — one trading signal your strategies produce
 *   2. Ledger  — daily trade record, persisted to disk
 *   3. Config  — venue configuration, built from env vars
 *
 * Keep field names consistent with existing venues (see gmx/types.ts,
 * hyperliquid/types.ts) so the orchestrator and surplus router work
 * without special-casing.
 */

// ─── Signal ────────────────────────────────────────────────────────────
// A signal is one actionable trade idea your strategy scan produces.
// The orchestrator collects these and (optionally) routes them to execution.

/** A trading signal from %%VENUE_NAME%% strategies */
export interface %%VENUE_NAME%%Signal {
  /** Market identifier — whatever the venue uses (address, symbol, pair ID) */
  market: string;

  /** Human-readable asset name (e.g. "ETH", "REGEN/USDC") */
  asset: string;

  /**
   * Which strategy produced this signal.
   * Add your strategy names here as a union type.
   * Example: "funding" | "momentum" | "spread_capture"
   */
  strategy: string; // TODO: Replace with a union of your strategy names

  /** Trade direction */
  direction: "long" | "short" | "buy" | "sell";

  /** Entry price in USD */
  entry: number;

  /** Position size in USD */
  size_usd: number;

  /** Leverage (1 for spot) */
  leverage: number;

  /**
   * Strategy-specific metrics — add fields for whatever your strategy computes.
   * Examples:
   *   funding_rate?: number;
   *   spread_pct?: number;
   *   volume_24h?: number;
   */
  // TODO: Add strategy-specific numeric fields here

  /** Human-readable explanation of why this signal was generated */
  rationale: string;
}

// ─── Ledger ────────────────────────────────────────────────────────────
// The ledger tracks what was actually executed (or paper-traded) today.
// One file per day, stored in <dataDir>/%%venue_key%%/ledger-YYYY-MM-DD.json.

/** Daily ledger for %%VENUE_NAME%% trades */
export interface %%VENUE_NAME%%Ledger {
  /** ISO date string: YYYY-MM-DD */
  date: string;

  /** Total USD spent today across all trades */
  spent_usd: number;

  /** Individual trade records */
  trades: Array<{
    market: string;
    direction: string;
    size_usd: number;
    price: number;
    timestamp: string;
    dry_run: boolean;
  }>;
}

// ─── Config ────────────────────────────────────────────────────────────
// All values come from environment variables with sane defaults.
// The buildConfig() function in index.ts reads these.

/** %%VENUE_NAME%% venue configuration */
export interface %%VENUE_NAME%%Config {
  /** Private key for signing transactions (undefined = signal-only mode) */
  privateKey?: string;

  /** When true, log trades but don't execute. Always start here. */
  dryRun: boolean;

  /** Maximum USD to spend per day across all strategies */
  dailyCap: number;

  /** Maximum USD per single position */
  maxPosition: number;

  /** Maximum leverage allowed (1 for spot venues) */
  maxLeverage: number;

  /**
   * TODO: Add venue-specific config fields.
   * Examples:
   *   rpcUrl: string;
   *   chainId: number;
   *   minLiquidity: number;
   *   apiBaseUrl: string;
   */
}
