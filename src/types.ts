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
  /** Delta from last poll for the primary metric */
  delta?: string;
  /** Trend indicator over last 3 polls (e.g. "↑↑↓") */
  trend?: string;
  /** Link to Regen Network explorer */
  explorerUrl?: string;
  /** Minutes until next check */
  nextCheckMinutes?: number;
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

/** Price snapshot for rolling history — serializable to JSON */
export interface PriceSnapshot {
  price_usd: number;
  timestamp: string; // ISO string for JSON persistence
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
  status: "normal" | "watchlist" | "flagged" | "insufficient_data";
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
  port: number;
  dailyDigestHourUtc: number;
  dataDir: string;
  mcpTimeoutMs: number;
  mcpRetryAttempts: number;
}

/** MCP tool call response */
export interface McpToolResponse {
  content: Array<{
    type: string;
    text?: string;
  }>;
  isError?: boolean;
}

/** Persisted alert state for deduplication across restarts */
export interface PersistedAlertState {
  lastFired: Record<string, number>; // title -> epoch ms
  alertsFiredToday: number;
  dayStart: number; // epoch ms of start of current day
}

/** Full market snapshot written after each poll */
export interface MarketSnapshot {
  price?: RegenPrice;
  supplyHealth?: SupplyHealth;
  credits?: AvailableCreditsResult;
  communityGoals?: CommunityGoalsResult;
  anomaly?: AnomalyReport;
  liquidity?: LiquidityReport;
  retirement?: RetirementReport;
  curation?: CurationReport;
  lastPollAt: string; // ISO
  pollDurationMs: number;
}

/** Health endpoint response */
export interface HealthResponse {
  status: "ok" | "degraded" | "starting";
  lastPollAt: string | null;
  nextPollAt: string | null;
  mcpReachable: boolean;
  alertsFiredToday: number;
  uptime: number;
}
