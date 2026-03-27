import "dotenv/config";

import { MarketMonitorCharacter } from "./characters/market-monitor.character.js";
import { RegenMarketPlugin } from "./plugins/regen-market-plugin.js";
import { McpClient } from "./mcp-client.js";
import { AlertManager } from "./alerts.js";
import { DataStore } from "./data-store.js";
import { Scheduler } from "./scheduler.js";
import { HealthServer } from "./health-server.js";
import { TelegramNotifier } from "./notifiers/telegram.js";
import { SignalStore } from "./signals/signal-store.js";
import { SignalPublisher } from "./signals/signal-publisher.js";
import { buildSubscriptionGuide } from "./signals/subscription-guide.js";
import { ThresholdTuner } from "./tuner/threshold-tuner.js";
import { LCDClient } from "./chain/lcd-client.js";
import { EventWatcher } from "./chain/event-watcher.js";
import { ProposalBuilder } from "./chain/proposal-builder.js";
import { ProposalSubmitter } from "./chain/proposal-submitter.js";
import { ApprovalGate } from "./chain/approval-gate.js";
import { TelegramCommandHandler } from "./chain/telegram-commands.js";
import { AuditLog } from "./chain/audit-log.js";
import { CrossChainAggregator } from "./chain/cross-chain-aggregator.js";
import { ArbitrageDetector } from "./chain/arbitrage-detector.js";
import { SignalComposer } from "./signals/signal-composer.js";
import { SignalInvalidator } from "./signals/signal-invalidator.js";
import { TradingSignalStore } from "./signals/trading-signal-store.js";
import { BankrAdapter } from "./execution/bankr-adapter.js";
import { ExecutionLedger } from "./execution/execution-ledger.js";
import { StrategyOrchestrator } from "./strategies/strategy-orchestrator.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info(
    {
      agent: MarketMonitorCharacter.agentId,
      name: MarketMonitorCharacter.name,
      type: MarketMonitorCharacter.type,
    },
    "Initializing RegenMarketMonitor"
  );

  // Data persistence layer
  const store = new DataStore(config.dataDir, logger);

  // MCP client with retry + timeout
  const mcp = new McpClient(config.regenComputeMcpUrl, config, logger);

  // Plugin with all four OODA workflows
  const plugin = new RegenMarketPlugin(mcp, store, logger);

  // ─── Signal Broadcasting Layer ────────────────────────────────────

  const signalStore = new SignalStore(config.dataDir, logger);
  const signalPublisher = new SignalPublisher(signalStore, logger);
  await signalPublisher.init();

  // Alert manager with persistent deduplication + signal production
  const alerts = new AlertManager(config, store, logger);
  alerts.broadcastChannels = signalPublisher.configuredChannels;
  alerts.onSignal = async (signal) => {
    await signalPublisher.publish(signal);
  };

  // Telegram notifier
  const notifier = new TelegramNotifier(config, logger);
  alerts.onAlert((alert) => notifier.sendAlert(alert));

  // Health endpoint — serves /health, /state, /signals/*, /tuning-report
  const health = new HealthServer(config.port, logger);
  health.signalStore = signalStore;
  health.signalPublisher = signalPublisher;

  // Generate subscription guide for downstream agent teams
  buildSubscriptionGuide(config.dataDir, config.port, logger);

  // Threshold tuner — available via GET /tuning-report
  const tuner = new ThresholdTuner(config, logger);
  health.tuningAnalyzer = () => tuner.analyze();

  // ─── Cross-Chain Intelligence Layer ──────────────────────────────

  const crossChain = new CrossChainAggregator(config.dataDir, logger);
  await crossChain.init();
  const arbDetector = new ArbitrageDetector(logger);
  health.crossChainAggregator = crossChain;
  health.arbitrageDetector = arbDetector;

  // ─── Trading Signal Engine ──────────────────────────────────────

  const tradingStore = new TradingSignalStore(config.dataDir, logger);
  const composer = new SignalComposer(config.dataDir, logger);
  const invalidator = new SignalInvalidator(logger);
  health.tradingSignalStore = tradingStore;

  // ─── Execution + Strategy Layer ─────────────────────────────────

  const bankrAdapter = new BankrAdapter(config.dataDir, logger);
  const execLedger = new ExecutionLedger(config.dataDir, logger);
  const orchestrator = new StrategyOrchestrator(bankrAdapter, execLedger, config.dataDir, logger);

  // Trade approval via Telegram
  bankrAdapter.onApprovalRequired = async (order) => {
    const msg = `Trade approval required:\n${order.action.toUpperCase()} $${order.amount_usd} REGEN on ${order.venue}\nStrategy: ${order.phase}\nReply /approve-trade ${order.id} or /reject-trade ${order.id}`;
    notifier.sendAlert({ id: order.id, severity: "WARNING", title: "Trade Approval Required", body: msg, data: { phase: order.phase, amount: order.amount_usd }, timestamp: new Date() });
  };

  // Expose to health server
  health.executionLedger = execLedger;
  health.accumulationStrategy = orchestrator.accumulationStrategy;

  // ─── On-Chain Action Layer ────────────────────────────────────────

  const lcd = new LCDClient(config, logger);
  const audit = new AuditLog(config.dataDir, logger);
  const builder = new ProposalBuilder(lcd, audit, config, logger);
  const submitter = new ProposalSubmitter(config, audit, logger);

  if (config.regenMnemonic) {
    try {
      await submitter.init();
      logger.info("ProposalSubmitter wallet ready");
    } catch (err) {
      logger.error({ err }, "ProposalSubmitter init failed — proposal submission disabled");
    }
  } else {
    logger.warn("REGEN_MNEMONIC not set — proposal submission disabled (monitoring only)");
  }

  const gate = new ApprovalGate(config, builder, submitter, audit, logger);

  const bot = notifier.getBot();
  let commandHandler: TelegramCommandHandler | null = null;
  if (bot && config.telegramAdminChatId) {
    commandHandler = new TelegramCommandHandler(bot, gate, config, logger);
    commandHandler.start();
    gate.onNotify(async (proposal, markdown) => {
      await commandHandler!.sendApprovalRequest(proposal, markdown);
    });
  } else {
    logger.warn("Telegram admin chat not configured — proposal approval commands disabled");
  }

  const eventWatcher = new EventWatcher(lcd, config, logger);

  // ─── Wire the Scheduler ───────────────────────────────────────────

  logger.info(
    { system: MarketMonitorCharacter.system.join(" ") },
    "Character loaded"
  );

  const scheduler = new Scheduler(
    plugin, alerts, store, health, notifier, config, logger
  );

  // Subscribe to chain events
  scheduler.subscribeToEvents(eventWatcher);

  // Wire cross-chain intelligence
  scheduler.crossChainAggregator = crossChain;
  scheduler.arbitrageDetector = arbDetector;
  scheduler.onCrossChainSignal = async (type, data) => {
    try {
      const { buildSignal } = await import("./signals/signal-factory.js");
      const signal = buildSignal(type as any, data as any, { triggered_by: "scheduled_poll", workflow_id: "cross-chain" }, signalPublisher.configuredChannels);
      await signalPublisher.publish(signal);
    } catch (err) { logger.warn({ err, type }, "Cross-chain signal publish failed"); }
  };

  // Wire trading signal composer + invalidator
  scheduler.onComposeSignal = async (ccSnapshot, _recentSignals) => {
    try {
      const recentMS = signalStore.getRecent(50);
      const ts = composer.compose(ccSnapshot, recentMS);
      tradingStore.push(ts);
      logger.info({ class: ts.signal_class, conviction: ts.conviction, direction: ts.direction }, "Trading signal composed");
      // Notify Telegram on A-conviction signals
      if (ts.conviction === "A" && ts.direction !== "neutral") {
        const msg = `Signal: ${ts.direction.toUpperCase()} REGEN \u2014 Conviction A\nClass: ${ts.signal_class}\nEntry: ${ts.entry_venue} @ $${ts.entry_price_usd.toFixed(4)}\nTarget: $${ts.target_price_usd?.toFixed(4) || "n/a"}\nSize: $${ts.recommended_size_usd}\nHorizon: ${ts.time_horizon}\nWhy: ${ts.rationale.slice(0, 2).join(", ")}`;
        notifier.sendAlert({ id: ts.id, severity: "CRITICAL", title: `Trading Signal: ${ts.signal_class}`, body: msg, data: { conviction: "A", class: ts.signal_class }, timestamp: new Date() });
      }
      // Run strategy orchestrator after signal composition
      if (bankrAdapter.isEnabled) {
        try {
          await orchestrator.run(ccSnapshot, ts);
        } catch (stratErr) { logger.warn({ stratErr }, "Strategy orchestrator failed"); }
      }
    } catch (err) { logger.warn({ err }, "Trading signal compose failed"); }
  };

  scheduler.onInvalidateSignals = async (ccSnapshot, _recentSignals) => {
    try {
      const active = tradingStore.getActive();
      const recentMS = signalStore.getRecent(50);
      const invalidated = invalidator.checkAll(active, ccSnapshot, recentMS);
      for (const inv of invalidated) {
        if (inv.conviction === "A" || inv.conviction === "B") {
          notifier.sendAlert({ id: inv.id, severity: "WARNING", title: "Signal Invalidated", body: `${inv.signal_class} ${inv.direction} invalidated: ${inv.invalidated_reason}`, data: { class: inv.signal_class, reason: inv.invalidated_reason }, timestamp: new Date() });
        }
      }
    } catch (err) { logger.warn({ err }, "Signal invalidation check failed"); }
  };

  // Wire the freeze proposal pipeline
  scheduler.onCriticalAnomaly = async (anomalyReport) => {
    logger.info({ z_score: anomalyReport.z_score }, "CRITICAL anomaly — initiating freeze proposal pipeline");
    try {
      let orderIds: string[] = [];
      try {
        const orders = await lcd.getEcocreditSellOrders();
        orderIds = orders.slice(0, 10).map((o) => o.id);
      } catch { logger.warn("Could not fetch sell orders for proposal context"); }

      const priceHistory = store.loadPriceHistory();
      const proposal = builder.buildFreezeProposal(anomalyReport, priceHistory, orderIds);
      const validation = await builder.validateProposal(proposal);
      if (!validation.valid) {
        logger.warn({ proposalId: proposal.id, reasons: validation.reasons }, "Freeze proposal validation failed");
        return;
      }
      await gate.requestApproval(proposal);
    } catch (err) { logger.error({ err }, "Freeze proposal pipeline failed"); }
  };

  // Wire MARKET_REPORT signal into scheduler's daily digest
  scheduler.onDigestComplete = async (snapshot) => {
    if (!snapshot) return;
    try {
      const { buildSignal } = await import("./signals/signal-factory.js");
      const signal = buildSignal("MARKET_REPORT", {
        regen_price_usd: snapshot.price?.price_usd ?? 0,
        available_credits: snapshot.credits?.total_tradable ?? 0,
        health_score: snapshot.liquidity?.health_score ?? 0,
        active_goals: snapshot.communityGoals?.goals?.length ?? 0,
        goals_completed_today: snapshot.communityGoals?.goals?.filter((g) => g.percent_complete >= 100).length ?? 0,
        alerts_fired_today: alerts.alertsFiredToday,
        period_start: new Date(Date.now() - 86400000).toISOString(),
        period_end: new Date().toISOString(),
      }, { triggered_by: "scheduled_poll", workflow_id: "daily-digest" }, signalPublisher.configuredChannels);
      await signalPublisher.publish(signal);
    } catch (err) { logger.warn({ err }, "Failed to produce MARKET_REPORT signal"); }
  };

  // Graceful shutdown — close SSE and Redis before exit
  const origStop = scheduler.stop.bind(scheduler);
  scheduler.stop = async (signal?: string) => {
    signalPublisher.closeSseClients();
    await signalPublisher.close();
    await origStop(signal);
  };

  // Start everything
  await eventWatcher.start();
  await scheduler.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
