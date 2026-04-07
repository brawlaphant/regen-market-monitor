/**
 * Base EcoWealth Venue Types
 *
 * Signals from the parent wallet trading on Base chain.
 * Consumes /api/parent/ledger from MVP API.
 */

// ─── Signal ────────────────────────────────────────────────────────────

export interface BaseEcowealthSignal {
  /** Market: always "parent-base" (parent wallet on Base) */
  market: string;

  /** Asset pair being traded (e.g., "LITCOIN/WETH", "ECOWEALTH/WETH") */
  asset: string;

  /** Strategy name */
  strategy:
    | "litcoin_accumulation"
    | "ecowealth_fdv"
    | "regen_accumulation"
    | "yield_reinvestment";

  /** Trade direction */
  direction: "buy" | "sell" | "hold";

  /** Entry price in USD */
  entry: number;

  /** Position size in USD */
  size_usd: number;

  /** Leverage (always 1 for spot) */
  leverage: number;

  /** Metrics */
  metrics: {
    /** 24h realized P&L (USD) */
    pnl_24h: number;

    /** 24h gas spent (ETH) */
    gas_spent_24h: number;

    /** Daily LITCOIN mined */
    litcoin_mined_today: number;

    /** 24h staking yield (LITCOIN) */
    staking_yield_24h: number;

    /** Current price (USD) */
    price_usd: number;

    /** Confidence (0-1) */
    confidence: number;
  };

  /** When signal was generated */
  timestamp: string;
}

// ─── Ledger ────────────────────────────────────────────────────────────

export interface BaseEcowealthLedger {
  date: string;
  signals_generated: number;
  total_pnl: number;
  total_gas_spent: number;
  regen_bought: number;
  ecowealth_bought: number;
  timestamp: string;
}

// ─── Config ────────────────────────────────────────────────────────────

export interface BaseEcowealthConfig {
  /** Parent ledger API URL (e.g., "http://127.0.0.1:3099") */
  parentLedgerUrl: string;

  /** Confidence threshold to generate signal (0-1) */
  confidenceThreshold: number;

  /** Dry run mode (don't execute trades) */
  dryRun: boolean;

  /** Scan interval (ms) */
  scanInterval: number;
}
