import { RegenMarketPlugin } from "./plugins/regen-market-plugin.js";
import { AlertManager } from "./alerts.js";
import type { Config, PriceSnapshot } from "./types.js";
import type { Logger } from "./logger.js";

/**
 * Polling scheduler for the Market Monitor agent.
 *
 * - ASSESS_LIQUIDITY + DETECT_PRICE_ANOMALY: every POLL_INTERVAL_MS
 * - SCORE_CURATION_QUALITY: every POLL_INTERVAL_MS
 * - ANALYZE_RETIREMENTS: once per day (tracks last run timestamp)
 *
 * On startup: runs all checks immediately, then schedules.
 * Graceful shutdown on SIGINT/SIGTERM.
 */
export class Scheduler {
  private plugin: RegenMarketPlugin;
  private alerts: AlertManager;
  private config: Config;
  private logger: Logger;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastRetirementRun = 0;
  private lastPrice: number | undefined;
  private running = false;
  private readonly ONE_DAY_MS = 24 * 60 * 60 * 1000;

  constructor(
    plugin: RegenMarketPlugin,
    alerts: AlertManager,
    config: Config,
    logger: Logger
  ) {
    this.plugin = plugin;
    this.alerts = alerts;
    this.config = config;
    this.logger = logger;
  }

  /** Start the scheduler — runs all checks immediately then sets interval */
  async start(): Promise<void> {
    this.running = true;
    this.logger.info(
      { interval_ms: this.config.pollIntervalMs },
      "Scheduler starting"
    );

    // Register shutdown handlers
    process.on("SIGINT", () => this.stop("SIGINT"));
    process.on("SIGTERM", () => this.stop("SIGTERM"));

    // Initial run — all workflows
    await this.runCycle(true);

    // Schedule recurring polls
    this.pollTimer = setInterval(async () => {
      if (!this.running) return;
      await this.runCycle(false);
    }, this.config.pollIntervalMs);

    this.logger.info("Scheduler running");
  }

  /** Execute one polling cycle */
  private async runCycle(isInitial: boolean): Promise<void> {
    const cycleStart = Date.now();
    this.logger.info(
      { initial: isInitial },
      "Poll cycle starting"
    );

    try {
      // WF-MM-01: Price Anomaly Detection — every poll
      const anomaly = await this.plugin.detectPriceAnomaly();
      await this.alerts.checkAnomaly(anomaly, this.lastPrice);
      this.lastPrice = anomaly.current_price;
    } catch (err) {
      this.logger.error({ err, workflow: "WF-MM-01" }, "Price anomaly check failed");
    }

    try {
      // WF-MM-02: Liquidity Monitoring — every poll
      const liquidity = await this.plugin.assessLiquidity();
      await this.alerts.checkLiquidity(liquidity);
    } catch (err) {
      this.logger.error({ err, workflow: "WF-MM-02" }, "Liquidity check failed");
    }

    try {
      // WF-MM-04: Curation Quality — every poll
      const curation = await this.plugin.scoreCurationQuality();
      await this.alerts.checkCuration(curation);
    } catch (err) {
      this.logger.error({ err, workflow: "WF-MM-04" }, "Curation quality check failed");
    }

    // WF-MM-03: Retirement Analysis — once per day
    const now = Date.now();
    if (isInitial || now - this.lastRetirementRun >= this.ONE_DAY_MS) {
      try {
        const retirements = await this.plugin.analyzeRetirements();
        await this.alerts.checkRetirements(retirements);
        this.lastRetirementRun = now;
      } catch (err) {
        this.logger.error({ err, workflow: "WF-MM-03" }, "Retirement analysis failed");
      }
    }

    const elapsed = Date.now() - cycleStart;
    this.logger.info({ elapsed_ms: elapsed }, "Poll cycle complete");
  }

  /** Stop the scheduler gracefully */
  stop(signal?: string): void {
    if (!this.running) return;
    this.running = false;

    if (signal) {
      this.logger.info({ signal }, "Shutdown signal received");
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.logger.info("Scheduler stopped");
    process.exit(0);
  }
}
