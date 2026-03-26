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

  // Telegram notifier (falls back to console if not configured)
  const notifier = new TelegramNotifier(config, logger);
  alerts.onAlert((alert) => notifier.sendAlert(alert));

  // Health endpoint — serves /health, /state, and /signals/* routes
  const health = new HealthServer(config.port, logger);
  health.signalStore = signalStore;
  health.signalPublisher = signalPublisher;

  // Generate subscription guide for downstream agent teams
  buildSubscriptionGuide(config.dataDir, config.port, logger);

  // Log character system prompt
  logger.info(
    { system: MarketMonitorCharacter.system.join(" ") },
    "Character loaded"
  );

  // Start polling scheduler
  const scheduler = new Scheduler(
    plugin, alerts, store, health, notifier, config, logger
  );

  // Wire MARKET_REPORT signal into scheduler's daily digest
  scheduler.onDigestComplete = async (snapshot) => {
    if (!snapshot) return;
    try {
      const { buildSignal } = await import("./signals/signal-factory.js");
      const signal = buildSignal(
        "MARKET_REPORT",
        {
          regen_price_usd: snapshot.price?.price_usd ?? 0,
          available_credits: snapshot.credits?.total_tradable ?? 0,
          health_score: snapshot.liquidity?.health_score ?? 0,
          active_goals: snapshot.communityGoals?.goals?.length ?? 0,
          goals_completed_today: snapshot.communityGoals?.goals?.filter(
            (g) => g.percent_complete >= 100
          ).length ?? 0,
          alerts_fired_today: alerts.alertsFiredToday,
          period_start: new Date(Date.now() - 86400000).toISOString(),
          period_end: new Date().toISOString(),
        },
        { triggered_by: "scheduled_poll", workflow_id: "daily-digest" },
        signalPublisher.configuredChannels
      );
      await signalPublisher.publish(signal);
    } catch (err) {
      logger.warn({ err }, "Failed to produce MARKET_REPORT signal");
    }
  };

  // Graceful shutdown — close SSE and Redis before exit
  const origStop = scheduler.stop.bind(scheduler);
  scheduler.stop = async (signal?: string) => {
    signalPublisher.closeSseClients();
    await signalPublisher.close();
    await origStop(signal);
  };

  await scheduler.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
