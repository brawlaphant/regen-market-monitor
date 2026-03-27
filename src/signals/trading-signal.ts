export const SIGNAL_CLASSES = [
  "ARBITRAGE_LONG",
  "MOMENTUM_LONG",
  "MOMENTUM_SHORT",
  "ACCUMULATION",
  "DISTRIBUTION",
  "EPOCH_PLAY",
  "MEAN_REVERSION",
  "LIQUIDITY_EVENT",
  "HOLD",
  "EXIT",
] as const;
export type SignalClass = (typeof SIGNAL_CLASSES)[number];

export interface VenueContext {
  best_price_venue: string;
  worst_price_venue: string;
  cross_chain_spread_pct: number;
  hydrex_apr: number;
  hydrex_hours_to_epoch: number;
  hydrex_vote_trend: "increasing" | "decreasing" | "stable";
  bridge_flow_signal: "accumulation" | "distribution" | "neutral";
  total_liquidity_usd: number;
}

export interface TradingSignal {
  id: string;
  version: "1.0";
  generated_at: string;
  signal_class: SignalClass;
  direction: "long" | "short" | "neutral" | "exit";
  conviction: "A" | "B" | "C";
  token: "REGEN";
  entry_venue: string;
  entry_price_usd: number;
  target_price_usd: number | null;
  stop_loss_usd: number | null;
  recommended_size_usd: number;
  max_size_usd: number;
  time_horizon: "immediate" | "1h" | "4h" | "24h" | "epoch";
  expiry_at: string;
  rationale: string[];
  contributing_signals: string[];
  risk_factors: string[];
  venue_context: VenueContext;
  invalidated: boolean;
  invalidated_reason?: string;
}

/** Time horizons in milliseconds */
export const HORIZON_MS: Record<string, number> = {
  immediate: 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

/** Signal class → time horizon */
export const CLASS_HORIZON: Record<SignalClass, string> = {
  ARBITRAGE_LONG: "immediate",
  MOMENTUM_LONG: "4h",
  MOMENTUM_SHORT: "4h",
  ACCUMULATION: "24h",
  DISTRIBUTION: "24h",
  EPOCH_PLAY: "epoch",
  MEAN_REVERSION: "4h",
  LIQUIDITY_EVENT: "1h",
  HOLD: "4h",
  EXIT: "immediate",
};
