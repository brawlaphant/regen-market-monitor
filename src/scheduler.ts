import { RegenMarketPlugin } from "./plugins/regen-market-plugin.js";
import { AlertManager } from "./alerts.js";
import { DataStore } from "./data-store.js";
import { HealthServer } from "./health-server.js";
import { TelegramNotifier } from "./notifiers/telegram.js";
import { EventWatcher } from "./chain/event-watcher.js";
import type { CrossChainAggregator } from "./chain/cross-chain-aggregator.js";
import type { ArbitrageDetector } from "./chain/arbitrage-detector.js";
import type { Config, AnomalyReport, LiquidityReport, RetirementReport, CurationReport, ChainEvent, MarketSnapshot } from "./types.js";
import type { Logger } from "./logger.js";

/**
 * Polling scheduler with:
 * - Independent error boundaries per workflow
 * - EventWatcher integration — chain events trigger immediate workflows
 * - Workflow deduplication — never run two instances of the same workflow concurrently
 * - Graceful shutdown: completes current cycle, flushes data
 * - Market snapshot cache
 * - Daily digest
 *
 * Returns the AnomalyReport from the latest run (for freeze proposal pipeline).
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

  /** Cross-chain intelligence — set from index.ts */
  public crossChainAggregator: CrossChainAggregator | null = null;
  public arbitrageDetector: ArbitrageDetector | null = null;
  /** Callback when cross-chain signals fire */
  public onCrossChainSignal: ((type: string, data: Record<string, unknown>) => Promise<void>) | null = null;

  /** Trading signal engine — set from index.ts */
  public onComposeSignal: ((snapshot: any, recentSignals: any[]) => Promise<void>) | null = null;
  public onInvalidateSignals: ((snapshot: any, recentSignals: any[]) => Promise<void>) | null = null;

  /** Tracks running workflows to prevent duplicates */
  private runningWorkflows = new Set<string>();

  /** Callback when a CRITICAL anomaly is detected (z-score >= 3.5) */
  public onCriticalAnomaly: ((report: AnomalyReport) => Promise<void>) | null = null;

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

  /** Subscribe to an EventWatcher for chain-triggered workflows */
  subscribeToEvents(watcher: EventWatcher): void {
    watcher.on("chain_event", (event: ChainEvent) => {
      this.handleChainEvent(event);
    });
    this.logger.info("Scheduler subscribed to EventWatcher");
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.info(
      { interval_ms: this.config.pollIntervalMs },
      "Scheduler starting"
    );

    const cached = this.store.loadSnapshot();
    if (cached) {
      this.health.snapshot = cached;
      this.logger.info({ lastPollAt: cached.lastPollAt }, "Loaded cached snapshot for /state");
    }

    const shutdown = (signal: string) => this.stop(signal);
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    await this.runCycle(true);

    this.pollTimer = setInterval(async () => {
      if (!this.running) return;
      await this.runCycle(false);
    }, this.config.pollIntervalMs);

    this.digestTimer = setInterval(() => {
      this.checkDigest();
    }, 60_000);

    this.health.nextPollAt = new Date(Date.now() + this.config.pollIntervalMs);
    this.logger.info("Scheduler running");
  }

  // ─── Chain Event Handler ──────────────────────────────────────────

  private handleChainEvent(event: ChainEvent): void {
    this.logger.info(
      { trigger: "event_watcher", event_type: event.type, block_height: event.blockHeight },
      "Chain event received"
    );

    switch (event.type) {
      case "new_sell_order":
        this.runWorkflow("WF-MM-01", () => this.runPriceAnomaly("event: new_sell_order"));
        break;
      case "new_retirement":
        this.runWorkflow("WF-MM-03", () => this.runRetirementAnalysis("event: new_retirement"));
        break;
      case "large_trade":
        this.runWorkflow("WF-MM-02", () => this.runLiquidityAssessment("event: large_trade"));
        break;
    }
  }

  /** Run a workflow if not already running (deduplication) */
  private runWorkflow(name: string, fn: () => Promise<void>): void {
    if (this.runningWorkflows.has(name)) {
      this.logger.debug({ workflow: name }, "Workflow already running, skipping");
      return;
    }
    this.runningWorkflows.add(name);
    fn().finally(() => this.runningWorkflows.delete(name));
  }

  private async runPriceAnomaly(reason: string): Promise<void> {
    try {
      this.logger.info({ reason }, "WF-MM-01 triggered by event");
      const anomaly = await this.plugin.detectPriceAnomaly();
      this.alerts.recordPrice(anomaly.current_price);
      await this.alerts.checkAnomaly(anomaly, this.lastPrice);
      this.lastPrice = anomaly.current_price;

      // Trigger freeze proposal pipeline on CRITICAL
      if (anomaly.status === "flagged" && anomaly.z_score >= 3.5 && this.onCriticalAnomaly) {
        await this.onCriticalAnomaly(anomaly);
      }
    } catch (err) {
      this.logger.error({ workflow: "WF-MM-01", error: String(err) }, "Event-triggered price anomaly failed");
    }
  }

  private async runLiquidityAssessment(reason: string): Promise<void> {
    try {
      this.logger.info({ reason }, "WF-MM-02 triggered by event");
      const liquidity = await this.plugin.assessLiquidity();
      await this.alerts.checkLiquidity(liquidity);
    } catch (err) {
      this.logger.error({ workflow: "WF-MM-02", error: String(err) }, "Event-triggered liquidity check failed");
    }
  }

  private async runRetirementAnalysis(reason: string): Promise<void> {
    try {
      this.logger.info({ reason }, "WF-MM-03 triggered by event");
      const retirement = await this.plugin.analyzeRetirements();
      await this.alerts.checkRetirements(retirement);
      this.lastRetirementRun = Date.now();
    } catch (err) {
      this.logger.error({ workflow: "WF-MM-03", error: String(err) }, "Event-triggered retirement analysis failed");
    }
  }

  // ─── Scheduled Poll Cycle ─────────────────────────────────────────

  private async runCycle(isInitial: boolean): Promise<void> {
    const cycleStart = Date.now();
    this.cycleInProgress = true;
    this.logger.info({ initial: isInitial }, "Poll cycle starting");

    let anomaly: AnomalyReport | null = null;
    let liquidity: LiquidityReport | null = null;
    let retirement: RetirementReport | null = null;
    let curation: CurationReport | null = null;

    // Invalidate active trading signals at start of cycle
    if (this.onInvalidateSignals && this.crossChainAggregator?.getLastSnapshot()) {
      try {
        await this.onInvalidateSignals(this.crossChainAggregator.getLastSnapshot(), []);
      } catch {}
    }

    // WF-MM-01
    try {
      anomaly = await this.plugin.detectPriceAnomaly();
      this.alerts.recordPrice(anomaly.current_price);
      await this.alerts.checkAnomaly(anomaly, this.lastPrice);
      this.lastPrice = anomaly.current_price;

      if (anomaly.status === "flagged" && anomaly.z_score >= 3.5 && this.onCriticalAnomaly) {
        await this.onCriticalAnomaly(anomaly);
      }
    } catch (err) {
      this.logger.error(
        { workflow: "WF-MM-01", tool: "get_regen_price/browse_available_credits", error: String(err), timestamp: new Date().toISOString() },
        "Price anomaly check failed"
      );
      await this.alerts.emitMcpUnreachable("get_regen_price").catch(() => {});
    }

    // WF-MM-02
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

    // WF-MM-04
    try {
      curation = await this.plugin.scoreCurationQuality();
      await this.alerts.checkCuration(curation);
    } catch (err) {
      this.logger.error(
        { workflow: "WF-MM-04", tool: "browse_available_credits/check_supply_health", error: String(err), timestamp: new Date().toISOString() },
        "Curation quality check failed"
      );
    }

    // WF-MM-03 — once per day
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

    // Cross-chain intelligence — runs every poll cycle
    if (this.crossChainAggregator) {
      try {
        const ccSnapshot = await this.crossChainAggregator.fetchAll();
        if (this.arbitrageDetector) {
          const arb = this.arbitrageDetector.detectArbitrage(ccSnapshot);
          if (arb) ccSnapshot.arbitrage_opportunity = arb;
          // Emit cross-chain signals
          if (arb && arb.profitable && arb.confidence !== "low" && this.onCrossChainSignal) {
            await this.onCrossChainSignal("CROSS_CHAIN_ARBITRAGE", {
              buy_venue: arb.buy_venue, sell_venue: arb.sell_venue,
              buy_price_usd: arb.buy_price_usd, sell_price_usd: arb.sell_price_usd,
              net_spread_pct: arb.net_spread_pct, recommended_size_usd: arb.recommended_size_usd,
              bridge_path: arb.notes, expiry_estimate_minutes: arb.expiry_estimate_minutes,
            });
          }
          // Venue divergence check
          if (ccSnapshot.spread_pct > 5 && this.onCrossChainSignal) {
            await this.onCrossChainSignal("VENUE_PRICE_DIVERGENCE", {
              venue_a: ccSnapshot.best_ask_venue, venue_b: ccSnapshot.best_bid_venue,
              price_a: ccSnapshot.venues.find(v => v.venue === ccSnapshot.best_ask_venue)?.price_usd ?? 0,
              price_b: ccSnapshot.venues.find(v => v.venue === ccSnapshot.best_bid_venue)?.price_usd ?? 0,
              divergence_pct: ccSnapshot.spread_pct,
            });
          }
          // Bridge flow signal
          if (ccSnapshot.bridge_flow.signal !== "neutral" && this.onCrossChainSignal) {
            await this.onCrossChainSignal("BRIDGE_FLOW_SPIKE", {
              direction: ccSnapshot.bridge_flow.signal,
              net_regen_24h: ccSnapshot.bridge_flow.net_regen_24h,
              net_usd_24h: ccSnapshot.bridge_flow.net_usd_24h,
              tx_count_24h: ccSnapshot.bridge_flow.tx_count_24h,
              largest_tx_amount: ccSnapshot.bridge_flow.largest_tx?.amount_regen ?? 0,
            });
          }

          // Hydrex epoch/emission signals
          const hd = this.crossChainAggregator.lastHydrexData;
          if (hd && this.onCrossChainSignal) {
            // Epoch transition warning
            if (hd.epoch_info.hours_until_flip < 6) {
              const action = hd.vote_trend === "increasing"
                ? "Monitor for LP inflow"
                : hd.vote_trend === "decreasing" ? "Watch for LP exit" : "Monitor";
              await this.onCrossChainSignal("HYDX_EPOCH_TRANSITION", {
                current_epoch: hd.epoch_info.current_epoch,
                hours_until_flip: hd.epoch_info.hours_until_flip,
                votes_toward_regen: 0,
                vote_trend: hd.vote_trend,
                vote_change_pct: hd.vote_change_pct,
                combined_apr_pct: hd.combined_apr_pct,
                action,
              });
            }
            // Emission shift (> 20% vote change)
            if (Math.abs(hd.vote_change_pct) > 20) {
              await this.onCrossChainSignal("EMISSION_SHIFT", {
                votes_previous: 0, votes_current: 0,
                change_pct: hd.vote_change_pct,
                direction: hd.vote_change_pct > 0 ? "increasing" : "decreasing",
                incentive_apr_pct: hd.incentive_apr_pct,
              });
            }
          }
        }
      } catch (err) {
        this.logger.error({ err: String(err) }, "Cross-chain fetch failed");
      }
    }

    // Compose trading signal after all workflows complete
    if (this.onComposeSignal && this.crossChainAggregator?.getLastSnapshot()) {
      try {
        await this.onComposeSignal(this.crossChainAggregator.getLastSnapshot(), []);
      } catch (err) {
        this.logger.warn({ err: String(err) }, "Trading signal composition failed");
      }
    }

    const elapsed = Date.now() - cycleStart;

    const snapshot = this.plugin.buildSnapshot(anomaly, liquidity, retirement, curation, elapsed);
    this.store.saveSnapshot(snapshot);
    this.health.snapshot = snapshot;

    this.health.lastPollAt = new Date();
    this.health.nextPollAt = new Date(Date.now() + this.config.pollIntervalMs);
    this.health.mcpReachable = this.plugin.lastPrice !== null || this.plugin.lastSupplyHealth !== null;
    this.health.alertsFiredToday = this.alerts.alertsFiredToday;

    this.cycleInProgress = false;
    this.logger.info({ elapsed_ms: elapsed }, "Poll cycle complete");
  }

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

  async stop(signal?: string): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (signal) {
      this.logger.info({ signal }, "Shutdown signal received");
    }

    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.digestTimer) { clearInterval(this.digestTimer); this.digestTimer = null; }

    if (this.cycleInProgress) {
      this.logger.info("Waiting for current cycle to complete...");
      let waits = 0;
      while (this.cycleInProgress && waits < 300) {
        await new Promise((r) => setTimeout(r, 100));
        waits++;
      }
    }

    this.logger.info("Flushing data to disk...");
    this.plugin.flushPriceHistory();
    this.alerts.flush();
    await this.store.waitForWrites();
    await this.health.close();

    this.logger.info("Scheduler stopped — clean shutdown");
    process.exit(0);
  }
}
