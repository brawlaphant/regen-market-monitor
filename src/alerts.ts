import type {
  AlertSeverity,
  MarketAlert,
  Config,
  AnomalyReport,
  LiquidityReport,
  RetirementReport,
  CurationReport,
} from "./types.js";
import type { Logger } from "./logger.js";

/**
 * Alert manager with threshold checks and deduplication.
 * Same alert (by title) won't re-fire within ALERT_COOLDOWN_MS.
 */
export class AlertManager {
  private config: Config;
  private logger: Logger;
  private lastFired: Map<string, number> = new Map();
  private listeners: Array<(alert: MarketAlert) => void | Promise<void>> = [];
  private alertCounter = 0;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /** Register a listener that receives every emitted alert */
  onAlert(listener: (alert: MarketAlert) => void | Promise<void>): void {
    this.listeners.push(listener);
  }

  /** Check anomaly report against thresholds and emit alerts */
  async checkAnomaly(report: AnomalyReport, lastPrice?: number): Promise<void> {
    // Z-score anomaly alerts
    if (report.z_score >= 3.5) {
      await this.emit(
        "CRITICAL",
        "Price Manipulation Flagged",
        `Z-score ${report.z_score.toFixed(2)} exceeds manipulation threshold (3.5). ` +
          `Current price $${report.current_price.toFixed(4)}, median $${report.median_price.toFixed(4)}.`,
        { z_score: report.z_score, price: report.current_price, median: report.median_price }
      );
    } else if (report.z_score >= 2.0) {
      await this.emit(
        "WARNING",
        "Price Anomaly Detected",
        `Z-score ${report.z_score.toFixed(2)} exceeds monitoring threshold (2.0). ` +
          `Added to watchlist. Price $${report.current_price.toFixed(4)}.`,
        { z_score: report.z_score, price: report.current_price }
      );
    }

    // Price movement alert (vs last snapshot)
    if (lastPrice !== undefined && lastPrice > 0) {
      const changePct = Math.abs(
        (report.current_price - lastPrice) / lastPrice
      );
      if (changePct >= this.config.priceMoveThreshold) {
        const direction = report.current_price > lastPrice ? "up" : "down";
        await this.emit(
          "WARNING",
          "Significant Price Movement",
          `REGEN price moved ${direction} ${(changePct * 100).toFixed(1)}% ` +
            `($${lastPrice.toFixed(4)} → $${report.current_price.toFixed(4)}).`,
          { change_pct: changePct, from: lastPrice, to: report.current_price }
        );
      }
    }
  }

  /** Check liquidity report against thresholds */
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
        }
      );
    }

    if (report.health_score < 30) {
      await this.emit(
        "CRITICAL",
        "Market Health Critical",
        `Market health score dropped to ${report.health_score}/100. ` +
          `Only ${report.credit_class_count} credit class(es) with active listings.`,
        { health_score: report.health_score, classes: report.credit_class_count }
      );
    } else if (report.health_score < 50) {
      await this.emit(
        "WARNING",
        "Market Health Declining",
        `Market health score is ${report.health_score}/100. Monitoring closely.`,
        { health_score: report.health_score }
      );
    }
  }

  /** Check retirement report for completed goals */
  async checkRetirements(report: RetirementReport): Promise<void> {
    for (const goal of report.completed_goals) {
      await this.emit(
        "INFO",
        "Community Goal Completed",
        `"${goal.name}" reached 100% completion ` +
          `(${goal.current.toLocaleString()}/${goal.target.toLocaleString()} credits).`,
        { goal_id: goal.id, goal_name: goal.name, target: goal.target }
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

  /** Check curation quality report */
  async checkCuration(report: CurationReport): Promise<void> {
    if (report.quality_score < 300) {
      await this.emit(
        "WARNING",
        "Curation Quality Degradation",
        `Quality score ${report.quality_score}/1000 indicates degradation. ` +
          `${report.degraded_batches.length} batch(es) flagged.`,
        {
          quality_score: report.quality_score,
          degraded_batches: report.degraded_batches,
          factors: report.factor_breakdown,
        }
      );
    }
  }

  /** Emit an alert if not within cooldown window */
  private async emit(
    severity: AlertSeverity,
    title: string,
    body: string,
    data: Record<string, unknown>
  ): Promise<void> {
    const now = Date.now();
    const lastTime = this.lastFired.get(title);
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
    };

    this.lastFired.set(title, now);
    this.logger.info({ alert_id: alert.id, severity, title }, "Alert emitted");

    for (const listener of this.listeners) {
      try {
        await listener(alert);
      } catch (err) {
        this.logger.error({ err, alert_id: alert.id }, "Alert listener error");
      }
    }
  }
}
