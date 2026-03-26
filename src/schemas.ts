import { z } from "zod";

// ─── MCP Response Schemas ───────────────────────────────────────────

export const CreditClassHealthSchema = z.object({
  class_id: z.string(),
  class_name: z.string(),
  available: z.number(),
  retired: z.number(),
  health: z.string(),
});

export const SupplyHealthSchema = z.object({
  available_credits: z.number(),
  total_supply: z.number(),
  retired_credits: z.number(),
  health_score: z.number(),
  credit_classes: z.array(CreditClassHealthSchema),
});

export const RegenPriceSchema = z.object({
  price_usd: z.number(),
  change_24h: z.number(),
  volume_24h: z.number(),
  market_cap: z.number(),
  timestamp: z.string(),
});

export const AvailableCreditSchema = z.object({
  batch_denom: z.string(),
  class_id: z.string(),
  project_id: z.string(),
  tradable_amount: z.number(),
  retired_amount: z.number(),
  ask_price_usd: z.number().optional(),
  vintage_start: z.string().optional(),
  vintage_end: z.string().optional(),
  metadata_uri: z.string().optional(),
});

export const AvailableCreditsResultSchema = z.object({
  credits: z.array(AvailableCreditSchema),
  total_listed_value_usd: z.number(),
  total_tradable: z.number(),
});

export const CommunityGoalSchema = z.object({
  id: z.string(),
  name: z.string(),
  target: z.number(),
  current: z.number(),
  percent_complete: z.number(),
  credit_class: z.string().optional(),
  deadline: z.string().optional(),
});

export const CommunityGoalsResultSchema = z.object({
  goals: z.array(CommunityGoalSchema),
});

// ─── MarketSignal Schemas ───────────────────────────────────────────

const AgentIdSchema = z.enum(["AGENT-001", "AGENT-002", "AGENT-003", "AGENT-004"]);

const SignalTypeSchema = z.enum([
  "PRICE_ANOMALY", "PRICE_MOVEMENT", "LIQUIDITY_WARNING", "LOW_SUPPLY",
  "GOAL_COMPLETED", "CURATION_DEGRADED", "MARKET_REPORT", "MANIPULATION_ALERT",
  "CROSS_CHAIN_ARBITRAGE", "BRIDGE_FLOW_SPIKE", "VENUE_PRICE_DIVERGENCE", "LIQUIDITY_MIGRATION",
]);

const BroadcastChannelSchema = z.enum(["redis", "webhook", "rest"]);

export const PriceAnomalyDataSchema = z.object({
  batch_denom: z.string(), current_price: z.number(), z_score: z.number(),
  mean_price: z.number(), std_dev: z.number(), window_size: z.number(),
  anomaly_level: z.enum(["warning", "critical"]),
});

export const PriceMovementDataSchema = z.object({
  current_price: z.number(), previous_price: z.number(), change_pct: z.number(),
  direction: z.enum(["up", "down"]), threshold_pct: z.number(),
});

export const LiquidityWarningDataSchema = z.object({
  health_score: z.number(), available_credits: z.number(), listed_value_usd: z.number(),
  previous_health_score: z.number(), degradation_pct: z.number(),
});

export const LowSupplyDataSchema = z.object({
  available_credits: z.number(), threshold: z.number(), deficit: z.number(),
  batch_denom: z.string().optional(),
});

export const GoalCompletedDataSchema = z.object({
  goal_id: z.string(), goal_name: z.string(), target: z.number(),
  final_value: z.number(), completed_at: z.string(),
});

export const CurationDegradedDataSchema = z.object({
  batch_denom: z.string(), current_score: z.number(), previous_score: z.number(),
  delta: z.number(), factors_changed: z.array(z.string()),
});

export const MarketReportDataSchema = z.object({
  regen_price_usd: z.number(), available_credits: z.number(), health_score: z.number(),
  active_goals: z.number(), goals_completed_today: z.number(), alerts_fired_today: z.number(),
  period_start: z.string(), period_end: z.string(),
});

export const ManipulationAlertDataSchema = z.object({
  batch_denom: z.string(), order_ids: z.array(z.string()), z_score: z.number(),
  evidence_summary: z.string(), proposal_id: z.string().optional(),
  proposal_status: z.string().optional(),
});

