/**
 * GMX venue types — perpetual futures on Arbitrum via @gmx-io/sdk.
 */

/** A trading signal from GMX strategies */
export interface GmxSignal {
  market: string;
  indexToken: string;
  strategy: "funding" | "momentum" | "gm_pool";
  direction: "long" | "short";
  entry: number;
  size_usd: number;
  leverage: number;
  funding_rate?: number;
  funding_annualized?: number;
  momentum_pct?: number;
  pool_apy?: number;
  rationale: string;
}

/** Daily ledger for GMX trades */
export interface GmxLedger {
  date: string;
  spent_usd: number;
  trades: Array<{
    market: string;
    direction: string;
    size_usd: number;
    price: number;
    timestamp: string;
    dry_run: boolean;
  }>;
}

/** GMX venue configuration */
export interface GmxConfig {
  privateKey?: string;
  dryRun: boolean;
  dailyCap: number;
  maxPosition: number;
  maxLeverage: number;
  fundingThreshold: number;
  momentumThreshold: number;
  minVolume24h: number;
  chainId: number;
  rpcUrl: string;
  gmPoolEnabled: boolean;
  gmMinApy: number;
}
