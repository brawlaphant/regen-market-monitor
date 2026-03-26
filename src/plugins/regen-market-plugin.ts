import { McpClient } from "../mcp-client.js";
import { DataStore } from "../data-store.js";
import {
  SupplyHealthSchema,
  RegenPriceSchema,
  AvailableCreditsResultSchema,
  CommunityGoalsResultSchema,
} from "../schemas.js";
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
  MarketSnapshot,
} from "../types.js";
import type { Logger } from "../logger.js";

const MIN_Z_SCORE_POINTS = 5;

/**
 * Regen Market Plugin — implements the four AGENT-003 OODA workflows.
 *
 * Each method maps to one workflow from the agentic-tokenomics spec:
 *   WF-MM-01: detectPriceAnomaly
 *   WF-MM-02: assessLiquidity
 *   WF-MM-03: analyzeRetirements
 *   WF-MM-04: scoreCurationQuality
 *
 * All MCP responses are validated through Zod schemas (#1).
 * Independent MCP calls use Promise.all (#7).
 * Price history persists to disk (#4).
 */
export class RegenMarketPlugin {
  private mcp: McpClient;
  private logger: Logger;
  private store: DataStore;
  private priceHistory: PriceSnapshot[];
  private readonly MAX_HISTORY = 24;

  /** Last raw MCP results for market snapshot */
  public lastPrice: RegenPrice | null = null;
  public lastSupplyHealth: SupplyHealth | null = null;
  public lastCredits: AvailableCreditsResult | null = null;
  public lastGoals: CommunityGoalsResult | null = null;

  constructor(mcpClient: McpClient, store: DataStore, logger: Logger) {
    this.mcp = mcpClient;
    this.store = store;
    this.logger = logger;
    this.priceHistory = store.loadPriceHistory();
    this.logger.info(
      { loaded_points: this.priceHistory.length },
      "Price history loaded from disk"
    );
  }

  /** Persist current price history to disk */
  flushPriceHistory(): void {
    this.store.savePriceHistory(this.priceHistory);
  }

  // ─── WF-MM-01: Price Anomaly Detection ────────────────────────────

  async detectPriceAnomaly(): Promise<AnomalyReport> {
    const start = Date.now();
    this.logger.info("WF-MM-01: Detecting price anomalies");

    // OBSERVE — parallel MCP calls (#7)
    const [priceRes, creditsRes] = await Promise.all([
      this.mcp.callTool("get_regen_price"),
      this.mcp.callTool("browse_available_credits"),
    ]);

    // VALIDATE (#1)
    const priceResult = McpClient.parseAndValidate(priceRes, RegenPriceSchema);
    if (!priceResult.success) {
      this.logger.error(
        { workflow: "WF-MM-01", tool: "get_regen_price", error: priceResult.error, raw: priceResult.raw },
        "Schema validation failed"
      );
      throw new Error(`get_regen_price validation failed: ${priceResult.error}`);
    }
    // Validate credits too but don't block anomaly detection if it fails
    const creditsResult = McpClient.parseAndValidate(creditsRes, AvailableCreditsResultSchema);
    if (!creditsResult.success) {
      this.logger.warn(
        { workflow: "WF-MM-01", tool: "browse_available_credits", error: creditsResult.error, raw: creditsResult.raw },
        "Credits schema validation failed (non-blocking for price anomaly)"
      );
    } else {
      this.lastCredits = creditsResult.data;
    }

    const price = priceResult.data;
    this.lastPrice = price;

    // Record snapshot and persist (#4)
    const snapshot: PriceSnapshot = {
      price_usd: price.price_usd,
      timestamp: new Date().toISOString(),
    };
    this.priceHistory.push(snapshot);
    if (this.priceHistory.length > this.MAX_HISTORY) {
      this.priceHistory.shift();
    }
    this.store.savePriceHistory(this.priceHistory);

    const prices = this.priceHistory.map((s) => s.price_usd);

    // ORIENT — z-score vs rolling median (#4: min 5 data points)
    let zScore: number;
    let status: AnomalyReport["status"];

    if (prices.length < MIN_Z_SCORE_POINTS) {
      // Fall back to percentage-change comparison
      zScore = 0;
      status = "insufficient_data";
      this.logger.info(
        { data_points: prices.length, min_required: MIN_Z_SCORE_POINTS },
        "Insufficient data for z-score, using percentage-change fallback"
      );
    } else {
      const median = computeMedian(prices);
      const stdDev = computeStdDev(prices, median);
      zScore = stdDev > 0 ? Math.abs(price.price_usd - median) / stdDev : 0;

      // DECIDE
      if (zScore >= 3.5) {
        status = "flagged";
      } else if (zScore >= 2.0) {
        status = "watchlist";
      } else {
        status = "normal";
      }
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
      median_price: computeMedian(prices),
      z_score: zScore,
      status,
      price_change_pct: changePercent,
      timestamp: new Date(),
    };

    this.logger.info(
      { z_score: zScore.toFixed(2), status, price: price.price_usd, duration_ms: Date.now() - start },
      "WF-MM-01 complete"
    );

    return report;
  }

