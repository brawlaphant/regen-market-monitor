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
  delta?: string;
  trend?: string;
  explorerUrl?: string;
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
  timestamp: string;
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
  // Chain config
  regenLcdUrl: string;
  regenRpcUrl: string;
  regenMnemonic?: string;
  regenChainId: string;
  regenGasPrice: string;
  gasMultiplier: number;
  eventPollIntervalMs: number;
  largeTradeThresholdUsd: number;
  proposalExpiryMs: number;
  telegramAdminChatId?: string;
  // Cross-chain intelligence
  osmosisLcdUrl: string;
  axelarApiUrl: string;
  baseRpcUrl: string;
  celoRpcUrl: string;
  coingeckoCacheTtlMs: number;
  arbitDetectionThreshold: number;
  arbitMinProfitPct: number;
  flowAccumulationThreshold: number;
  flowDistributionThreshold: number;
  crossChainTimeoutMs: number;
  venueDiscoveryTtlDays: number;
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
  lastFired: Record<string, number>;
  alertsFiredToday: number;
  dayStart: number;
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
  lastPollAt: string;
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

// ─── Chain / On-Chain Action Layer Types ─────────────────────────────

/** LCD sell order from /regen/ecocredit/marketplace/v1/sell-orders */
export interface LCDSellOrder {
  id: string;
  seller: string;
  batch_denom: string;
  quantity: string;
  ask_denom: string;
  ask_amount: string;
  disable_auto_retire: boolean;
  expiration?: string;
}

/** LCD credit batch from /regen/ecocredit/v1/batches */
export interface LCDBatch {
  batch_denom: string;
  issuer: string;
  project_id: string;
  class_id: string;
  start_date?: string;
  end_date?: string;
  open: boolean;
}

/** LCD retirement record */
export interface LCDRetirement {
  owner: string;
  batch_denom: string;
  amount: string;
  jurisdiction: string;
}

/** LCD allowed denom from marketplace */
export interface LCDAllowedDenom {
  bank_denom: string;
  display_denom: string;
  exponent: number;
}

/** LCD governance voting params */
export interface LCDVotingParams {
  voting_period: string;
}

/** Persisted event cursor */
export interface EventCursor {
  lastSellOrderId: string;
  lastRetirementHeight: string;
  lastPollTimestamp: string;
}

/** Event types emitted by EventWatcher */
export type ChainEventType = "new_sell_order" | "new_retirement" | "large_trade";

export interface ChainEvent {
  type: ChainEventType;
  blockHeight: string;
  data: Record<string, unknown>;
}

/** Evidence collected during anomaly detection */
export interface AnomalyEvidence {
  currentPrice: number;
  medianPrice: number;
  zScore: number;
  priceHistory: PriceSnapshot[];
  detectedAt: string;
}

/** A freeze proposal awaiting human approval */
export interface FreezeProposal {
  id: string;
  title: string;
  summary: string;
  evidence: AnomalyEvidence;
  affectedSellOrderIds: string[];
  batchDenom: string;
  zScore: number;
  deposit: { denom: string; amount: string };
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "rejected" | "expired" | "submitted" | "failed";
  rejectionReason?: string;
  txHash?: string;
}

/** Result from proposal validation */
export interface ValidationResult {
  valid: boolean;
  reasons: string[];
  confidence: number;
}

/** Result from on-chain proposal submission */
export interface SubmissionResult {
  success: boolean;
  txHash?: string;
  blockHeight?: number;
  gasUsed?: number;
  error?: string;
}

/** Result from dry-run simulation */
export interface DryRunResult {
  success: boolean;
  estimatedGas?: number;
  estimatedFee?: string;
  error?: string;
}

/** Audit log entry for proposal lifecycle */
export interface AuditEntry {
  timestamp: string;
  event: AuditEvent;
  proposalId: string;
  actorType: "agent" | "human";
  data: Record<string, unknown>;
  version: "1.0";
}

export type AuditEvent =
  | "proposal_created"
  | "proposal_validated"
  | "approval_requested"
  | "approved"
  | "rejected"
  | "expired"
  | "submitted"
  | "submission_failed"
  | "dry_run_completed";
