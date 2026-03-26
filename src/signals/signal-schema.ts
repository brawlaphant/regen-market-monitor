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

export type SignalData =
  | PriceAnomalyData
  | PriceMovementData
  | LiquidityWarningData
  | LowSupplyData
  | GoalCompletedData
  | CurationDegradedData
  | MarketReportData
  | ManipulationAlertData;

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