  // ─── WF-MM-02: Liquidity Monitoring ───────────────────────────────

  async assessLiquidity(): Promise<LiquidityReport> {
    const start = Date.now();
    this.logger.info("WF-MM-02: Assessing market liquidity");

    // OBSERVE — parallel (#7)
    const [healthRes, creditsRes] = await Promise.all([
      this.mcp.callTool("check_supply_health"),
      this.mcp.callTool("browse_available_credits"),
    ]);

    // VALIDATE (#1)
    const healthResult = McpClient.parseAndValidate(healthRes, SupplyHealthSchema);
    if (!healthResult.success) {
      this.logger.error(
        { workflow: "WF-MM-02", tool: "check_supply_health", error: healthResult.error, raw: healthResult.raw },
        "Schema validation failed"
      );
      throw new Error(`check_supply_health validation failed: ${healthResult.error}`);
    }
    const creditsResult = McpClient.parseAndValidate(creditsRes, AvailableCreditsResultSchema);
    if (!creditsResult.success) {
      this.logger.error(
        { workflow: "WF-MM-02", tool: "browse_available_credits", error: creditsResult.error, raw: creditsResult.raw },
        "Schema validation failed"
      );
      throw new Error(`browse_available_credits validation failed: ${creditsResult.error}`);
    }

    const health = healthResult.data;
    const credits = creditsResult.data;
    this.lastSupplyHealth = health;
    this.lastCredits = credits;

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
        duration_ms: Date.now() - start,
      },
      "WF-MM-02 complete"
    );

    return report;
  }

  // ─── WF-MM-03: Retirement Pattern Analysis ────────────────────────

  async analyzeRetirements(): Promise<RetirementReport> {
    const start = Date.now();
    this.logger.info("WF-MM-03: Analyzing retirement patterns");

    // OBSERVE — parallel (#7)
    const [goalsRes, healthRes] = await Promise.all([
      this.mcp.callTool("get_community_goals"),
      this.mcp.callTool("check_supply_health"),
    ]);

    // VALIDATE (#1)
    const goalsResult = McpClient.parseAndValidate(goalsRes, CommunityGoalsResultSchema);
    if (!goalsResult.success) {
      this.logger.error(
        { workflow: "WF-MM-03", tool: "get_community_goals", error: goalsResult.error, raw: goalsResult.raw },
        "Schema validation failed"
      );
      throw new Error(`get_community_goals validation failed: ${goalsResult.error}`);
    }
    const healthResult = McpClient.parseAndValidate(healthRes, SupplyHealthSchema);
    if (!healthResult.success) {
      this.logger.error(
        { workflow: "WF-MM-03", tool: "check_supply_health", error: healthResult.error, raw: healthResult.raw },
        "Schema validation failed"
      );
      throw new Error(`check_supply_health validation failed: ${healthResult.error}`);
    }

    const goalsData = goalsResult.data;
    const health = healthResult.data;
    this.lastGoals = goalsData;
    this.lastSupplyHealth = health;

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
        duration_ms: Date.now() - start,
      },
      "WF-MM-03 complete"
    );

    return report;
  }

  // ─── WF-MM-04: Curation Quality Scoring ───────────────────────────

  async scoreCurationQuality(): Promise<CurationReport> {
    const start = Date.now();
    this.logger.info("WF-MM-04: Scoring curation quality");

    // OBSERVE — parallel (#7)
    const [creditsRes, healthRes] = await Promise.all([
      this.mcp.callTool("browse_available_credits"),
      this.mcp.callTool("check_supply_health"),
    ]);

    // VALIDATE (#1)
    const creditsResult = McpClient.parseAndValidate(creditsRes, AvailableCreditsResultSchema);
    if (!creditsResult.success) {
      this.logger.error(
        { workflow: "WF-MM-04", tool: "browse_available_credits", error: creditsResult.error, raw: creditsResult.raw },
        "Schema validation failed"
      );
      throw new Error(`browse_available_credits validation failed: ${creditsResult.error}`);
    }
    const healthResult = McpClient.parseAndValidate(healthRes, SupplyHealthSchema);
    if (!healthResult.success) {
      this.logger.error(
        { workflow: "WF-MM-04", tool: "check_supply_health", error: healthResult.error, raw: healthResult.raw },
        "Schema validation failed"
      );
      throw new Error(`check_supply_health validation failed: ${healthResult.error}`);
    }

    const credits = creditsResult.data;
    const health = healthResult.data;
    this.lastCredits = credits;
    this.lastSupplyHealth = health;

    const factors: Record<string, number> = {
      supply_health: normalizeScore(health.health_score, 100),
      credit_diversity: normalizeScore(health.credit_classes.length * 50, 500),
      listing_depth: normalizeScore(credits.credits.length * 20, 1000),
      vintage_freshness: computeVintageFreshness(credits.credits),
      price_fairness: computePriceFairness(credits.credits),
    };

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

    const degradedBatches = credits.credits
      .filter((c) => computeSingleVintageFreshness(c) < 200)
      .map((c) => c.batch_denom);

    const report: CurationReport = {
      quality_score: qualityScore,
      factor_breakdown: factors,
      degraded_batches: degradedBatches,
      timestamp: new Date(),
    };

    this.logger.info(
      { quality_score: qualityScore, degraded_count: degradedBatches.length, duration_ms: Date.now() - start },
      "WF-MM-04 complete"
    );

    return report;
  }

  /** Build a MarketSnapshot from last known data */
  buildSnapshot(
    anomaly: AnomalyReport | null,
    liquidity: LiquidityReport | null,
    retirement: RetirementReport | null,
    curation: CurationReport | null,
    pollDurationMs: number
  ): MarketSnapshot {
    return {
      price: this.lastPrice ?? undefined,
      supplyHealth: this.lastSupplyHealth ?? undefined,
      credits: this.lastCredits ?? undefined,
      communityGoals: this.lastGoals ?? undefined,
      anomaly: anomaly ?? undefined,
      liquidity: liquidity ?? undefined,
      retirement: retirement ?? undefined,
      curation: curation ?? undefined,
      lastPollAt: new Date().toISOString(),
      pollDurationMs,
    };
  }
}