export const CrossChainArbitrageDataSchema = z.object({
  buy_venue: z.string(), sell_venue: z.string(),
  buy_price_usd: z.number(), sell_price_usd: z.number(),
  net_spread_pct: z.number(), recommended_size_usd: z.number(),
  bridge_path: z.string(), expiry_estimate_minutes: z.number(),
});

export const BridgeFlowSpikeDataSchema = z.object({
  direction: z.enum(["accumulation", "distribution"]),
  net_regen_24h: z.number(), net_usd_24h: z.number(),
  tx_count_24h: z.number(), largest_tx_amount: z.number(),
});

export const VenuePriceDivergenceDataSchema = z.object({
  venue_a: z.string(), venue_b: z.string(),
  price_a: z.number(), price_b: z.number(), divergence_pct: z.number(),
});

export const LiquidityMigrationDataSchema = z.object({
  from_venue: z.string(), to_venue: z.string(),
  liquidity_change_pct: z.number(), current_liquidity_usd: z.number(),
});

const SignalDataSchema = z.union([
  PriceAnomalyDataSchema, PriceMovementDataSchema, LiquidityWarningDataSchema,
  LowSupplyDataSchema, GoalCompletedDataSchema, CurationDegradedDataSchema,
  MarketReportDataSchema, ManipulationAlertDataSchema,
  CrossChainArbitrageDataSchema, BridgeFlowSpikeDataSchema,
  VenuePriceDivergenceDataSchema, LiquidityMigrationDataSchema,
]);

const SignalContextSchema = z.object({
  triggered_by: z.enum(["scheduled_poll", "event_watcher", "manual"]),
  workflow_id: z.string(),
  poll_sequence: z.number(),
  related_signal_ids: z.array(z.string()),
});

const SignalRoutingSchema = z.object({
  target_agents: z.array(AgentIdSchema),
  broadcast_channels: z.array(BroadcastChannelSchema),
  ttl_seconds: z.number(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export const MarketSignalSchema = z.object({
  id: z.string(),
  version: z.literal("1.0"),
  source: z.literal("regen-market-monitor"),
  agent_id: z.literal("AGENT-003"),
  signal_type: SignalTypeSchema,
  severity: z.enum(["INFO", "WARNING", "CRITICAL"]),
  timestamp: z.string(),
  data: SignalDataSchema,
  context: SignalContextSchema,
  routing: SignalRoutingSchema,
});

// ─── LCD Response Schemas ───────────────────────────────────────────

export const LCDSellOrderSchema = z.object({
  id: z.string(),
  seller: z.string(),
  batch_denom: z.string(),
  quantity: z.string(),
  ask_denom: z.string(),
  ask_amount: z.string(),
  disable_auto_retire: z.boolean(),
  expiration: z.string().optional(),
});

export const LCDSellOrdersResponseSchema = z.object({
  sell_orders: z.array(LCDSellOrderSchema),
  pagination: z.object({
    next_key: z.string().nullable().optional(),
    total: z.string().optional(),
  }).optional(),
});

export const LCDBatchSchema = z.object({
  batch_denom: z.string(),
  issuer: z.string(),
  project_id: z.string(),
  class_id: z.string(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  open: z.boolean(),
});

export const LCDBatchesResponseSchema = z.object({
  batches: z.array(LCDBatchSchema),
  pagination: z.object({
    next_key: z.string().nullable().optional(),
    total: z.string().optional(),
  }).optional(),
});

export const LCDRetirementSchema = z.object({
  owner: z.string(),
  batch_denom: z.string(),
  amount: z.string(),
  jurisdiction: z.string(),
});

export const LCDRetirementsResponseSchema = z.object({
  retirements: z.array(LCDRetirementSchema),
  pagination: z.object({
    next_key: z.string().nullable().optional(),
    total: z.string().optional(),
  }).optional(),
});

export const LCDAllowedDenomSchema = z.object({
  bank_denom: z.string(),
  display_denom: z.string(),
  exponent: z.number(),
});

export const LCDAllowedDenomsResponseSchema = z.object({
  allowed_denoms: z.array(LCDAllowedDenomSchema),
  pagination: z.object({
    next_key: z.string().nullable().optional(),
    total: z.string().optional(),
  }).optional(),
});

export const LCDVotingParamsResponseSchema = z.object({
  params: z.object({
    voting_period: z.string(),
  }),
});

export const LCDLatestBlockResponseSchema = z.object({
  block: z.object({
    header: z.object({
      height: z.string(),
    }),
  }),
});
