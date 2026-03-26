import "dotenv/config";

import { MarketMonitorCharacter } from "./characters/market-monitor.character.js";
import { RegenMarketPlugin } from "./plugins/regen-market-plugin.js";
import { McpClient } from "./mcp-client.js";
import { AlertManager } from "./alerts.js";
import { Scheduler } from "./scheduler.js";
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

  // MCP client for regen-compute tools
  const mcp = new McpClient(config.regenComputeMcpUrl, logger);

  // Plugin with all four OODA workflows
  const plugin = new RegenMarketPlugin(mcp, logger);

  // Alert manager with threshold checks and deduplication
  const alerts = new AlertManager(config, logger);

  // Telegram notifier (falls back to console if not configured)
  const notifier = new TelegramNotifier(config, logger);
  alerts.onAlert((alert) => notifier.sendAlert(alert));

  // Log character system prompt
  logger.info(
    { system: MarketMonitorCharacter.system.join(" ") },
    "Character loaded"
  );

  // Start polling scheduler
  const scheduler = new Scheduler(plugin, alerts, config, logger);
  await scheduler.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
