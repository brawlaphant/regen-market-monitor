import { McpClient } from "../mcp-client.js";
import type {
  SupplyHealth,
  RegenPrice,
  AvailableCreditsResult,
  CommunityGoalsResult,
  PriceSnapshot,
  AnomalyReport,
  LiquidityReport,
  RetirementReport,
  CurationReport,
  AvailableCredit,
} from "../types.js";
import type { Logger } from "../logger.js";

/**
 * Regen Market Plugin — implements the four AGENT-003 OODA workflows.
 *
 * Each method maps to one workflow from the agentic-tokenomics spec:
 *   WF-MM-01: detectPriceAnomaly
 *   WF-MM-02: assessLiquidity
 *   WF-MM-03: analyzeRetirements
 *   WF-MM-04: scoreCurationQuality
 */
export class RegenMarketPlugin {
  private mcp: McpClient;
  private logger: Logger;
  private priceHistory: PriceSnapshot[] = [];
  private readonly MAX_HISTORY = 168; // 7 days at hourly polls

  constructor(mcpClient: McpClient, logger: Logger) {
    this.mcp = mcpClient;
    this.logger = logger;
  }

  // ─── WF-MM-01: Price Anomaly Detection ────────────────────────────
  //
  // Trigger: SellOrderCreated / SellOrderFilled / scheduled
  // Observe: get_regen_price + browse_available_credits
  // Orient:  z-score vs rolling median
  // Decide:  <2.0 normal, 2.0–3.5 watchlist, ≥3.5 flagged
  // Act:     return report for alert manager

  async detectPriceAnomaly(): Promise<AnomalyReport> {
    this.logger.info("WF-MM-01: Detecting price anomalies");

    // OBSERVE
    const [priceRes, creditsRes] = await Promise.all([
      this.mcp.callTool("get_regen_price"),
      this.mcp.callTool("browse_available_credits"),
    ]);

    const price = McpClient.parseJson<RegenPrice>(priceRes);
    const credits = McpClient.parseJson<AvailableCreditsResult>(creditsRes);

    // Record snapshot
    const snapshot: PriceSnapshot = {
      price_usd: price.price_usd,
      timestamp: new Date(),
    };
    this.priceHistory.push(snapshot);
    if (this.priceHistory.length > this.MAX_HISTORY) {
      this.priceHistory.shift();
    }

    // ORIENT — z-score against rolling median
    const median = this.computeMedian(
      this.priceHistory.map((s) => s.price_usd)
    );
    const stdDev = this.computeStdDev(
      this.priceHistory.map((s) => s.price_usd),
      median
    );
    const zScore = stdDev > 0 ? Math.abs(price.price_usd - median) / stdDev : 0;

    // DECIDE
    let status: "normal" | "watchlist" | "flagged";
    if (zScore >= 3.5) {
      status = "flagged";
    } else if (zScore >= 2.0) {
      status = "watchlist";
    } else {
      status = "normal";
    }

    const previousPrice =
      this.priceHistory.length > 1
        ? this.priceHistory[this.priceHistory.length - 2].price_usd
        : price.price_usd;
    const changePercent =
      previousPrice > 0
        ? (price.price_usd - previousPrice) / previousPrice
        : 0;

    const report: AnomalyReport = {
      current_price: price.price_usd,
      median_price: median,
      z_score: zScore,
      status,
      price_change_pct: changePercent,
      timestamp: new Date(),
    };

    this.logger.info(
      { z_score: zScore.toFixed(2), status, price: price.price_usd },
      "WF-MM-01 complete"
    );

    return report;
  }

  // ─── WF-MM-02: Liquidity Monitoring ───────────────────────────────
  //
  // Trigger: Every 1 hour or significant trade (>$10k)
  // Observe: check_supply_health + browse_available_credits
  // Orient:  listed value, spread, depth, health score
  // Decide:  generate report with health assessment
  // Act:     return report for alert manager

  async assessLiquidity(): Promise<LiquidityReport> {
    this.logger.info("WF-MM-02: Assessing market liquidity");

    // OBSERVE
    const [healthRes, creditsRes] = await Promise.all([
      this.mcp.callTool("check_supply_health"),
      this.mcp.callTool("browse_available_credits"),
    ]);

    const health = McpClient.parseJson<SupplyHealth>(healthRes);
    const credits = McpClient.parseJson<AvailableCreditsResult>(creditsRes);

    // ORIENT + DECIDE
    const report: LiquidityReport = {
      listed_value_usd: credits.total_listed_value_usd,
      total_tradable: credits.total_tradable,
      health_score: health.health_score,
      available_credits: health.available_credits,
      credit_class_count: health.credit_classes.length,
      timestamp: new Date(),
    };

    this.logger.info(
      {
        health_score: report.health_score,
        available: report.available_credits,
        listed_value: report.listed_value_usd,
      },
      "WF-MM-02 complete"
    );

    return report;
  }

  // ─── WF-MM-03: Retirement Pattern Analysis ────────────────────────
  //
  // Trigger: MsgRetire event / daily scheduled
  // Observe: get_community_goals
  // Orient:  retirement metrics, demand signals
  // Decide:  update demand index
  // Act:     return report for alert manager

