import { RegenMarketPlugin } from "./plugins/regen-market-plugin.js";
import { AlertManager } from "./alerts.js";
import { DataStore } from "./data-store.js";
import { HealthServer } from "./health-server.js";
import { TelegramNotifier } from "./notifiers/telegram.js";
import type { Config, MarketSnapshot, AnomalyReport, LiquidityReport, RetirementReport, CurationReport } from "./types.js";
import type { Logger } from "./logger.js";

/**
 * Polling scheduler with:
 * - Independent error boundaries per workflow (#2)
 * - MCP unreachable alerts (#3)
 * - Graceful shutdown: completes current cycle, flushes data (#6)
 * - Market snapshot cache (#10)
 * - Daily digest at configured UTC hour (#12)
 * - Health endpoint updates (#8)
 */
export class Scheduler {
  private plugin: RegenMarketPlugin;
  private alerts: AlertManager;
  private store: DataStore;
  private health: HealthServer;
  private notifier: TelegramNotifier;
  private config: Config;
  private logger: Logger;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private digestTimer: ReturnType<typeof setInterval> | null = null;
  private lastRetirementRun = 0;
  private lastPrice: number | undefined;
  private running = false;
  private cycleInProgress = false;
  private startedAt = Date.now();
  private readonly ONE_DAY_MS = 24 * 60 * 60 * 1000;
  private lastDigestDay = -1;

  /** Callback when daily digest completes — produces MARKET_REPORT signal */
  public onDigestComplete: ((snapshot: MarketSnapshot | null) => Promise<void>) | null = null;

  constructor(
    plugin: RegenMarketPlugin,
    alerts: AlertManager,
    store: DataStore,
    health: HealthServer,
    notifier: TelegramNotifier,
    config: Config,
    logger: Logger
  ) {
    this.plugin = plugin;
    this.alerts = alerts;
    this.store = store;
    this.health = health;
    this.notifier = notifier;
    this.config = config;
    this.logger = logger;
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.info(
      { interval_ms: this.config.pollIntervalMs },
      "Scheduler starting"
    );

    // Load cached snapshot for immediate /state serving (#10)
    const cached = this.store.loadSnapshot();
    if (cached) {
      this.health.snapshot = cached;
      this.logger.info({ lastPollAt: cached.lastPollAt }, "Loaded cached snapshot for /state");
    }

    // Graceful shutdown (#6)
    const shutdown = (signal: string) => this.stop(signal);
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // Initial run
    await this.runCycle(true);

    // Schedule recurring polls
    this.pollTimer = setInterval(async () => {
      if (!this.running) return;
      await this.runCycle(false);
    }, this.config.pollIntervalMs);

    // Schedule daily digest check every minute (#12)
    this.digestTimer = setInterval(() => {
      this.checkDigest();
    }, 60_000);

    // Update next poll time
    this.health.nextPollAt = new Date(Date.now() + this.config.pollIntervalMs);

    this.logger.info("Scheduler running");
  }

