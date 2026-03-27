/** Agent IDs from the Regen agentic tokenomics spec (2.4) */
export type AgentId = "AGENT-001" | "AGENT-002" | "AGENT-003" | "AGENT-004";

export const SIGNAL_TYPES = [
  "PRICE_ANOMALY",
  "PRICE_MOVEMENT",
  "LIQUIDITY_WARNING",
  "LOW_SUPPLY",
  "GOAL_COMPLETED",
  "CURATION_DEGRADED",
  "MARKET_REPORT",
  "MANIPULATION_ALERT",
  "CROSS_CHAIN_ARBITRAGE",
  "BRIDGE_FLOW_SPIKE",
  "VENUE_PRICE_DIVERGENCE",
  "LIQUIDITY_MIGRATION",
  "HYDX_EPOCH_TRANSITION",
  "EMISSION_SHIFT",
  "LP_INCENTIVE_SPIKE",
  "SENTIMENT_SHIFT",
  "GOVERNANCE_EVENT",
  "WHALE_MOVEMENT",
  "WHALE_PATTERN",
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export type BroadcastChannel = "redis" | "webhook" | "rest";

export interface PriceAnomalyData {
  batch_denom: string;
  current_price: number;
  z_score: number;
  mean_price: number;
  std_dev: number;
  window_size: number;
  anomaly_level: "warning" | "critical";
}

export interface PriceMovementData {
  current_price: number;
  previous_price: number;
  change_pct: number;
  direction: "up" | "down";
  threshold_pct: number;
}

export interface LiquidityWarningData {
  health_score: number;
  available_credits: number;
  listed_value_usd: number;
  previous_health_score: number;
  degradation_pct: number;
}

export interface LowSupplyData {
  available_credits: number;
  threshold: number;
  deficit: number;
  batch_denom?: string;
}

export interface GoalCompletedData {
  goal_id: string;
  goal_name: string;
  target: number;
  final_value: number;
  completed_at: string;
}

export interface CurationDegradedData {
  batch_denom: string;
  current_score: number;
  previous_score: number;
  delta: number;
  factors_changed: string[];
}

export interface MarketReportData {
  regen_price_usd: number;
  available_credits: number;
  health_score: number;
  active_goals: number;
  goals_completed_today: number;
  alerts_fired_today: number;
  period_start: string;
  period_end: string;
}

export interface ManipulationAlertData {
  batch_denom: string;
  order_ids: string[];
  z_score: number;
  evidence_summary: string;
  proposal_id?: string;
  proposal_status?: string;
}

export interface CrossChainArbitrageData {
  buy_venue: string;
  sell_venue: string;
  buy_price_usd: number;
  sell_price_usd: number;
  net_spread_pct: number;
  recommended_size_usd: number;
  bridge_path: string;
  expiry_estimate_minutes: number;
}

export interface BridgeFlowSpikeData {
  direction: "accumulation" | "distribution";
  net_regen_24h: number;
  net_usd_24h: number;
  tx_count_24h: number;
  largest_tx_amount: number;
}

export interface VenuePriceDivergenceData {
  venue_a: string;
  venue_b: string;
  price_a: number;
  price_b: number;
  divergence_pct: number;
}

export interface LiquidityMigrationData {
  from_venue: string;
  to_venue: string;
  liquidity_change_pct: number;
  current_liquidity_usd: number;
}

export interface HydxEpochTransitionData {
  current_epoch: number;
  hours_until_flip: number;
  votes_toward_regen: number;
  vote_trend: string;
  vote_change_pct: number;
  combined_apr_pct: number;
  action: string;
}

export interface EmissionShiftData {
  votes_previous: number;
  votes_current: number;
  change_pct: number;
  direction: string;
  incentive_apr_pct: number;
}

export interface LpIncentiveSpikeData {
  previous_apr_pct: number;
  current_apr_pct: number;
  increase_pct: number;
  tvl_usd: number;
}

export interface SentimentShiftData {
  previous_score: number;
  current_score: number;
  delta: number;
  dominant_topics: string[];
  notable_post_title?: string;
}

export interface GovernanceEventData {
  proposal_id: string;
  title: string;
  status: string;
  importance: string;
}

export interface WhaleMovementData {
  wallet_label: string;
  wallet_tier: string;
  movement_type: string;
  amount_regen: number;
  amount_usd: number;
  chain: string;
  significance: string;
}

export interface WhalePatternData {
  pattern_type: string;
  dominant_signal: string;
  confidence: number;
  affected_wallets: number;
  summary: string;
}

export type SignalData =
  | PriceAnomalyData
  | PriceMovementData
  | LiquidityWarningData
  | LowSupplyData
  | GoalCompletedData
  | CurationDegradedData
  | MarketReportData
  | ManipulationAlertData
  | CrossChainArbitrageData
  | BridgeFlowSpikeData
  | VenuePriceDivergenceData
  | LiquidityMigrationData
  | HydxEpochTransitionData
  | EmissionShiftData
  | LpIncentiveSpikeData
  | SentimentShiftData
  | GovernanceEventData
  | WhaleMovementData
  | WhalePatternData;

export interface SignalContext {
  triggered_by: "scheduled_poll" | "event_watcher" | "manual";
  workflow_id: string;
  poll_sequence: number;
  related_signal_ids: string[];
}

export interface SignalRouting {
  target_agents: AgentId[];
  broadcast_channels: BroadcastChannel[];
  ttl_seconds: number;
  priority: 1 | 2 | 3;
}

export interface MarketSignal {
  id: string;
  version: "1.0";
  source: "regen-market-monitor";
  agent_id: "AGENT-003";
  signal_type: SignalType;
  severity: "INFO" | "WARNING" | "CRITICAL";
  timestamp: string;
  data: SignalData;
  context: SignalContext;
  routing: SignalRouting;
}

/** Routing table: signal_type → target agents */
export const ROUTING_TABLE: Record<SignalType, AgentId[]> = {
  PRICE_ANOMALY: ["AGENT-001", "AGENT-002", "AGENT-004"],
  PRICE_MOVEMENT: ["AGENT-001", "AGENT-002"],
  LIQUIDITY_WARNING: ["AGENT-001", "AGENT-002"],
  LOW_SUPPLY: ["AGENT-001"],
  GOAL_COMPLETED: ["AGENT-002"],
  CURATION_DEGRADED: ["AGENT-001", "AGENT-002"],
  MARKET_REPORT: ["AGENT-001", "AGENT-002", "AGENT-004"],
  MANIPULATION_ALERT: ["AGENT-001", "AGENT-002", "AGENT-004"],
  CROSS_CHAIN_ARBITRAGE: ["AGENT-001", "AGENT-002", "AGENT-004"],
  BRIDGE_FLOW_SPIKE: ["AGENT-001", "AGENT-002", "AGENT-004"],
  VENUE_PRICE_DIVERGENCE: ["AGENT-001", "AGENT-002"],
  LIQUIDITY_MIGRATION: ["AGENT-001", "AGENT-002"],
  HYDX_EPOCH_TRANSITION: ["AGENT-001", "AGENT-002"],
  EMISSION_SHIFT: ["AGENT-001", "AGENT-002"],
  LP_INCENTIVE_SPIKE: ["AGENT-001", "AGENT-002", "AGENT-004"],
  SENTIMENT_SHIFT: ["AGENT-001", "AGENT-002"],
  GOVERNANCE_EVENT: ["AGENT-002"],
  WHALE_MOVEMENT: ["AGENT-001", "AGENT-002", "AGENT-004"],
  WHALE_PATTERN: ["AGENT-001", "AGENT-002", "AGENT-004"],
};

/** TTL values by signal_type (seconds) */
export const TTL_TABLE: Record<SignalType, number> = {
  PRICE_ANOMALY: 1800,
  PRICE_MOVEMENT: 3600,
  LIQUIDITY_WARNING: 3600,
  LOW_SUPPLY: 3600,
  GOAL_COMPLETED: 3600,
  CURATION_DEGRADED: 3600,
  MARKET_REPORT: 86400,
  MANIPULATION_ALERT: 3600,
  CROSS_CHAIN_ARBITRAGE: 1800,
  BRIDGE_FLOW_SPIKE: 3600,
  VENUE_PRICE_DIVERGENCE: 1800,
  LIQUIDITY_MIGRATION: 3600,
  HYDX_EPOCH_TRANSITION: 21600, // 6h — lasts until epoch flips
  EMISSION_SHIFT: 3600,
  LP_INCENTIVE_SPIKE: 3600,
  SENTIMENT_SHIFT: 3600,
  GOVERNANCE_EVENT: 7200,
  WHALE_MOVEMENT: 1800,
  WHALE_PATTERN: 3600,
};

export interface PublishStatus {
  success: boolean;
  latency_ms: number;
  error?: string;
}

export interface PublishResult {
  signal_id: string;
  redis: PublishStatus;
  webhook: PublishStatus;
  stored: boolean;
}
