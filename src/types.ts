/** Severity levels for market alerts */
export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

/** A market alert emitted by the monitoring system */
export interface MarketAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

/** Result from the regen-compute check_supply_health MCP tool */
export interface SupplyHealth {
  available_credits: number;
  total_supply: number;
  retired_credits: number;
  health_score: number;
  credit_classes: CreditClassHealth[];
}

export interface CreditClassHealth {
  class_id: string;
  class_name: string;
  available: number;
  retired: number;
  health: string;
}

/** Result from the regen-compute get_regen_price MCP tool */
export interface RegenPrice {
  price_usd: number;
  change_24h: number;
  volume_24h: number;
  market_cap: number;
  timestamp: string;
}

/** A single credit batch from browse_available_credits */
export interface AvailableCredit {
  batch_denom: string;
  class_id: string;
  project_id: string;
  tradable_amount: number;
  retired_amount: number;
  ask_price_usd?: number;
  vintage_start?: string;
  vintage_end?: string;
  metadata_uri?: string;
}

/** Result from browse_available_credits */
export interface AvailableCreditsResult {
  credits: AvailableCredit[];
  total_listed_value_usd: number;
  total_tradable: number;
}

/** A single community goal from get_community_goals */
export interface CommunityGoal {
  id: string;
  name: string;
  target: number;
  current: number;
  percent_complete: number;
  credit_class?: string;
  deadline?: string;
}

/** Result from get_community_goals */
export interface CommunityGoalsResult {
  goals: CommunityGoal[];
}

/** Price snapshot for rolling history */
export interface PriceSnapshot {
  price_usd: number;
  timestamp: Date;
}

/** Liquidity assessment output */
export interface LiquidityReport {
  listed_value_usd: number;
  total_tradable: number;
  health_score: number;
  available_credits: number;
  credit_class_count: number;
  timestamp: Date;
}

/** Price anomaly detection output */
export interface AnomalyReport {
  current_price: number;
  median_price: number;
  z_score: number;
  status: "normal" | "watchlist" | "flagged";
  price_change_pct: number;
  timestamp: Date;
}

/** Retirement analysis output */
export interface RetirementReport {
  goals: CommunityGoal[];
  completed_goals: CommunityGoal[];
  total_retired: number;
  demand_signal: "low" | "moderate" | "high";
  timestamp: Date;
}

/** Curation quality output */
export interface CurationReport {
  quality_score: number;
  factor_breakdown: Record<string, number>;
  degraded_batches: string[];
  timestamp: Date;
}

/** Configuration parsed from environment */
export interface Config {
  regenComputeMcpUrl: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  pollIntervalMs: number;
  lowStockThreshold: number;
  priceMoveThreshold: number;
  alertCooldownMs: number;
  logLevel: string;
}

/** MCP tool call request */
export interface McpToolCall {
  method: "tools/call";
  params: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}

/** MCP tool call response */
export interface McpToolResponse {
  content: Array<{
    type: string;
    text?: string;
  }>;
  isError?: boolean;
}
