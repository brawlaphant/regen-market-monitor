import type { HydrexVenueData } from "../chain/venues/hydrex-client.js";
import type { TradingSignal } from "../signals/trading-signal.js";
import type { LPPosition } from "./lp-position-tracker.js";
import type { Logger } from "../logger.js";

export interface LPDecision {
  action: "add" | "remove" | "hold" | "rebalance";
  reason: string;
  urgency: "immediate" | "next_poll" | "watch";
  amount_regen?: number;
  amount_weth_usd?: number;
}

/**
 * Decides whether to add or remove LP from Hydrex WETH/REGEN pool.
 * LP_ENABLED must be true (default false) — explicit opt-in.
 */
export class LPDecisionEngine {
  private enabled: boolean;
  private maxPositionUsd: number;
  private minAprPct: number;
  private minHoursToEpoch: number;
  private maxIlPct: number;
  private minNetPositionPct: number;
  private priceRangePct: number;
  private minRegenAmount: number;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.enabled = process.env.LP_ENABLED === "true";
    this.maxPositionUsd = parseFloat(process.env.LP_MAX_POSITION_USD || "200");
    this.minAprPct = parseFloat(process.env.LP_MIN_APR_PCT || "200");
    this.minHoursToEpoch = parseFloat(process.env.LP_MIN_HOURS_TO_EPOCH || "12");
    this.maxIlPct = parseFloat(process.env.LP_MAX_IL_PCT || "15");
    this.minNetPositionPct = parseFloat(process.env.LP_MIN_NET_POSITION_PCT || "-5");
    this.priceRangePct = parseFloat(process.env.LP_PRICE_RANGE_PCT || "20");
    this.minRegenAmount = parseFloat(process.env.LP_MIN_REGEN_AMOUNT || "1000");

    if (!this.enabled) this.logger.info("LP management disabled (LP_ENABLED=false)");
  }

  get isEnabled(): boolean { return this.enabled; }

  shouldAddLP(hydrexData: HydrexVenueData | null, signal: TradingSignal, currentPosition: LPPosition | null): LPDecision {
    if (!this.enabled || !hydrexData) return { action: "hold", reason: "LP disabled or no Hydrex data", urgency: "watch" };

    // 1. Position limit check
    if (currentPosition && currentPosition.total_value_usd >= this.maxPositionUsd) {
      return { action: "hold", reason: `Position at max ($${currentPosition.total_value_usd}/$${this.maxPositionUsd})`, urgency: "watch" };
    }

    // 2. APR check
    if (hydrexData.combined_apr_pct < this.minAprPct) {
      return { action: "hold", reason: `APR ${hydrexData.combined_apr_pct}% below minimum ${this.minAprPct}%`, urgency: "watch" };
    }

    // 3. Vote trend check
    if (hydrexData.vote_trend === "decreasing") {
      return { action: "hold", reason: "Vote trend decreasing — incentives at risk", urgency: "watch" };
    }

    // 4. Epoch timing
    if (hydrexData.epoch_info.hours_until_flip < this.minHoursToEpoch) {
      return { action: "hold", reason: `Only ${hydrexData.epoch_info.hours_until_flip}h to epoch flip — wait`, urgency: "watch" };
    }

    // 5. Signal direction check
    if (signal.direction === "short" || signal.signal_class === "EXIT") {
      return { action: "hold", reason: "Bearish signal — don't LP into weakness", urgency: "watch" };
    }

    // 6. Price range check on re-entry
    if (currentPosition && currentPosition.entry_regen_price_usd > 0) {
      const drift = Math.abs(hydrexData.price_usd - currentPosition.entry_regen_price_usd) / currentPosition.entry_regen_price_usd * 100;
      if (drift > this.priceRangePct) {
        return { action: "hold", reason: `Price drifted ${drift.toFixed(1)}% from entry — review IL before re-entering`, urgency: "watch" };
      }
    }

    // All conditions pass — recommend adding LP
    const amountUsd = Math.min(this.maxPositionUsd - (currentPosition?.total_value_usd || 0), this.maxPositionUsd / 2);
    return {
      action: "add",
      reason: `APR ${hydrexData.combined_apr_pct}%, votes ${hydrexData.vote_trend}, ${hydrexData.epoch_info.hours_until_flip}h to epoch`,
      urgency: "next_poll",
      amount_regen: amountUsd / (hydrexData.price_usd || 0.04) / 2,
      amount_weth_usd: amountUsd / 2,
    };
  }

  shouldRemoveLP(position: LPPosition | null, hydrexData: HydrexVenueData | null, signal: TradingSignal): LPDecision {
    if (!position || !this.enabled) return { action: "hold", reason: "No position or LP disabled", urgency: "watch" };

    // 1. IL exceeds max
    if (Math.abs(position.impermanent_loss_pct) > this.maxIlPct) {
      return { action: "remove", reason: `IL ${position.impermanent_loss_pct.toFixed(1)}% exceeds max ${this.maxIlPct}%`, urgency: "immediate" };
    }

    // 2. APR collapsed
    if (hydrexData && hydrexData.combined_apr_pct < this.minAprPct * 0.5) {
      return { action: "remove", reason: `APR collapsed to ${hydrexData.combined_apr_pct}%`, urgency: "next_poll" };
    }

    // 3. Vote trend + epoch imminent
    if (hydrexData && hydrexData.vote_trend === "decreasing" && hydrexData.epoch_info.hours_until_flip < 24) {
      return { action: "remove", reason: "Votes decreasing with epoch < 24h — incentives will drop", urgency: "next_poll" };
    }

    // 4. Bearish signal
    if (signal.direction === "short" || signal.signal_class === "EXIT") {
      return { action: "remove", reason: `${signal.signal_class} signal — exit LP`, urgency: "immediate" };
    }

    // 5. MANIPULATION_ALERT — check via signal rationale
    if (signal.rationale.some(r => r.includes("MANIPULATION"))) {
      return { action: "remove", reason: "MANIPULATION_ALERT active", urgency: "immediate" };
    }

    // 6. TVL crash
    if (hydrexData && hydrexData.tvl_usd < parseFloat(process.env.ACCUMULATION_MIN_TVL_USD || "10000") * 0.6) {
      return { action: "remove", reason: `TVL dropped to $${hydrexData.tvl_usd} — liquidity crisis`, urgency: "immediate" };
    }

    // 7. Net position too negative
    if (position.net_position_pct < this.minNetPositionPct) {
      return { action: "remove", reason: `Net position ${position.net_position_pct}% below min ${this.minNetPositionPct}%`, urgency: "next_poll" };
    }

    return { action: "hold", reason: "Position healthy", urgency: "watch" };
  }
}
