import type {
  AlertSeverity,
  MarketAlert,
  Config,
  AnomalyReport,
  LiquidityReport,
  RetirementReport,
  CurationReport,
  PersistedAlertState,
  PriceSnapshot,
} from "./types.js";
import { DataStore } from "./data-store.js";
import type { Logger } from "./logger.js";
import type { MarketSignal, SignalType, SignalData, BroadcastChannel } from "./signals/signal-schema.js";
import { buildSignal } from "./signals/signal-factory.js";

/**
 * Alert manager with threshold checks, deduplication, and persistent state.
 * Cooldowns survive restarts via data/alert-state.json (#5).
 * Tracks alerts fired today for health endpoint and daily digest.
 */
export class AlertManager {
  private config: Config;
  private logger: Logger;
  private store: DataStore;
  private state: PersistedAlertState;
  private listeners: Array<(alert: MarketAlert) => void | Promise<void>> = [];
  private alertCounter = 0;
  /** Recent price snapshots for trend computation */
  private recentPrices: number[] = [];
  /** Signal publishing callback — set from index.ts */
  public onSignal: ((signal: MarketSignal) => Promise<void>) | null = null;
  /** Configured broadcast channels — set from index.ts */
  public broadcastChannels: BroadcastChannel[] = ["rest"];

