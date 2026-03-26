import "dotenv/config";

import { MarketMonitorCharacter } from "./characters/market-monitor.character.js";
import { RegenMarketPlugin } from "./plugins/regen-market-plugin.js";
import { McpClient } from "./mcp-client.js";
import { AlertManager } from "./alerts.js";
import { DataStore } from "./data-store.js";
import { Scheduler } from "./scheduler.js";
import { HealthServer } from "./health-server.js";
import { TelegramNotifier } from "./notifiers/telegram.js";
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

  // Telegram notifier (falls back to console if not configured)
  const notifier = new TelegramNotifier(config, logger);
  alerts.onAlert((alert) => notifier.sendAlert(alert));

  // Health endpoint
  const health = new HealthServer(config.port, logger);

  // Log character system prompt
  logger.info(
    { system: MarketMonitorCharacter.system.join(" ") },
    "Character loaded"
  );

  // Start polling scheduler
  const scheduler = new Scheduler(
    plugin, alerts, store, health, notifier, config, logger
  );
  await scheduler.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
