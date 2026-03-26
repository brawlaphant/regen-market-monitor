import { z } from "zod";

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

const SignalDataSchema = z.union([
  PriceAnomalyDataSchema, PriceMovementDataSchema, LiquidityWarningDataSchema,
  LowSupplyDataSchema, GoalCompletedDataSchema, CurationDegradedDataSchema,
  MarketReportDataSchema, ManipulationAlertDataSchema,
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
