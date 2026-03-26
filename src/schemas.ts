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
