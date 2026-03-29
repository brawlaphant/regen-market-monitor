/**
 * Hyperliquid venue types.
 */

/** A trading signal from Hyperliquid strategies */
export interface HyperliquidSignal {
  coin: string;
  strategy: "funding" | "momentum" | "mean_reversion";
  direction: "long" | "short";
  entry: number;
  size_usd: number;
  leverage: number;
  funding_rate?: number;
  funding_annualized?: number;
  momentum_pct?: number;
  rationale: string;
}

/** Daily ledger for Hyperliquid trades */
export interface HyperliquidLedger {
  date: string;
  spent_usd: number;
  trades: Array<{
    coin: string;
    direction: string;
    size_usd: number;
    price: number;
    timestamp: string;
    dry_run: boolean;
  }>;
}

/** Hyperliquid venue configuration */
export interface HyperliquidConfig {
  privateKey?: string;
  dryRun: boolean;
  dailyCap: number;
  maxPosition: number;
  maxLeverage: number;
  fundingThreshold: number;
  momentumThreshold: number;
  minVolume24h: number;
}