  private async runCycle(isInitial: boolean): Promise<void> {
    const cycleStart = Date.now();
    this.cycleInProgress = true;
    this.logger.info({ initial: isInitial }, "Poll cycle starting");

    let anomaly: AnomalyReport | null = null;
    let liquidity: LiquidityReport | null = null;
    let retirement: RetirementReport | null = null;
    let curation: CurationReport | null = null;

    // WF-MM-01: Price Anomaly Detection (#2: independent error boundary)
    try {
      anomaly = await this.plugin.detectPriceAnomaly();
      this.alerts.recordPrice(anomaly.current_price);
      await this.alerts.checkAnomaly(anomaly, this.lastPrice);
      this.lastPrice = anomaly.current_price;
    } catch (err) {
      this.logger.error(
        { workflow: "WF-MM-01", tool: "get_regen_price/browse_available_credits", error: String(err), timestamp: new Date().toISOString() },
        "Price anomaly check failed"
      );
      await this.alerts.emitMcpUnreachable("get_regen_price").catch(() => {});
    }

    // WF-MM-02: Liquidity Monitoring (#2)
    try {
      liquidity = await this.plugin.assessLiquidity();
      await this.alerts.checkLiquidity(liquidity);
    } catch (err) {
      this.logger.error(
        { workflow: "WF-MM-02", tool: "check_supply_health/browse_available_credits", error: String(err), timestamp: new Date().toISOString() },
        "Liquidity check failed"
      );
      await this.alerts.emitMcpUnreachable("check_supply_health").catch(() => {});
    }

    // WF-MM-04: Curation Quality (#2)
    try {
      curation = await this.plugin.scoreCurationQuality();
      await this.alerts.checkCuration(curation);
    } catch (err) {
      this.logger.error(
        { workflow: "WF-MM-04", tool: "browse_available_credits/check_supply_health", error: String(err), timestamp: new Date().toISOString() },
        "Curation quality check failed"
      );
    }

    // WF-MM-03: Retirement Analysis — once per day (#2)
    const now = Date.now();
    if (isInitial || now - this.lastRetirementRun >= this.ONE_DAY_MS) {
      try {
        retirement = await this.plugin.analyzeRetirements();
        await this.alerts.checkRetirements(retirement);
        this.lastRetirementRun = now;
      } catch (err) {
        this.logger.error(
          { workflow: "WF-MM-03", tool: "get_community_goals/check_supply_health", error: String(err), timestamp: new Date().toISOString() },
          "Retirement analysis failed"
        );
        await this.alerts.emitMcpUnreachable("get_community_goals").catch(() => {});
      }
    }

    const elapsed = Date.now() - cycleStart;

    // Build and persist market snapshot (#10)
    const snapshot = this.plugin.buildSnapshot(anomaly, liquidity, retirement, curation, elapsed);
    this.store.saveSnapshot(snapshot);
    this.health.snapshot = snapshot;

    // Update health endpoint state (#8)
    this.health.lastPollAt = new Date();
    this.health.nextPollAt = new Date(Date.now() + this.config.pollIntervalMs);
    this.health.mcpReachable = this.plugin.lastPrice !== null || this.plugin.lastSupplyHealth !== null;
    this.health.alertsFiredToday = this.alerts.alertsFiredToday;

    this.cycleInProgress = false;
    this.logger.info({ elapsed_ms: elapsed }, "Poll cycle complete");
  }

  /** Check if it's time to send daily digest (#12) */
  private checkDigest(): void {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcDay = now.getUTCDate();

    if (utcHour === this.config.dailyDigestHourUtc && utcDay !== this.lastDigestDay) {
      this.lastDigestDay = utcDay;
      const uptimeSeconds = Math.round((Date.now() - this.startedAt) / 1000);
      this.notifier
        .sendDigest(this.health.snapshot, this.alerts.alertsFiredToday, uptimeSeconds)
        .then(() => this.onDigestComplete?.(this.health.snapshot))
        .catch((err) => this.logger.error({ err }, "Daily digest failed"));
    }
  }

  /** Graceful shutdown: wait for current cycle, flush data, exit (#6) */
  async stop(signal?: string): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (signal) {
      this.logger.info({ signal }, "Shutdown signal received");
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.digestTimer) {
      clearInterval(this.digestTimer);
      this.digestTimer = null;
    }

    // Wait for in-progress cycle to complete (#6)
    if (this.cycleInProgress) {
      this.logger.info("Waiting for current cycle to complete...");
      let waits = 0;
      while (this.cycleInProgress && waits < 300) {
        await new Promise((r) => setTimeout(r, 100));
        waits++;
      }
    }

    // Flush all persistent data (#6)
    this.logger.info("Flushing data to disk...");
    this.plugin.flushPriceHistory();
    this.alerts.flush();
    await this.store.waitForWrites();

    // Close health server
    await this.health.close();

    this.logger.info("Scheduler stopped — clean shutdown");
    process.exit(0);
  }
}
