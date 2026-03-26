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