  constructor(config: Config, store: DataStore, logger: Logger) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.state = store.loadAlertState();
    this.logger.info(
      { persisted_cooldowns: Object.keys(this.state.lastFired).length },
      "Alert state loaded from disk"
    );
  }

  get alertsFiredToday(): number {
    return this.state.alertsFiredToday;
  }

  onAlert(listener: (alert: MarketAlert) => void | Promise<void>): void {
    this.listeners.push(listener);
  }

  /** Flush state to disk (called on shutdown) (#6) */
  flush(): void {
    this.store.saveAlertState(this.state);
  }

  /** Track a price for trend computation (#11) */
  recordPrice(price: number): void {
    this.recentPrices.push(price);
    if (this.recentPrices.length > 4) this.recentPrices.shift();
  }

  /** Compute trend indicator from last 3 price deltas */
  private computeTrend(): string {
    if (this.recentPrices.length < 2) return "";
    const arrows: string[] = [];
    for (let i = 1; i < this.recentPrices.length; i++) {
      arrows.push(this.recentPrices[i] >= this.recentPrices[i - 1] ? "\u2191" : "\u2193");
    }
    return arrows.join("");
  }

  private nextCheckMinutes(): number {
    return Math.round(this.config.pollIntervalMs / 60000);
  }

  async checkAnomaly(report: AnomalyReport, lastPrice?: number): Promise<void> {
    const trend = this.computeTrend();

    if (report.z_score >= 3.5) {
      await this.emit(
        "CRITICAL",
        "Price Manipulation Flagged",
        `Z-score ${report.z_score.toFixed(2)} exceeds manipulation threshold (3.5). ` +
          `Current price $${report.current_price.toFixed(4)}, median $${report.median_price.toFixed(4)}.`,
        { z_score: report.z_score, price: report.current_price, median: report.median_price, threshold: 3.5 },
        {
          delta: lastPrice ? `${((report.current_price - lastPrice) / lastPrice * 100).toFixed(1)}% from last poll` : undefined,
          trend,
          explorerUrl: "https://app.regen.network/ecocredits/portfolio",
        }
      );
    } else if (report.z_score >= 2.0) {
      await this.emit(
        "WARNING",
        "Price Anomaly Detected",
        `Z-score ${report.z_score.toFixed(2)} exceeds monitoring threshold (2.0). ` +
          `Added to watchlist. Price $${report.current_price.toFixed(4)}.`,
        { z_score: report.z_score, price: report.current_price, threshold: 2.0 },
        { delta: lastPrice ? `${((report.current_price - lastPrice) / lastPrice * 100).toFixed(1)}% from last poll` : undefined, trend }
      );
    }

    if (lastPrice !== undefined && lastPrice > 0) {
      const changePct = Math.abs((report.current_price - lastPrice) / lastPrice);
      if (changePct >= this.config.priceMoveThreshold) {
        const direction = report.current_price > lastPrice ? "up" : "down";
        await this.emit(
          "WARNING",
          "Significant Price Movement",
          `REGEN price moved ${direction} ${(changePct * 100).toFixed(1)}% ` +
            `($${lastPrice.toFixed(4)} \u2192 $${report.current_price.toFixed(4)}).`,
          { change_pct: changePct, from: lastPrice, to: report.current_price, threshold: this.config.priceMoveThreshold },
          { delta: `${(changePct * 100).toFixed(1)}% in last hour`, trend }
        );
      }
    }
  }

  async checkLiquidity(report: LiquidityReport): Promise<void> {
    if (report.available_credits < this.config.lowStockThreshold) {
      await this.emit(
        "WARNING",
        "Low Credit Stock",
        `Available credits (${report.available_credits.toLocaleString()}) fell below ` +
          `threshold (${this.config.lowStockThreshold.toLocaleString()}). ` +
          `Listed value: $${report.listed_value_usd.toLocaleString()}.`,
        {
          available: report.available_credits,
          threshold: this.config.lowStockThreshold,
          listed_value: report.listed_value_usd,
        },
        { explorerUrl: "https://app.regen.network/ecocredits/credits" }
      );
    }

    if (report.health_score < 30) {
      await this.emit(
        "CRITICAL",
        "Market Health Critical",
        `Market health score dropped to ${report.health_score}/100. ` +
          `Only ${report.credit_class_count} credit class(es) with active listings.`,
        { health_score: report.health_score, classes: report.credit_class_count, threshold: 30 },
        { explorerUrl: "https://app.regen.network/ecocredits/credits" }
      );
    } else if (report.health_score < 50) {
      await this.emit(
        "WARNING",
        "Market Health Declining",
        `Market health score is ${report.health_score}/100. Monitoring closely.`,
        { health_score: report.health_score, threshold: 50 }
      );
    }
  }

  async checkRetirements(report: RetirementReport): Promise<void> {
    for (const goal of report.completed_goals) {
      await this.emit(
        "INFO",
        "Community Goal Completed",
        `"${goal.name}" reached 100% completion ` +
          `(${goal.current.toLocaleString()}/${goal.target.toLocaleString()} credits).`,
        { goal_id: goal.id, goal_name: goal.name, target: goal.target },
        { explorerUrl: "https://app.regen.network/ecocredits/credits" }
      );
    }

    if (report.demand_signal === "high") {
      await this.emit(
        "INFO",
        "High Retirement Demand",
        `Retirement demand signal is HIGH. ` +
          `Total retired: ${report.total_retired.toLocaleString()} credits.`,
        { demand_signal: report.demand_signal, total_retired: report.total_retired }
      );
    }
  }

  async checkCuration(report: CurationReport): Promise<void> {
    if (report.quality_score < 300) {
      await this.emit(
        "WARNING",
        "Curation Quality Degradation",
        `Quality score ${report.quality_score}/1000 indicates degradation. ` +
          `${report.degraded_batches.length} batch(es) flagged.`,
        {
          quality_score: report.quality_score,
          threshold: 300,
          degraded_batches: report.degraded_batches,
          factors: report.factor_breakdown,
        }
      );
    }
  }

  /** Emit a WARNING for unreachable MCP tools (#3) */
  async emitMcpUnreachable(toolName: string): Promise<void> {
    await this.emit(
      "WARNING",
      "MCP Tool Unreachable",
      `MCP tool "${toolName}" unreachable after ${this.config.mcpRetryAttempts} attempts.`,
      { tool: toolName, attempts: this.config.mcpRetryAttempts }
    );
  }

  private async emit(
    severity: AlertSeverity,
    title: string,
    body: string,
    data: Record<string, unknown>,
    enrichment?: { delta?: string; trend?: string; explorerUrl?: string }
  ): Promise<void> {
    const now = Date.now();

    // Reset daily counter if day rolled over
    const todayStart = startOfDayMs();
    if (this.state.dayStart < todayStart) {
      this.state.alertsFiredToday = 0;
      this.state.dayStart = todayStart;
    }

    // Deduplication — check persisted cooldowns (#5)
    const lastTime = this.state.lastFired[title];
    if (lastTime && now - lastTime < this.config.alertCooldownMs) {
      this.logger.debug({ title }, "Alert suppressed (cooldown)");
      return;
    }

    const alert: MarketAlert = {
      id: `MM-${++this.alertCounter}-${now}`,
      severity,
      title,
      body,
      data,
      timestamp: new Date(now),
      delta: enrichment?.delta,
      trend: enrichment?.trend,
      explorerUrl: enrichment?.explorerUrl,
      nextCheckMinutes: this.nextCheckMinutes(),
    };

    this.state.lastFired[title] = now;
    this.state.alertsFiredToday++;
    this.store.saveAlertState(this.state);

    this.logger.info({ alert_id: alert.id, severity, title }, "Alert emitted");

    for (const listener of this.listeners) {
      try {
        await listener(alert);
      } catch (err) {
        this.logger.error({ err, alert_id: alert.id }, "Alert listener error");
      }
    }

    // Produce MarketSignal from alert
    if (this.onSignal) {
      try {
        const signalType = this.alertTitleToSignalType(title);
        if (signalType) {
          const signal = buildSignal(signalType, data as any, { triggered_by: "scheduled_poll" }, this.broadcastChannels);
          await this.onSignal(signal);
        }
      } catch (err) {
        this.logger.warn({ err, title }, "Signal production from alert failed");
      }
    }
  }

  private alertTitleToSignalType(title: string): SignalType | null {
    const map: Record<string, SignalType> = {
      "Price Manipulation Flagged": "MANIPULATION_ALERT",
      "Price Anomaly Detected": "PRICE_ANOMALY",
      "Significant Price Movement": "PRICE_MOVEMENT",
      "Low Credit Stock": "LOW_SUPPLY",
      "Market Health Critical": "LIQUIDITY_WARNING",
      "Market Health Declining": "LIQUIDITY_WARNING",
      "Community Goal Completed": "GOAL_COMPLETED",
      "Curation Quality Degradation": "CURATION_DEGRADED",
      "High Retirement Demand": "GOAL_COMPLETED",
    };
    return map[title] ?? null;
  }
}

function startOfDayMs(): number {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).getTime();
}
