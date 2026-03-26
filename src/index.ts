import "dotenv/config";

import { MarketMonitorCharacter } from "./characters/market-monitor.character.js";
import { RegenMarketPlugin } from "./plugins/regen-market-plugin.js";
import { McpClient } from "./mcp-client.js";
import { AlertManager } from "./alerts.js";
import { DataStore } from "./data-store.js";
import { Scheduler } from "./scheduler.js";
import { HealthServer } from "./health-server.js";
import { TelegramNotifier } from "./notifiers/telegram.js";
import { ThresholdTuner } from "./tuner/threshold-tuner.js";
import { LCDClient } from "./chain/lcd-client.js";
import { EventWatcher } from "./chain/event-watcher.js";
import { ProposalBuilder } from "./chain/proposal-builder.js";
import { ProposalSubmitter } from "./chain/proposal-submitter.js";
import { ApprovalGate } from "./chain/approval-gate.js";
import { TelegramCommandHandler } from "./chain/telegram-commands.js";
import { AuditLog } from "./chain/audit-log.js";
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

  // Alert manager with persistent deduplication
  const alerts = new AlertManager(config, store, logger);

  // Telegram notifier
  const notifier = new TelegramNotifier(config, logger);
  alerts.onAlert((alert) => notifier.sendAlert(alert));

  // Health endpoint
  const health = new HealthServer(config.port, logger);

  // Threshold tuner — available via GET /tuning-report
  const tuner = new ThresholdTuner(config, logger);
  health.tuningAnalyzer = () => tuner.analyze();

  // ─── On-Chain Action Layer ────────────────────────────────────────

  // LCD client for direct Regen chain queries
  const lcd = new LCDClient(config, logger);

  // Audit log (append-only)
  const audit = new AuditLog(config.dataDir, logger);

  // Proposal builder + submitter
  const builder = new ProposalBuilder(lcd, audit, config, logger);
  const submitter = new ProposalSubmitter(config, audit, logger);

  // Initialize wallet if mnemonic is provided
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

  // Approval gate
  const gate = new ApprovalGate(config, builder, submitter, audit, logger);

  // Telegram command handler for /approve and /reject
  const bot = notifier.getBot();
  let commandHandler: TelegramCommandHandler | null = null;
  if (bot && config.telegramAdminChatId) {
    commandHandler = new TelegramCommandHandler(bot, gate, config, logger);
    commandHandler.start();

    // Wire approval gate notifications through Telegram
    gate.onNotify(async (proposal, markdown) => {
      await commandHandler!.sendApprovalRequest(proposal, markdown);
    });
  } else {
    logger.warn("Telegram admin chat not configured — proposal approval commands disabled");
  }

  // Event watcher for real-time chain events
  const eventWatcher = new EventWatcher(lcd, config, logger);

  // ─── Wire the Scheduler ───────────────────────────────────────────

  // Log character system prompt
  logger.info(
    { system: MarketMonitorCharacter.system.join(" ") },
    "Character loaded"
  );

  const scheduler = new Scheduler(
    plugin, alerts, store, health, notifier, config, logger
  );

  // Subscribe to chain events
  scheduler.subscribeToEvents(eventWatcher);

  // Wire the freeze proposal pipeline
  scheduler.onCriticalAnomaly = async (anomalyReport) => {
    logger.info(
      { z_score: anomalyReport.z_score },
      "CRITICAL anomaly — initiating freeze proposal pipeline"
    );

    try {
      let orderIds: string[] = [];
      try {
        const orders = await lcd.getEcocreditSellOrders();
        orderIds = orders.slice(0, 10).map((o) => o.id);
      } catch {
        logger.warn("Could not fetch sell orders for proposal context");
      }

      const priceHistory = store.loadPriceHistory();
      const proposal = builder.buildFreezeProposal(anomalyReport, priceHistory, orderIds);

      const validation = await builder.validateProposal(proposal);
      if (!validation.valid) {
        logger.warn(
          { proposalId: proposal.id, reasons: validation.reasons, confidence: validation.confidence },
          "Freeze proposal validation failed — not requesting approval"
        );
        return;
      }

      await gate.requestApproval(proposal);
    } catch (err) {
      logger.error({ err }, "Freeze proposal pipeline failed");
    }
  };

  // Start everything
  await eventWatcher.start();
  await scheduler.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