// ─── Pure helpers (no class state) ──────────────────────────────────

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function computeStdDev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

function normalizeScore(value: number, maxExpected: number): number {
  return Math.min(1000, Math.round((value / maxExpected) * 1000));
}

function computeVintageFreshness(credits: AvailableCredit[]): number {
  if (credits.length === 0) return 500;
  const scores = credits.map((c) => computeSingleVintageFreshness(c));
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function computeSingleVintageFreshness(credit: AvailableCredit): number {
  if (!credit.vintage_start) return 500;
  const vintageDate = new Date(credit.vintage_start);
  const ageMs = Date.now() - vintageDate.getTime();
  const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
  const freshness = Math.max(0, 1 - ageYears / 10);
  return Math.round(freshness * 1000);
}

function computePriceFairness(credits: AvailableCredit[]): number {
  const priced = credits.filter(
    (c) => c.ask_price_usd !== undefined && c.ask_price_usd > 0
  );
  if (priced.length < 2) return 700;
  const prices = priced.map((c) => c.ask_price_usd!);
  const median = computeMedian(prices);
  if (median === 0) return 700;
  const avgDeviation =
    prices.reduce((sum, p) => sum + Math.abs(p - median) / median, 0) /
    prices.length;
  const fairness = Math.max(0, 1 - avgDeviation * 2);
  return Math.round(fairness * 1000);
}
