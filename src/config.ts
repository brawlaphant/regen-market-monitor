import { Config } from "./types.js";

export function loadConfig(): Config {
  const url = process.env.REGEN_COMPUTE_MCP_URL;
  if (!url) {
    throw new Error(
      "REGEN_COMPUTE_MCP_URL is required. Set it in .env or environment."
    );
  }

  return {
    regenComputeMcpUrl: url,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "3600000", 10),
    lowStockThreshold: parseInt(process.env.LOW_STOCK_THRESHOLD || "1000", 10),
    priceMoveThreshold: parseFloat(process.env.PRICE_MOVE_THRESHOLD || "0.10"),
    alertCooldownMs: parseInt(process.env.ALERT_COOLDOWN_MS || "3600000", 10),
    logLevel: process.env.LOG_LEVEL || "info",
    port: parseInt(process.env.PORT || "3099", 10),
    dailyDigestHourUtc: parseInt(process.env.DAILY_DIGEST_HOUR_UTC || "9", 10),
    dataDir: process.env.DATA_DIR || "./data",
    mcpTimeoutMs: parseInt(process.env.MCP_TIMEOUT_MS || "10000", 10),
    mcpRetryAttempts: parseInt(process.env.MCP_RETRY_ATTEMPTS || "3", 10),
  };
}