  async analyzeRetirements(): Promise<RetirementReport> {
    this.logger.info("WF-MM-03: Analyzing retirement patterns");

    // OBSERVE
    const [goalsRes, healthRes] = await Promise.all([
      this.mcp.callTool("get_community_goals"),
      this.mcp.callTool("check_supply_health"),
    ]);

    const goalsData = McpClient.parseJson<CommunityGoalsResult>(goalsRes);
    const health = McpClient.parseJson<SupplyHealth>(healthRes);

    // ORIENT — extract demand signals
    const goals = goalsData.goals || [];
    const completedGoals = goals.filter((g) => g.percent_complete >= 100);
    const avgCompletion =
      goals.length > 0
        ? goals.reduce((sum, g) => sum + g.percent_complete, 0) / goals.length
        : 0;

    let demandSignal: "low" | "moderate" | "high";
    if (avgCompletion >= 75 || completedGoals.length >= 2) {
      demandSignal = "high";
    } else if (avgCompletion >= 40 || completedGoals.length >= 1) {
      demandSignal = "moderate";
    } else {
      demandSignal = "low";
    }

    const report: RetirementReport = {
      goals,
      completed_goals: completedGoals,
      total_retired: health.retired_credits,
      demand_signal: demandSignal,
      timestamp: new Date(),
    };

    this.logger.info(
      {
        demand_signal: demandSignal,
        completed_goals: completedGoals.length,
        total_retired: health.retired_credits,
      },
      "WF-MM-03 complete"
    );

    return report;
  }

  // ─── WF-MM-04: Curation Quality Scoring ───────────────────────────
  //
  // Trigger: SellOrderCreated / daily refresh
  // Observe: browse_available_credits + check_supply_health
  // Orient:  weighted quality factors → score 0–1000
  // Decide:  flag degradation if score < collection floor
  // Act:     return report for alert manager

  async scoreCurationQuality(): Promise<CurationReport> {
    this.logger.info("WF-MM-04: Scoring curation quality");

    // OBSERVE
    const [creditsRes, healthRes] = await Promise.all([
      this.mcp.callTool("browse_available_credits"),
      this.mcp.callTool("check_supply_health"),
    ]);

    const credits = McpClient.parseJson<AvailableCreditsResult>(creditsRes);
    const health = McpClient.parseJson<SupplyHealth>(healthRes);

    // ORIENT — compute weighted quality factors
    const factors: Record<string, number> = {
      supply_health: this.normalizeScore(health.health_score, 100),
      credit_diversity: this.normalizeScore(
        health.credit_classes.length * 50,
        500
      ),
      listing_depth: this.normalizeScore(credits.credits.length * 20, 1000),
      vintage_freshness: this.computeVintageFreshness(credits.credits),
      price_fairness: this.computePriceFairness(credits.credits),
    };

    // Weighted combination (weights from spec factors)
    const weights: Record<string, number> = {
      supply_health: 0.25,
      credit_diversity: 0.15,
      listing_depth: 0.20,
      vintage_freshness: 0.20,
      price_fairness: 0.20,
    };

    let qualityScore = 0;
    for (const [key, weight] of Object.entries(weights)) {
      qualityScore += (factors[key] || 0) * weight;
    }
    qualityScore = Math.round(qualityScore);

    // DECIDE — flag degraded batches
    const degradedBatches = credits.credits
      .filter((c) => {
        const freshness = this.computeSingleVintageFreshness(c);
        return freshness < 200; // low freshness threshold
      })
      .map((c) => c.batch_denom);

    const report: CurationReport = {
      quality_score: qualityScore,
      factor_breakdown: factors,
      degraded_batches: degradedBatches,
      timestamp: new Date(),
    };

    this.logger.info(
      { quality_score: qualityScore, degraded_count: degradedBatches.length },
      "WF-MM-04 complete"
    );

    return report;
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private computeMedian(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  private computeStdDev(values: number[], mean: number): number {
    if (values.length < 2) return 0;
    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
      (values.length - 1);
    return Math.sqrt(variance);
  }

  /** Normalize a raw value to 0–1000 scale */
  private normalizeScore(value: number, maxExpected: number): number {
    return Math.min(1000, Math.round((value / maxExpected) * 1000));
  }

  /** Average vintage freshness across all credits (0–1000 scale, 10-year window) */
  private computeVintageFreshness(credits: AvailableCredit[]): number {
    if (credits.length === 0) return 500;
    const scores = credits.map((c) => this.computeSingleVintageFreshness(c));
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }

  /** Single credit vintage freshness: linear decay over 10-year window */
  private computeSingleVintageFreshness(credit: AvailableCredit): number {
    if (!credit.vintage_start) return 500;
    const vintageDate = new Date(credit.vintage_start);
    const ageMs = Date.now() - vintageDate.getTime();
    const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
    const TEN_YEARS = 10;
    const freshness = Math.max(0, 1 - ageYears / TEN_YEARS);
    return Math.round(freshness * 1000);
  }

  /** Price fairness: how tight are prices within each class (0–1000) */
  private computePriceFairness(credits: AvailableCredit[]): number {
    const priced = credits.filter(
      (c) => c.ask_price_usd !== undefined && c.ask_price_usd > 0
    );
    if (priced.length < 2) return 700; // not enough data, assume fair

    const prices = priced.map((c) => c.ask_price_usd!);
    const median = this.computeMedian(prices);
    if (median === 0) return 700;

    // Average absolute deviation from median as fraction
    const avgDeviation =
      prices.reduce((sum, p) => sum + Math.abs(p - median) / median, 0) /
      prices.length;

    // Low deviation = high fairness
    const fairness = Math.max(0, 1 - avgDeviation * 2);
    return Math.round(fairness * 1000);
  }
}
